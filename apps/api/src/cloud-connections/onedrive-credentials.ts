import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type { AppDatabase } from '../db/database.js';
import { OneDriveProvisionError, type OneDriveProvisionCandidate } from './onedrive-provision.js';
import type { RcloneOneDriveProvisionAdapter } from './rclone-onedrive-provision.js';
import type { CloudConnectionProviderSession } from './refresh-coordinator.js';

export type OneDriveCredentialBinding = {
  accountId: string;
  profileId: string | null;
  rawRemote: string;
  cryptRemote: string;
  provisioningMode: string;
  escrowState: string | null;
  cryptState: string | null;
};

type MaterializationRow = {
  materializedSecretRef: string | null;
  owner: string | null;
  expiresAt: number | null;
};

/** Reuses the verified profile and aliases. Only the encrypted DB credential is
 * authoritative; a separate durable stamp/lease fences stale runtime artifacts.
 */
export class OneDriveCredentialMaterializer {
  private readonly now: () => number;

  constructor(
    private readonly options: {
      db: AppDatabase;
      adapter: Pick<
        RcloneOneDriveProvisionAdapter,
        | 'materializeCredentialCandidate'
        | 'probeAbout'
        | 'probeList'
        | 'activateCandidate'
        | 'rollbackCandidate'
        | 'finalizeCandidate'
      >;
      now?: () => number;
    },
  ) {
    this.now = options.now ?? Date.now;
  }

  binding(connectionId: string): OneDriveCredentialBinding | null {
    const rows = this.options.db
      .prepare(
        `SELECT account.id AS accountId,
      account.encryption_profile_id AS profileId, account.raw_remote AS rawRemote,
      account.crypt_remote AS cryptRemote, account.provisioning_mode AS provisioningMode,
      profile.escrow_state AS escrowState, profile.crypt_roundtrip_state AS cryptState
      FROM storage_accounts AS account LEFT JOIN encryption_profiles AS profile ON profile.id = account.encryption_profile_id
      WHERE account.connection_id = ? ORDER BY account.id`,
      )
      .all(connectionId) as OneDriveCredentialBinding[];
    if (rows.length > 1) throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FENCE_REJECTED');
    return rows[0] ?? null;
  }

  async ensure(session: CloudConnectionProviderSession): Promise<void> {
    if (session.provider !== 'ONEDRIVE') return;
    const binding = this.binding(session.connectionId);
    if (binding === null) return; // Initial provision is a different workflow.
    this.assertCurrent(session);
    if (
      binding.provisioningMode === 'WEB_OAUTH' &&
      (binding.profileId === null ||
        binding.escrowState !== 'VERIFIED' ||
        binding.cryptState !== 'PASSED')
    ) {
      throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FENCE_REJECTED');
    }
    const owner = randomUUID();
    for (;;) {
      this.assertCurrent(session);
      const acquired = this.options.db
        .transaction(() => {
          this.options.db
            .prepare(
              'INSERT OR IGNORE INTO cloud_connection_materializations(connection_id, updated_at) VALUES (?, ?)',
            )
            .run(session.connectionId, this.now());
          const row = this.row(session.connectionId);
          if (row.materializedSecretRef === session.secretRefId) return 'READY';
          const change = this.options.db
            .prepare(
              `UPDATE cloud_connection_materializations
          SET owner_token = ?, lease_expires_at = ?, updated_at = ?
          WHERE connection_id = ? AND (owner_token IS NULL OR lease_expires_at <= ?)`,
            )
            .run(owner, this.now() + 30_000, this.now(), session.connectionId, this.now());
          return change.changes === 1 ? 'OWNED' : 'WAIT';
        })
        .immediate();
      if (acquired === 'READY') return;
      if (acquired === 'OWNED') break;
      await delay(25);
    }
    let candidate: OneDriveProvisionCandidate | undefined;
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      const result = this.options.db
        .prepare(
          'UPDATE cloud_connection_materializations SET lease_expires_at = ? WHERE connection_id = ? AND owner_token = ?',
        )
        .run(this.now() + 30_000, session.connectionId, owner);
      if (result.changes !== 1) leaseLost = true;
    }, 5_000);
    heartbeat.unref();
    const assertOwner = (): void => {
      this.assertCurrent(session);
      const row = this.row(session.connectionId);
      if (
        leaseLost ||
        row.owner !== owner ||
        row.expiresAt === null ||
        row.expiresAt <= this.now() ||
        JSON.stringify(this.binding(session.connectionId)) !== JSON.stringify(binding)
      ) {
        throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FENCE_REJECTED');
      }
    };
    try {
      candidate = await this.options.adapter.materializeCredentialCandidate({
        connectionId: session.connectionId,
        session,
        rawRemote: binding.rawRemote,
        cryptRemote: binding.cryptRemote,
      });
      assertOwner();
      await this.options.adapter.probeAbout(candidate);
      assertOwner();
      await this.options.adapter.probeList(candidate);
      assertOwner();
      await this.options.adapter.activateCandidate(candidate);
      this.options.db
        .transaction(() => {
          assertOwner();
          this.options.db
            .prepare(
              `UPDATE cloud_connection_materializations
          SET materialized_secret_ref = ?, owner_token = NULL, lease_expires_at = NULL, failure_code = NULL, updated_at = ?
          WHERE connection_id = ? AND owner_token = ?`,
            )
            .run(session.secretRefId, this.now(), session.connectionId, owner);
          this.options.db
            .prepare(
              "UPDATE cloud_connections SET provision_state = 'READY', updated_at = ? WHERE id = ?",
            )
            .run(this.now(), session.connectionId);
        })
        .immediate();
      await this.options.adapter.finalizeCandidate(candidate).catch(() => undefined);
    } catch {
      if (candidate !== undefined)
        await this.options.adapter.rollbackCandidate(candidate).catch(() => undefined);
      this.options.db
        .transaction(() => {
          this.options.db
            .prepare(
              `UPDATE cloud_connection_materializations
          SET owner_token = NULL, lease_expires_at = NULL, failure_code = 'ONEDRIVE_CREDENTIAL_MATERIALIZATION_FAILED', updated_at = ?
          WHERE connection_id = ? AND owner_token = ?`,
            )
            .run(this.now(), session.connectionId, owner);
          // Preserve the storage verification evidence. Public projection marks
          // this credential-only failure separately via the pending stamp.
        })
        .immediate();
      throw new OneDriveProvisionError('ONEDRIVE_CREDENTIAL_MATERIALIZATION_FAILED');
    } finally {
      clearInterval(heartbeat);
    }
  }

  private row(connectionId: string): MaterializationRow {
    return this.options.db
      .prepare(
        'SELECT materialized_secret_ref AS materializedSecretRef, owner_token AS owner, lease_expires_at AS expiresAt FROM cloud_connection_materializations WHERE connection_id = ?',
      )
      .get(connectionId) as MaterializationRow;
  }

  private assertCurrent(session: CloudConnectionProviderSession): void {
    const current = this.options.db
      .prepare(
        `SELECT 1 FROM cloud_connections WHERE id = ? AND provider = 'ONEDRIVE'
      AND auth_state = 'CONNECTED' AND external_account_id = ? AND secret_ref = ? AND revision = ? AND access_expires_at = ?`,
      )
      .get(
        session.connectionId,
        session.externalAccountId,
        session.secretRefId,
        session.connectionRevision,
        session.accessExpiresAt,
      );
    if (current === undefined)
      throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FENCE_REJECTED');
  }
}
