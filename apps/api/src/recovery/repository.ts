import {
  AgeRecipientSchema,
  RecoveryCloudCopySchema,
  RecoveryExportSchema,
  RecoveryStatusSchema,
  Sha256Schema,
  type RecoveryCloudCopy,
  type RecoveryExport,
  type RecoveryStatus,
} from '@ptvault/contracts';

import type { AppDatabase } from '../db/database.js';

type RecoveryExportRow = {
  version: number;
  recipient_generation: number;
  public_recipient: string;
  bundle_sha256: string | null;
  escrow_sha256: string | null;
  computer_confirmed_at: number | null;
  computer_confirmed_sha256: string | null;
  passphrase_verified_at: number | null;
  passphrase_verified_sha256: string | null;
  created_at: number;
  completed_at: number | null;
};

type RecoveryCopyRow = {
  version: number;
  account_id: string;
  bundle_sha256: string;
  escrow_sha256: string;
  bundle_remote_path: string;
  escrow_remote_path: string;
  verification_status: RecoveryCloudCopy['verificationStatus'];
  verified_at: number | null;
  created_at: number;
};

function exportFromRow(row: RecoveryExportRow): RecoveryExport {
  return RecoveryExportSchema.parse({
    version: row.version,
    recipientGeneration: row.recipient_generation,
    publicRecipient: row.public_recipient,
    bundleSha256: row.bundle_sha256,
    escrowSha256: row.escrow_sha256,
    computerConfirmedAt: row.computer_confirmed_at,
    computerConfirmedSha256: row.computer_confirmed_sha256,
    passphraseVerifiedAt: row.passphrase_verified_at,
    passphraseVerifiedSha256: row.passphrase_verified_sha256,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  });
}

function copyFromRow(row: RecoveryCopyRow): RecoveryCloudCopy {
  return RecoveryCloudCopySchema.parse({
    version: row.version,
    accountId: row.account_id,
    bundleSha256: row.bundle_sha256,
    escrowSha256: row.escrow_sha256,
    bundleRemotePath: row.bundle_remote_path,
    escrowRemotePath: row.escrow_remote_path,
    verificationStatus: row.verification_status,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
  });
}

