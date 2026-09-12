import type { MediaCatalogEntry } from '@ptvault/contracts';
import path from 'node:path';

import type { AppDatabase } from '../db/database.js';
import { blobRelativePath } from '../storage/blob-path.js';
import type { FarmBlobLocation } from './symlink-farm.js';
import { contentKindForLegacySnapshot } from './plan.js';

/**
 * Resolves a catalog entry to the verified blob the farm should link at.
 *
 * This is the join the farm cannot do itself: the catalog knows a title's logical
 * path and which account currently backs it, while `cloud_replicas` knows the
 * digest of every file and whether it was read back and verified. A link built
 * without consulting both would point at bytes nobody has verified.
 */
export type BlobResolverOptions = {
  db: AppDatabase;
  /** Live connection/profile/runtime authority; unlike a mount outage, false is fail-closed. */
  isAccountEligible?: (accountId: string) => boolean;
  /**
   * Whether an account's mount can currently serve reads.
   *
   * Present so a title with a second verified copy can be linked through the
   * account that is actually up. Without it the resolver would pin every title to
   * its active account and a healthy replica elsewhere would go unused — which is
   * the redundancy `REPLICA_PROMOTE` exists to create.
   */
  isAccountHealthy: (accountId: string) => boolean;
};

type ReplicaRow = {
  accountId: string;
  role: 'PRIMARY' | 'SECONDARY';
  sha256: string;
  fileCount: number;
};

export function createBlobResolver(
  options: BlobResolverOptions,
): (entry: MediaCatalogEntry) => FarmBlobLocation | null {
  const legacy = createLegacySingleBlobResolver(options);
  const snapshot = options.db.prepare(`SELECT job_id AS jobId, content_root_kind AS contentKind,
    source_size AS sourceSize, canonical_content_root AS contentPath
    FROM offload_snapshots WHERE instance_id = ? AND torrent_hash = ?
    AND current_step IN ('CLOUD_COMMITTED', 'LOCAL_CLEANUP', 'COMPLETED')
    ORDER BY created_at DESC, job_id DESC LIMIT 1`);
  const manifest = options.db.prepare(`SELECT relative_path AS relativePath, sha256, size
    FROM offload_files WHERE job_id = ? ORDER BY relative_path`);
  const replicas = options.db.prepare(`SELECT account_id AS accountId, role, sha256
    FROM cloud_replicas WHERE instance_id = ? AND torrent_hash = ? AND relative_path = ?
    AND sha256 = ? AND size = ? AND active = 1 AND verification_status = 'VERIFIED'
    ORDER BY account_id, CASE role WHEN 'PRIMARY' THEN 0 ELSE 1 END`);
  return (entry) => {
    if (entry.activeAccountId === null) return null;
    const root = snapshot.get(entry.instanceId, entry.torrentHash) as
      | {
          jobId: string;
          contentKind: 'FILE' | 'DIRECTORY' | null;
          sourceSize: number | null;
          contentPath: string | null;
        }
      | undefined;
    // Preserve pre-manifest single-file catalogs, never guess a multi-file shape.
    if (!root) return legacy(entry);
    const files = manifest.all(root.jobId) as {
      relativePath: string;
      sha256: string | null;
      size: number;
    }[];
    if (!files.length || files.some((file) => file.sha256 === null)) return null;
    const kind = contentKindForLegacySnapshot(
      root.contentKind,
      root.sourceSize,
      root.contentPath ?? entry.logicalPath,
      files,
    );
    if (kind === null || (kind === 'FILE' && files.length !== 1)) return null;
    const resolved = [];
    for (const file of files) {
      // Validate before joining: normalize/join must never hide traversal in evidence.
      if (
        !file.relativePath ||
        file.relativePath === '.' ||
        file.relativePath.includes('\\') ||
        file.relativePath.includes('\0') ||
        path.posix.isAbsolute(file.relativePath) ||
        path.posix.normalize(file.relativePath) !== file.relativePath ||
        file.relativePath === '..' ||
        file.relativePath.startsWith('../')
      )
        throw new Error('FARM_MANIFEST_PATH_INVALID');
      const rows = (
        replicas.all(
          entry.instanceId,
          entry.torrentHash,
          file.relativePath,
          file.sha256,
          file.size,
        ) as ReplicaRow[]
      ).filter((row) => options.isAccountEligible?.(row.accountId) ?? true);
      const active = rows.find(
        (row) => row.accountId === entry.activeAccountId && row.role === 'PRIMARY',
      );
      const chosen =
        active && options.isAccountHealthy(active.accountId)
          ? active
          : (rows.find((row) => options.isAccountHealthy(row.accountId)) ?? active ?? rows[0]);
      // All-or-nothing title: no partial manifest is claimed as a complete publication.
      if (!chosen) return null;
      resolved.push({ ...location(chosen), relativePath: file.relativePath });
    }
    return kind === 'FILE'
      ? locationFromFile(resolved[0]!)
      : { ...locationFromFile(resolved[0]!), files: resolved };
  };
}

