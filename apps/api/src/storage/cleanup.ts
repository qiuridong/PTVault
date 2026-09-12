import { lstat, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';

import { DeletionPermitSchema, type DeletionPermit } from '@ptvault/contracts';

import { isPathWithinRoot } from '../core/paths.js';
import type { AppDatabase } from '../db/database.js';
import type { RecoveryPreparationCoordinator } from '../recovery/preparation-coordinator.js';
import type { CloudState, QbRepository } from '../qb/repository.js';
import type { QbControlRegistry } from '../qb/types.js';
import type { OffloadMachine } from './offload-machine.js';
import { hasVerifiedPrimaryForEveryFile } from './replica-guard.js';

/**
 * Answers whether an absolute path is currently being read by a downstream
 * consumer (Jellyfin/mount). Deletion is refused while playback is active. The
 * production graph supplies a fail-closed Jellyfin probe; tests may supply a fake.
 */
export type PlaybackProbe = {
  isActive(absolutePath: string): Promise<boolean>;
};

/**
 * Publishes the cloud view of a torrent whose local copy has just been deleted.
 *
 * Must not resolve until what it published is actually readable, and throwing is
 * how it says otherwise — cleanup turns that into `CLEANUP_FOLLOW_UP_PENDING`
 * instead of final success. The first production cleanup is why this is stated
 * here rather than left to the implementation: the mounts cache directory
 * listings for 72 hours with polling disabled, the previous implementation only
 * rebuilt the symlink farm, and a link to a blob prefix the mount had never listed
 * answered ENOENT while the deletion reported COMPLETED.
 *
 * Takes the torrent, not paths. The old signature passed the local content root,
 * which is the one thing that no longer exists once this runs; the identity is
 * what the catalog and the farm are keyed by.
 */
export type MountRefresh = {
  refresh(torrent: { instanceId: string; torrentHash: string }): Promise<void>;
};

/** Marks the catalog local copy absent before the farm is refreshed. */
export type CatalogCleanup = {
  setLocalHot(input: { instanceId: string; torrentHash: string; localHot: boolean }): void;
};

/** The minimal recovery-status surface cleanup needs to re-check the deletion gate. */
export type CleanupRecoveryProbe = {
  currentStatus(): CleanupReadinessStatus | Promise<CleanupReadinessStatus>;
};
type CleanupReadinessStatus = {
  version: number | null;
  deletionUnlocked: boolean;
  baselineRevision?: number | undefined;
  materialRevision?: number | undefined;
};

export type CleanupServiceOptions = {
  preparationCoordinator?: RecoveryPreparationCoordinator;
  db: AppDatabase;
  machine: OffloadMachine;
  recovery: CleanupRecoveryProbe;
  registry: QbControlRegistry;
  torrentRepository: Pick<QbRepository, 'setCloudState'>;
  playback?: PlaybackProbe;
  catalog?: CatalogCleanup;
  refresh?: MountRefresh;
  now?: () => number;
};

type CleanupResultBase = {
  /** Cleanup entered its deletion phase; local bytes may already be partly gone. */
  localDeletionStarted: true;
  deleted: number;
};

export type CleanupResult = CleanupResultBase &
  (
    | {
        localDeleted: true;
        completed: true;
        followUpPending: false;
        warningCode: null;
      }
    | {
        localDeleted: true;
        completed: false;
        followUpPending: true;
        warningCode: 'CLEANUP_FOLLOW_UP_PENDING';
      }
    | {
        localDeleted: false;
        completed: false;
        followUpPending: true;
        warningCode: 'CLEANUP_PARTIAL_LOCAL_DELETION';
      }
  );

type StoredSnapshotRow = {
  contentRoot: string | null;
  contentRootKind: 'FILE' | 'DIRECTORY' | null;
  sourceDevice: bigint | null;
  sourceInode: bigint | null;
  instanceId: string;
  torrentHash: string;
  currentStep: string;
};

type StoredFileRow = {
  relativePath: string;
  device: bigint;
  inode: bigint;
  size: bigint;
  mtimeNs: bigint;
  deletedAt: bigint | null;
};

type PlannedDeletion = {
  relativePath: string;
  absolutePath: string;
};

type ValidationResult = {
  plan: PlannedDeletion[];
  missing: StoredFileRow[];
  error?: unknown;
};

/**
 * The deletion lifeline. `clean` reloads every piece of evidence, refuses to
 * touch disk unless the deletion gate is still unlocked at the same recovery
 * version the permit was issued against, every manifest file has a verified
 * primary replica, and the job has reached CLOUD_COMMITTED (or LOCAL_CLEANUP on
 * resume). It then validates each surviving file against its recorded identity
 * without following symlinks, and only unlinks exact snapshot matches. Any
 * anomaly found during the full preflight — path escape, identity drift,
 * symlink swap, new external hardlink, or active playback — aborts before a
 * single unlink. Deletes are recorded per file so a crash or later anomaly can
 * be reported as partial cleanup and resumes only the paths that still survive.
 */
export class CleanupService {
  private readonly now: () => number;

  constructor(private readonly options: CleanupServiceOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  async clean(jobId: string, permit: DeletionPermit, signal: AbortSignal): Promise<CleanupResult> {
    const release = this.options.preparationCoordinator?.acquireRead();
    try {
      return await this.cleanLeased(jobId, permit, signal);
    } finally {
      release?.();
    }
  }

  private async cleanLeased(
    jobId: string,
    permit: DeletionPermit,
    signal: AbortSignal,
  ): Promise<CleanupResult> {
    this.throwIfAborted(signal);

    const parsedPermit = DeletionPermitSchema.safeParse(permit);
    if (!parsedPermit.success) throw new Error('CLEANUP_PERMIT_INVALID');
    // API-C1: the permit is bound to the job it was issued for. Reject a permit
    // minted for a different job so one job's permit can never authorize
    // deleting another job's local files.
    if (parsedPermit.data.jobId !== jobId) throw new Error('CLEANUP_PERMIT_JOB_MISMATCH');

    const snapshot = this.readSnapshot(jobId);
    if (snapshot.currentStep !== 'CLOUD_COMMITTED' && snapshot.currentStep !== 'LOCAL_CLEANUP') {
      throw new Error('CLEANUP_NOT_CLOUD_COMMITTED');
    }

    // LOCAL_CLEANUP is the crash-resume boundary. It cannot prove whether a
    // prior process stopped immediately before or after unlink, so once this
    // marker exists no later error may claim or imply that the source is intact.
    let deletionObserved = snapshot.currentStep === 'LOCAL_CLEANUP';
    let deleted = 0;

    try {
      const status = await this.options.recovery.currentStatus();
      if (
        !status.deletionUnlocked ||
        status.version !== parsedPermit.data.recoveryVersion ||
        (status.baselineRevision !== undefined &&
          status.baselineRevision !== parsedPermit.data.baselineRevision) ||
        (status.materialRevision !== undefined &&
          status.materialRevision !== parsedPermit.data.materialRevision)
      ) {
        throw new Error('CLEANUP_RECOVERY_VERSION_CHANGED');
      }

      if (!hasVerifiedPrimaryForEveryFile(this.options.db, jobId)) {
        throw new Error('CLEANUP_PRIMARY_NOT_VERIFIED');
      }

      if (!snapshot.contentRoot) throw new Error('CLEANUP_CONTENT_ROOT_MISSING');
      const contentRoot = snapshot.contentRoot;

      const files = this.readFiles(jobId);
      if (files.length === 0) throw new Error('CLEANUP_MANIFEST_EMPTY');
      const contentRootKind = resolveContentRootKind(snapshot, files);

      const survivors = files.filter((file) => file.deletedAt === null);
      deletionObserved ||= survivors.length !== files.length;
      const validation = await this.validateAndPlan(
        contentRoot,
        contentRootKind,
        snapshot,
        survivors,
        signal,
        snapshot.currentStep === 'LOCAL_CLEANUP' || deletionObserved,
      );

      // A process can die after unlink succeeds but before deleted_at is written.
      // On a LOCAL_CLEANUP resume, an already-missing snapshot path is therefore
      // reconciled as absent instead of being reported as if the local tree were
      // still intact. This only records absence; it never authorizes a new unlink.
      if (validation.missing.length > 0) {
        deletionObserved = true;
        this.recordDeletedFiles(jobId, validation.missing);
      }

      if (validation.error !== undefined) {
        if (snapshot.currentStep === 'LOCAL_CLEANUP') return this.partialResult(deleted);
        throw asError(validation.error);
      }
      const plan = validation.plan;

      // Validate the *whole* surviving manifest before moving the state marker or
      // unlinking anything. A failed playback/identity/hardlink check therefore
      // leaves the job at CLOUD_COMMITTED and the operator can retry after fixing
      // the condition. LOCAL_CLEANUP is also safe to retry when the marker was
      // written just before a crash.
      if (snapshot.currentStep === 'CLOUD_COMMITTED') {
        this.options.machine.transition(jobId, 'CLOUD_COMMITTED', 'LOCAL_CLEANUP');
        deletionObserved = true;
      }

      const touchedDirectories = new Set<string>();
      for (const target of plan) {
        this.throwIfAborted(signal);
        // Re-confirm identity immediately before unlink: the file must still be
        // the exact snapshot inode and no parent component may have become a
        // symlink since planning.
        const stored = survivors.find((file) => file.relativePath === target.relativePath);
        if (!stored) throw new Error('CLEANUP_PLAN_STALE');
        await this.assertSafeTraversal(contentRoot, contentRootKind, snapshot, stored.relativePath);
        await this.assertExactMatch(target.absolutePath, stored);
        await unlink(target.absolutePath);

        // From this point on, bubbling a generic error would falsely suggest the
        // local bytes are intact. Count the unlink before persisting its evidence
        // so even an SQLite failure is returned as partial local deletion.
        deletionObserved = true;
        deleted += 1;
        touchedDirectories.add(path.dirname(target.absolutePath));
        this.recordDeletedFiles(jobId, [stored]);
      }

      if (!this.isDeletionPersisted(jobId)) throw new Error('CLEANUP_DELETE_RECORD_INCOMPLETE');

      let followUpPending = false;

      // Every manifest path is now absent with durable evidence. The remaining
      // operations are non-destructive follow-up, so failures return a retryable
      // warning while clearly stating that local deletion is already complete.
      try {
        await this.pruneEmptyDirectories(contentRoot, touchedDirectories);
      } catch {
        followUpPending = true;
      }

      // Keep the torrent paused; only tag it, flip its cloud state, and publish the
      // cloud view in its place. Never resume — the local data is gone.
      try {
        const control = this.options.registry.get(snapshot.instanceId);
        await control.addTag(snapshot.torrentHash, 'ptvault:cloud');
      } catch {
        followUpPending = true;
      }
      try {
        this.options.torrentRepository.setCloudState(
          snapshot.instanceId,
          snapshot.torrentHash,
          'CLOUD' satisfies CloudState,
        );
        this.options.catalog?.setLocalHot({
          instanceId: snapshot.instanceId,
          torrentHash: snapshot.torrentHash,
          localHot: false,
        });
      } catch {
        followUpPending = true;
      }
      try {
        await this.options.refresh?.refresh({
          instanceId: snapshot.instanceId,
          torrentHash: snapshot.torrentHash,
        });
      } catch {
        followUpPending = true;
      }

      if (!followUpPending) {
        try {
          this.options.machine.transition(jobId, 'LOCAL_CLEANUP', 'COMPLETED', {
            cleanupCompleted: true,
          });
        } catch {
          followUpPending = true;
        }
      }

      return followUpPending
        ? {
            localDeletionStarted: true,
            localDeleted: true,
            completed: false,
            deleted,
            followUpPending: true,
            warningCode: 'CLEANUP_FOLLOW_UP_PENDING',
          }
        : {
            localDeletionStarted: true,
            localDeleted: true,
            completed: true,
            deleted,
            followUpPending: false,
            warningCode: null,
          };
    } catch (error) {
      if (deletionObserved || isMissingSource(error)) return this.partialResult(deleted);
      throw error;
    }
  }

  /**
   * Validates every surviving file against its recorded identity without
   * following symlinks and returns the exact set to unlink. Throws before any
   * deletion if a path escapes the root, drifted, became a symlink, grew a new
   * external hardlink, or is being played back.
   */
  private async validateAndPlan(
    contentRoot: string,
    contentRootKind: 'FILE' | 'DIRECTORY',
    snapshot: StoredSnapshotRow,
    survivors: readonly StoredFileRow[],
    signal: AbortSignal,
    allowMissing: boolean,
  ): Promise<ValidationResult> {
    const knownPathsPerInode = new Map<string, number>();
    for (const file of survivors) {
      const key = inodeKey(file);
      knownPathsPerInode.set(key, (knownPathsPerInode.get(key) ?? 0) + 1);
    }

    const plan: PlannedDeletion[] = [];
    const missing: StoredFileRow[] = [];
    for (const file of survivors) {
      try {
        this.throwIfAborted(signal);
        const absolutePath = resolveWithinRoot(contentRoot, contentRootKind, file.relativePath);

        let stats;
        try {
          await this.assertSafeTraversal(contentRoot, contentRootKind, snapshot, file.relativePath);
          stats = await this.assertExactMatch(absolutePath, file);
        } catch (error) {
          if (allowMissing && isMissingSource(error)) {
            missing.push(file);
            continue;
          }
          throw error;
        }

        const knownPaths = knownPathsPerInode.get(inodeKey(file)) ?? 1;
        if (stats.nlink > BigInt(Math.max(1, knownPaths))) {
          throw new Error('EXTERNAL_HARDLINK');
        }

        if (!this.options.playback) throw new Error('PLAYBACK_PROBE_UNAVAILABLE');
        if (await this.options.playback.isActive(absolutePath)) {
          throw new Error('PLAYBACK_ACTIVE');
        }

        plan.push({ relativePath: file.relativePath, absolutePath });
      } catch (error) {
        return { plan: [], missing, error };
      }
    }
    return { plan, missing };
  }

  /** Rejects a replaced root or any symlink introduced below a directory root. */
  private async assertSafeTraversal(
    contentRoot: string,
    contentRootKind: 'FILE' | 'DIRECTORY',
    snapshot: StoredSnapshotRow,
    relativePath: string,
  ): Promise<void> {
    if (contentRootKind === 'FILE') return;

    const rootStats = await lstatSource(contentRoot);
    if (
      rootStats.isSymbolicLink() ||
      !rootStats.isDirectory() ||
      (snapshot.sourceDevice !== null && rootStats.dev !== snapshot.sourceDevice) ||
      (snapshot.sourceInode !== null && rootStats.ino !== snapshot.sourceInode)
    ) {
      throw new Error('SOURCE_CHANGED');
    }

    const segments = relativeSegments(relativePath);
    let current = contentRoot;
    for (const segment of segments.slice(0, -1)) {
      current = path.join(current, segment);
      const stats = await lstatSource(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('SOURCE_CHANGED');
    }
  }

  private recordDeletedFiles(jobId: string, files: readonly StoredFileRow[]): void {
    if (files.length === 0) return;
    const record = this.options.db.prepare(
      `UPDATE offload_files SET deleted_at = ?
       WHERE job_id = ? AND relative_path = ? AND deleted_at IS NULL`,
    );
    this.options.db.transaction(() => {
      const timestamp = this.now();
      for (const file of files) {
        const updated = record.run(timestamp, jobId, file.relativePath);
        if (updated.changes !== 1) throw new Error('CLEANUP_DELETE_RECORD_CONFLICT');
      }
    })();
  }

  private isDeletionPersisted(jobId: string): boolean {
    const counts = this.options.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted
         FROM offload_files WHERE job_id = ?`,
      )
      .get(jobId) as { total: number; deleted: number | null };
    return counts.total > 0 && counts.total === (counts.deleted ?? 0);
  }

  private partialResult(deleted: number): CleanupResult {
    return {
      localDeletionStarted: true,
      localDeleted: false,
      completed: false,
      deleted,
      followUpPending: true,
      warningCode: 'CLEANUP_PARTIAL_LOCAL_DELETION',
    };
  }

  /** lstat (never follows symlinks) and require an exact dev/ino/size/mtime match. */
  private async assertExactMatch(
    absolutePath: string,
    stored: StoredFileRow,
  ): Promise<{ nlink: bigint }> {
    let stats;
    try {
      stats = await lstat(absolutePath, { bigint: true });
    } catch (error: unknown) {
      throw new Error('SOURCE_CHANGED', { cause: error });
    }
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error('SOURCE_CHANGED');
    if (
      stats.dev !== stored.device ||
      stats.ino !== stored.inode ||
      stats.size !== stored.size ||
      stats.mtimeNs !== stored.mtimeNs
    ) {
      throw new Error('SOURCE_CHANGED');
    }
    return { nlink: stats.nlink };
  }

  /** rmdir only now-empty directories beneath the content root, deepest first, never recursive. */
  private async pruneEmptyDirectories(
    contentRoot: string,
    touched: ReadonlySet<string>,
  ): Promise<void> {
    const candidates = [...touched]
      .filter((directory) => directory !== contentRoot && isPathWithinRoot(directory, contentRoot))
      .sort((left, right) => right.length - left.length);
    for (const directory of candidates) {
      try {
        await rmdir(directory);
      } catch {
        // Non-empty or already gone: leave it. Never force, never recurse.
      }
    }
  }

  private readSnapshot(jobId: string): StoredSnapshotRow {
    const row = this.options.db
      .prepare(
        `SELECT canonical_content_root AS contentRoot, content_root_kind AS contentRootKind,
                source_device AS sourceDevice, source_inode AS sourceInode,
                instance_id AS instanceId,
                torrent_hash AS torrentHash, current_step AS currentStep
         FROM offload_snapshots WHERE job_id = ?`,
      )
      .safeIntegers()
      .get(jobId) as StoredSnapshotRow | undefined;
    if (!row) throw new Error('OFFLOAD_NOT_FOUND');
    return row;
  }

  private readFiles(jobId: string): StoredFileRow[] {
    return this.options.db
      .prepare(
        `SELECT relative_path AS relativePath, device, inode, size,
                mtime_ns AS mtimeNs, deleted_at AS deletedAt
         FROM offload_files WHERE job_id = ? ORDER BY relative_path`,
      )
      .safeIntegers()
      .all(jobId) as StoredFileRow[];
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('CLEANUP_ABORTED');
    }
  }
}

function resolveWithinRoot(
  contentRoot: string,
  contentRootKind: 'FILE' | 'DIRECTORY',
  relativePath: string,
): string {
  const segments = relativeSegments(relativePath);
  if (contentRootKind === 'FILE') {
    if (segments.length !== 1 || segments[0] !== path.basename(contentRoot)) {
      throw new Error('CLEANUP_FILE_ROOT_PATH_MISMATCH');
    }
    return contentRoot;
  }

  const candidate = path.resolve(contentRoot, ...segments);
  if (candidate !== contentRoot && !isPathWithinRoot(candidate, contentRoot)) {
    throw new Error('PATH_OUTSIDE_ROOT');
  }
  return candidate;
}

function relativeSegments(relativePath: string): string[] {
  if (
    relativePath.length === 0 ||
    relativePath.includes('\0') ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath === '..' ||
    relativePath.startsWith('../')
  ) {
    throw new Error('PATH_OUTSIDE_ROOT');
  }
  return relativePath.split('/');
}

function resolveContentRootKind(
  snapshot: StoredSnapshotRow,
  files: readonly StoredFileRow[],
): 'FILE' | 'DIRECTORY' {
  if (snapshot.contentRootKind !== null) return snapshot.contentRootKind;
  if (
    snapshot.contentRoot !== null &&
    files.length === 1 &&
    files[0]?.relativePath === path.basename(snapshot.contentRoot)
  ) {
    return 'FILE';
  }
  return 'DIRECTORY';
}

async function lstatSource(candidate: string) {
  try {
    return await lstat(candidate, { bigint: true });
  } catch (error: unknown) {
    throw new Error('SOURCE_CHANGED', { cause: error });
  }
}

function inodeKey(file: StoredFileRow): string {
  return `${file.device}:${file.inode}`;
}

function isMissingSource(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
  if (error.message !== 'SOURCE_CHANGED') return false;
  const cause = error.cause;
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('CLEANUP_FAILED', { cause: error });
}