export class RecoveryRepository {
  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => number = () => Date.now(),
  ) {}

  configurePublicRecipient(publicRecipient: string): void {
    const recipient = AgeRecipientSchema.parse(publicRecipient);
    const current = this.db
      .prepare(
        `SELECT public_recipient AS publicRecipient, recipient_generation AS recipientGeneration
         FROM recovery_settings WHERE id = 1`,
      )
      .get() as { publicRecipient: string; recipientGeneration: number } | undefined;
    const generation = current
      ? current.publicRecipient === recipient
        ? current.recipientGeneration
        : current.recipientGeneration + 1
      : 1;
    this.db
      .prepare(
        `INSERT INTO recovery_settings(id, public_recipient, recipient_generation, updated_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET public_recipient = excluded.public_recipient,
                                       recipient_generation = excluded.recipient_generation,
                                       updated_at = excluded.updated_at`,
      )
      .run(recipient, generation, this.now());
  }

  getPublicRecipient(): string | null {
    const value = this.db
      .prepare('SELECT public_recipient FROM recovery_settings WHERE id = 1')
      .pluck()
      .get() as string | undefined;
    return value ?? null;
  }

  getRecipientIdentity(): { publicRecipient: string; recipientGeneration: number } | null {
    return (
      (this.db
        .prepare(
          `SELECT public_recipient AS publicRecipient, recipient_generation AS recipientGeneration
      FROM recovery_settings WHERE id = 1`,
        )
        .get() as { publicRecipient: string; recipientGeneration: number } | undefined) ?? null
    );
  }

  beginExport(input: {
    escrowSha256: string;
    expectedMaterialRevision?: number;
    expectedPublicRecipient?: string;
    expectedRecipientGeneration?: number;
  }): number {
    return this.db
      .transaction(() => {
        const settings = this.db
          .prepare(
            `SELECT public_recipient AS publicRecipient, recipient_generation AS recipientGeneration
         FROM recovery_settings WHERE id = 1`,
          )
          .get() as { publicRecipient: string; recipientGeneration: number } | undefined;
        if (!settings) throw new Error('RECOVERY_RECIPIENT_NOT_CONFIGURED');
        const escrowSha256 = Sha256Schema.parse(input.escrowSha256);
        if (
          input.expectedMaterialRevision !== undefined ||
          input.expectedPublicRecipient !== undefined ||
          input.expectedRecipientGeneration !== undefined
        ) {
          const material = this.db
            .prepare(
              `SELECT material_revision AS revision, active_escrow_sha256 AS sha256,
        escrow_update_state AS state FROM recovery_preparation_state WHERE id = 1`,
            )
            .get() as { revision: number; sha256: string | null; state: string } | undefined;
          if (
            !material ||
            material.state !== 'STABLE' ||
            material.revision !== input.expectedMaterialRevision ||
            material.sha256 !== escrowSha256 ||
            settings.publicRecipient !== input.expectedPublicRecipient ||
            settings.recipientGeneration !== input.expectedRecipientGeneration
          )
            throw new Error('RECOVERY_EXPORT_MATERIAL_CHANGED');
        }
        const result = this.db
          .prepare(
            `INSERT INTO recovery_exports(
           recipient_generation, public_recipient, bundle_sha256, escrow_sha256, created_at
         ) VALUES (?, ?, NULL, ?, ?)`,
          )
          .run(settings.recipientGeneration, settings.publicRecipient, escrowSha256, this.now());
        return Number(result.lastInsertRowid);
      })
      .immediate();
  }

  completeExport(version: number, input: { bundleSha256: string }): void {
    const bundleSha256 = Sha256Schema.parse(input.bundleSha256);
    const changed = this.db
      .prepare(
        `UPDATE recovery_exports
         SET bundle_sha256 = ?, completed_at = ?
         WHERE version = ? AND bundle_sha256 IS NULL`,
      )
      .run(bundleSha256, this.now(), version);
    if (changed.changes === 0) throw new Error('RECOVERY_EXPORT_NOT_FOUND');
  }

  getExport(version: number): RecoveryExport | null {
    const row = this.db.prepare('SELECT * FROM recovery_exports WHERE version = ?').get(version) as
      RecoveryExportRow | undefined;
    return row ? exportFromRow(row) : null;
  }

  currentExport(): RecoveryExport | null {
    const row = this.db
      .prepare(
        `SELECT * FROM recovery_exports
         WHERE bundle_sha256 IS NOT NULL AND completed_at IS NOT NULL
         ORDER BY version DESC LIMIT 1`,
      )
      .get() as RecoveryExportRow | undefined;
    return row ? exportFromRow(row) : null;
  }

  /** Lists every recovery export, newest first, for the read-only recovery view. */
  listExports(): RecoveryExport[] {
    const rows = this.db
      .prepare('SELECT * FROM recovery_exports ORDER BY version DESC')
      .all() as RecoveryExportRow[];
    return rows.map(exportFromRow);
  }

  recordCloudCopy(
    input: Omit<RecoveryCloudCopy, 'verificationStatus' | 'createdAt'> & { verifiedAt: number },
  ): void {
    const exportRow = this.getExport(input.version);
    if (!exportRow?.bundleSha256 || !exportRow.escrowSha256) {
      throw new Error('RECOVERY_EXPORT_NOT_READY');
    }
    if (
      input.bundleSha256 !== exportRow.bundleSha256 ||
      input.escrowSha256 !== exportRow.escrowSha256
    ) {
      throw new Error('RECOVERY_COPY_CHECKSUM_MISMATCH');
    }
    this.db
      .prepare(
        `INSERT INTO recovery_cloud_copies(
           version, account_id, bundle_sha256, escrow_sha256,
           bundle_remote_path, escrow_remote_path, verification_status,
           verified_at, created_at
         ) VALUES (@version, @accountId, @bundleSha256, @escrowSha256,
                   @bundleRemotePath, @escrowRemotePath, 'VERIFIED',
                   @verifiedAt, @createdAt)
         ON CONFLICT(version, account_id) DO UPDATE SET
           bundle_sha256 = excluded.bundle_sha256,
           escrow_sha256 = excluded.escrow_sha256,
           bundle_remote_path = excluded.bundle_remote_path,
           escrow_remote_path = excluded.escrow_remote_path,
           verification_status = excluded.verification_status,
           verified_at = excluded.verified_at`,
      )
      .run({ ...input, createdAt: this.now() });
  }

  confirmComputerDownload(input: {
    version: number;
    bundleSha256: string;
    confirmedAt: number;
  }): void {
    const checksum = Sha256Schema.parse(input.bundleSha256);
    const changed = this.db
      .prepare(
        `UPDATE recovery_exports
         SET computer_confirmed_at = ?, computer_confirmed_sha256 = ?
         WHERE version = ? AND bundle_sha256 = ?`,
      )
      .run(input.confirmedAt, checksum, input.version, checksum);
    if (changed.changes === 0) {
      throw new Error('RECOVERY_BUNDLE_NOT_FOUND_OR_CHECKSUM_MISMATCH');
    }
  }

  attestPassphraseVerification(input: {
    version: number;
    escrowSha256: string;
    verifiedAt: number;
  }): void {
    const checksum = Sha256Schema.parse(input.escrowSha256);
    const changed = this.db
      .prepare(
        `UPDATE recovery_exports
         SET passphrase_verified_at = ?, passphrase_verified_sha256 = ?
         WHERE version = ? AND escrow_sha256 = ?`,
      )
      .run(input.verifiedAt, checksum, input.version, checksum);
    if (changed.changes === 0) {
      throw new Error('RECOVERY_ESCROW_NOT_FOUND_OR_CHECKSUM_MISMATCH');
    }
  }

  listCloudCopies(version: number): RecoveryCloudCopy[] {
    const rows = this.db
      .prepare('SELECT * FROM recovery_cloud_copies WHERE version = ? ORDER BY account_id')
      .all(version) as RecoveryCopyRow[];
    return rows.map(copyFromRow);
  }

  currentStatus(): RecoveryStatus {
    const current = this.currentExport();
    const configured = this.db
      .prepare(
        `SELECT public_recipient AS publicRecipient, recipient_generation AS recipientGeneration
         FROM recovery_settings WHERE id = 1`,
      )
      .get() as { publicRecipient: string; recipientGeneration: number } | undefined;
    const configuredRecipient = configured?.publicRecipient ?? null;
    const publicRecipientConfigured = configuredRecipient !== null;
    if (!current) {
      return RecoveryStatusSchema.parse({
        version: null,
        publicRecipientConfigured,
        computerDownloadConfirmedAt: null,
        escrowVerifiedAt: null,
        cloudCopyAccountIds: [],
        deletionUnlocked: false,
      });
    }

    const copies = this.db
      .prepare(
        `SELECT c.account_id AS accountId
         FROM recovery_cloud_copies c
         JOIN storage_accounts a ON a.id = c.account_id
         WHERE c.version = ? AND c.verification_status = 'VERIFIED'
           AND c.bundle_sha256 = ? AND c.escrow_sha256 = ?
           AND a.health = 'HEALTHY'
           AND (a.circuit_open_until IS NULL OR a.circuit_open_until <= ?)
         ORDER BY c.account_id`,
      )
      .all(current.version, current.bundleSha256, current.escrowSha256, this.now()) as Array<{
      accountId: string;
    }>;
    const cloudCopyAccountIds = copies.map((copy) => copy.accountId);
    const computerConfirmed =
      current.computerConfirmedAt !== null &&
      current.computerConfirmedSha256 === current.bundleSha256;
    const escrowVerified =
      current.passphraseVerifiedAt !== null &&
      current.passphraseVerifiedSha256 === current.escrowSha256;
    const recipientMatchesCurrentExport = configuredRecipient === current.publicRecipient;
    const generationMatchesCurrentExport =
      configured?.recipientGeneration === current.recipientGeneration;

    return RecoveryStatusSchema.parse({
      version: current.version,
      publicRecipientConfigured,
      computerDownloadConfirmedAt: computerConfirmed ? current.computerConfirmedAt : null,
      escrowVerifiedAt: escrowVerified ? current.passphraseVerifiedAt : null,
      cloudCopyAccountIds,
      deletionUnlocked:
        publicRecipientConfigured &&
        recipientMatchesCurrentExport &&
        generationMatchesCurrentExport &&
        cloudCopyAccountIds.length >= 2 &&
        computerConfirmed &&
        escrowVerified,
    });
  }
}
