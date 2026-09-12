import { randomUUID } from 'node:crypto';

import type { OffloadSnapshot } from '@ptvault/contracts';

import type { AppDatabase } from '../db/database.js';
import type { StorageAccountRepository } from './accounts.js';
import {
  LIBRARY_BLOB_ROOT,
  blobRelativePath,
  libraryBlobPath,
  stagingBlobPath,
} from './blob-path.js';
import type { StagingRclone } from './offload-handler.js';
import { StrictRemoteVerifier, type VerifiableFile } from './verify.js';

/**
 * Adds a second, distinct-account cloud copy for IMPORTANT media after the
 * primary is already committed and verified.
 *
 * Safety posture: this is a *pure addition*. The primary replica is the safety
 * net that already gates cleanup; the secondary never touches the local source
 * (which may already be cleaned by the time this runs) and never mutates the
 * offload state machine. Its only source of bytes is the already-verified
 * PRIMARY remote object, copied crypt-remote→crypt-remote so the plaintext
 * round-trips through rclone's decrypt/re-encrypt. Every secondary object is
 * read back and hash-checked with the same {@link StrictRemoteVerifier} the
 * primary used before a SECONDARY row is recorded, so a corrupt or truncated
 * secondary copy is never trusted. A failure here leaves the primary and the
 * cleanup eligibility completely unaffected.
 */
export type SecondaryReplicatorOptions = {
  db: AppDatabase;
  accounts: StorageAccountRepository;
  rclone: StagingRclone;
  now?: () => number;
};

export type SecondaryReplicaResult = {
  /** Files that gained a new verified SECONDARY replica in this run. */
  replicated: string[];
  /** Files skipped because an active SECONDARY replica already existed. */
  skipped: string[];
};

type ManifestFile = { relativePath: string; sha256: string; size: number };

type PrimaryReplica = { relativePath: string; remotePath: string; accountId: string };

export class SecondaryReplicator {
  private readonly now: () => number;

