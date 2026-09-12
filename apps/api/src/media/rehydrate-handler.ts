import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { QbRepository } from '../qb/repository.js';
import type { QbControl, QbControlRegistry } from '../qb/types.js';
import type { CacheGovernor } from './cache.js';
import type { MediaCatalog } from './catalog.js';
import type { RehydrateMachine, RehydrateWorkState } from './rehydrate-machine.js';

export const RehydratePayloadSchema = z.object({
  jobId: z.string().uuid(),
});

/** How long to wait for qB to finish rechecking before giving up. */
export const RECHECK_TIMEOUT_MS = 30 * 60 * 1000;

/** Seconds between recheck polls once the recheck is known to be under way. */
export const RECHECK_POLL_MS = 2000;

/** Polling interval while still waiting for the recheck to *start*. */
export const RECHECK_OBSERVE_POLL_MS = 250;

/**
 * How many polls to keep looking for evidence the recheck ran before accepting a
 * torrent that has read complete the whole time.
 *
 * Counted in attempts rather than milliseconds so the bound holds under an injected
 * clock as well as a real one. At the observe interval this is about ten seconds.
 */
export const RECHECK_OBSERVE_ATTEMPTS = Math.ceil(10_000 / RECHECK_OBSERVE_POLL_MS);

/** A clock deadline plus this bound prevents a stopped clock from spinning forever. */
export const RECHECK_MAX_ATTEMPTS =
  RECHECK_OBSERVE_ATTEMPTS + Math.ceil(RECHECK_TIMEOUT_MS / RECHECK_POLL_MS) + 1;

/** Extra space reserved beyond the manifest, for filesystem overhead and slack. */
export const TEMP_OVERHEAD_FRACTION = 0.02;

export type RehydrateFile = {
  relativePath: string;
  sha256: string;
  size: number;
  /** Live storage authority owning the remote object. */
  accountId: string;
  /** The verified remote object to pull from. */
  remotePath: string;
};

export type RehydratePlan = {
  files: RehydrateFile[];
  contentKind: 'FILE' | 'DIRECTORY';
  destination: string;
};

export type RehydrateRclone = {
  /** Copies a remote object to a local path. */
  copyTo(remotePath: string, localPath: string, signal: AbortSignal): Promise<void>;
};

