import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { AppDatabase } from '../db/database.js';
import type {
  EncryptionProfileRepository,
  EncryptionProfileService,
} from './encryption-profiles.js';
import type { EncryptionProfileSecret } from './secrets.js';
import type { OneDriveCredentialMaterializer } from './onedrive-credentials.js';
import type {
  CloudConnectionProviderSession,
  CloudConnectionTokenRefreshCoordinator,
} from './refresh-coordinator.js';

const REMOTE_ALIAS = /^[A-Za-z0-9_-]+:$/;
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{2,79}$/;

export type OneDriveProvisionCandidate = Readonly<{ candidateId: string }>;

export interface OneDriveProvisionAdapter {
  materializeCandidate(input: {
    connectionId: string;
    session: CloudConnectionProviderSession;
    rawRemote: string;
    cryptRemote: string;
    secret: EncryptionProfileSecret;
    signal?: AbortSignal;
  }): Promise<OneDriveProvisionCandidate>;
  writeEscrow(
    candidate: OneDriveProvisionCandidate,
    input: { profileId: string; secret: EncryptionProfileSecret; signal?: AbortSignal },
  ): Promise<{ receiptRef: string; digest: string }>;
  readBackEscrow(
    candidate: OneDriveProvisionCandidate,
    input: { receiptRef: string; signal?: AbortSignal },
  ): Promise<{ digest: string }>;
  probeAbout(
    candidate: OneDriveProvisionCandidate,
    signal?: AbortSignal,
  ): Promise<{ totalBytes: number | null; freeBytes: number | null }>;
  probeList(candidate: OneDriveProvisionCandidate, signal?: AbortSignal): Promise<void>;
  cryptRoundTrip(
    candidate: OneDriveProvisionCandidate,
    sample: { plaintext: Uint8Array; sha256: string; signal?: AbortSignal },
  ): Promise<{ sha256: string }>;
  /** Must atomically replace only this service's managed rclone sections. */
  activateCandidate(candidate: OneDriveProvisionCandidate): Promise<void>;
  /** Idempotent compensation for materialization or activation failure. */
  rollbackCandidate(candidate: OneDriveProvisionCandidate): Promise<void>;
  /** Best-effort removal of the isolated candidate after the database switch commits. */
  finalizeCandidate(candidate: OneDriveProvisionCandidate): Promise<void>;
  /** Read-only, exact drive identity probe used only by the explicit takeover API. */
  inspectLegacyIdentity(input: {
    rawRemote: string;
    cryptRemote: string;
    signal?: AbortSignal;
  }): Promise<{ externalAccountId: string }>;
}

export type OneDriveProvisionResult = {
  connectionId: string;
  connectionRevision: number;
  accountId: string;
  profileId: string | null;
  rawRemote: string;
  cryptRemote: string;
  provisionState: 'READY';
};

export type OneDriveLegacyTakeoverResult = {
  connectionId: string;
  connectionRevision: number;
  accountId: string;
  accountRevision: number;
};

export type OneDriveProvisionErrorCode =
  | 'ONEDRIVE_PROVISION_DISABLED'
  | 'ONEDRIVE_CONNECTION_NOT_FOUND'
  | 'ONEDRIVE_CONNECTION_REVISION_CONFLICT'
  | 'ONEDRIVE_CONNECTION_NOT_ELIGIBLE'
  | 'ONEDRIVE_PROVISION_ALREADY_BOUND'
  | 'ONEDRIVE_PROVISION_IN_PROGRESS'
  | 'ONEDRIVE_PROVISION_FENCE_REJECTED'
  | 'ONEDRIVE_ESCROW_VERIFY_FAILED'
  | 'ONEDRIVE_CRYPT_ROUNDTRIP_FAILED'
  | 'ONEDRIVE_LEGACY_ACCOUNT_NOT_FOUND'
  | 'ONEDRIVE_LEGACY_ACCOUNT_CONFLICT'
  | 'ONEDRIVE_LEGACY_IDENTITY_MISMATCH'
  | 'ONEDRIVE_LEGACY_REMOTE_MISMATCH'
  | 'ONEDRIVE_PROVISION_FAILED';

