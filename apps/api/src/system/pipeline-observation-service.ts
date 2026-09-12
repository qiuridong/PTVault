import { randomUUID } from 'node:crypto';
import type {
  PipelineMetrics,
  PipelineObservationEventInput,
  PipelineObservationQuery,
  PipelineObservationResponse,
  PipelineObservationSummary,
} from '@ptvault/contracts';
import type { AppDatabase } from '../db/database.js';
import type { GroupResourceEvent, GroupResourceScheduler } from '../imports/groups/resources.js';
import type { GroupSettingsService } from '../imports/groups/settings.js';
import type { HostSnapshot } from './host-metrics.js';
import { LinuxPressureSampler } from './pipeline-pressure.js';
import type { PipelineActivitySampler } from './pipeline-activity.js';
import type { PipelineObservationStore } from './pipeline-observation-store.js';

type Options = {
  db: AppDatabase;
  store: PipelineObservationStore;
  settings: GroupSettingsService;
  resources: GroupResourceScheduler;
  reservedBytes: () => string;
  build: string;
  now?: () => number;
  pressure?: Pick<LinuxPressureSampler, 'sample'>;
  activity?: Pick<PipelineActivitySampler, 'sample'>;
};
type Identity = { pipeline_id: string; group_key: string; attempt: number };
type DurableEvent = {
  rowid: number;
  id: string;
  job_id: string;
  pipeline_id: string;
  group_key: string;
  event_code: string;
  created_at: number;
  bytes: string | null;
  elapsed_ms: string | null;
  error_class: string | null;
};
const numericBytes = (value: string) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};
const knownCode = (value: string) => /^[A-Z][A-Z0-9_]{0,79}$/.test(value);

