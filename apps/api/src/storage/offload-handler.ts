import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import type {
  OffloadResourceWait,
  OffloadSnapshot,
  TorrentIdentity,
  TorrentPreflight,
} from '@ptvault/contracts';

import { randomUUID } from 'node:crypto';

import type { Readable } from 'node:stream';

import type { SecretBox } from '../core/crypto.js';
import type { AppDatabase } from '../db/database.js';
import { normalizeTorrentState } from '../qb/client.js';
import type { QbRepository } from '../qb/repository.js';
import type { QbControl, QbControlRegistry } from '../qb/types.js';
import type { RecoveryGate } from '../recovery/gate.js';
import type { StorageAccountRepository } from './accounts.js';
import {
  LIBRARY_BLOB_ROOT,
  blobRelativePath,
  libraryBlobPath,
  stagingBlobPath,
} from './blob-path.js';
import { hashStableFile, snapshotSourceFiles, type StableFileIdentity } from './manifest.js';
import type { OffloadMachine } from './offload-machine.js';
import { OffloadTelemetryReporter } from './offload-telemetry.js';
import type { ProcessResult } from './process-runner.js';
import { OffloadResourceScheduler, type SemaphoreObserver } from './resource-scheduler.js';
import type { RcloneProgressCallback } from './rclone.js';
import { StrictRemoteVerifier, type VerifiableFile } from './verify.js';

export type OffloadPreflight = {
  check(identity: TorrentIdentity): Promise<TorrentPreflight>;
};

/**
 * The crypt-remote surface the handler needs across the whole pipeline: `copy`
 * stages a local file, `stat`/`cat` power the strict decrypted readback, and
 * `move` promotes a verified staging object into the library prefix. All calls
 * speak to a crypt remote; no plaintext path leaves the local machine.
 */
export type StagingRclone = {
  copy(
    source: string,
    destination: string,
    signal: AbortSignal,
    onProgress?: RcloneProgressCallback,
  ): Promise<void>;
  move(source: string, destination: string, signal: AbortSignal): Promise<void>;
  deleteFile?(remotePath: string, signal: AbortSignal): Promise<void>;
  stat(remotePath: string, signal?: AbortSignal): Promise<{ size: number; name: string } | null>;
  cat(
    remotePath: string,
    signal: AbortSignal,
  ): { stream: Readable; completed: Promise<ProcessResult> };
};

/**
 * How long to keep waiting for qB to actually stop the torrent.
 *
 * This was 20 attempts at 25 ms — about **one second** including round trips —
 * and a 12.95 GiB 2160p torrent failed against it in production: qB had to flush
 * and close the files and write fastresume, and reported the stop well after the
 * window shut. The torrent *did* stop; the job had already given up and gone
 * FAILED_SAFE.
 *
 * The mistake was the same one behind the recheck race (`6cff38f`): **qB's
 * commands are queued, not synchronous.** Both places read back a state qB had
 * not reached yet, one giving up too early and the other accepting too early.
 *
 * A generous bound is close to free here. Nothing is deleted while waiting, and
 * failing safe costs only a retry — so the cost of waiting a minute is far below
 * the cost of abandoning a migration that was about to succeed. The hot pool is a
 * mechanical disk carrying PT traffic, so a slow stop is normal, not a fault.
 */
export const PAUSE_TIMEOUT_MS = 60_000;

/** Interval between pause polls. `list()` returns every torrent, so twice a second. */
export const PAUSE_POLL_MS = 500;

/** Consecutive paused readings required before the state is believed. */
export const PAUSE_STABLE_OBSERVATIONS = 2;

/** A clock deadline plus this bound prevents a stopped clock from spinning forever. */
export const PAUSE_MAX_ATTEMPTS = Math.ceil(PAUSE_TIMEOUT_MS / PAUSE_POLL_MS) + 1;

export type OffloadHandlerOptions = {
  db: AppDatabase;
  machine: OffloadMachine;
  preflight: OffloadPreflight;
  registry: QbControlRegistry;
  torrentRepository: QbRepository;
  recoveryGate: Pick<RecoveryGate, 'issueDeletionPermit'>;
  accounts: StorageAccountRepository;
  rclone: StagingRclone;
  secretBox: SecretBox;
  /**
   * Queues the second cloud copy once the primary is committed and verified.
   *
   * Optional so tests and the pilot CLI can omit it. When absent, a committed
   * offload simply has no secondary — which is the pre-existing behaviour, not a
   * regression, since deletion has never depended on the secondary.
   */
  onCommitted?: (snapshot: OffloadSnapshot) => void;
  /**
   * Records the title in the media catalog, inside the commit transaction.
   *
   * Inside rather than after, unlike `onCommitted`: the catalog row is what maps a
   * verified replica back to a path a media server can identify, and the mapping
   * exists nowhere else — `ptvault.db` losing it means "the bytes are safe but
   * nothing knows which blob is which title". Committing replicas without it would
   * leave that gap open between the two writes.
   *
   * Optional for the same reason as above: the pilot CLI and most tests have no
   * media surface configured.
   */
  catalogRecorder?: CatalogRecorder;
  now?: () => number;
  /**
   * Injectable delay, so a test can exercise the real polling window without
   * spending it. Defaults to a genuine abortable timer.
   */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  resources?: OffloadResourceScheduler;
  maxPausedPipelines?: number | (() => number);
  monotonicNow?: () => number;
};

/**
 * Records a committed title in the media catalog.
 *
 * A narrow port rather than the `MediaCatalog` class: the offload handler should
 * not learn where media lives on disk, and this keeps the hot-root arithmetic on
 * the media side where the rest of it already is.
 */
export type CatalogRecorder = {
  record(input: {
    instanceId: string;
    torrentHash: string;
    /** Canonical absolute path of the torrent's content on local disk. */
    contentRoot: string;
    /** Account holding the verified primary replica. */
    accountId: string;
  }): void;
};