export class OneDriveProvisionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'OneDriveProvisionError';
  }
}

type BeginResult = {
  attemptId: string;
  connectionId: string;
  connectionRevision: number;
  profileId: string;
  accountId: string;
  label: string;
  rawRemote: string;
  cryptRemote: string;
};

type ConnectionRow = {
  id: string;
  provider: string;
  label: string;
  externalAccountId: string;
  authState: string;
  secretRef: string | null;
  provisionState: string;
  revision: number;
};

type LegacyTakeoverFence = {
  connectionId: string;
  expectedConnectionRevision: number;
  accountId: string;
  expectedAccountRevision: number;
  expectedRawRemote: string;
  expectedCryptRemote: string;
};

/** SQLite authority for the provision fence and the final live-binding switch. */
export class OneDriveProvisionRepository {
  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => number = () => Date.now(),
  ) {}

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation).immediate();
  }

  begin(input: {
    attemptId: string;
    connectionId: string;
    expectedRevision: number;
    profileId: string;
    accountId: string;
    rawRemote: string;
    cryptRemote: string;
  }): BeginResult {
    assertRemote(input.rawRemote);
    assertRemote(input.cryptRemote);
    if (input.rawRemote === input.cryptRemote)
      throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FAILED');
    return this.db
      .transaction(() => {
        const row = this.connection(input.connectionId);
        if (row.revision !== input.expectedRevision) {
          throw new OneDriveProvisionError('ONEDRIVE_CONNECTION_REVISION_CONFLICT');
        }
        if (
          row.provider !== 'ONEDRIVE' ||
          row.authState !== 'CONNECTED' ||
          row.secretRef === null
        ) {
          throw new OneDriveProvisionError('ONEDRIVE_CONNECTION_NOT_ELIGIBLE');
        }
        const bound = Number(
          this.db
            .prepare('SELECT COUNT(*) FROM storage_accounts WHERE connection_id = ?')
            .pluck()
            .get(row.id),
        );
        if (bound > 0) throw new OneDriveProvisionError('ONEDRIVE_PROVISION_ALREADY_BOUND');
        const active = Number(
          this.db
            .prepare(
              "SELECT COUNT(*) FROM cloud_connection_provision_attempts WHERE connection_id = ? AND state IN ('PREPARING', 'VERIFIED')",
            )
            .pluck()
            .get(row.id),
        );
        if (active > 0) throw new OneDriveProvisionError('ONEDRIVE_PROVISION_IN_PROGRESS');
        if (!['NOT_REQUESTED', 'PROVISION_FAILED'].includes(row.provisionState)) {
          throw new OneDriveProvisionError('ONEDRIVE_CONNECTION_NOT_ELIGIBLE');
        }
        const timestamp = this.now();
        const changed = this.db
          .prepare(
            `UPDATE cloud_connections
           SET provision_state = 'PROVISIONING', revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ? AND auth_state = 'CONNECTED'
             AND provider = 'ONEDRIVE' AND secret_ref IS NOT NULL
             AND provision_state IN ('NOT_REQUESTED', 'PROVISION_FAILED')`,
          )
          .run(timestamp, row.id, input.expectedRevision);
        if (changed.changes !== 1) {
          throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FENCE_REJECTED');
        }
        const connectionRevision = input.expectedRevision + 1;
        this.db
          .prepare(
            `INSERT INTO cloud_connection_provision_attempts(
             id, connection_id, connection_revision, profile_id, candidate_account_id,
             raw_remote, crypt_remote, state, diagnostic_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PREPARING', '{}', ?, ?)`,
          )
          .run(
            input.attemptId,
            row.id,
            connectionRevision,
            input.profileId,
            input.accountId,
            input.rawRemote,
            input.cryptRemote,
            timestamp,
            timestamp,
          );
        return {
          attemptId: input.attemptId,
          connectionId: row.id,
          connectionRevision,
          profileId: input.profileId,
          accountId: input.accountId,
          label: row.label,
          rawRemote: input.rawRemote,
          cryptRemote: input.cryptRemote,
        };
      })
      .immediate();
  }

  complete(input: {
    attempt: BeginResult;
    escrowReceiptRef: string;
    totalBytes: number | null;
    freeBytes: number | null;
    reserveBytes: number;
  }): OneDriveProvisionResult {
    validateQuota(input.totalBytes);
    validateQuota(input.freeBytes);
    if (!Number.isSafeInteger(input.reserveBytes) || input.reserveBytes < 0) {
      throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FAILED');
    }
    return this.db
      .transaction(() => {
        const timestamp = this.now();
        const verified = this.db
          .prepare(
            `UPDATE cloud_connection_provision_attempts
           SET state = 'VERIFIED', escrow_receipt_ref = ?, updated_at = ?
           WHERE id = ? AND connection_id = ? AND connection_revision = ? AND state = 'PREPARING'`,
          )
          .run(
            input.escrowReceiptRef,
            timestamp,
            input.attempt.attemptId,
            input.attempt.connectionId,
            input.attempt.connectionRevision,
          );
        if (verified.changes !== 1)
          throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FENCE_REJECTED');
        const profile = this.db
          .prepare(
            `UPDATE encryption_profiles
           SET escrow_state = 'VERIFIED', escrow_receipt_ref = ?, crypt_roundtrip_state = 'PASSED'
           WHERE id = ? AND escrow_state = 'PENDING' AND crypt_roundtrip_state = 'NOT_RUN'`,
          )
          .run(input.escrowReceiptRef, input.attempt.profileId);
        if (profile.changes !== 1)
          throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FENCE_REJECTED');
        const connection = this.db
          .prepare(
            `UPDATE cloud_connections
           SET provision_state = 'READY',
               capabilities_json = '["ARCHIVE_DESTINATION","JELLYFIN_MOUNT","RECOVERY_ELIGIBLE"]',
               revision = revision + 1,
               last_checked_at = ?, updated_at = ?
           WHERE id = ? AND revision = ? AND auth_state = 'CONNECTED'
             AND provider = 'ONEDRIVE' AND provision_state = 'PROVISIONING'`,
          )
          .run(timestamp, timestamp, input.attempt.connectionId, input.attempt.connectionRevision);
        if (connection.changes !== 1) {
          throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FENCE_REJECTED');
        }
        this.db
          .prepare(
            `INSERT INTO storage_accounts(
             id, label, raw_remote, crypt_remote, health, total_bytes, free_bytes,
             reserve_bytes, circuit_open_until, last_checked_at, created_at, updated_at,
             connection_id, provider, provisioning_mode, encryption_profile_id,
             enabled, revision
           ) VALUES (?, ?, ?, ?, 'HEALTHY', ?, ?, ?, NULL, ?, ?, ?, ?, 'ONEDRIVE',
                     'WEB_OAUTH', ?, 1, 0)`,
          )
          .run(
            input.attempt.accountId,
            input.attempt.label,
            input.attempt.rawRemote,
            input.attempt.cryptRemote,
            input.totalBytes,
            input.freeBytes,
            input.reserveBytes,
            timestamp,
            timestamp,
            timestamp,
            input.attempt.connectionId,
            input.attempt.profileId,
          );
        const activated = this.db
          .prepare(
            `UPDATE cloud_connection_provision_attempts
           SET state = 'ACTIVATED', diagnostic_json = ?, updated_at = ?, completed_at = ?
           WHERE id = ? AND state = 'VERIFIED'`,
          )
          .run(
            JSON.stringify({
              about: 'PASSED',
              list: 'PASSED',
              escrowReadback: 'PASSED',
              cryptRoundtrip: 'PASSED',
            }),
            timestamp,
            timestamp,
            input.attempt.attemptId,
          );
        if (activated.changes !== 1)
          throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FENCE_REJECTED');
        this.db
          .prepare(
            `INSERT INTO cloud_connection_materializations(connection_id, materialized_secret_ref, updated_at)
          SELECT id, secret_ref, ? FROM cloud_connections WHERE id = ?
          ON CONFLICT(connection_id) DO UPDATE SET materialized_secret_ref = excluded.materialized_secret_ref,
            owner_token = NULL, lease_expires_at = NULL, failure_code = NULL, updated_at = excluded.updated_at`,
          )
          .run(timestamp, input.attempt.connectionId);
        return {
          connectionId: input.attempt.connectionId,
          connectionRevision: input.attempt.connectionRevision + 1,
          accountId: input.attempt.accountId,
          profileId: input.attempt.profileId,
          rawRemote: input.attempt.rawRemote,
          cryptRemote: input.attempt.cryptRemote,
          provisionState: 'READY',
        } satisfies OneDriveProvisionResult;
      })
      .immediate();
  }

  fail(attempt: BeginResult, failureCode: string, rollbackFailed: boolean): void {
    const safeCode = safeFailureCode(failureCode);
    this.db
      .transaction(() => {
        const timestamp = this.now();
        this.db
          .prepare(
            `UPDATE encryption_profiles
           SET escrow_state = CASE WHEN escrow_state = 'VERIFIED' THEN escrow_state ELSE 'FAILED' END,
               escrow_receipt_ref = CASE WHEN escrow_state = 'VERIFIED' THEN escrow_receipt_ref ELSE NULL END,
               crypt_roundtrip_state = CASE WHEN crypt_roundtrip_state = 'PASSED' THEN crypt_roundtrip_state ELSE 'FAILED' END
           WHERE id = ?`,
          )
          .run(attempt.profileId);
        this.db
          .prepare(
            `UPDATE cloud_connections
           SET provision_state = 'PROVISION_FAILED', revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ? AND provision_state = 'PROVISIONING'`,
          )
          .run(timestamp, attempt.connectionId, attempt.connectionRevision);
        this.db
          .prepare(
            `UPDATE cloud_connection_provision_attempts
           SET state = 'FAILED', failure_code = ?, diagnostic_json = ?,
               updated_at = ?, completed_at = ?
           WHERE id = ? AND state IN ('PREPARING', 'VERIFIED')`,
          )
          .run(
            safeCode,
            JSON.stringify({ rollback: rollbackFailed ? 'FAILED' : 'PASSED' }),
            timestamp,
            timestamp,
            attempt.attemptId,
          );
      })
      .immediate();
  }

  /** Fail closed before any provider read; the transaction repeats this fence after the probe. */
  assertConnectionRevision(id: string, expectedRevision: number): void {
    if (this.connection(id).revision !== expectedRevision)
      throw new OneDriveProvisionError('ONEDRIVE_CONNECTION_REVISION_CONFLICT');
  }

  assertLegacyTakeoverCandidate(input: LegacyTakeoverFence): void {
    this.legacyTakeoverAuthority(input);
  }

  takeOverLegacy(
    input: LegacyTakeoverFence & {
      observedExternalAccountId: string;
    },
  ): OneDriveLegacyTakeoverResult {
    return this.db
      .transaction(() => {
        const connection = this.legacyTakeoverAuthority(input);
        if (connection.externalAccountId !== input.observedExternalAccountId) {
          throw new OneDriveProvisionError('ONEDRIVE_LEGACY_IDENTITY_MISMATCH');
        }
        const timestamp = this.now();
        const connectionChanged = this.db
          .prepare(
            `UPDATE cloud_connections
           SET provision_state = 'READY', revision = revision + 1,
               last_checked_at = ?, updated_at = ?
           WHERE id = ? AND revision = ? AND provider = 'ONEDRIVE'
             AND auth_state = 'CONNECTED' AND secret_ref IS NOT NULL
             AND provision_state IN ('NOT_REQUESTED', 'PROVISION_FAILED')`,
          )
          .run(timestamp, timestamp, connection.id, connection.revision);
        if (connectionChanged.changes !== 1) {
          throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FENCE_REJECTED');
        }
        const accountChanged = this.db
          .prepare(
            `UPDATE storage_accounts
           SET connection_id = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ? AND provisioning_mode = 'LEGACY_RCLONE'
             AND connection_id IS NULL AND raw_remote = ? AND crypt_remote = ?`,
          )
          .run(
            connection.id,
            timestamp,
            input.accountId,
            input.expectedAccountRevision,
            input.expectedRawRemote,
            input.expectedCryptRemote,
          );
        if (accountChanged.changes !== 1) {
          throw new OneDriveProvisionError('ONEDRIVE_LEGACY_ACCOUNT_CONFLICT');
        }
        return {
          connectionId: connection.id,
          connectionRevision: connection.revision + 1,
          accountId: input.accountId,
          accountRevision: input.expectedAccountRevision + 1,
        };
      })
      .immediate();
  }

  private legacyTakeoverAuthority(input: LegacyTakeoverFence): ConnectionRow {
    const connection = this.connection(input.connectionId);
    if (connection.revision !== input.expectedConnectionRevision) {
      throw new OneDriveProvisionError('ONEDRIVE_CONNECTION_REVISION_CONFLICT');
    }
    if (
      connection.provider !== 'ONEDRIVE' ||
      connection.authState !== 'CONNECTED' ||
      connection.secretRef === null ||
      (connection.provisionState !== 'NOT_REQUESTED' &&
        connection.provisionState !== 'PROVISION_FAILED')
    ) {
      throw new OneDriveProvisionError('ONEDRIVE_CONNECTION_NOT_ELIGIBLE');
    }
    const bound = Number(
      this.db
        .prepare('SELECT COUNT(*) FROM storage_accounts WHERE connection_id = ?')
        .pluck()
        .get(connection.id),
    );
    if (bound > 0) throw new OneDriveProvisionError('ONEDRIVE_PROVISION_ALREADY_BOUND');
    const account = this.db
      .prepare(
        `SELECT raw_remote AS rawRemote, crypt_remote AS cryptRemote,
                provisioning_mode AS provisioningMode, connection_id AS connectionId,
                revision
         FROM storage_accounts WHERE id = ?`,
      )
      .get(input.accountId) as
      | {
          rawRemote: string;
          cryptRemote: string;
          provisioningMode: string;
          connectionId: string | null;
          revision: number;
        }
      | undefined;
    if (account === undefined)
      throw new OneDriveProvisionError('ONEDRIVE_LEGACY_ACCOUNT_NOT_FOUND');
    if (
      account.rawRemote !== input.expectedRawRemote ||
      account.cryptRemote !== input.expectedCryptRemote
    ) {
      throw new OneDriveProvisionError('ONEDRIVE_LEGACY_REMOTE_MISMATCH');
    }
    if (
      account.revision !== input.expectedAccountRevision ||
      account.provisioningMode !== 'LEGACY_RCLONE' ||
      account.connectionId !== null
    ) {
      throw new OneDriveProvisionError('ONEDRIVE_LEGACY_ACCOUNT_CONFLICT');
    }
    return connection;
  }

  private connection(id: string): ConnectionRow {
    const row = this.db
      .prepare(
        `SELECT id, provider, label, external_account_id AS externalAccountId,
                auth_state AS authState, secret_ref AS secretRef,
                provision_state AS provisionState, revision
         FROM cloud_connections WHERE id = ?`,
      )
      .get(id) as ConnectionRow | undefined;
    if (row === undefined) throw new OneDriveProvisionError('ONEDRIVE_CONNECTION_NOT_FOUND');
    return row;
  }
}