export type RehydrateHandlerOptions = {
  machine: RehydrateMachine;
  governor: Pick<CacheGovernor, 'reserve' | 'release' | 'activeReservationBytes'>;
  rclone: RehydrateRclone;
  registry: Pick<QbControlRegistry, 'get'>;
  torrentRepository: Pick<QbRepository, 'setCloudState'>;
  catalog: Pick<MediaCatalog, 'setLocalHot'>;
  refreshFarm: () => Promise<void>;
  /** Where restored torrents live, e.g. `/data/downloads`. */
  hotRoot: string;
  readFreeBytes: () => Promise<number>;
  loadPlan: (input: { instanceId: string; torrentHash: string }) => RehydratePlan | null;
  /** Rechecked immediately before and after every provider-backed copy. */
  assertAccountEligible: (accountId: string) => void;
  /**
   * Whether releasing VFS cache could free space on the hot root.
   *
   * False whenever the cache lives on another filesystem, which is the reference
   * deployment's layout. Absent means unknown, and unknown is treated as false: a
   * job that says an operator must add space is recoverable by doing exactly that,
   * while one parked in EVICTING_CACHE waits for something that may never run.
   */
  canEvictForHotRoot?: () => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

type ActiveRun = {
  controller: AbortController;
  done: Promise<void>;
};

/**
 * Pulls a migrated torrent back to local disk and resumes its seed.
 *
 * Every durable step is resumable. The temp root is one explicit filesystem
 * object (`FILE` or `DIRECTORY`), so the install is always one atomic rename and
 * never depends on guessing from the first manifest path.
 */
export class RehydrateHandler {
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(private readonly options: RehydrateHandlerOptions) {
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
  }

  async run(payload: unknown, workerSignal: AbortSignal): Promise<void> {
    const parsed = RehydratePayloadSchema.safeParse(payload);
    if (!parsed.success) throw new Error('REHYDRATE_PAYLOAD_INVALID');
    const { jobId } = parsed.data;
    if (this.activeRuns.has(jobId)) throw new Error('REHYDRATE_ALREADY_RUNNING');

    const cancelController = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.activeRuns.set(jobId, { controller: cancelController, done });
    const combined = combineSignals(workerSignal, cancelController.signal);

    try {
      const initial = this.options.machine.workState(jobId);
      if (!initial) throw new Error('REHYDRATE_NOT_FOUND');
      if (initial.cancelledAt !== null) {
        await this.cleanupCancelled(jobId);
        return;
      }
      await this.resume(initial, combined.signal);
    } catch (error) {
      const current = this.options.machine.workState(jobId);
      if (current?.cancelledAt !== null) {
        await this.cleanupCancelled(jobId);
        return;
      }

      // Once installed, the bytes occupy real disk space and the durable
      // reservation must no longer double-count them, even if qB/farm follow-up
      // failed. Before install the claim remains with the retryable temp tree.
      if (current?.installedAt !== null) this.options.governor.release(jobId);
      if (current) {
        this.options.torrentRepository.setCloudState(
          current.instanceId,
          current.torrentHash,
          'BLOCKED',
        );
      }
      throw error;
    } finally {
      combined.dispose();
      if (this.activeRuns.get(jobId)?.controller === cancelController) {
        this.activeRuns.delete(jobId);
      }
      finish();
    }
  }

  /** Cancels an uninstalled job, aborting an active copy before cleaning its temp tree. */
  async cancel(jobId: string): Promise<{ cancelled: true; localPreserved: true }> {
    const current = this.options.machine.workState(jobId);
    if (!current) throw new Error('REHYDRATE_NOT_FOUND');
    const result =
      current.cancelledAt === null
        ? this.options.machine.requestCancel(jobId)
        : ({ cancelled: true, localPreserved: true } as const);
    const active = this.activeRuns.get(jobId);
    if (active) {
      active.controller.abort(new Error('REHYDRATE_CANCELLED'));
      await active.done;
      if (this.options.machine.workState(jobId)?.jobState !== 'CANCELLED_SAFE') {
        throw new Error('REHYDRATE_CANCEL_CLEANUP_FAILED');
      }
    } else {
      await this.cleanupCancelled(jobId);
    }
    return result;
  }

  private async resume(initial: RehydrateWorkState, signal: AbortSignal): Promise<void> {
    const plan = this.options.loadPlan({
      instanceId: initial.instanceId,
      torrentHash: initial.torrentHash,
    });
    if (!plan) throw new Error('REHYDRATE_PLAN_NOT_FOUND');
    assertPlan(plan);

    const manifestBytes = plan.files.reduce((sum, file) => sum + file.size, 0);
    if (!Number.isSafeInteger(manifestBytes)) throw new Error('REHYDRATE_MANIFEST_TOO_LARGE');
    const requiredBytes = manifestBytes + Math.ceil(manifestBytes * TEMP_OVERHEAD_FRACTION);
    const temporaryDirectory = this.temporaryDirectory(initial);
    const temporaryContent = path.join(temporaryDirectory, 'content');

    this.options.torrentRepository.setCloudState(
      initial.instanceId,
      initial.torrentHash,
      'REHYDRATING',
    );

    let snapshot = initial;
    while (snapshot.currentStep !== 'COMPLETED') {
      this.throwIfCancelled(snapshot.jobId, signal);
      switch (snapshot.currentStep) {
        case 'RESERVING_SPACE':
        case 'EVICTING_CACHE':
          snapshot = await this.reserveAndAdvance(snapshot, requiredBytes, temporaryDirectory);
          break;

        case 'DOWNLOADING_TEMP':
          await this.ensureReservation(snapshot, requiredBytes, temporaryDirectory);
          await this.downloadPlan(plan, temporaryDirectory, temporaryContent, signal);
          snapshot = this.requireWork(
            this.options.machine.transition(snapshot.jobId, 'DOWNLOADING_TEMP', 'VERIFYING_LOCAL')
              .jobId,
          );
          break;

        case 'VERIFYING_LOCAL':
          await this.ensureReservation(snapshot, requiredBytes, temporaryDirectory);
          // Reaching this step means a prior process may have stopped after some
          // files landed. Re-copy only missing/mismatched files, then verify all.
          await this.verifyPlan(plan, temporaryContent, signal, true);
          snapshot = this.requireWork(
            this.options.machine.transition(snapshot.jobId, 'VERIFYING_LOCAL', 'INSTALLING_LOCAL')
              .jobId,
          );
          break;

        case 'INSTALLING_LOCAL': {
          // If rename already succeeded before a crash, the destination itself is
          // the evidence. Do not demand a second reservation for bytes already on
          // disk; verify them and persist installed_at instead.
          if (!(await pathExists(plan.destination))) {
            await this.ensureReservation(snapshot, requiredBytes, temporaryDirectory);
          }
          await this.installOrRecover(plan, temporaryContent, signal);
          snapshot = this.requireWork(
            this.options.machine.transition(snapshot.jobId, 'INSTALLING_LOCAL', 'QB_RECHECKING', {
              installedAt: this.now(),
            }).jobId,
          );
          await this.publishLocalCopy(snapshot);
          break;
        }

        case 'QB_RECHECKING': {
          await this.publishLocalCopy(snapshot);
          const control = this.options.registry.get(snapshot.instanceId);
          await control.forceRecheck(snapshot.torrentHash);
          await this.waitForRecheck(control, snapshot.torrentHash, signal);
          snapshot = this.requireWork(
            this.options.machine.transition(snapshot.jobId, 'QB_RECHECKING', 'QB_RESUMING').jobId,
          );
          break;
        }

        case 'QB_RESUMING': {
          await this.publishLocalCopy(snapshot);
          const control = this.options.registry.get(snapshot.instanceId);
          if (snapshot.autoResume) await control.resume(snapshot.torrentHash);
          // Set before the terminal transition. If the process stops between the
          // two, retrying QB_RESUMING is idempotent and repairs the snapshot.
          this.options.torrentRepository.setCloudState(
            snapshot.instanceId,
            snapshot.torrentHash,
            'LOCAL',
          );
          snapshot = this.requireWork(
            this.options.machine.transition(snapshot.jobId, 'QB_RESUMING', 'COMPLETED').jobId,
          );
          await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
          break;
        }
      }
    }
  }

  private async reserveAndAdvance(
    snapshot: RehydrateWorkState,
    requiredBytes: number,
    temporaryDirectory: string,
  ): Promise<RehydrateWorkState> {
    const reservation = await this.acquireReservation(snapshot.jobId, requiredBytes);
    if (!reservation.reserved) {
      // Only park in EVICTING_CACHE when giving cache back could actually free space
      // where the restore needs it. On a deployment whose VFS cache sits on a
      // different filesystem from the hot root — the reference machine's does, cache
      // on the system disk and media on the data disk — evicting every cached byte
      // frees nothing here. Parking there anyway names a recovery that cannot
      // happen, and the operator reads a job waiting on a process that will never
      // run instead of one waiting on them to add space.
      const evictionCanHelp = await this.canEvictForHotRoot();
      if (evictionCanHelp && snapshot.currentStep === 'RESERVING_SPACE') {
        this.options.machine.transition(snapshot.jobId, 'RESERVING_SPACE', 'EVICTING_CACHE', {
          blockedMissingBytes: reservation.missingBytes,
        });
      } else {
        this.options.machine.updateFields(snapshot.jobId, snapshot.currentStep, {
          blockedMissingBytes: reservation.missingBytes,
        });
      }
      // Retrying either step re-reads free space, so a retry still succeeds once
      // space appears. The distinct code is what says where it has to come from.
      throw new Error(
        evictionCanHelp
          ? 'REHYDRATE_INSUFFICIENT_SPACE'
          : 'REHYDRATE_INSUFFICIENT_SPACE_NO_RECLAIM',
      );
    }

    return this.requireWork(
      this.options.machine.transition(snapshot.jobId, snapshot.currentStep, 'DOWNLOADING_TEMP', {
        reservedBytes: requiredBytes,
        blockedMissingBytes: null,
        tempDirectory: temporaryDirectory,
      }).jobId,
    );
  }

  /** Never throws: an unreadable path is not a reason to fail a restore differently. */
  private async canEvictForHotRoot(): Promise<boolean> {
    if (!this.options.canEvictForHotRoot) return false;
    try {
      return await this.options.canEvictForHotRoot();
    } catch {
      return false;
    }
  }

  private async ensureReservation(
    snapshot: RehydrateWorkState,
    requiredBytes: number,
    temporaryDirectory: string,
  ): Promise<void> {
    const active = this.options.governor.activeReservationBytes(snapshot.jobId);
    if (active !== null && active >= requiredBytes) return;
    const reservation = await this.acquireReservation(snapshot.jobId, requiredBytes);
    if (!reservation.reserved) {
      this.options.machine.updateFields(snapshot.jobId, snapshot.currentStep, {
        blockedMissingBytes: reservation.missingBytes,
      });
      throw new Error('REHYDRATE_INSUFFICIENT_SPACE');
    }
    this.options.machine.updateFields(snapshot.jobId, snapshot.currentStep, {
      reservedBytes: requiredBytes,
      blockedMissingBytes: null,
      tempDirectory: temporaryDirectory,
    });
  }

  private async acquireReservation(
    jobId: string,
    requiredBytes: number,
  ): Promise<{ reserved: true } | { reserved: false; missingBytes: number }> {
    return this.options.governor.reserve({
      jobId,
      kind: 'REHYDRATE',
      bytes: requiredBytes,
      freeBytes: await this.options.readFreeBytes(),
    });
  }

  private async downloadPlan(
    plan: RehydratePlan,
    temporaryDirectory: string,
    temporaryContent: string,
    signal: AbortSignal,
  ): Promise<void> {
    await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
    if (plan.contentKind === 'DIRECTORY') {
      await mkdir(temporaryContent, { recursive: true, mode: 0o700 });
    }
    for (const file of plan.files) {
      this.throwIfCancelledBySignal(signal);
      const target = contentFilePath(plan, temporaryContent, file);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      this.options.assertAccountEligible(file.accountId);
      await this.options.rclone.copyTo(file.remotePath, target, signal);
      this.options.assertAccountEligible(file.accountId);
    }
  }

  private async verifyPlan(
    plan: RehydratePlan,
    temporaryContent: string,
    signal: AbortSignal,
    repair: boolean,
  ): Promise<void> {
    for (const file of plan.files) {
      const target = contentFilePath(plan, temporaryContent, file);
      try {
        await verifyFile(target, file, signal);
      } catch (error) {
        if (!repair || signal.aborted || !isRepairableVerificationError(error)) throw error;
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        this.options.assertAccountEligible(file.accountId);
        await this.options.rclone.copyTo(file.remotePath, target, signal);
        this.options.assertAccountEligible(file.accountId);
        await verifyFile(target, file, signal);
      }
    }
  }

  private async installOrRecover(
    plan: RehydratePlan,
    temporaryContent: string,
    signal: AbortSignal,
  ): Promise<void> {
    this.throwIfCancelledBySignal(signal);
    await this.assertDestinationParent(plan.destination);
    if (await pathExists(plan.destination)) {
      // Crash window: rename completed, but installed_at did not. Hashing the
      // destination closes that window without overwriting or deleting anything.
      await verifyContent(plan, plan.destination, signal);
      return;
    }
    await assertRootKind(temporaryContent, plan.contentKind, 'REHYDRATE_TEMP_ROOT_INVALID');
    await rename(temporaryContent, plan.destination);
  }

  private async publishLocalCopy(snapshot: RehydrateWorkState): Promise<void> {
    // Actual local bytes now consume the filesystem; keeping the logical claim as
    // well would double-count the restore and block unrelated work indefinitely.
    this.options.governor.release(snapshot.jobId);
    this.options.catalog.setLocalHot({
      instanceId: snapshot.instanceId,
      torrentHash: snapshot.torrentHash,
      localHot: true,
    });
    await this.options.refreshFarm();
  }

  private async cleanupCancelled(jobId: string): Promise<void> {
    const current = this.options.machine.workState(jobId);
    if (!current) throw new Error('REHYDRATE_NOT_FOUND');
    try {
      await rm(this.temporaryDirectory(current), { recursive: true, force: true });
    } catch (error) {
      throw new Error('REHYDRATE_CANCEL_CLEANUP_FAILED', { cause: error });
    }
    this.options.governor.release(jobId);
    this.options.machine.finalizeCancellation(jobId);
  }

  private temporaryDirectory(snapshot: RehydrateWorkState): string {
    const expected = path.resolve(this.options.hotRoot, '.ptvault-rehydrate', snapshot.jobId);
    if (snapshot.tempDirectory !== null && path.resolve(snapshot.tempDirectory) !== expected) {
      throw new Error('REHYDRATE_TEMP_DIRECTORY_MISMATCH');
    }
    return expected;
  }

  private async assertDestinationParent(destination: string): Promise<void> {
    const resolvedDestination = path.resolve(destination);
    const resolvedHotRoot = path.resolve(this.options.hotRoot);
    const destinationRelative = path.relative(resolvedHotRoot, resolvedDestination);
    if (
      destinationRelative === '' ||
      destinationRelative === '..' ||
      destinationRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(destinationRelative)
    ) {
      throw new Error('REHYDRATE_DESTINATION_OUTSIDE_HOT_ROOT');
    }

    const parent = path.dirname(resolvedDestination);
    const parentStats = await lstat(parent);
    if (!parentStats.isDirectory()) throw new Error('REHYDRATE_DESTINATION_PARENT_NOT_DIR');
    if (parentStats.isSymbolicLink()) throw new Error('REHYDRATE_DESTINATION_PARENT_SYMLINK');
    const canonicalHotRoot = await realpath(resolvedHotRoot);
    const canonicalParent = await realpath(parent);
    const parentRelative = path.relative(canonicalHotRoot, canonicalParent);
    if (
      parentRelative === '..' ||
      parentRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(parentRelative)
    ) {
      throw new Error('REHYDRATE_DESTINATION_PARENT_ESCAPES');
    }
  }

  private requireWork(jobId: string): RehydrateWorkState {
    const snapshot = this.options.machine.workState(jobId);
    if (!snapshot) throw new Error('REHYDRATE_NOT_FOUND');
    return snapshot;
  }

  private throwIfCancelled(jobId: string, signal: AbortSignal): void {
    this.throwIfCancelledBySignal(signal);
    if (this.requireWork(jobId).cancelledAt !== null) throw new Error('REHYDRATE_CANCELLED');
  }

  private throwIfCancelledBySignal(signal: AbortSignal): void {
    if (!signal.aborted) return;
    throw cancellationError(signal);
  }

  private async waitForRecheck(
    control: QbControl,
    hash: string,
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = this.now() + RECHECK_TIMEOUT_MS;
    // Whether qB has been seen actually rechecking, as opposed to still reporting
    // what it believed before the recheck was asked for.
    let observed = false;
    for (let attempt = 0; attempt < RECHECK_MAX_ATTEMPTS; attempt += 1) {
      if (this.now() >= deadline) break;
      this.throwIfCancelledBySignal(signal);

      // Sleep *before* the first poll. `forceRecheck` only queues the recheck, and
      // after an offload the state qB has cached is `progress: 1` and paused —
      // cleanup deleted the files and only tagged the torrent, it never told qB the
      // data was gone. A poll issued in the same breath therefore reads that stale
      // figure, matches the completion test below, and returns before a single byte
      // has been hashed; the caller then resumes, announcing data qB never confirmed.
      await this.sleep(observed ? RECHECK_POLL_MS : RECHECK_OBSERVE_POLL_MS, signal);

      const torrent = (await control.list()).find(
        (candidate) => candidate.hash.toLowerCase() === hash.toLowerCase(),
      );
      if (!torrent) throw new Error('REHYDRATE_TORRENT_NOT_ON_INSTANCE');

      // Evidence the recheck really ran: qB is either hashing now, or has already
      // dropped the completion figure it was carrying.
      if (torrent.state === 'CHECKING' || torrent.progress < 1) observed = true;

      // Both conditions: `progress` alone can read 1 while qB is still checking, and
      // resuming mid-check announces data qB has not finished confirming.
      if (torrent.progress < 1 || torrent.state === 'CHECKING') continue;

      // Complete — accept once the recheck was seen, or once it has read complete
      // across the whole observation window. A torrent small enough to recheck
      // between two polls has already been rechecked, and qB drains this queue in
      // far less than that window. Holding out for an observation that can no longer
      // arrive would strand the job instead, and strand it with the bytes already
      // installed, which is worse than the uncertainty it would be guarding against.
      if (observed || attempt >= RECHECK_OBSERVE_ATTEMPTS) return;
    }
    throw new Error('REHYDRATE_RECHECK_TIMEOUT');
  }
}

function assertPlan(plan: RehydratePlan): void {
  if (plan.files.length === 0) throw new Error('REHYDRATE_MANIFEST_EMPTY');
  if (!path.isAbsolute(plan.destination)) throw new Error('REHYDRATE_DESTINATION_NOT_ABSOLUTE');
  if (plan.destination.includes('\0')) throw new Error('REHYDRATE_DESTINATION_INVALID');
  if (plan.contentKind === 'FILE' && plan.files.length !== 1) {
    throw new Error('REHYDRATE_FILE_ROOT_MULTIPLE_FILES');
  }
  for (const file of plan.files) {
    relativeSegments(file.relativePath);
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      throw new Error('REHYDRATE_FILE_SIZE_INVALID');
    }
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('REHYDRATE_FILE_HASH_INVALID');
  }
  if (
    plan.contentKind === 'FILE' &&
    plan.files[0]?.relativePath !== path.posix.basename(plan.destination)
  ) {
    throw new Error('REHYDRATE_FILE_ROOT_PATH_MISMATCH');
  }
}