  constructor(private readonly options: SecondaryReplicatorOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Ensures a verified SECONDARY replica exists for every manifest file of an
   * IMPORTANT, already-committed offload. Idempotent: files that already have
   * an active SECONDARY replica are skipped, and a half-placed final object
   * (from an interrupted run) is not moved again.
   */
  async replicate(snapshot: OffloadSnapshot, signal: AbortSignal): Promise<SecondaryReplicaResult> {
    throwIfAborted(signal);
    if (snapshot.importance !== 'IMPORTANT') {
      throw new Error('SECONDARY_NOT_IMPORTANT');
    }
    if (
      snapshot.currentStep !== 'CLOUD_COMMITTED' &&
      snapshot.currentStep !== 'LOCAL_CLEANUP' &&
      snapshot.currentStep !== 'COMPLETED'
    ) {
      throw new Error('SECONDARY_PRIMARY_NOT_COMMITTED');
    }

    const manifest = this.loadManifest(snapshot.jobId);
    if (manifest.length === 0) throw new Error('OFFLOAD_MANIFEST_EMPTY');

    const primaries = this.loadVerifiedPrimaries(snapshot);
    for (const file of manifest) {
      if (!primaries.has(file.relativePath)) {
        throw new Error('SECONDARY_PRIMARY_NOT_VERIFIED');
      }
    }

    const existingSecondaries = this.loadActiveSecondaryPaths(snapshot);
    const pending = manifest.filter((file) => !existingSecondaries.has(file.relativePath));
    const skipped = manifest
      .filter((file) => existingSecondaries.has(file.relativePath))
      .map((file) => file.relativePath);
    if (pending.length === 0) return { replicated: [], skipped };

    const primaryAccountIds = new Set([...primaries.values()].map((row) => row.accountId));
    const requiredBytes = sumSafe(pending.map((file) => file.size));
    const capacityClaim = {
      ownerKind: 'SECONDARY' as const,
      ownerId: snapshot.jobId,
      requiredBytes: String(requiredBytes),
      excludeAccountIds: [...primaryAccountIds],
    };
    const account = this.options.accounts.reserveCapacity(capacityClaim);

    try {
      const stagingPrefix = `staging-secondary/${snapshot.jobId}`;
      const replicated: string[] = [];

      // Stage every pending file first, then verify the whole set, then promote —
      // matching the primary pipeline's copy → strict readback → move ordering so
      // a corrupt copy is caught before any object lands in the library prefix.
      for (const file of pending) {
        throwIfAborted(signal);
        this.options.accounts.getEligible(account.id, 'NEW_WORK');
        const source = requirePrimary(primaries, file.relativePath).remotePath;
        const destination = `${account.cryptRemote}${stagingBlobPath(stagingPrefix, file.sha256)}`;
        const alreadyStaged = await this.options.rclone.stat(destination);
        this.options.accounts.getEligible(account.id, 'NEW_WORK');
        if (!alreadyStaged) {
          this.options.accounts.reserveCapacity({ ...capacityClaim, accountId: account.id });
          this.options.accounts.beginCapacityWrite('SECONDARY', snapshot.jobId);
          await this.options.rclone.copy(source, destination, signal);
          this.options.accounts.getEligible(account.id, 'NEW_WORK');
        }
      }

      const verifiable: VerifiableFile[] = pending.map((file) => ({
        relativePath: file.relativePath,
        remoteRelativePath: blobRelativePath(file.sha256),
        size: file.size,
        sha256: file.sha256,
      }));
      const verifier = new StrictRemoteVerifier({ rclone: this.options.rclone, now: this.now });
      this.options.accounts.getEligible(account.id, 'NEW_WORK');
      await verifier.verify(
        { cryptRemote: account.cryptRemote, stagingPrefix, files: verifiable },
        signal,
        {
          context: 'STAGING',
          onFileStart: () => {
            this.options.accounts.getEligible(account.id, 'NEW_WORK');
          },
          onFileCompleted: () => {
            this.options.accounts.getEligible(account.id, 'NEW_WORK');
          },
        },
      );

      type Placed = { file: ManifestFile; logicalPath: string; remotePath: string };
      const placed: Placed[] = [];
      for (const file of pending) {
        throwIfAborted(signal);
        this.options.accounts.getEligible(account.id, 'NEW_WORK');
        const stagingRemote = `${account.cryptRemote}${stagingBlobPath(stagingPrefix, file.sha256)}`;
        const logicalPath = libraryBlobPath(file.sha256);
        const remotePath = `${account.cryptRemote}${logicalPath}`;

        const alreadyPlaced = await this.options.rclone.stat(remotePath);
        this.options.accounts.getEligible(account.id, 'NEW_WORK');
        if (!alreadyPlaced) {
          await this.options.rclone.move(stagingRemote, remotePath, signal);
          this.options.accounts.getEligible(account.id, 'NEW_WORK');
        }

        const finalStat = await this.options.rclone.stat(remotePath);
        this.options.accounts.getEligible(account.id, 'NEW_WORK');
        if (!finalStat) throw new Error('REPLICA_OBJECT_MISSING');
        if (finalStat.size !== file.size) throw new Error('REPLICA_SIZE_MISMATCH');
        placed.push({ file, logicalPath, remotePath });
      }

      // API-H1: re-read and re-hash the library objects after promotion. The move
      // loop only size-checks the final path and skips the move when an object is
      // already present, so a pre-existing wrong-but-right-sized library object
      // would otherwise be recorded as a VERIFIED secondary without its bytes ever
      // being read. Re-verifying the library prefix closes that gap.
      if (placed.length > 0) {
        const libraryVerifiable: VerifiableFile[] = placed.map(({ file }) => ({
          relativePath: file.relativePath,
          remoteRelativePath: blobRelativePath(file.sha256),
          size: file.size,
          sha256: file.sha256,
        }));
        this.options.accounts.getEligible(account.id, 'NEW_WORK');
        await verifier.verify(
          {
            cryptRemote: account.cryptRemote,
            stagingPrefix: LIBRARY_BLOB_ROOT,
            files: libraryVerifiable,
          },
          signal,
          {
            context: 'COMMITTED',
            onFileStart: () => {
              this.options.accounts.getEligible(account.id, 'NEW_WORK');
            },
            onFileCompleted: () => {
              this.options.accounts.getEligible(account.id, 'NEW_WORK');
            },
          },
        );
      }

      const insert = this.options.db.prepare(
        `INSERT INTO cloud_replicas(
         id, instance_id, torrent_hash, relative_path, role, account_id,
         logical_path, remote_path, sha256, size, verification_status,
         verified_at, active, created_at
       ) VALUES (?, ?, ?, ?, 'SECONDARY', ?, ?, ?, ?, ?, 'VERIFIED', ?, 1, ?)`,
      );
      const existing = this.options.db.prepare(
        `SELECT id, sha256, size FROM cloud_replicas
       WHERE instance_id = ? AND torrent_hash = ? AND relative_path = ?
         AND role = 'SECONDARY' AND active = 1`,
      );
      const deactivate = this.options.db.prepare(
        `UPDATE cloud_replicas SET active = 0 WHERE id = ?`,
      );
      this.options.db.transaction(() => {
        this.options.accounts.getEligible(account.id, 'NEW_WORK');
        for (const { file, logicalPath, remotePath } of placed) {
          const prior = existing.get(
            snapshot.instanceId,
            snapshot.torrentHash,
            file.relativePath,
          ) as { id: string; sha256: string; size: number } | undefined;
          if (prior) {
            // API-C2 dedup: identical content already recorded — keep it.
            if (prior.sha256 === file.sha256 && prior.size === file.size) continue;
            // Content changed: retire the stale active row so it can neither satisfy
            // the verified guard for the new bytes nor collide with the active-
            // identity unique index (migration v8) on the fresh insert below.
            deactivate.run(prior.id);
          }
          insert.run(
            randomUUID(),
            snapshot.instanceId,
            snapshot.torrentHash,
            file.relativePath,
            account.id,
            logicalPath,
            remotePath,
            file.sha256,
            file.size,
            this.now(),
            this.now(),
          );
          replicated.push(file.relativePath);
        }
      })();

      return { replicated, skipped };
    } finally {
      this.options.accounts.releaseCapacity('SECONDARY', snapshot.jobId);
    }
  }

  private loadManifest(jobId: string): ManifestFile[] {
    const rows = this.options.db
      .prepare(
        `SELECT relative_path AS relativePath, sha256, size
         FROM offload_files WHERE job_id = ? ORDER BY relative_path`,
      )
      .safeIntegers()
      .all(jobId) as Array<{ relativePath: string; sha256: string | null; size: bigint }>;
    return rows.map((row) => {
      if (!row.sha256) throw new Error('OFFLOAD_MANIFEST_NOT_READY');
      return { relativePath: row.relativePath, sha256: row.sha256, size: safeNumber(row.size) };
    });
  }

  private loadVerifiedPrimaries(snapshot: OffloadSnapshot): Map<string, PrimaryReplica> {
    const rows = this.options.db
      .prepare(
        `SELECT relative_path AS relativePath, remote_path AS remotePath, account_id AS accountId
         FROM cloud_replicas
         WHERE instance_id = ? AND torrent_hash = ?
           AND role = 'PRIMARY' AND active = 1 AND verification_status = 'VERIFIED'`,
      )
      .all(snapshot.instanceId, snapshot.torrentHash) as PrimaryReplica[];
    return new Map(rows.map((row) => [row.relativePath, row]));
  }

  private loadActiveSecondaryPaths(snapshot: OffloadSnapshot): Set<string> {
    // API-C2: a secondary counts as "already present" only when its content
    // matches this job's manifest (sha256 AND size), not merely its path. A
    // stale active secondary left from an earlier offload of the same torrent
    // therefore does NOT suppress re-replication of the new bytes — the file is
    // treated as pending, re-staged/verified, and the insert path retires the
    // stale row. Path-only matching here would strand the wrong bytes as the
    // redundant copy and make the insert-loop dedup unreachable.
    const rows = this.options.db
      .prepare(
        `SELECT r.relative_path AS relativePath FROM cloud_replicas r
         JOIN offload_files f
           ON f.job_id = ? AND f.relative_path = r.relative_path
          AND f.sha256 = r.sha256 AND f.size = r.size
         WHERE r.instance_id = ? AND r.torrent_hash = ?
           AND r.role = 'SECONDARY' AND r.active = 1`,
      )
      .all(snapshot.jobId, snapshot.instanceId, snapshot.torrentHash) as Array<{
      relativePath: string;
    }>;
    return new Set(rows.map((row) => row.relativePath));
  }
}

function requirePrimary(
  primaries: Map<string, PrimaryReplica>,
  relativePath: string,
): PrimaryReplica {
  const row = primaries.get(relativePath);
  if (!row) throw new Error('SECONDARY_PRIMARY_NOT_VERIFIED');
  return row;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
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
