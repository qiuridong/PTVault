// Scheduled recovery-backup orchestrator.
//
// This wires the pieces that already exist (SQLite online backup +
// RecoveryBundleService) into a single, safe, idempotent scheduled run:
//   1. take an online SQLite backup (never a raw file copy of a live WAL DB),
//   2. build the current recovery bundle source from it,
//   3. generate + verify the encrypted bundle into the configured accounts,
//   4. ONLY THEN prune remote versions beyond current + configured history.
//
// Every effect is injected via BackupDeps so the whole thing is testable in
// memory and never spawns a real process, touches a real remote, or arms any
// production mutation. Pruning is fail-safe: if generation throws, nothing is
// pruned, and if the current version is not present in the version list we
// keep everything.

import type { RecoveryBundleSource } from '../recovery/bundle.js';

export type GeneratedBundle = {
  version: number;
  bundlePath: string;
  bundleSha256: string;
  escrowSha256: string;
  accountIds: string[];
};

export type BackupDeps = {
  /** Take a consistent online SQLite backup to `destination` and return its bytes. */
  onlineBackup: (destination: string) => Promise<Buffer>;
  /** Assemble the recovery bundle source (rclone config, mapping, manifest) around the DB bytes. */
  buildBundleSource: (databaseBackup: Buffer) => Promise<RecoveryBundleSource>;
  /** Generate + verify the encrypted bundle into the destination accounts. */
  generateBundle: (input: {
    destinationAccountIds: readonly string[];
    source: RecoveryBundleSource;
    encryptedEscrow: Uint8Array;
    signal: AbortSignal;
  }) => Promise<GeneratedBundle>;
  /** The most recent passphrase-encrypted escrow to re-copy alongside the bundle. */
  latestEscrow: () => Promise<Uint8Array>;
  /** All completed export versions, any order (planner sorts newest-first). */
  listExportVersions: () => number[];
  /** Remove one remote recovery version. Only ever called after the new bundle is verified. */
  pruneRemoteVersion: (version: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
};

export type BackupConfig = {
  destinationAccountIds: readonly string[];
  /** How many prior versions to retain in addition to the current one. */
  historyDepth: number;
};

export type PrunePlan = {
  retain: number[];
  prune: number[];
};

export type PruneInput = {
  versions: number[];
  currentVersion: number;
  historyDepth: number;
};

// Decide which recovery versions to keep and which to prune. Newest-first.
// Fail-safe rules:
//   - if the current version is not in the list, keep everything (prune nothing);
//   - always keep the current version, even with a zero history depth.
export function planVersionPrune(input: PruneInput): PrunePlan {
  const sorted = [...input.versions].sort((left, right) => right - left);

  if (!sorted.includes(input.currentVersion)) {
    return { retain: sorted, prune: [] };
  }

  const keepCount = Math.max(1, input.historyDepth + 1);
  const retain = sorted.slice(0, keepCount);
  const prune = sorted.slice(keepCount);
  return { retain, prune };
}

export class ScheduledBackupService {
  private readonly deps: BackupDeps;
  private readonly config: BackupConfig;
  private inFlight: Promise<GeneratedBundle> | null = null;

  constructor(deps: BackupDeps, config: BackupConfig) {
    const distinct = new Set(config.destinationAccountIds);
    if (distinct.size < 2) {
      throw new Error('BACKUP_REQUIRES_TWO_DESTINATIONS');
    }
    this.deps = deps;
    this.config = config;
  }

  async run(signal: AbortSignal): Promise<GeneratedBundle> {
    // A single scheduled run at a time. A second concurrent call joins the
    // first instead of taking a duplicate online backup.
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.execute(signal);
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async execute(signal: AbortSignal): Promise<GeneratedBundle> {
    const stamp = this.deps.now();
    const backupBytes = await this.deps.onlineBackup(`.backup-${stamp}.db`);
    const source = await this.deps.buildBundleSource(backupBytes);
    const encryptedEscrow = await this.deps.latestEscrow();

    // Generate + verify FIRST. If this throws, we never reach the prune step,
    // so an older good version is never removed before a newer verified one
    // exists.
    const generated = await this.deps.generateBundle({
      destinationAccountIds: this.config.destinationAccountIds,
      source,
      encryptedEscrow,
      signal,
    });

    const plan = planVersionPrune({
      versions: this.deps.listExportVersions(),
      currentVersion: generated.version,
      historyDepth: this.config.historyDepth,
    });
    for (const version of plan.prune) {
      await this.deps.pruneRemoteVersion(version, signal);
    }

    return generated;
  }
}
