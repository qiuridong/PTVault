import { Sha256Schema } from '@ptvault/contracts';

import type { AppDatabase } from '../db/database.js';

export type PreparationState = {
  baselineVersion: number | null;
  baselineRevision: number;
  selectedAt: number | null;
  selectedBy: string | null;
  selectionSource: 'NONE' | 'MIGRATION_APPROVED' | 'USER';
  bootstrapPending: boolean;
  materialRevision: number;
  activeEscrowSha256: string | null;
  escrowState: 'UNINITIALIZED' | 'STABLE' | 'UPDATING' | 'UNRESOLVED';
  pendingEscrowSha256: string | null;
  pendingOperationId: string | null;
  updatedAt: number;
};

export type BaselineSelection = {
  version: number;
  bundleSha256: string;
  escrowSha256: string;
  adminId: string;
  expectedBaselineRevision: number;
  expectedMaterialRevision: number;
};

/** Synchronous transactions only. Async file observation belongs to readiness. */
export class RecoveryPreparationStore {
  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  get(): PreparationState {
    const row = this.db
      .prepare(
        `SELECT baseline_export_version AS baselineVersion,
      baseline_revision AS baselineRevision, baseline_selected_at AS selectedAt,
      baseline_selected_by_admin_id AS selectedBy, baseline_selection_source AS selectionSource,
      baseline_bootstrap_pending AS bootstrapPending, material_revision AS materialRevision,
      active_escrow_sha256 AS activeEscrowSha256, escrow_update_state AS escrowState,
      pending_escrow_sha256 AS pendingEscrowSha256, pending_operation_id AS pendingOperationId,
      updated_at AS updatedAt FROM recovery_preparation_state WHERE id = 1`,
      )
      .get() as
      (Omit<PreparationState, 'bootstrapPending'> & { bootstrapPending: number }) | undefined;
    if (!row) throw new Error('RECOVERY_PREPARATION_STATE_MISSING');
    return { ...row, bootstrapPending: row.bootstrapPending === 1 };
  }

  bootstrap(input: Omit<BaselineSelection, 'expectedMaterialRevision'>): PreparationState {
    return this.db
      .transaction(() => {
        const current = this.get();
        if (
          !current.bootstrapPending ||
          current.baselineVersion !== null ||
          current.baselineRevision !== 0 ||
          input.expectedBaselineRevision !== 0
        ) {
          throw new Error('RECOVERY_BASELINE_BOOTSTRAP_UNAVAILABLE');
        }
        this.assertIdentity(input, true);
        this.writeSelection(input, 'MIGRATION_APPROVED');
        return this.get();
      })
      .immediate();
  }

  select(input: BaselineSelection): PreparationState {
    return this.db
      .transaction(() => {
        const current = this.get();
        if (
          current.baselineRevision !== input.expectedBaselineRevision ||
          current.materialRevision !== input.expectedMaterialRevision
        ) {
          throw new Error('RECOVERY_PREPARATION_STALE');
        }
        this.assertIdentity(input, false);
        if (current.baselineVersion !== input.version) this.writeSelection(input, 'USER');
        return this.get();
      })
      .immediate();
  }

  /** Only explicit startup initialization may register existing on-disk material. */
  initializeEscrow(sha256: string): void {
    Sha256Schema.parse(sha256);
    const result = this.db
      .prepare(
        `UPDATE recovery_preparation_state SET active_escrow_sha256 = ?,
      escrow_update_state = 'STABLE', updated_at = ? WHERE id = 1 AND escrow_update_state = 'UNINITIALIZED'`,
      )
      .run(sha256, this.now());
    if (result.changes !== 1) throw new Error('RECOVERY_ESCROW_ALREADY_INITIALIZED');
  }

  advanceMaterialRevision(expectedMaterialRevision: number): void {
    const changed = this.db
      .prepare(
        `UPDATE recovery_preparation_state SET material_revision = material_revision + 1,
      updated_at = ? WHERE id = 1 AND material_revision = ? AND escrow_update_state IN ('UNINITIALIZED', 'STABLE')`,
      )
      .run(this.now(), expectedMaterialRevision);
    if (changed.changes !== 1) throw new Error('RECOVERY_PREPARATION_STALE');
  }

