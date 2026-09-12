import {
  RecoveryStatusSchema,
  type RecoveryReadinessProblem,
  type RecoveryStatus,
} from '@ptvault/contracts';

import type { AppDatabase } from '../db/database.js';
import type { RecoveryPreparationCoordinator } from './preparation-coordinator.js';
import type { RecoveryMaterialObserver } from './preparation-material.js';
import type { RecoveryPreparationStore, PreparationState } from './preparation-state.js';
import type { RecoveryRepository } from './repository.js';

export type RecoveryReadiness = Pick<RecoveryReadinessService, 'currentStatus'>;

type Options = {
  db: AppDatabase;
  repository: RecoveryRepository;
  store: RecoveryPreparationStore;
  coordinator: RecoveryPreparationCoordinator;
  observer: Pick<RecoveryMaterialObserver, 'read'>;
  now?: () => number;
  readOnly?: boolean;
};

/** All runtime readiness consumers share this asynchronous, material-aware projection. */
export class RecoveryReadinessService {
  constructor(private readonly options: Options) {}

  async currentStatus(): Promise<RecoveryStatus> {
    let release: () => void;
    try {
      release = this.options.coordinator.acquireRead();
    } catch {
      return this.project(this.options.store.get(), null, ['MATERIAL_UPDATE_IN_PROGRESS']);
    }
    try {
      const before = this.options.store.get();
      let sha256: string | null = null;
      const problems: RecoveryReadinessProblem[] = [];
      if (before.escrowState === 'UPDATING') problems.push('MATERIAL_UPDATE_IN_PROGRESS');
      else if (before.escrowState === 'UNRESOLVED') problems.push('MATERIAL_UNRESOLVED');
      else {
        try {
          sha256 = (await this.options.observer.read()).sha256;
        } catch {
          problems.push('ESCROW_UNAVAILABLE');
        }
      }
      const after = this.options.store.get();
      if (
        after.baselineRevision !== before.baselineRevision ||
        after.materialRevision !== before.materialRevision ||
        after.escrowState !== before.escrowState ||
        after.activeEscrowSha256 !== before.activeEscrowSha256
      ) {
        return this.project(after, null, ['STATE_CHANGED']);
      }
      return this.project(after, sha256, problems);
    } finally {
      release();
    }
  }

  private project(
    state: PreparationState,
    actualSha256: string | null,
    problems: RecoveryReadinessProblem[],
  ): RecoveryStatus {
    const { db, repository } = this.options;
    const current =
      state.baselineVersion === null ? null : repository.getExport(state.baselineVersion);
    const configured = db
      .prepare(
        'SELECT public_recipient AS recipient, recipient_generation AS generation FROM recovery_settings WHERE id = 1',
      )
      .get() as { recipient: string; generation: number } | undefined;
    const common = {
      version: state.baselineVersion,
      baselineRevision: state.baselineRevision,
      materialRevision: state.materialRevision,
      latestSnapshotVersion: repository.currentExport()?.version ?? null,
      publicRecipientConfigured: configured !== undefined,
      escrowConfigured:
        state.escrowState === 'STABLE' &&
        actualSha256 !== null &&
        actualSha256 === state.activeEscrowSha256,
    };
    if (this.options.readOnly) problems.push('COMPATIBILITY_READ_ONLY');
    if (
      !current ||
      current.completedAt === null ||
      current.bundleSha256 === null ||
      current.escrowSha256 === null
    ) {
      return RecoveryStatusSchema.parse({
        ...common,
        computerDownloadConfirmedAt: null,
        escrowVerifiedAt: null,
        cloudCopyAccountIds: [],
        deletionUnlocked: false,
        readinessProblems: [...new Set([...problems, 'NO_BASELINE'])],
      });
    }
    if (configured?.recipient !== current.publicRecipient) problems.push('RECIPIENT_CHANGED');
    if (configured?.generation !== current.recipientGeneration) problems.push('GENERATION_CHANGED');
    if (problems.length === 0 || actualSha256 !== null) {
      if (state.escrowState !== 'STABLE' || actualSha256 === null)
        problems.push('ESCROW_UNAVAILABLE');
      else if (actualSha256 !== state.activeEscrowSha256 || actualSha256 !== current.escrowSha256)
        problems.push('ESCROW_CHANGED');
    }
    const computerConfirmed =
      current.computerConfirmedAt !== null &&
      current.computerConfirmedSha256 === current.bundleSha256;
    const drillConfirmed =
      current.passphraseVerifiedAt !== null &&
      current.passphraseVerifiedSha256 === current.escrowSha256;
    if (!computerConfirmed) problems.push('COMPUTER_NOT_CONFIRMED');
    if (!drillConfirmed) problems.push('DRILL_NOT_CONFIRMED');
    const copies = db
      .prepare(
        `SELECT c.account_id AS accountId FROM recovery_cloud_copies c
      JOIN storage_accounts a ON a.id = c.account_id
      WHERE c.version = ? AND c.verification_status = 'VERIFIED' AND c.bundle_sha256 = ? AND c.escrow_sha256 = ?
      AND a.health = 'HEALTHY' AND (a.circuit_open_until IS NULL OR a.circuit_open_until <= ?) ORDER BY c.account_id`,
      )
      .all(
        current.version,
        current.bundleSha256,
        current.escrowSha256,
        (this.options.now ?? Date.now)(),
      ) as Array<{ accountId: string }>;
    if (copies.length < 2) problems.push('CLOUD_COPY_QUORUM');
    return RecoveryStatusSchema.parse({
      ...common,
      computerDownloadConfirmedAt: computerConfirmed ? current.computerConfirmedAt : null,
      escrowVerifiedAt: drillConfirmed ? current.passphraseVerifiedAt : null,
      cloudCopyAccountIds: copies.map((copy) => copy.accountId),
      deletionUnlocked: problems.length === 0,
      readinessProblems: [...new Set(problems)],
    });
  }
}