export type OneDriveProvisionServiceOptions = {
  repository: OneDriveProvisionRepository;
  profiles: EncryptionProfileRepository;
  profileService: EncryptionProfileService;
  refresh: Pick<CloudConnectionTokenRefreshCoordinator, 'getSession'>;
  adapter: OneDriveProvisionAdapter;
  enabled?: boolean;
  newAttemptId?: () => string;
  newAccountId?: () => string;
  reserveBytes?: number;
  credentials?: OneDriveCredentialMaterializer;
};

/** Orchestrates every irreversible-looking step behind a compensating rollback. */
export class OneDriveProvisionService {
  private readonly enabled: boolean;
  private readonly newAttemptId: () => string;
  private readonly newAccountId: () => string;
  private readonly reserveBytes: number;

  constructor(private readonly options: OneDriveProvisionServiceOptions) {
    this.enabled = options.enabled ?? false;
    this.newAttemptId = options.newAttemptId ?? randomUUID;
    this.newAccountId = options.newAccountId ?? randomUUID;
    this.reserveBytes = options.reserveBytes ?? 0;
  }

  async provision(input: {
    connectionId: string;
    expectedRevision: number;
    signal?: AbortSignal;
  }): Promise<OneDriveProvisionResult> {
    if (!this.enabled) throw new OneDriveProvisionError('ONEDRIVE_PROVISION_DISABLED');
    const bound = this.options.credentials?.binding(input.connectionId);
    if (bound !== undefined && bound !== null) {
      this.options.repository.assertConnectionRevision(input.connectionId, input.expectedRevision);
      const session = await this.options.refresh.getSession(input.connectionId);
      await this.options.credentials!.ensure(session);
      return {
        connectionId: input.connectionId,
        connectionRevision: session.connectionRevision,
        accountId: bound.accountId,
        profileId: bound.profileId,
        rawRemote: bound.rawRemote,
        cryptRemote: bound.cryptRemote,
        provisionState: 'READY',
      };
    }
    const names = managedRemoteNames(input.connectionId);
    // The immutable profile and its provision journal are one authority change.
    // If the connection fence rejects the attempt, neither secret nor profile is
    // left orphaned for an operation that never started.
    const attempt = this.options.repository.transaction(() => {
      const profile = this.options.profileService.create();
      return this.options.repository.begin({
        attemptId: this.newAttemptId(),
        connectionId: input.connectionId,
        expectedRevision: input.expectedRevision,
        profileId: profile.id,
        accountId: this.newAccountId(),
        ...names,
      });
    });
    let candidate: OneDriveProvisionCandidate | undefined;
    try {
      const session = await this.options.refresh.getSession(attempt.connectionId);
      if (
        session.provider !== 'ONEDRIVE' ||
        session.connectionId !== attempt.connectionId ||
        session.connectionRevision !== attempt.connectionRevision
      ) {
        throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FENCE_REJECTED');
      }
      const secret = this.options.profileService.openForProvisioning(attempt.profileId);
      candidate = await this.options.adapter.materializeCandidate({
        connectionId: attempt.connectionId,
        session,
        rawRemote: attempt.rawRemote,
        cryptRemote: attempt.cryptRemote,
        secret,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      const escrow = await this.options.adapter.writeEscrow(candidate, {
        profileId: attempt.profileId,
        secret,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      assertDigest(escrow.digest, 'ONEDRIVE_ESCROW_VERIFY_FAILED');
      if (escrow.receiptRef.length < 1 || escrow.receiptRef.length > 1024) {
        throw new OneDriveProvisionError('ONEDRIVE_ESCROW_VERIFY_FAILED');
      }
      const escrowReadback = await this.options.adapter.readBackEscrow(candidate, {
        receiptRef: escrow.receiptRef,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (escrowReadback.digest !== escrow.digest) {
        throw new OneDriveProvisionError('ONEDRIVE_ESCROW_VERIFY_FAILED');
      }
      const about = await this.options.adapter.probeAbout(candidate, input.signal);
      await this.options.adapter.probeList(candidate, input.signal);
      const plaintext = randomBytes(64);
      const sha256 = createHash('sha256').update(plaintext).digest('hex');
      const roundtrip = await this.options.adapter.cryptRoundTrip(candidate, {
        plaintext,
        sha256,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (roundtrip.sha256 !== sha256) {
        throw new OneDriveProvisionError('ONEDRIVE_CRYPT_ROUNDTRIP_FAILED');
      }
      await this.options.adapter.activateCandidate(candidate);
      const result = this.options.repository.complete({
        attempt,
        escrowReceiptRef: escrow.receiptRef,
        totalBytes: about.totalBytes,
        freeBytes: about.freeBytes,
        reserveBytes: this.reserveBytes,
      });
      // Candidate cleanup is not part of the committed live binding. A cleanup
      // failure must not compensate a READY database row and live rclone config.
      await this.options.adapter.finalizeCandidate(candidate).catch(() => undefined);
      return result;
    } catch (error) {
      let rollbackFailed = false;
      if (candidate !== undefined) {
        try {
          await this.options.adapter.rollbackCandidate(candidate);
        } catch {
          rollbackFailed = true;
        }
      }
      const code = provisionFailureCode(error);
      this.options.repository.fail(attempt, code, rollbackFailed);
      if (error instanceof OneDriveProvisionError) throw error;
      throw new OneDriveProvisionError(code);
    }
  }

  async takeOverLegacy(input: {
    connectionId: string;
    expectedConnectionRevision: number;
    accountId: string;
    expectedAccountRevision: number;
    expectedRawRemote: string;
    expectedCryptRemote: string;
    signal?: AbortSignal;
  }): Promise<OneDriveLegacyTakeoverResult> {
    if (!this.enabled) throw new OneDriveProvisionError('ONEDRIVE_PROVISION_DISABLED');
    this.options.repository.assertLegacyTakeoverCandidate(input);
    const observed = await this.options.adapter.inspectLegacyIdentity({
      rawRemote: input.expectedRawRemote,
      cryptRemote: input.expectedCryptRemote,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const result = this.options.repository.takeOverLegacy({
      ...input,
      observedExternalAccountId: observed.externalAccountId,
    });
    if (this.options.credentials !== undefined) {
      await this.options.credentials.ensure(
        await this.options.refresh.getSession(input.connectionId),
      );
    }
    return result;
  }
}

export function managedRemoteNames(connectionId: string): {
  rawRemote: string;
  cryptRemote: string;
} {
  const slug = connectionId.replaceAll('-', '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(slug)) throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FAILED');
  const prefix = slug.slice(0, 12);
  return {
    rawRemote: `ptvault_od_${prefix}_raw:`,
    cryptRemote: `ptvault_od_${prefix}_crypt:`,
  };
}

function assertRemote(value: string): void {
  if (!REMOTE_ALIAS.test(value)) throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FAILED');
}

function assertDigest(value: string, code: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new OneDriveProvisionError(code);
}

function validateQuota(value: number | null): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FAILED');
  }
}

function safeFailureCode(value: string): string {
  return FAILURE_CODE.test(value) ? value : 'ONEDRIVE_PROVISION_FAILED';
}

function provisionFailureCode(error: unknown): string {
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    FAILURE_CODE.test(error.code)
  ) {
    return error.code;
  }
  if (error instanceof Error && FAILURE_CODE.test(error.message)) return error.message;
  return 'ONEDRIVE_PROVISION_FAILED';
}
