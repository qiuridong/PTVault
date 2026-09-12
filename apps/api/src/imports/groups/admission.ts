import type { AppDatabase } from '../../db/database.js';
import type { ImportSpoolCapacityGate } from '../data-plane/spool-capacity.js';
import type { ImportPipelineRepository, PipelineAdmissionRow } from './repository.js';

export type GroupAdmissionLimits = {
  residentMaxBytes: string;
  waitingCacheMaxBytes: string;
  maxResidentGroups: number;
};
type Job = {
  state: string;
  attempt: number;
  paused: number;
  pause_requested_at: number | null;
  cancel_requested_at: number | null;
  retry_at: number | null;
};
type Options = {
  db: AppDatabase;
  repository: ImportPipelineRepository;
  capacity: ImportSpoolCapacityGate;
  limits: () => GroupAdmissionLimits;
  measure: (jobId: string) => Promise<string>;
  freeBytes: () => Promise<string>;
  reserveBytes: () => string;
  now?: () => number;
  evict?: (jobId: string) => Promise<boolean>;
  onError?: (code: string) => void;
  holdNewAdmission?: () => boolean;
  minIntervalMs?: number;
  onAdmitted?: (jobId: string, needsRedownload: boolean) => void;
};
const bytes = (s: string) => {
  if (!/^(0|[1-9]\d{0,29})$/.test(s)) throw Error('GROUP_CAPACITY_INVALID');
  return BigInt(s);
};
const minimum = (a: bigint, b: bigint) => (a < b ? a : b);

