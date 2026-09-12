import type { AppDatabase } from '../db/database.js';

/**
 * The single source of truth for "does every manifest file of this job have a
 * verified PRIMARY replica whose content matches the manifest?".
 *
 * API-C2 fix: the EXISTS predicate binds the replica to the manifest file by
 * `sha256` AND `size`, not just by relative path. A stale PRIMARY replica left
 * over from an earlier offload of the same torrent (same instance/hash/path)
 * therefore can NOT satisfy the guard for a new job whose content differs — the
 * digest/size won't match, so the file is counted as *not* verified and cleanup
 * (or the CLOUD_COMMITTED/LOCAL_CLEANUP transition) is refused. This is what
 * keeps the "never delete local before decrypt-readback passes" invariant true
 * across re-offloads of the same torrent.
 *
 * Binding is by content, deliberately not by job_id: two jobs may legitimately
 * offload identical bytes and share one replica, so a job_id column would
 * over-constrain and force redundant re-uploads. Content identity is the real
 * safety property.
 */
export function hasVerifiedPrimaryForEveryFile(db: AppDatabase, jobId: string): boolean {
  const counts = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(
           CASE WHEN EXISTS (
             SELECT 1 FROM cloud_replicas r
             WHERE r.instance_id = s.instance_id
               AND r.torrent_hash = s.torrent_hash
               AND r.relative_path = f.relative_path
               AND r.role = 'PRIMARY'
               AND r.verification_status = 'VERIFIED'
               AND r.active = 1
               AND r.sha256 = f.sha256
               AND r.size = f.size
           ) THEN 1 ELSE 0 END
         ) AS verified
       FROM offload_files f
       JOIN offload_snapshots s ON s.job_id = f.job_id
       WHERE f.job_id = ?`,
    )
    .get(jobId) as { total: number; verified: number | null };
  return counts.total > 0 && counts.total === (counts.verified ?? 0);
}