function locationFromFile(file: FarmBlobLocation): FarmBlobLocation {
  return { accountId: file.accountId, blobRelativePath: file.blobRelativePath };
}

function createLegacySingleBlobResolver(
  options: BlobResolverOptions,
): (entry: MediaCatalogEntry) => FarmBlobLocation | null {
  /**
   * Every verified copy of the title, on any account.
   *
   * Deliberately not filtered to the active account or to `PRIMARY`: which copy is
   * readable right now depends on which mounts are up, and that is decided below.
   * The digest is carried per row so a copy is only ever used as the bytes it was
   * actually verified as.
   *
   * Only used when no committed snapshot exists. Historical single-file catalogs
   * keep their identity; multi-file roots require the manifest resolver above.
   */
  const statement = options.db.prepare(
    `SELECT r.account_id AS accountId, r.role AS role, r.sha256 AS sha256,
            (SELECT COUNT(DISTINCT relative_path) FROM cloud_replicas
             WHERE instance_id = r.instance_id AND torrent_hash = r.torrent_hash
               AND active = 1) AS fileCount
     FROM cloud_replicas r
     WHERE r.instance_id = ? AND r.torrent_hash = ?
       AND r.active = 1 AND r.verification_status = 'VERIFIED'
     ORDER BY r.account_id`,
  );

  return (entry: MediaCatalogEntry): FarmBlobLocation | null => {
    // No active account means no replica has been committed for this title yet.
    if (entry.activeAccountId === null) return null;

    const rows = (statement.all(entry.instanceId, entry.torrentHash) as ReplicaRow[]).filter(
      (row) => options.isAccountEligible?.(row.accountId) ?? true,
    );

    // A multi-file torrent cannot be represented by one symlink, whichever account
    // it sits on. Checked before anything else so no failover path can smuggle one
    // into the farm.
    if (rows.length === 0 || rows.some((row) => row.fileCount !== 1)) return null;

    const active = rows.find(
      (row) => row.accountId === entry.activeAccountId && row.role === 'PRIMARY',
    );

    // Preferred whenever its mount is up, even if another copy exists: the active
    // account is where a promotion put the title, and switching links on a healthy
    // account would churn the farm for no gain.
    const chosen =
      active !== undefined && options.isAccountHealthy(active.accountId)
        ? active
        : // Falls back to any other verified copy whose mount is up. This is the
          // payoff of a second copy: an account outage costs playback only for the
          // titles that have no replica anywhere else.
          rows.find((row) => options.isAccountHealthy(row.accountId));

    // Nothing readable right now, so this resolves to a verified copy anyway rather
    // than to null: null would drop the title from the plan and the farm would
    // *remove* its link, which Jellyfin reads as a deletion and answers by
    // discarding the watch history — a total outage would cost the library itself,
    // not just playback. Prefers the active copy, else the lowest account id so a
    // repeated sync during the outage keeps producing the same plan. The catalog
    // already reports the title UNAVAILABLE; that is where an outage belongs.
    return location(chosen ?? active ?? rows[0]!);
  };
}

function location(row: ReplicaRow): FarmBlobLocation {
  return {
    accountId: row.accountId,
    // Derived, never read from `remote_path`: the digest is what the object is
    // named by, and rebuilding the path from it means a stale stored path can
    // never send a link somewhere the blob is not.
    blobRelativePath: blobRelativePath(row.sha256),
  };
}