function contentFilePath(plan: RehydratePlan, contentRoot: string, file: RehydrateFile): string {
  if (plan.contentKind === 'FILE') return contentRoot;
  const candidate = path.resolve(contentRoot, ...relativeSegments(file.relativePath));
  const relative = path.relative(path.resolve(contentRoot), candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('REHYDRATE_MANIFEST_PATH_ESCAPES');
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
    throw new Error('REHYDRATE_MANIFEST_PATH_INVALID');
  }
  return relativePath.split('/');
}

async function verifyContent(
  plan: RehydratePlan,
  contentRoot: string,
  signal: AbortSignal,
): Promise<void> {
  await assertRootKind(contentRoot, plan.contentKind, 'REHYDRATE_INSTALLED_ROOT_INVALID');
  for (const file of plan.files) {
    await verifyFile(contentFilePath(plan, contentRoot, file), file, signal);
  }
}

async function assertRootKind(
  contentRoot: string,
  kind: 'FILE' | 'DIRECTORY',
  code: string,
): Promise<void> {
  const stats = await lstat(contentRoot);
  if (stats.isSymbolicLink()) throw new Error(code);
  if (kind === 'FILE' ? !stats.isFile() : !stats.isDirectory()) throw new Error(code);
}

async function verifyFile(
  absolutePath: string,
  file: RehydrateFile,
  signal: AbortSignal,
): Promise<void> {
  let stats;
  try {
    stats = await lstat(absolutePath);
  } catch {
    throw new Error('REHYDRATE_TEMP_FILE_MISSING');
  }
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('REHYDRATE_TEMP_FILE_INVALID');
  if (stats.size !== file.size) throw new Error('REHYDRATE_SIZE_MISMATCH');
  if ((await hashFile(absolutePath, signal)) !== file.sha256) {
    throw new Error('REHYDRATE_HASH_MISMATCH');
  }
}

function isRepairableVerificationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === 'REHYDRATE_TEMP_FILE_MISSING' ||
      error.message === 'REHYDRATE_SIZE_MISMATCH' ||
      error.message === 'REHYDRATE_HASH_MISMATCH')
  );
}

async function hashFile(absolutePath: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(absolutePath, { signal });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch {
    return false;
  }
}

function combineSignals(
  first: AbortSignal,
  second: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abortFrom = (source: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  const firstAbort = (): void => abortFrom(first);
  const secondAbort = (): void => abortFrom(second);
  if (first.aborted) abortFrom(first);
  else first.addEventListener('abort', firstAbort, { once: true });
  if (second.aborted) abortFrom(second);
  else second.addEventListener('abort', secondAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      first.removeEventListener('abort', firstAbort);
      second.removeEventListener('abort', secondAbort);
    },
  };
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(cancellationError(signal));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error && signal.reason.message === 'REHYDRATE_CANCELLED'
    ? signal.reason
    : new Error('REHYDRATE_CANCELLED');
}