type StoredFile = {
  relativePath: string;
  device: bigint;
  inode: bigint;
  size: bigint;
  allocatedBytes: bigint;
  mtimeNs: bigint;
  sha256: string | null;
  uploadStatus: 'PENDING' | 'STAGED' | 'VERIFIED' | 'FAILED';
  verificationStatus: 'PENDING' | 'VERIFIED' | 'FAILED';
};

type StoredSnapshot = {
  exportedTorrentEncrypted: string | null;
  canonicalContentRoot: string | null;
  contentRootKind: 'FILE' | 'DIRECTORY' | null;
  sourceDevice: bigint | null;
  sourceInode: bigint | null;
  sourceSize: bigint | null;
  sourceMtimeNs: bigint | null;
  selectedAccountId: string | null;
  stagingPrefix: string | null;
  recoveryVersion: bigint | null;
};

export class OffloadHandler {
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly resources: OffloadResourceScheduler;
  private readonly maxPausedPipelines: () => number;

  constructor(private readonly options: OffloadHandlerOptions) {
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? abortableDelay;
    this.resources =
      options.resources ??
      new OffloadResourceScheduler({
        preflightConcurrency: 1,
        pauseSnapshotConcurrency: 1,
        hashConcurrency: 1,
        remoteDataConcurrency: 1,
        metadataConcurrency: 1,
      });
    const configuredMaximum = options.maxPausedPipelines;
    this.maxPausedPipelines =
      typeof configuredMaximum === 'function' ? configuredMaximum : () => configuredMaximum ?? 1;
  }

  async run(jobId: string, signal: AbortSignal): Promise<void> {
    const telemetry = new OffloadTelemetryReporter({
      jobId,
      writer: this.options.machine,
      wallNow: this.now,
      ...(this.options.monotonicNow ? { monotonicNow: this.options.monotonicNow } : {}),
    });
    try {
      this.throwIfCancelled(jobId, signal);
      let snapshot = this.requireSnapshot(jobId);
      if (snapshot.currentStep === 'PREFLIGHT') {
        await this.withObservedResource(jobId, 'PREFLIGHT_SLOT', (observer) =>
          this.resources.withPreflight(
            signal,
            async () => {
              const preflight = await this.options.preflight.check({
                instanceId: snapshot.instanceId,
                hash: snapshot.torrentHash,
              });
              if (!preflight.eligible) throw new Error('OFFLOAD_PREFLIGHT_BLOCKED');
            },
            observer,
          ),
        );
        await this.resources.waitForPausedAdmission(
          signal,
          () =>
            this.options.machine.tryAdmitPausedPipeline(jobId, this.maxPausedPipelines()) !== null,
        );
        snapshot = this.requireSnapshot(jobId);
      }

      // A resumed attempt may reuse completed per-file hashes/uploads, but only
      // after proving the local snapshot still names the exact same bytes and qB
      // still reports the torrent stopped. There is deliberately no qB resume in
      // an operator-pause path.
      if (snapshot.currentStep !== 'PREFLIGHT') {
        await this.revalidateResumeSource(snapshot, signal);
      }

      this.initializeTelemetry(snapshot.jobId, telemetry);
      while (snapshot.currentStep !== 'CLOUD_COMMITTED') {
        this.throwIfCancelled(jobId, signal);
        switch (snapshot.currentStep) {
          case 'PREFLIGHT':
            throw new Error('PAUSED_PIPELINE_ADMISSION_LOST');
          case 'PAUSING':
          case 'SNAPSHOTTING':
            await this.withObservedResource(jobId, 'PAUSE_SNAPSHOT_SLOT', (observer) =>
              this.resources.withPauseSnapshot(
                signal,
                async () => {
                  if (snapshot.currentStep === 'PAUSING') {
                    await this.pauseAndSnapshot(snapshot, signal);
                    snapshot = this.options.machine.transition(jobId, 'PAUSING', 'SNAPSHOTTING');
                  }
                  snapshot = this.options.machine.transition(jobId, 'SNAPSHOTTING', 'HASHING');
                },
                observer,
              ),
            );
            this.initializeTelemetry(snapshot.jobId, telemetry);
            break;
          case 'HASHING':
            this.beginStageTelemetry(jobId, 'HASHING', telemetry);
            await this.withObservedResource(jobId, 'HASH_SLOT', (observer) =>
              this.resources.withHash(
                signal,
                () => this.hashSnapshot(snapshot, signal, telemetry),
                observer,
              ),
            );
            telemetry.completeStage();
            snapshot = this.options.machine.transition(jobId, 'HASHING', 'UPLOADING_STAGING');
            break;
          case 'UPLOADING_STAGING':
            this.beginStageTelemetry(jobId, 'UPLOADING_STAGING', telemetry);
            await this.uploadStaging(snapshot, signal, telemetry);
            telemetry.completeStage();
            snapshot = this.options.machine.transition(jobId, 'UPLOADING_STAGING', 'VERIFYING');
            break;
          case 'VERIFYING':
            this.beginStageTelemetry(jobId, 'VERIFYING', telemetry);
            await this.verifyReadback(snapshot, signal, telemetry);
            telemetry.completeStage();
            snapshot = this.options.machine.transition(jobId, 'VERIFYING', 'FINALIZING_REMOTE');
            break;
          case 'FINALIZING_REMOTE':
            this.beginStageTelemetry(jobId, 'FINALIZING_REMOTE', telemetry);
            await this.finalizeAndCommit(snapshot, signal, telemetry);
            snapshot = this.requireSnapshot(jobId);
            break;
          default:
            return;
        }
      }
    } finally {
      this.clearResourceWait(jobId);
      telemetry.clearActive();
      const final = this.options.machine.get(jobId);
      if (final && (final.cancelledAt !== null || final.currentStep === 'CLOUD_COMMITTED')) {
        this.resources.notifyPausedCapacityChanged();
      }
    }
  }