/** One serial admission tick; a disk waiter never consumes a download/worker slot. */
export class GroupAdmissionCoordinator {
  private running: Promise<void> | undefined;
  private readonly now: () => number;
  private lastTick = -Infinity;
  private jobs = new Map<string, Job>();
  private readyParents = new Set<string>();
  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
  }
  tick(): Promise<void> {
    if (this.running) return this.running;
    if (this.now() - this.lastTick < (this.options.minIntervalMs ?? 0)) return Promise.resolve();
    this.lastTick = this.now();
    const run = this.reconcile()
      .catch(() => {
        // A space decision needs evidence. Failed observation stops new admission,
        // not existing transfers and not the whole worker loop.
        try {
          this.options.onError?.('GROUP_SPACE_PROBE_UNAVAILABLE');
        } catch {
          /* advisory reporter */
        }
      })
      .finally(() => {
        if (this.running === run) this.running = undefined;
      });
    this.running = run;
    return run;
  }
  private async reconcile(): Promise<void> {
    const { db, capacity, repository } = this.options,
      now = this.now(),
      limits = this.options.limits();
    const maximum = bytes(limits.residentMaxBytes);
    bytes(limits.waitingCacheMaxBytes);
    if (
      !Number.isSafeInteger(limits.maxResidentGroups) ||
      limits.maxResidentGroups < 1 ||
      limits.maxResidentGroups > 8
    )
      throw Error('GROUP_CAPACITY_INVALID');
    const initialRows = repository.admissionRows();
    if (initialRows.length === 0) return;
    this.loadStateSnapshot();
    // Probe before changing allocations, so failure has no false "empty disk" effect.
    const free = bytes(await this.options.freeBytes());
    const reserve = bytes(this.options.reserveBytes());
    for (const row of initialRows) {
      if (row.job_id === null || row.admission === 'COMPLETE') continue;
      if (row.admission === 'EVICTING') {
        if (this.options.evict && row.cache_probe_after <= now)
          await this.options.evict(row.job_id);
        continue;
      }
      const job = this.job(row.job_id);
      // Never-started groups have no owned data to measure. Their complete peak
      // is still reserved before the first claim; physical free space is independent.
      if (row.admission === 'WAITING' && job.attempt === 0 && row.resident_bytes === '0') continue;
      const active =
        job.state === 'RUNNING' ||
        (row.admission === 'ADMITTED' && job.state === 'QUEUED' && !job.paused);
      if (active && row.resident_sampled_at !== null && now - row.resident_sampled_at < 10000)
        continue;
      if (
        !active &&
        row.admission === 'WAITING' &&
        row.resident_sampled_at !== null &&
        row.resident_bytes === '0'
      )
        continue;
      const actual = bytes(await this.options.measure(row.job_id));
      db.transaction(() => {
        const current = this.job(row.job_id!, true);
        if (current.state !== job.state || current.attempt !== job.attempt) return;
        let admission = row.admission;
        if (current.state === 'COMPLETED') {
          // Completed is already an existing worker cleanup receipt. Any observed
          // leftovers remain accounted rather than silently erased from the budget.
          if (actual === 0n) {
            capacity.release(row.job_id!);
            admission = 'COMPLETE';
          }
        } else if (!active) {
          capacity.tryResize(row.job_id!, actual.toString());
          admission = actual === 0n ? 'WAITING' : 'CACHED';
        }
        db.prepare(
          `UPDATE import_pipeline_groups SET resident_bytes=?,resident_sampled_at=?,admission=?,updated_at=? WHERE job_id=?`,
        ).run(actual.toString(), now, admission, now, row.job_id);
      }).immediate();
    }
    const rows = repository.admissionRows();
    let activeCount = rows.filter((x) => x.admission === 'ADMITTED').length;
    const reservationMap = () =>
      new Map(
        (
          db.prepare('SELECT job_id,reserved_bytes FROM import_spool_reservations').all() as Array<{
            job_id: string;
            reserved_bytes: string;
          }>
        ).map((row) => [row.job_id, bytes(row.reserved_bytes)]),
      );
    let reservations = reservationMap();
    const groupReserved = () =>
      rows.reduce((sum, row) => {
        const reserved = row.job_id === null ? 0n : (reservations.get(row.job_id) ?? 0n),
          actual = bytes(row.resident_bytes);
        return sum + (reserved > actual ? reserved : actual);
      }, 0n);
    const unwritten = () => {
      const known = rows.reduce(
        (sum, row) =>
          sum +
          (row.job_id === null
            ? 0n
            : minimum(bytes(row.resident_bytes), reservations.get(row.job_id) ?? 0n)),
        0n,
      );
      const total = [...reservations.values()].reduce((sum, value) => sum + value, 0n);
      return total > known ? total - known : 0n;
    };
    this.loadStateSnapshot();
    const candidates = rows
      .filter(
        (row) =>
          row.job_id !== null &&
          ['WAITING', 'CACHED'].includes(row.admission) &&
          this.isRunnable(row.job_id) &&
          this.parentReady(row.pipeline_id),
      )
      .sort(
        (a, b) =>
          (a.wait_since ?? now) - (b.wait_since ?? now) ||
          a.ordinal - b.ordinal ||
          a.group_key.localeCompare(b.group_key),
      );
    if (this.options.holdNewAdmission?.()) {
      db.prepare(
        `UPDATE import_pipeline_groups SET wait_kind='PRESSURE',wait_since=COALESCE(wait_since,?),updated_at=?
        WHERE admission IN ('WAITING','CACHED') AND wait_kind IS NOT 'PRESSURE' AND job_id IN (
          SELECT j.id FROM import_jobs j JOIN import_pipeline_groups g ON g.job_id=j.id JOIN import_pipelines p ON p.id=g.pipeline_id
          WHERE p.paused=0 AND p.cancel_requested=0 AND j.paused=0 AND j.pause_requested_at IS NULL AND j.cancel_requested_at IS NULL
            AND (j.state='QUEUED' OR (j.state='RETRY_WAIT' AND j.retry_at<=?)))`,
      ).run(now, now, now);
      await this.reclaimWaitingCache(now, limits);
      return;
    }
    let oldestBlocked: { row: PipelineAdmissionRow; extra: bigint } | undefined;
    for (const row of candidates) {
      // READY is the atomic receipt for fully installed, hashed output objects.
      // The archive processor never downloads/extracts again after this point;
      // uploads and readbacks stream without allocating another local copy.
      // Keep every measured input/output byte, but do not reserve the obsolete
      // extraction maximum a second time after an upload retry or restart.
      const uploadOnly = row.archive_phase === 'READY' || row.archive_phase === 'CLEANED';
      const need = bytes(uploadOnly ? row.resident_bytes : row.required_spool_bytes),
        owned = reservations.get(row.job_id!) ?? 0n;
      if (need > maximum) {
        this.wait(row, 'CAPACITY', 'GROUP_EXCEEDS_RESIDENT_BUDGET');
        continue;
      }
      if (activeCount >= limits.maxResidentGroups) {
        this.wait(row, 'CAPACITY', null);
        break;
      }
      const extra = need > owned ? need - owned : 0n;
      const spaceFits = groupReserved() + extra <= maximum;
      const diskFits = free >= reserve + unwritten() + extra;
      if (!spaceFits || !diskFits) {
        this.wait(row, diskFits ? 'CAPACITY' : 'DISK', null);
        oldestBlocked ??= { row, extra };
        continue;
      }
      if (oldestBlocked && extra > 0n) {
        // Backfill only space that is not needed by the oldest blocked group
        // after the next resident completes. A polling count/age must not keep
        // useful space idle forever, nor may small arrivals starve the head.
        const releases = rows
          .filter((x) => x.admission === 'ADMITTED' && x.job_id !== null)
          .map((x) => reservations.get(x.job_id!) ?? 0n)
          .filter((value) => value > 0n);
        const smallestRelease = releases.length === 0 ? 0n : releases.reduce(minimum);
        const headroom = minimum(maximum - groupReserved(), free - reserve - unwritten());
        if (headroom - extra + smallestRelease < oldestBlocked.extra) {
          this.wait(row, 'FAIRNESS', null);
          continue;
        }
      }
      const admitted = db
        .transaction(() => {
          if (!this.isRunnable(row.job_id!, true) || !this.parentReady(row.pipeline_id, true))
            return false;
          const live = db
            .prepare('SELECT admission FROM import_pipeline_groups WHERE job_id=?')
            .pluck()
            .get(row.job_id);
          if (!['WAITING', 'CACHED'].includes(String(live))) return false;
          if (!capacity.tryResize(row.job_id!, need.toString())) return false;
          db.prepare(
            `UPDATE import_pipeline_groups SET admission='ADMITTED',wait_kind=NULL,bypass_count=0,
          last_error_code=NULL,issue=CASE WHEN issue='GROUP_EXCEEDS_RESIDENT_BUDGET' THEN NULL ELSE issue END,revision=revision+1,updated_at=? WHERE job_id=?`,
          ).run(now, row.job_id);
          db.prepare('UPDATE import_pipelines SET revision=revision+1,updated_at=? WHERE id=?').run(
            now,
            row.pipeline_id,
          );
          return true;
        })
        .immediate();
      if (admitted) {
        activeCount++;
        row.admission = 'ADMITTED';
        reservations = reservationMap();
        if (oldestBlocked)
          db.prepare(
            'UPDATE import_pipeline_groups SET bypass_count=MIN(bypass_count+1,1000000) WHERE job_id=?',
          ).run(oldestBlocked.row.job_id);
        try {
          this.options.onAdmitted?.(row.job_id!, row.needs_redownload === 1);
        } catch {
          /* optional history */
        }
      } else this.wait(row, 'CAPACITY', null);
    }
    // A resumed cached group leaves the waiting pool before any eviction. Never
    // throw away a recoverable prefix immediately before admitting its owner.
    await this.reclaimWaitingCache(now, limits);
  }
  private async reclaimWaitingCache(now: number, limits: GroupAdmissionLimits): Promise<void> {
    if (!this.options.evict) return;
    const rows = this.options.repository.admissionRows();
    // Frozen outputs cannot be evicted before the recovery receipt. Counting
    // them against the input-cache allowance made even a small interrupted
    // download get evicted whenever a large upload entered backoff. All these
    // bytes still count against the global resident/spool budget above.
    const inputCaches = rows.filter(
      (x) =>
        x.admission === 'CACHED' &&
        !['PREPARING_VIDEOS', 'READY', 'CLEANED'].includes(x.archive_phase ?? ''),
    );
    let cached = inputCaches.reduce((sum, x) => sum + bytes(x.resident_bytes), 0n);
    const maximum = bytes(limits.waitingCacheMaxBytes);
    if (cached <= maximum) return;
    const progress = new Map(
      (
        this.options.db
          .prepare(
            "SELECT job_id,MAX(updated_at) AS at FROM archive_inputs WHERE completed_bytes!='0' GROUP BY job_id",
          )
          .all() as Array<{ job_id: string; at: number }>
      ).map((x) => [x.job_id, x.at]),
    );
    const recent = (row: PipelineAdmissionRow) =>
      (progress.get(row.job_id!) ?? 0) > now - 300000 ? 1 : 0;
    const candidates = inputCaches
      .filter(
        (x) =>
          x.admission === 'CACHED' &&
          x.job_id !== null &&
          x.cache_probe_after <= now &&
          this.job(x.job_id, true).state !== 'RUNNING',
      )
      .sort(
        (a, b) =>
          recent(a) - recent(b) ||
          (progress.get(a.job_id!) ?? 0) - (progress.get(b.job_id!) ?? 0) ||
          a.ordinal - b.ordinal,
      );
    for (const row of candidates) {
      // An eligible retry that lacks space is still an idle cache. Skipping all
      // such old caches used to evict the group that had just hit a short fault.
      // Recent progress is preferred, not an exemption from the configured cap;
      // the spool manager still proves source readability and sole ownership.
      const evicted = await this.options.evict(row.job_id!);
      this.options.db
        .prepare('UPDATE import_pipeline_groups SET cache_probe_after=? WHERE job_id=?')
        .run(this.now() + 60000, row.job_id);
      if (evicted) cached -= bytes(row.resident_bytes);
      if (cached <= maximum) break;
    }
  }
  private wait(row: PipelineAdmissionRow, kind: string, error: string | null): void {
    if (row.wait_kind === kind && row.last_error_code === error && row.wait_since !== null) return;
    this.options.db
      .prepare(
        `UPDATE import_pipeline_groups SET wait_kind=?,last_error_code=?,wait_since=COALESCE(wait_since,?),updated_at=? WHERE job_id=? AND admission IN ('WAITING','CACHED')`,
      )
      .run(kind, error, this.now(), this.now(), row.job_id);
  }
  private loadStateSnapshot(): void {
    const rows = this.options.db
      .prepare(
        `SELECT j.id,j.state,j.attempt,j.paused,j.pause_requested_at,j.cancel_requested_at,j.retry_at FROM import_jobs j JOIN import_pipeline_groups g ON g.job_id=j.id WHERE g.admission<>'COMPLETE'`,
      )
      .all() as Array<Job & { id: string }>;
    this.jobs = new Map(rows.map((row) => [row.id, row]));
    this.readyParents = new Set(
      this.options.db
        .prepare('SELECT id FROM import_pipelines WHERE paused=0 AND cancel_requested=0')
        .pluck()
        .all() as string[],
    );
  }
  private job(jobId: string, fresh = false): Job {
    const cached = this.jobs.get(jobId);
    if (!fresh && cached) return cached;
    return this.options.db
      .prepare(
        'SELECT state,attempt,paused,pause_requested_at,cancel_requested_at,retry_at FROM import_jobs WHERE id=?',
      )
      .get(jobId) as Job;
  }
  private isRunnable(jobId: string, fresh = false): boolean {
    const job = this.job(jobId, fresh);
    return (
      !job.paused &&
      job.pause_requested_at === null &&
      job.cancel_requested_at === null &&
      (job.state === 'QUEUED' ||
        (job.state === 'RETRY_WAIT' && job.retry_at !== null && job.retry_at <= this.now()))
    );
  }
  private parentReady(id: string, fresh = false): boolean {
    if (!fresh) return this.readyParents.has(id);
    return (
      this.options.db
        .prepare('SELECT 1 FROM import_pipelines WHERE id=? AND paused=0 AND cancel_requested=0')
        .get(id) !== undefined
    );
  }
}
