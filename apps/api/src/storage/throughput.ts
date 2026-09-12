import type { MigrationThroughput, ThroughputWindow } from '@ptvault/contracts';

import type { AppDatabase } from '../db/database.js';

/**
 * How many recent commits the estimate is built from.
 *
 * Recent rather than all-time: the number is used to answer "how long will the
 * next one take", and an average dragged down by a run from before the rclone
 * upgrade would answer a question nobody asked.
 */
export const THROUGHPUT_SAMPLE_JOBS = 20;

type Row = {
  jobId: string;
  committedAt: number;
  uploadStart: number | null;
  uploadEnd: number | null;
  workStart: number | null;
  retried: number;
  bytes: number;
};

/**
 * Measured migration throughput, taken from what actually ran.
 *
 * The step transitions are already recorded in `job_events` as `OFFLOAD_<STEP>`,
 * so the timing does not need new bookkeeping — it needs reading the events that
 * are already there. That matters for trust: these are the same timestamps the
 * transfer page's timeline draws, not a second measurement that could disagree
 * with it.
 *
 * Two windows are returned because they differ by a lot and are used for
 * different decisions:
 *
 * - `uploadPhase` (`UPLOADING_STAGING` → `VERIFYING`) is bytes over the wire.
 *   Robust under retries: it takes the *last* upload attempt before the commit,
 *   so a run that failed halfway and resumed does not average in its dead time.
 * - `endToEnd` (`PAUSING` → `CLOUD_COMMITTED`) also covers hashing every byte
 *   locally and streaming the whole object back down to verify it decrypts to
 *   the same digest. This is the one that answers "when can I delete the local
 *   copy". Jobs that were retried are excluded from it, because their window
 *   contains time when nothing was running and no honest rate can be recovered
 *   from it.
 */
export function readMigrationThroughput(
  db: AppDatabase,
  limit = THROUGHPUT_SAMPLE_JOBS,
): MigrationThroughput {
  const rows = db
    .prepare(
      `WITH committed AS (
         SELECT s.job_id AS jobId,
                MAX(CASE WHEN e.event_type = 'OFFLOAD_CLOUD_COMMITTED' THEN e.created_at END)
                  AS committedAt,
                MAX(CASE WHEN e.event_type = 'OFFLOAD_UPLOADING_STAGING' THEN e.created_at END)
                  AS uploadStart,
                MAX(CASE WHEN e.event_type = 'OFFLOAD_PAUSING' THEN e.created_at END)
                  AS workStart,
                MAX(CASE WHEN e.event_type = 'OFFLOAD_RETRY_QUEUED' THEN 1 ELSE 0 END)
                  AS retried
         FROM offload_snapshots s
         JOIN job_events e ON e.job_id = s.job_id
         WHERE s.cancelled_at IS NULL
         GROUP BY s.job_id
         HAVING committedAt IS NOT NULL
       )
       SELECT c.jobId, c.committedAt, c.uploadStart, c.workStart, c.retried,
              (SELECT MIN(v.created_at) FROM job_events v
                WHERE v.job_id = c.jobId
                  AND v.event_type = 'OFFLOAD_VERIFYING'
                  AND v.created_at >= c.uploadStart) AS uploadEnd,
              (SELECT COALESCE(SUM(f.size), 0) FROM offload_files f
                WHERE f.job_id = c.jobId) AS bytes
       FROM committed c
       ORDER BY c.committedAt DESC
       LIMIT ?`,
    )
    .all(limit) as Row[];

  const upload = accumulate(rows, (row) =>
    row.uploadStart === null || row.uploadEnd === null
      ? null
      : { bytes: row.bytes, ms: row.uploadEnd - row.uploadStart },
  );
  const endToEnd = accumulate(rows, (row) =>
    row.retried === 1 || row.workStart === null
      ? null
      : { bytes: row.bytes, ms: row.committedAt - row.workStart },
  );

  return {
    uploadPhase: upload,
    endToEnd,
    lastCommittedAt: rows[0]?.committedAt ?? null,
  };
}

/**
 * Folds the rows a window can use into one weighted rate.
 *
 * Weighted by bytes rather than averaging per-job rates: the estimate is about
 * to be applied to a large file, and a 5 MiB test torrent that finished in two
 * seconds should not get the same vote as a 600 GiB one.
 *
 * A row contributes only when it has both bytes and a positive duration. Zero
 * duration happens for a torrent small enough to commit inside one clock tick,
 * and dividing by it would produce an infinite rate that then renders as a
 * confident "0 seconds" estimate for everything.
 */
function accumulate(
  rows: Row[],
  measure: (row: Row) => { bytes: number; ms: number } | null,
): ThroughputWindow {
  let jobs = 0;
  let bytes = 0;
  let ms = 0;

  for (const row of rows) {
    const measured = measure(row);
    if (!measured || measured.bytes <= 0 || measured.ms <= 0) continue;
    jobs += 1;
    bytes += measured.bytes;
    ms += measured.ms;
  }

  const seconds = ms / 1000;
  return {
    jobs,
    bytes,
    seconds,
    bytesPerSecond: seconds > 0 && bytes > 0 ? bytes / seconds : null,
  };
}