  beginEscrowUpdate(input: {
    expectedMaterialRevision: number;
    escrowSha256: string;
    operationId: string;
  }): PreparationState {
    Sha256Schema.parse(input.escrowSha256);
    if (!input.operationId || input.operationId.length > 128)
      throw new Error('RECOVERY_MATERIAL_OPERATION_INVALID');
    return this.db
      .transaction(() => {
        const current = this.get();
        if (current.materialRevision !== input.expectedMaterialRevision)
          throw new Error('RECOVERY_PREPARATION_STALE');
        if (current.escrowState === 'UPDATING' || current.escrowState === 'UNRESOLVED')
          throw new Error('RECOVERY_MATERIAL_UPDATE_PENDING');
        this.db
          .prepare(
            `UPDATE recovery_preparation_state SET escrow_update_state = 'UPDATING',
        pending_escrow_sha256 = ?, pending_operation_id = ?, material_revision = material_revision + 1,
        updated_at = ? WHERE id = 1`,
          )
          .run(input.escrowSha256, input.operationId, this.now());
        return this.get();
      })
      .immediate();
  }

  /** Caller supplies a protected observation, never the requested hash as assumed evidence. */
  resolveEscrowUpdate(
    operationId: string,
    actualSha256: string | null,
  ): 'OLD' | 'NEW' | 'UNRESOLVED' {
    if (actualSha256 !== null) Sha256Schema.parse(actualSha256);
    return this.db
      .transaction(() => {
        const current = this.get();
        if (
          (current.escrowState !== 'UPDATING' && current.escrowState !== 'UNRESOLVED') ||
          current.pendingOperationId !== operationId ||
          current.pendingEscrowSha256 === null
        ) {
          throw new Error('RECOVERY_MATERIAL_OPERATION_MISMATCH');
        }
        const result =
          actualSha256 !== null && actualSha256 === current.pendingEscrowSha256
            ? 'NEW'
            : actualSha256 !== null && actualSha256 === current.activeEscrowSha256
              ? 'OLD'
              : 'UNRESOLVED';
        if (result === 'UNRESOLVED') {
          this.db
            .prepare(
              "UPDATE recovery_preparation_state SET escrow_update_state = 'UNRESOLVED', updated_at = ? WHERE id = 1",
            )
            .run(this.now());
        } else {
          this.db
            .prepare(
              `UPDATE recovery_preparation_state SET escrow_update_state = 'STABLE', active_escrow_sha256 = ?,
          pending_escrow_sha256 = NULL, pending_operation_id = NULL, updated_at = ? WHERE id = 1`,
            )
            .run(actualSha256, this.now());
        }
        return result;
      })
      .immediate();
  }

  private assertIdentity(
    input: Omit<BaselineSelection, 'expectedMaterialRevision'>,
    requireProofs: boolean,
  ): void {
    if (
      !Number.isSafeInteger(input.version) ||
      input.version < 1 ||
      input.adminId.length < 1 ||
      input.adminId.length > 128
    ) {
      throw new Error('RECOVERY_BASELINE_INVALID');
    }
    Sha256Schema.parse(input.bundleSha256);
    Sha256Schema.parse(input.escrowSha256);
    const row = this.db
      .prepare(
        `SELECT completed_at, bundle_sha256, escrow_sha256,
      computer_confirmed_at, computer_confirmed_sha256, passphrase_verified_at, passphrase_verified_sha256
      FROM recovery_exports WHERE version = ?`,
      )
      .get(input.version) as
      | {
          completed_at: number | null;
          bundle_sha256: string | null;
          escrow_sha256: string | null;
          computer_confirmed_at: number | null;
          computer_confirmed_sha256: string | null;
          passphrase_verified_at: number | null;
          passphrase_verified_sha256: string | null;
        }
      | undefined;
    if (
      !row ||
      row.completed_at === null ||
      row.bundle_sha256 !== input.bundleSha256 ||
      row.escrow_sha256 !== input.escrowSha256
    ) {
      throw new Error('RECOVERY_EXPORT_IDENTITY_MISMATCH');
    }
    if (
      requireProofs &&
      (row.computer_confirmed_at === null ||
        row.computer_confirmed_sha256 !== row.bundle_sha256 ||
        row.passphrase_verified_at === null ||
        row.passphrase_verified_sha256 !== row.escrow_sha256)
    ) {
      throw new Error('RECOVERY_BASELINE_PROOFS_REQUIRED');
    }
  }

  private writeSelection(
    input: Omit<BaselineSelection, 'expectedMaterialRevision'>,
    source: 'USER' | 'MIGRATION_APPROVED',
  ): void {
    this.db
      .prepare(
        `UPDATE recovery_preparation_state SET baseline_export_version = ?,
      baseline_revision = baseline_revision + 1, baseline_selected_at = ?,
      baseline_selected_by_admin_id = ?, baseline_selection_source = ?, baseline_bootstrap_pending = 0,
      updated_at = ? WHERE id = 1`,
      )
      .run(input.version, this.now(), input.adminId, source, this.now());
  }
}