/** Reuses the existing 10-second host clock; there is no second process-scanning loop. */
export class PipelineObservationService {
  private readonly now: () => number;
  private readonly pressure: Pick<LinuxPressureSampler, 'sample'>;
  private pending: Promise<void> | undefined;
  private pressureCount = 0;
  private pressureAt: number | null = null;
  private lastHostAt: number | null = null;
  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.pressure = options.pressure ?? new LinuxPressureSampler();
  }
  onHostSample(host: HostSnapshot, extra: { cpuStealPercent: number | null }): void {
    // Slow optional file I/O drops a sample instead of queuing an unbounded backlog.
    if (this.pending) return;
    const run = this.sample(host, extra)
      .catch(() => {
        this.pressureCount = 0;
      })
      .finally(() => {
        if (this.pending === run) this.pending = undefined;
      });
    this.pending = run;
  }
  async idle(): Promise<void> {
    await this.pending;
  }
  async close(): Promise<void> {
    await this.idle();
    this.options.store.close();
  }
  holdNewAdmission(): boolean {
    return (
      this.pressureCount >= 2 &&
      this.pressureAt !== null &&
      this.now() >= this.pressureAt &&
      this.now() - this.pressureAt <= 30000
    );
  }
  recordResource(event: GroupResourceEvent): void {
    const identity = this.identity(event.jobId);
    if (!identity) return;
    const kind = event.kind === 'IN_FLIGHT' ? 'CAPACITY' : event.kind;
    if (event.event === 'WAITING')
      this.options.db
        .prepare(
          'UPDATE import_pipeline_groups SET wait_kind=?,wait_since=COALESCE(wait_since,?),updated_at=? WHERE job_id=?',
        )
        .run(kind, event.at, event.at, event.jobId);
    if (event.event === 'ACQUIRED')
      this.options.db
        .prepare(
          'UPDATE import_pipeline_groups SET wait_kind=NULL,wait_since=NULL,updated_at=? WHERE job_id=? AND wait_kind=?',
        )
        .run(event.at, event.jobId, kind);
    this.record({
      kind: event.event,
      code: event.kind,
      at: event.at,
      jobId: event.jobId,
      durationMs: event.elapsedMs,
    });
  }
  record(
    input: Pick<PipelineObservationEventInput, 'kind' | 'code'> &
      Partial<Pick<PipelineObservationEventInput, 'jobId' | 'at' | 'durationMs' | 'bytes'>>,
  ): void {
    const identity = input.jobId ? this.identity(input.jobId) : undefined;
    this.options.store.enqueueEvent({
      id: randomUUID(),
      at: input.at ?? this.now(),
      kind: input.kind,
      code: input.code,
      jobId: input.jobId ?? null,
      pipelineId: identity?.pipeline_id ?? null,
      groupKey: identity?.group_key ?? null,
      attempt: identity?.attempt ?? null,
      durationMs: input.durationMs ?? null,
      bytes: input.bytes ?? null,
      configRevision: this.options.settings.status().revision,
      build: this.options.build,
    });
  }
  captureDurableEvents(): void {
    const { db, store } = this.options;
    if (store.status().state === 'UNAVAILABLE') return;
    const rows = db
      .prepare(
        `SELECT e.rowid,e.id,e.job_id,e.event_code,e.created_at,e.bytes,e.elapsed_ms,e.error_class,g.pipeline_id,g.group_key
      FROM import_events e JOIN import_pipeline_groups g ON g.job_id=e.job_id
      WHERE e.rowid>? ORDER BY e.rowid LIMIT 100`,
      )
      .all(store.cursor()) as DurableEvent[];
    const events: PipelineObservationEventInput[] = [];
    for (const row of rows) {
      if (!knownCode(row.event_code)) continue;
      const claim = db
        .prepare(
          `SELECT detail_sanitized FROM import_events WHERE job_id=? AND rowid<=? AND event_code='IMPORT_WORKER_CLAIMED' ORDER BY rowid DESC LIMIT 1`,
        )
        .pluck()
        .get(row.job_id, row.rowid) as string | undefined;
      const attemptText = /^attempt:(\d+)$/.exec(claim ?? '')?.[1];
      events.push({
        id: `durable:${row.id}`,
        at: row.created_at,
        kind:
          row.error_class !== null
            ? 'FAILED'
            : row.event_code === 'IMPORT_OBJECT_COMMITTED_VERIFIED'
              ? 'VERIFIED'
              : 'STATE',
        code: row.event_code,
        failureCode:
          row.error_class !== null && knownCode(row.error_class) ? row.error_class : null,
        jobId: row.job_id,
        pipelineId: row.pipeline_id,
        groupKey: row.group_key,
        attempt: attemptText ? Number(attemptText) : null,
        bytes: row.bytes !== null && /^(0|[1-9]\d{0,29})$/.test(row.bytes) ? row.bytes : null,
        durationMs: row.elapsed_ms === null ? null : numericBytes(row.elapsed_ms),
        // Business history predates this observer and does not persist build/config at each event.
        configRevision: null,
        build: null,
      });
    }
    const cursor =
      rows.at(-1)?.rowid ??
      (db.prepare('SELECT COALESCE(max(rowid),0) FROM import_events').pluck().get() as number);
    if (cursor > store.cursor()) store.enqueueImported(events, cursor);
  }
  history(query: PipelineObservationQuery): PipelineObservationResponse {
    const history = this.options.store.history(query),
      events = this.options.store.events({ ...query, limit: 1000 });
    const summary = this.summary(query);
    summary.observedHours =
      history.firstSampleAt === null || history.lastSampleAt === null
        ? 0
        : (history.lastSampleAt - history.firstSampleAt) / 3600000;
    const samplesEnough = history.coverage >= 0.8 && summary.observedHours >= 6;
    summary.sufficient = samplesEnough && summary.completedGroups >= 3;
    summary.reason = !samplesEnough
      ? 'INSUFFICIENT_SAMPLES'
      : summary.completedGroups < 3
        ? 'INSUFFICIENT_COMPLETIONS'
        : 'SUFFICIENT_FOR_COMPARISON';
    return {
      ...history,
      summary,
      events: events.events,
      eventsTruncated: events.truncated,
      context: {
        qbittorrent: 'NOT_ATTRIBUTED',
        jellyfin: 'NOT_ATTRIBUTED',
        cgroup: 'API_WITH_CHILDREN',
      },
    };
  }
  private identity(jobId: string): Identity | undefined {
    return this.options.db
      .prepare(
        'SELECT g.pipeline_id,g.group_key,j.attempt FROM import_pipeline_groups g JOIN import_jobs j ON j.id=g.job_id WHERE g.job_id=?',
      )
      .get(jobId) as Identity | undefined;
  }
  private async sample(
    host: HostSnapshot,
    extra: { cpuStealPercent: number | null },
  ): Promise<void> {
    const at = this.now();
    const [optional, activity] = await Promise.all([
      this.pressure.sample(at),
      this.options.activity?.sample(at).catch(() => ({})) ?? Promise.resolve({}),
    ]);
    const memory = host.memory;
    const pressure =
      memory !== null &&
      memory.totalBytes > 0 &&
      memory.availableBytes / memory.totalBytes < 0.05 &&
      ((optional.hostMemoryPressureSome ?? 0) >= 20 ||
        (optional.hostMemoryPressureFull ?? 0) >= 10);
    const fresh =
      host.source === 'PROC' &&
      host.sampledAt !== null &&
      at >= host.sampledAt &&
      at - host.sampledAt <= 30000;
    if (!fresh || !pressure) this.pressureCount = 0;
    else if (host.sampledAt !== this.lastHostAt)
      this.pressureCount =
        this.pressureAt !== null && at - this.pressureAt <= 30000 ? this.pressureCount + 1 : 1;
    this.pressureAt = fresh ? at : null;
    this.lastHostAt = host.sampledAt;
    const uplink = host.interfaces.find((entry) => entry.isDefaultRoute);
    const sumDisk = (key: 'readBytesPerSecond' | 'writeBytesPerSecond') => {
      const numbers = host.disks
        .map((disk) => disk[key])
        .filter((value): value is number => value !== null);
      return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) : null;
    };
    const resident = this.options.db
      .prepare("SELECT resident_bytes FROM import_pipeline_groups WHERE admission<>'COMPLETE'")
      .pluck()
      .all() as string[];
    const stats = this.options.resources.stats();
    const metrics: PipelineMetrics = {
      ...optional,
      ...activity,
      hostCpuPercent: host.cpu?.usagePercent ?? null,
      hostStealPercent: extra.cpuStealPercent,
      hostMemoryUsedPercent:
        memory === null || memory.totalBytes <= 0
          ? null
          : Math.max(0, (1 - memory.availableBytes / memory.totalBytes) * 100),
      hostSwapUsedBytes: memory?.swapUsedBytes ?? null,
      hostReadBps: sumDisk('readBytesPerSecond'),
      hostWriteBps: sumDisk('writeBytesPerSecond'),
      hostRxBps: uplink?.rxBytesPerSecond ?? null,
      hostTxBps: uplink?.txBytesPerSecond ?? null,
      downloadActive: stats.download.active,
      extractionActive: stats.extraction.active,
      uploadActive: stats.upload.active,
      residentBytes: numericBytes(
        resident.reduce((sum, value) => sum + BigInt(value), 0n).toString(),
      ),
      reservedBytes: numericBytes(this.options.reservedBytes()),
    };
    this.captureDurableEvents();
    this.options.store.enqueueSample({
      at,
      metrics,
      configRevision: this.options.settings.status().revision,
      build: this.options.build,
    });
  }
  private summary(query: PipelineObservationQuery): PipelineObservationSummary {
    const db = this.options.db;
    const receipts = db
      .prepare(
        `WITH first_verified AS (
        SELECT job_id,object_id,min(rowid) AS receipt FROM import_receipts WHERE kind='COMMITTED_VERIFIED' GROUP BY job_id,object_id)
      SELECT r.size FROM first_verified f JOIN import_receipts r ON r.rowid=f.receipt
        JOIN import_pipeline_groups g ON g.job_id=f.job_id WHERE r.created_at>=? AND r.created_at<=?`,
      )
      .pluck()
      .iterate(query.from, query.to) as Iterable<string | null>;
    let total = 0n;
    for (const size of receipts) if (size !== null && /^\d+$/.test(size)) total += BigInt(size);
    const count = (condition: string) =>
      db
        .prepare(
          `SELECT count(DISTINCT e.job_id) FROM import_events e JOIN import_pipeline_groups g ON g.job_id=e.job_id WHERE e.created_at>=? AND e.created_at<=? AND ${condition}`,
        )
        .pluck()
        .get(query.from, query.to) as number;
    return {
      verifiedBytes: total.toString(),
      verifiedGiBPerHour: Number(total) / 1024 ** 3 / ((query.to - query.from) / 3600000),
      completedGroups: count("e.event_code='IMPORT_COMPLETED'"),
      failedGroups: count('e.error_class IS NOT NULL'),
      observedHours: 0,
      sufficient: false,
      reason: 'INSUFFICIENT_SAMPLES',
    };
  }
}
