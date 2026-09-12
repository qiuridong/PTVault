import path from 'node:path';

import type { AppDatabase } from '../db/database.js';
import type { RehydrateFile } from './rehydrate-handler.js';

export type RehydratePlan = {
  files: RehydrateFile[];
  /** Files are installed as exactly this filesystem object at `destination`. */
  contentKind: 'FILE' | 'DIRECTORY';
  /** Absolute path the torrent root is renamed to, back where qB expects it. */
  destination: string;
};

/**
 * Builds a restore plan from the offload that migrated this torrent.
 *
 * Reads the *verified active* replica for each file, joining the manifest to
 * `cloud_replicas`. A file with no verified active replica means there is nothing
 * safe to pull, and the plan is refused rather than partially assembled — a
 * partial restore would rename a tree with holes into the path qB seeds from.
 *
 * The destination comes from the torrent's recorded `content_path`, so a restored
 * torrent lands exactly where it was migrated from. Anything else would leave qB
 * pointing at a path nobody writes to.
 */
export function loadRehydratePlan(
  db: AppDatabase,
  input: { instanceId: string; torrentHash: string },
): RehydratePlan | null {
  const torrent = db
    .prepare(
      `SELECT content_path AS contentPath, save_path AS savePath
       FROM torrents WHERE instance_id = ? AND hash = ?`,
    )
    .get(input.instanceId, input.torrentHash) as
    { contentPath: string; savePath: string } | undefined;
  if (!torrent) return null;

  // The most recent committed offload for this torrent holds the manifest to
  // restore from. An earlier one may describe files that have since changed.
  const job = db
    .prepare(
      `SELECT job_id AS jobId, content_root_kind AS contentKind,
              source_size AS sourceSize
       FROM offload_snapshots
       WHERE instance_id = ? AND torrent_hash = ?
         AND current_step IN ('CLOUD_COMMITTED', 'LOCAL_CLEANUP', 'COMPLETED')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(input.instanceId, input.torrentHash) as
    | { jobId: string; contentKind: 'FILE' | 'DIRECTORY' | null; sourceSize: number | null }
    | undefined;
  if (!job) return null;

  const rows = db
    .prepare(
      `SELECT f.relative_path AS relativePath, f.sha256 AS sha256, f.size AS size,
              (
                SELECT r.remote_path
                FROM cloud_replicas r
                JOIN media_catalog c
                  ON c.instance_id = r.instance_id AND c.torrent_hash = r.torrent_hash
                WHERE r.instance_id = ? AND r.torrent_hash = ?
                  AND r.relative_path = f.relative_path
                  AND r.account_id = c.active_account_id
                  AND r.active = 1 AND r.verification_status = 'VERIFIED'
                  AND r.sha256 = f.sha256 AND r.size = f.size
                ORDER BY CASE r.role WHEN 'PRIMARY' THEN 0 ELSE 1 END, r.created_at DESC
                LIMIT 1
              ) AS remotePath,
              (
                SELECT r.account_id
                FROM cloud_replicas r
                JOIN media_catalog c
                  ON c.instance_id = r.instance_id AND c.torrent_hash = r.torrent_hash
                WHERE r.instance_id = ? AND r.torrent_hash = ?
                  AND r.relative_path = f.relative_path
                  AND r.account_id = c.active_account_id
                  AND r.active = 1 AND r.verification_status = 'VERIFIED'
                  AND r.sha256 = f.sha256 AND r.size = f.size
                ORDER BY CASE r.role WHEN 'PRIMARY' THEN 0 ELSE 1 END, r.created_at DESC
                LIMIT 1
              ) AS accountId
       FROM offload_files f
       WHERE f.job_id = ?
       ORDER BY f.relative_path`,
    )
    .all(
      input.instanceId,
      input.torrentHash,
      input.instanceId,
      input.torrentHash,
      job.jobId,
    ) as Array<{
    relativePath: string;
    sha256: string | null;
    size: number;
    remotePath: string | null;
    accountId: string | null;
  }>;
  if (rows.length === 0) return null;

  const files: RehydrateFile[] = [];
  for (const row of rows) {
    // All three must be present. A missing hash means the manifest never finished
    // hashing; a missing remote path means no verified copy exists to pull.
    if (row.sha256 === null || row.remotePath === null || row.accountId === null) return null;
    files.push({
      relativePath: row.relativePath,
      sha256: row.sha256,
      size: row.size,
      accountId: row.accountId,
      remotePath: row.remotePath,
    });
  }

  const destination = path.posix.isAbsolute(torrent.contentPath)
    ? path.posix.normalize(torrent.contentPath)
    : path.posix.join(torrent.savePath, torrent.contentPath);
  const contentKind = contentKindForLegacySnapshot(
    job.contentKind,
    job.sourceSize,
    destination,
    files,
  );
  // No plan rather than a guessed shape. The caller reports the restore as
  // unavailable, which an operator can act on; a wrong shape only shows up after
  // the bytes have been written and cannot be retried out of.
  if (contentKind === null) return null;
  return { files, contentKind, destination };
}

/**
 * v15 records the root shape explicitly. Older committed snapshots are inferred
 * from what the snapshot already measured about the root itself.
 *
 * The names alone are not enough, and the case they miss is real: a *directory*
 * torrent holding exactly one file named after its own directory looks identical
 * to a single-file torrent — one manifest entry whose path equals the basename of
 * the content root. Guessing FILE there installs a file where qB expects a
 * directory; the recheck then sits at 0% until it times out, and every retry
 * re-confirms the wrongly shaped path as already installed, so the job can never
 * finish without someone deleting it by hand.
 *
 * `source_size` settles it, and it is recorded for every snapshot that ever
 * reached this state — it is the root's own `lstat` size. For a file root that is
 * the file's length; for a directory root it is the directory inode's size, which
 * is a block-size multiple and not the length of the media inside it.
 *
 * Ambiguous with no measurement to fall back on is left as DIRECTORY only when the
 * manifest already says so. A single-entry manifest whose size cannot be confirmed
 * returns null instead: both wrong answers strand the restore after the bytes are
 * on disk, so refusing to plan is the cheaper failure.
 */
export function contentKindForLegacySnapshot(
  stored: 'FILE' | 'DIRECTORY' | null,
  sourceSize: number | null,
  destination: string,
  files: readonly { relativePath: string; size: number }[],
): 'FILE' | 'DIRECTORY' | null {
  if (stored !== null) return stored;

  const single = files.length === 1 ? files[0] : undefined;
  if (!single || single.relativePath !== path.posix.basename(destination)) return 'DIRECTORY';

  if (sourceSize === null) return null;
  return sourceSize === single.size ? 'FILE' : 'DIRECTORY';
}