  private async pauseAndSnapshot(snapshot: OffloadSnapshot, signal: AbortSignal): Promise<void> {
    const existing = this.readStoredSnapshot(snapshot.jobId);
    if (existing.exportedTorrentEncrypted) {
      // Export is downstream of waitForPaused in every historical implementation,
      // so it is safe evidence for a v19 PAUSING row upgraded without qb_paused_at.
      this.options.machine.confirmQbPaused(snapshot.jobId);
    }
    if (
      existing.exportedTorrentEncrypted &&
      existing.canonicalContentRoot &&
      existing.contentRootKind
    ) {
      return;
    }

    // A database upgraded from before content_root_kind may already have the
    // immutable snapshot but not the root shape. While the local source still
    // exists, fill only that missing fact instead of exporting/snapshotting again.
    if (existing.exportedTorrentEncrypted && existing.canonicalContentRoot) {
      const existingRoot = await lstat(existing.canonicalContentRoot);
      const contentRootKind = rootKind(existingRoot);
      this.options.db
        .prepare(
          `UPDATE offload_snapshots SET content_root_kind = ?, updated_at = ?
           WHERE job_id = ? AND content_root_kind IS NULL`,
        )
        .run(contentRootKind, this.now(), snapshot.jobId);
      return;
    }

    const control = this.options.registry.get(snapshot.instanceId);
    await control.pause(snapshot.torrentHash);
    await waitForPaused(control, snapshot.torrentHash, signal, this.sleep, this.now);
    this.options.machine.confirmQbPaused(snapshot.jobId);
    this.throwIfCancelled(snapshot.jobId, signal);

    const exportedTorrent = await control.exportTorrent(snapshot.torrentHash);
    const torrent = this.options.torrentRepository.getTorrent(
      snapshot.instanceId,
      snapshot.torrentHash,
    );
    if (!torrent) throw new Error('TORRENT_NOT_FOUND');
    const contentPath = path.isAbsolute(torrent.contentPath)
      ? path.resolve(torrent.contentPath)
      : path.resolve(torrent.savePath, torrent.contentPath);
    const canonicalRoot = await realpath(contentPath);
    const rootStats = await lstat(canonicalRoot, { bigint: true });
    const contentRootKind = rootKind(rootStats);
    const files = await snapshotSourceFiles(canonicalRoot);
    if (files.length === 0) throw new Error('SOURCE_EMPTY');

    const encryptedTorrent = this.options.secretBox.seal(
      Buffer.from(exportedTorrent).toString('base64'),
    );
    this.options.db.transaction(() => {
      const current = this.readStoredSnapshot(snapshot.jobId);
      if (current.exportedTorrentEncrypted || current.canonicalContentRoot) {
        if (!current.exportedTorrentEncrypted || !current.canonicalContentRoot) {
          throw new Error('OFFLOAD_SNAPSHOT_INCOMPLETE');
        }
        return;
      }
      this.options.db
        .prepare(
          `UPDATE offload_snapshots
           SET exported_torrent_encrypted = ?, canonical_content_root = ?,
               content_root_kind = ?, source_device = ?, source_inode = ?,
               source_size = ?, source_mtime_ns = ?,
               updated_at = ?
           WHERE job_id = ?`,
        )
        .run(
          encryptedTorrent,
          canonicalRoot,
          contentRootKind,
          rootStats.dev,
          rootStats.ino,
          rootStats.size,
          rootStats.mtimeNs,
          this.now(),
          snapshot.jobId,
        );
      const insert = this.options.db.prepare(
        `INSERT INTO offload_files(
           job_id, relative_path, device, inode, size, allocated_bytes, mtime_ns
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const file of files) {
        insert.run(
          snapshot.jobId,
          file.relativePath,
          file.dev,
          file.ino,
          file.size,
          file.allocatedBytes,
          file.mtimeNs,
        );
      }
    })();
  }

  private async hashSnapshot(
    snapshot: OffloadSnapshot,
    signal: AbortSignal,
    telemetry: OffloadTelemetryReporter,
  ): Promise<void> {
    let stored = this.readStoredSnapshot(snapshot.jobId);
    if (!stored.canonicalContentRoot) throw new Error('OFFLOAD_SNAPSHOT_MISSING');
    const contentRoot = stored.canonicalContentRoot;

    if (stored.recoveryVersion === null) {
      const permit = await this.options.recoveryGate.issueDeletionPermit(snapshot.jobId);
      this.options.db
        .prepare(
          `UPDATE offload_snapshots SET recovery_version = ?, updated_at = ?
           WHERE job_id = ? AND recovery_version IS NULL`,
        )
        .run(permit.recoveryVersion, this.now(), snapshot.jobId);
      stored = this.readStoredSnapshot(snapshot.jobId);
    }

    await assertRootIdentity(stored);
    const files = this.listStoredFiles(snapshot.jobId);
    const digestByInode = new Map<string, string>();
    for (const [index, file] of files.entries()) {
      this.throwIfCancelled(snapshot.jobId, signal);
      if (file.sha256) {
        digestByInode.set(inodeKey(file), file.sha256);
        continue;
      }
      telemetry.startFile(file.relativePath, index);
      const absolutePath = await resolveStoredFile(contentRoot, file.relativePath);
      const expected = expectedIdentity(file);
      const key = inodeKey(file);
      const cached = digestByInode.get(key);
      const digest =
        cached ??
        (await hashStableFile(absolutePath, expected, signal, (bytes) => {
          telemetry.addChunk(bytes);
        }));
      if (cached) await assertFileIdentity(absolutePath, expected);
      this.options.db
        .prepare(
          `UPDATE offload_files SET sha256 = ?
           WHERE job_id = ? AND relative_path = ? AND sha256 IS NULL`,
        )
        .run(digest, snapshot.jobId, file.relativePath);
      digestByInode.set(key, digest);
      telemetry.completeFile(file.size);
    }
  }

  private async uploadStaging(
    snapshot: OffloadSnapshot,
    signal: AbortSignal,
    telemetry: OffloadTelemetryReporter,
  ): Promise<void> {
    let stored = this.readStoredSnapshot(snapshot.jobId);
    if (!stored.canonicalContentRoot || stored.recoveryVersion === null) {
      throw new Error('OFFLOAD_MANIFEST_NOT_READY');
    }
    const contentRoot = stored.canonicalContentRoot;
    const files = this.listStoredFiles(snapshot.jobId);
    if (files.some((file) => file.sha256 === null)) throw new Error('OFFLOAD_MANIFEST_NOT_READY');

    if (!stored.selectedAccountId || !stored.stagingPrefix) {
      const requiredBytes = sumSafe(files.map((file) => safeNumber(file.size)));
      const stagingPrefix = `staging/${snapshot.jobId}`;
      this.options.accounts.reserveOffloadCapacity({
        jobId: snapshot.jobId,
        requiredBytes,
        stagingPrefix,
      });
      stored = this.readStoredSnapshot(snapshot.jobId);
    }

    if (!stored.selectedAccountId || !stored.stagingPrefix) {
      throw new Error('OFFLOAD_ACCOUNT_NOT_FOUND');
    }
    const account = this.options.accounts.getEligible(stored.selectedAccountId, 'EXISTING_WORK');

    for (const [index, file] of this.listStoredFiles(snapshot.jobId).entries()) {
      if (file.uploadStatus === 'STAGED' || file.uploadStatus === 'VERIFIED') continue;
      this.throwIfCancelled(snapshot.jobId, signal);
      this.options.accounts.getEligible(account.id, 'EXISTING_WORK');
      if (!file.sha256) throw new Error('OFFLOAD_MANIFEST_NOT_READY');
      const source = await resolveStoredFile(contentRoot, file.relativePath);
      await assertFileIdentity(source, expectedIdentity(file));
      // Content-addressed staging target: the source filename never reaches the
      // remote, so encrypted path length no longer depends on it.
      const destination = `${account.cryptRemote}${stagingBlobPath(stored.stagingPrefix, file.sha256)}`;
      try {
        if (await this.reuseMatchingStagingObject(snapshot.jobId, destination, file, signal)) {
          this.options.accounts.getEligible(account.id, 'EXISTING_WORK');
          this.options.db
            .prepare(
              `UPDATE offload_files SET upload_status = 'STAGED'
               WHERE job_id = ? AND relative_path = ?`,
            )
            .run(snapshot.jobId, file.relativePath);
          telemetry.startFile(file.relativePath, index);
          telemetry.completeFile(file.size);
          continue;
        }
        await this.withObservedRemoteDataResource(
          snapshot.jobId,
          'UPLOAD_SLOT',
          (stageObserver, remoteHeavyObserver) =>
            this.resources.withUpload(
              signal,
              async () => {
                telemetry.startFile(file.relativePath, index);
                await this.options.rclone.copy(source, destination, signal, ({ bytesDone }) => {
                  telemetry.setCurrentFileBytes(BigInt(bytesDone));
                });
                this.options.accounts.getEligible(account.id, 'EXISTING_WORK');
                this.options.db
                  .prepare(
                    `UPDATE offload_files SET upload_status = 'STAGED'
                   WHERE job_id = ? AND relative_path = ?`,
                  )
                  .run(snapshot.jobId, file.relativePath);
                telemetry.completeFile(file.size);
              },
              stageObserver,
              remoteHeavyObserver,
            ),
        );
      } catch (error: unknown) {
        this.options.db
          .prepare(
            `UPDATE offload_files SET upload_status = 'FAILED'
             WHERE job_id = ? AND relative_path = ?`,
          )
          .run(snapshot.jobId, file.relativePath);
        throw error;
      }
    }
  }

  /**
   * Streams every staged object back through the crypt remote and verifies the
   * decrypted size and SHA-256 against the manifest. Any corruption, truncation,
   * wrong crypt password, or missing object throws here — while the step is
   * still VERIFYING and before any staging object is moved — so the local source
   * always survives a verification failure. On success it records the readback
   * evidence on each file independently of its upload status.
   */
  private async verifyReadback(
    snapshot: OffloadSnapshot,
    signal: AbortSignal,
    telemetry: OffloadTelemetryReporter,
  ): Promise<void> {
    const stored = this.readStoredSnapshot(snapshot.jobId);
    if (!stored.stagingPrefix || !stored.selectedAccountId) {
      throw new Error('OFFLOAD_MANIFEST_NOT_READY');
    }
    const account = this.findAccount(stored.selectedAccountId);
    const files = this.listStoredFiles(snapshot.jobId);
    if (files.length === 0) throw new Error('OFFLOAD_MANIFEST_EMPTY');

    const pendingFiles = files.filter((file) => file.verificationStatus !== 'VERIFIED');
    const verifiable: VerifiableFile[] = pendingFiles.map((file) => {
      if (!file.sha256) throw new Error('OFFLOAD_MANIFEST_NOT_READY');
      return {
        relativePath: file.relativePath,
        remoteRelativePath: blobRelativePath(file.sha256),
        size: safeNumber(file.size),
        sha256: file.sha256,
      };
    });

    const verifier = new StrictRemoteVerifier({ rclone: this.options.rclone, now: this.now });
    await verifier.verify(
      { cryptRemote: account.cryptRemote, stagingPrefix: stored.stagingPrefix, files: verifiable },
      signal,
      {
        context: 'STAGING',
        withFile: ({ verify }) =>
          this.withObservedRemoteDataResource(
            snapshot.jobId,
            'READBACK_SLOT',
            (stageObserver, remoteHeavyObserver) =>
              this.resources.withReadback(signal, verify, stageObserver, remoteHeavyObserver),
          ),
        onFileStart: ({ file }) => {
          this.options.accounts.getEligible(account.id, 'EXISTING_WORK');
          telemetry.startFile(
            file.relativePath,
            files.findIndex((candidate) => candidate.relativePath === file.relativePath),
          );
        },
        onChunk: ({ bytes }) => {
          telemetry.addChunk(bytes);
        },
        onFileCompleted: ({ file }) => {
          this.options.accounts.getEligible(account.id, 'EXISTING_WORK');
          this.options.db
            .prepare(
              `UPDATE offload_files SET verification_status = 'VERIFIED'
               WHERE job_id = ? AND relative_path = ?`,
            )
            .run(snapshot.jobId, file.relativePath);
          telemetry.completeFile(BigInt(file.size));
          telemetry.completeReadbackFile('STAGING', BigInt(file.size));
        },
      },
    );
  }

  /**
   * Promotes each verified staging object into the library prefix, re-stats the
   * final path, then in a single transaction records a verified PRIMARY replica
   * for every manifest file and transitions to CLOUD_COMMITTED. The move step is
   * idempotent: a final object that already exists (from an interrupted run) is
   * not moved again. The state-machine transition enforces that every manifest
   * file has a verified primary before the commit is allowed.
   */
  private async finalizeAndCommit(
    snapshot: OffloadSnapshot,
    signal: AbortSignal,
    telemetry: OffloadTelemetryReporter,
  ): Promise<void> {
    const stored = this.readStoredSnapshot(snapshot.jobId);
    if (!stored.stagingPrefix || !stored.selectedAccountId) {
      throw new Error('OFFLOAD_MANIFEST_NOT_READY');
    }
    const stagingPrefix = stored.stagingPrefix;
    const account = this.findAccount(stored.selectedAccountId);
    const files = this.listStoredFiles(snapshot.jobId);
    if (files.length === 0) throw new Error('OFFLOAD_MANIFEST_EMPTY');

    type Placed = { file: StoredFile; logicalPath: string; remotePath: string };
    const placed: Placed[] = await this.resources.withMetadata(signal, async () => {
      const result: Placed[] = [];
      for (const file of files) {
        this.throwIfCancelled(snapshot.jobId, signal);
        this.options.accounts.getEligible(account.id, 'EXISTING_WORK');
        if (!file.sha256) throw new Error('OFFLOAD_MANIFEST_NOT_READY');
        const stagingRemote = `${account.cryptRemote}${stagingBlobPath(stagingPrefix, file.sha256)}`;
        const logicalPath = libraryBlobPath(file.sha256);
        const remotePath = `${account.cryptRemote}${logicalPath}`;

        const alreadyPlaced = await this.options.rclone.stat(remotePath, signal);
        this.options.accounts.getEligible(account.id, 'EXISTING_WORK');
        if (!alreadyPlaced) {
          await this.options.rclone.move(stagingRemote, remotePath, signal);
          this.options.accounts.getEligible(account.id, 'EXISTING_WORK');
        }

        const finalStat = await this.options.rclone.stat(remotePath, signal);
        this.options.accounts.getEligible(account.id, 'EXISTING_WORK');
        if (!finalStat) throw new Error('REPLICA_OBJECT_MISSING');
        if (finalStat.size !== safeNumber(file.size)) throw new Error('REPLICA_SIZE_MISMATCH');
        result.push({ file, logicalPath, remotePath });
      }
      return result;
    });

    // API-H1: re-read and re-hash the *library* objects after the move. The move
    // loop above only size-checks the final path, and it deliberately skips the
    // move when an object already sits there (interrupted-run idempotence) — so a
    // pre-existing wrong-but-right-sized object would otherwise pass unnoticed.
    // Verifying the actual library bytes here keeps the "never delete local
    // before decrypt-readback passes" invariant true for the committed copy, not
    // merely for the staging copy checked in verifyReadback.
    const pendingPlaced = placed.filter(
      ({ file }) => !this.hasMatchingVerifiedPrimary(snapshot, file),
    );
    const verifiable: VerifiableFile[] = pendingPlaced.map(({ file }) => {
      if (!file.sha256) throw new Error('OFFLOAD_MANIFEST_NOT_READY');
      return {
        relativePath: file.relativePath,
        remoteRelativePath: blobRelativePath(file.sha256),
        size: safeNumber(file.size),
        sha256: file.sha256,
      };
    });
    const verifier = new StrictRemoteVerifier({ rclone: this.options.rclone, now: this.now });
    await verifier.verify(
      {
        cryptRemote: account.cryptRemote,
        stagingPrefix: LIBRARY_BLOB_ROOT,
        files: verifiable,
      },
      signal,
      {
        context: 'COMMITTED',
        withFile: ({ verify }) =>
          this.withObservedRemoteDataResource(
            snapshot.jobId,
            'READBACK_SLOT',
            (stageObserver, remoteHeavyObserver) =>
              this.resources.withReadback(signal, verify, stageObserver, remoteHeavyObserver),
          ),
        onFileStart: ({ file }) => {
          this.options.accounts.getEligible(account.id, 'EXISTING_WORK');
          telemetry.startFile(
            file.relativePath,
            files.findIndex((candidate) => candidate.relativePath === file.relativePath),
          );
        },
        onChunk: ({ bytes }) => {
          telemetry.addChunk(bytes);
        },
        onFileCompleted: ({ file }) => {
          this.options.accounts.getEligible(account.id, 'EXISTING_WORK');
          const placedFile = pendingPlaced.find(
            (candidate) => candidate.file.relativePath === file.relativePath,
          );
          if (!placedFile) throw new Error('OFFLOAD_MANIFEST_NOT_READY');
          const verifiedBytes = this.persistVerifiedPrimary(snapshot, account.id, placedFile);
          telemetry.completeFile(BigInt(file.size));
          telemetry.setVerifiedBytes(verifiedBytes);
        },
      },
    );

    telemetry.completeStage();
    this.options.db.transaction(() => {
      this.options.accounts.getEligible(account.id, 'EXISTING_WORK');
      this.options.machine.transition(snapshot.jobId, 'FINALIZING_REMOTE', 'CLOUD_COMMITTED', {
        primaryReplicaVerified: true,
      });
      // The bytes are now independently recoverable, but the local source is
      // still present. Do not call this CLOUD yet: that state means cleanup has
      // actually completed and Jellyfin should use the cloud-only farm entry.
      this.options.torrentRepository.setCloudState(
        snapshot.instanceId,
        snapshot.torrentHash,
        'CLOUD_COMMITTED',
      );
      // Inside the transaction with the replica rows, not after. The catalog row is
      // the only thing that maps a content-addressed blob back to a title a media
      // server can identify — committing replicas without it would leave verified
      // bytes that nothing can name.
      if (stored.canonicalContentRoot !== null) {
        this.options.catalogRecorder?.record({
          instanceId: snapshot.instanceId,
          torrentHash: snapshot.torrentHash,
          contentRoot: stored.canonicalContentRoot,
          accountId: account.id,
        });
      }
    })();

    // After the transaction, never inside it. Queueing the follow-up is not part
    // of the guarantee the commit makes, and a failure to queue an optional second
    // copy must not roll back a primary that is already verified on the remote.
    this.options.onCommitted?.(this.requireSnapshot(snapshot.jobId));
  }

  private hasMatchingVerifiedPrimary(snapshot: OffloadSnapshot, file: StoredFile): boolean {
    if (!file.sha256) return false;
    return (
      this.options.db
        .prepare(
          `SELECT 1 FROM cloud_replicas
           WHERE instance_id = ? AND torrent_hash = ? AND relative_path = ?
             AND role = 'PRIMARY' AND active = 1 AND verification_status = 'VERIFIED'
             AND sha256 = ? AND size = ?
           LIMIT 1`,
        )
        .get(
          snapshot.instanceId,
          snapshot.torrentHash,
          file.relativePath,
          file.sha256,
          safeNumber(file.size),
        ) !== undefined
    );
  }

  private persistVerifiedPrimary(
    snapshot: OffloadSnapshot,
    accountId: string,
    placed: { file: StoredFile; logicalPath: string; remotePath: string },
  ): bigint {
    const { file, logicalPath, remotePath } = placed;
    if (!file.sha256) throw new Error('OFFLOAD_MANIFEST_NOT_READY');
    return this.options.db.transaction(() => {
      this.options.accounts.getEligible(accountId, 'EXISTING_WORK');
      const prior = this.options.db
        .prepare(
          `SELECT id, sha256, size FROM cloud_replicas
           WHERE instance_id = ? AND torrent_hash = ? AND relative_path = ?
             AND role = 'PRIMARY' AND active = 1`,
        )
        .get(snapshot.instanceId, snapshot.torrentHash, file.relativePath) as
        { id: string; sha256: string; size: number } | undefined;
      if (!prior || prior.sha256 !== file.sha256 || prior.size !== safeNumber(file.size)) {
        if (prior) {
          this.options.db
            .prepare('UPDATE cloud_replicas SET active = 0 WHERE id = ?')
            .run(prior.id);
        }
        this.options.db
          .prepare(
            `INSERT INTO cloud_replicas(
               id, instance_id, torrent_hash, relative_path, role, account_id,
               logical_path, remote_path, sha256, size, verification_status,
               verified_at, active, created_at
             ) VALUES (?, ?, ?, ?, 'PRIMARY', ?, ?, ?, ?, ?, 'VERIFIED', ?, 1, ?)`,
          )
          .run(
            randomUUID(),
            snapshot.instanceId,
            snapshot.torrentHash,
            file.relativePath,
            accountId,
            logicalPath,
            remotePath,
            file.sha256,
            safeNumber(file.size),
            this.now(),
            this.now(),
          );
      } else {
        const refreshed = this.options.db
          .prepare(
            `UPDATE cloud_replicas
             SET account_id = ?, logical_path = ?, remote_path = ?,
                 verification_status = 'VERIFIED', verified_at = ?
             WHERE id = ? AND active = 1`,
          )
          .run(accountId, logicalPath, remotePath, this.now(), prior.id);
        if (refreshed.changes !== 1) throw new Error('REPLICA_UPDATE_CONFLICT');
      }
      const verifiedBytes = this.verifiedPrimaryBytes(snapshot.jobId);
      const totalBytes = this.manifestTotalBytes(snapshot.jobId);
      this.options.db
        .prepare(
          `UPDATE offload_snapshots
           SET verified_bytes = ?, total_bytes = ?, updated_at = ?
           WHERE job_id = ?`,
        )
        .run(verifiedBytes.toString(), totalBytes.toString(), this.now(), snapshot.jobId);
      return verifiedBytes;
    })();
  }

  private initializeTelemetry(jobId: string, telemetry: OffloadTelemetryReporter): void {
    const files = this.listStoredFiles(jobId);
    if (files.length === 0) return;
    telemetry.initializeManifest(
      this.manifestTotalBytes(jobId),
      files.length,
      this.verifiedPrimaryBytes(jobId),
    );
  }

  private beginStageTelemetry(
    jobId: string,
    step: 'HASHING' | 'UPLOADING_STAGING' | 'VERIFYING' | 'FINALIZING_REMOTE',
    telemetry: OffloadTelemetryReporter,
  ): void {
    const files = this.listStoredFiles(jobId);
    const completed = files.filter((file) => {
      switch (step) {
        case 'HASHING':
          return file.sha256 !== null;
        case 'UPLOADING_STAGING':
          return file.uploadStatus === 'STAGED' || file.uploadStatus === 'VERIFIED';
        case 'VERIFYING':
          return file.verificationStatus === 'VERIFIED';
        case 'FINALIZING_REMOTE':
          return this.hasMatchingVerifiedPrimary(this.requireSnapshot(jobId), file);
      }
    });
    telemetry.beginStage({
      step,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0n),
      fileCount: files.length,
      resumedBytes: completed.reduce((sum, file) => sum + file.size, 0n),
      resumedFiles: completed.length,
    });
  }

  private manifestTotalBytes(jobId: string): bigint {
    return this.listStoredFiles(jobId).reduce((sum, file) => sum + file.size, 0n);
  }

  private verifiedPrimaryBytes(jobId: string): bigint {
    const rows = this.options.db
      .prepare(
        `SELECT CAST(f.size AS TEXT) AS size
         FROM offload_files f
         JOIN offload_snapshots s ON s.job_id = f.job_id
         WHERE f.job_id = ? AND EXISTS (
           SELECT 1 FROM cloud_replicas r
           WHERE r.instance_id = s.instance_id AND r.torrent_hash = s.torrent_hash
             AND r.relative_path = f.relative_path AND r.role = 'PRIMARY' AND r.active = 1
             AND r.verification_status = 'VERIFIED' AND r.sha256 = f.sha256 AND r.size = f.size
         )`,
      )
      .all(jobId) as Array<{ size: string }>;
    return rows.reduce((sum, row) => sum + BigInt(row.size), 0n);
  }

  private findAccount(accountId: string) {
    return this.options.accounts.getEligible(accountId, 'EXISTING_WORK');
  }

  private async revalidateResumeSource(
    snapshot: OffloadSnapshot,
    signal: AbortSignal,
  ): Promise<void> {
    this.throwIfCancelled(snapshot.jobId, signal);
    const stored = this.readStoredSnapshot(snapshot.jobId);
    // A freshly admitted PAUSING job has not captured its root yet. Its normal
    // pauseAndSnapshot path establishes the identities below before any hash.
    if (!stored.canonicalContentRoot) return;
    await assertRootIdentity(stored);
    for (const file of this.listStoredFiles(snapshot.jobId)) {
      this.throwIfCancelled(snapshot.jobId, signal);
      const absolutePath = await resolveStoredFile(stored.canonicalContentRoot, file.relativePath);
      await assertFileIdentity(absolutePath, expectedIdentity(file));
    }
    const control = this.options.registry.get(snapshot.instanceId);
    const torrent = (await control.list()).find(
      (candidate) => candidate.hash.toLowerCase() === snapshot.torrentHash.toLowerCase(),
    );
    this.throwIfCancelled(snapshot.jobId, signal);
    if (!torrent) throw new Error('TORRENT_NOT_FOUND_ON_INSTANCE');
    if (normalizeTorrentState(torrent.state) !== 'PAUSED') throw new Error('SOURCE_CHANGED');
  }

  private async reuseMatchingStagingObject(
    jobId: string,
    remotePath: string,
    file: StoredFile,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!file.sha256) throw new Error('OFFLOAD_MANIFEST_NOT_READY');
    const sha256 = file.sha256;
    const existing = await this.resources.withMetadata(signal, () =>
      this.options.rclone.stat(remotePath, signal),
    );
    if (!existing) return false;
    const removeAndReplace = async (): Promise<false> => {
      if (!this.options.rclone.deleteFile) {
        throw new Error('OFFLOAD_STAGING_REPLACE_UNAVAILABLE');
      }
      await this.resources.withMetadata(signal, () =>
        this.options.rclone.deleteFile!(remotePath, signal),
      );
      return false;
    };
    if (existing.size !== safeNumber(file.size)) return removeAndReplace();
    const separator = remotePath.indexOf(':');
    if (separator < 1) throw new Error('OFFLOAD_STAGING_PATH_INVALID');
    const cryptRemote = remotePath.slice(0, separator + 1);
    const objectPath = remotePath.slice(separator + 1);
    const slash = objectPath.lastIndexOf('/');
    if (slash < 1) throw new Error('OFFLOAD_STAGING_PATH_INVALID');
    try {
      await this.withObservedRemoteDataResource(
        jobId,
        'READBACK_SLOT',
        (stageObserver, remoteHeavyObserver) =>
          this.resources.withReadback(
            signal,
            () =>
              new StrictRemoteVerifier({ rclone: this.options.rclone, now: this.now }).verify(
                {
                  cryptRemote,
                  stagingPrefix: objectPath.slice(0, slash),
                  files: [
                    {
                      relativePath: file.relativePath,
                      remoteRelativePath: objectPath.slice(slash + 1),
                      size: safeNumber(file.size),
                      sha256,
                    },
                  ],
                },
                signal,
              ),
            stageObserver,
            remoteHeavyObserver,
          ),
      );
      return true;
    } catch (error: unknown) {
      const code = error instanceof Error ? error.message : '';
      if (
        code === 'REPLICA_OBJECT_MISSING' ||
        code === 'REPLICA_SIZE_MISMATCH' ||
        code === 'REPLICA_DIGEST_MISMATCH'
      ) {
        return removeAndReplace();
      }
      throw error;
    }
  }

  private requireSnapshot(jobId: string): OffloadSnapshot {
    const snapshot = this.options.machine.get(jobId);
    if (!snapshot) throw new Error('OFFLOAD_NOT_FOUND');
    return snapshot;
  }

  private async withObservedResource<T>(
    jobId: string,
    resourceWait: OffloadResourceWait,
    run: (observer: SemaphoreObserver) => Promise<T>,
  ): Promise<T> {
    try {
      return await run(this.resourceObserver(jobId, resourceWait));
    } finally {
      this.clearResourceWait(jobId);
    }
  }

  /**
   * Tracks both layers without reversing the established acquisition order.
   *
   * A job first reports the upload/readback stage semaphore. Once that permit is
   * acquired, an inner shared-capacity queue replaces the marker with
   * REMOTE_HEAVY_SLOT. Acquiring both permits clears the marker before the data
   * plane body starts; every exit path clears it again as a fail-safe.
   */
  private async withObservedRemoteDataResource<T>(
    jobId: string,
    stageResourceWait: 'UPLOAD_SLOT' | 'READBACK_SLOT',
    run: (stageObserver: SemaphoreObserver, remoteHeavyObserver: SemaphoreObserver) => Promise<T>,
  ): Promise<T> {
    try {
      return await run(
        this.resourceObserver(jobId, stageResourceWait, false),
        this.resourceObserver(jobId, 'REMOTE_HEAVY_SLOT'),
      );
    } finally {
      this.clearResourceWait(jobId);
    }
  }

  private resourceObserver(
    jobId: string,
    resourceWait: OffloadResourceWait,
    clearOnAcquired = true,
  ): SemaphoreObserver {
    return {
      queued: ({ position, active, capacity }) => {
        this.options.machine.setResourceWait(jobId, {
          resourceWait,
          resourceQueuePosition: position,
          resourceActive: active,
          resourceCapacity: capacity,
        });
      },
      acquired: () => {
        if (clearOnAcquired) this.clearResourceWait(jobId);
      },
    };
  }

  private clearResourceWait(jobId: string): void {
    try {
      if (this.options.machine.get(jobId)?.resourceWait !== undefined) {
        this.options.machine.setResourceWait(jobId, null);
      }
    } catch {
      // The job may have been removed during shutdown/cancellation; cleanup is advisory then.
    }
  }

  private readStoredSnapshot(jobId: string): StoredSnapshot {
    const row = this.options.db
      .prepare(
        `SELECT exported_torrent_encrypted AS exportedTorrentEncrypted,
                canonical_content_root AS canonicalContentRoot,
                content_root_kind AS contentRootKind,
                source_device AS sourceDevice, source_inode AS sourceInode,
                source_size AS sourceSize, source_mtime_ns AS sourceMtimeNs,
                selected_account_id AS selectedAccountId,
                staging_prefix AS stagingPrefix, recovery_version AS recoveryVersion
         FROM offload_snapshots WHERE job_id = ?`,
      )
      .safeIntegers()
      .get(jobId) as StoredSnapshot | undefined;
    if (!row) throw new Error('OFFLOAD_NOT_FOUND');
    return row;
  }

  private listStoredFiles(jobId: string): StoredFile[] {
    return this.options.db
      .prepare(
        `SELECT relative_path AS relativePath, device, inode, size,
                allocated_bytes AS allocatedBytes, mtime_ns AS mtimeNs,
                sha256, upload_status AS uploadStatus,
                verification_status AS verificationStatus
         FROM offload_files WHERE job_id = ? ORDER BY relative_path`,
      )
      .safeIntegers()
      .all(jobId) as StoredFile[];
  }

  private throwIfCancelled(jobId: string, signal: AbortSignal): void {
    if (signal.aborted) throw abortReason(signal);
    if (this.requireSnapshot(jobId).cancelledAt !== null) throw new Error('OFFLOAD_CANCELLED');
  }
}

function rootKind(stats: { isFile(): boolean; isDirectory(): boolean }): 'FILE' | 'DIRECTORY' {
  if (stats.isFile()) return 'FILE';
  if (stats.isDirectory()) return 'DIRECTORY';
  throw new Error('SOURCE_CHANGED');
}

async function waitForPaused(
  control: QbControl,
  hash: string,
  signal: AbortSignal,
  sleep: (ms: number, signal: AbortSignal) => Promise<void>,
  now: () => number,
): Promise<void> {
  // A deadline as well as an attempt bound, for the same reason the recheck wait
  // carries both: the deadline is what makes the window mean wall-clock seconds,
  // and the attempt bound is what stops an injected clock that never advances from
  // spinning forever.
  const deadline = now() + PAUSE_TIMEOUT_MS;
  let stableObservations = 0;
  for (let attempt = 0; attempt < PAUSE_MAX_ATTEMPTS; attempt += 1) {
    if (signal.aborted) throw abortReason(signal);
    const torrent = (await control.list()).find(
      (candidate) => candidate.hash.toLowerCase() === hash.toLowerCase(),
    );
    if (!torrent) throw new Error('TORRENT_NOT_FOUND_ON_INSTANCE');
    // Two consecutive readings, because one is not evidence: `pause` is queued, so
    // a single sample can be the state qB held before it was asked.
    if (normalizeTorrentState(torrent.state) === 'PAUSED') stableObservations += 1;
    else stableObservations = 0;
    if (stableObservations >= PAUSE_STABLE_OBSERVATIONS) return;
    if (now() >= deadline) break;
    await sleep(PAUSE_POLL_MS, signal);
  }
  throw new Error('TORRENT_DID_NOT_PAUSE');
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      signal.removeEventListener('abort', cancelled);
      resolve();
    }
    function cancelled(): void {
      clearTimeout(timer);
      reject(abortReason(signal));
    }
    signal.addEventListener('abort', cancelled, { once: true });
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}

async function resolveStoredFile(root: string, relativePath: string): Promise<string> {
  if (path.isAbsolute(relativePath) || relativePath.includes('\0'))
    throw new Error('SOURCE_CHANGED');
  const rootStats = await lstat(root);
  const candidate = rootStats.isDirectory() ? path.resolve(root, ...relativePath.split('/')) : root;
  const relative = path.relative(rootStats.isDirectory() ? root : path.dirname(root), candidate);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('SOURCE_CHANGED');
  }
  return candidate;
}

async function assertRootIdentity(snapshot: StoredSnapshot): Promise<void> {
  if (
    !snapshot.canonicalContentRoot ||
    snapshot.sourceDevice === null ||
    snapshot.sourceInode === null ||
    snapshot.sourceSize === null ||
    snapshot.sourceMtimeNs === null
  ) {
    throw new Error('OFFLOAD_SNAPSHOT_MISSING');
  }
  await assertFileIdentity(snapshot.canonicalContentRoot, {
    dev: snapshot.sourceDevice,
    ino: snapshot.sourceInode,
    size: snapshot.sourceSize,
    mtimeNs: snapshot.sourceMtimeNs,
  });
}

async function assertFileIdentity(
  absolutePath: string,
  expected: StableFileIdentity,
): Promise<void> {
  let actual;
  try {
    actual = await lstat(absolutePath, { bigint: true });
  } catch (error: unknown) {
    throw new Error('SOURCE_CHANGED', { cause: error });
  }
  if (
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.size !== expected.size ||
    actual.mtimeNs !== expected.mtimeNs
  ) {
    throw new Error('SOURCE_CHANGED');
  }
}

function expectedIdentity(file: StoredFile): StableFileIdentity {
  return {
    dev: file.device,
    ino: file.inode,
    size: file.size,
    mtimeNs: file.mtimeNs,
  };
}

function inodeKey(file: StoredFile): string {
  return `${file.device}:${file.inode}:${file.size}:${file.mtimeNs}`;
}

function safeNumber(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('SOURCE_STAT_OUT_OF_RANGE');
  return result;
}

function sumSafe(values: readonly number[]): number {
  return values.reduce((total, value) => {
    const next = total + value;
    if (!Number.isSafeInteger(next) || next < 0) throw new Error('SOURCE_SIZE_OUT_OF_RANGE');
    return next;
  }, 0);
}
