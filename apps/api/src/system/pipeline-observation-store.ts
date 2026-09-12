import { statSync } from 'node:fs';
import Database from 'better-sqlite3';
import {
  PipelineObservationEventSchema,
  PipelineObservationSampleSchema,
  type PipelineMetric,
  type PipelineMetrics,
  type PipelineObservationSample,
  type PipelineObservationEvent,
  type PipelineObservationHistory,
  type PipelineObservationQuery,
  type PipelineObservationPoint,
  type PipelineObservationStatus,
} from '@ptvault/contracts';

const DAY = 86400000;
type Aggregate = {
  first: number;
  last: number;
  samples: number;
  valid: number;
  configRevision: number | null;
  build: string | null;
  values: Partial<Record<PipelineMetric, { sum: number; count: number; max: number }>>;
};
type Entry =
  | { sample: PipelineObservationSample }
  | { event: PipelineObservationEvent }
  | { imported: PipelineObservationEvent[]; cursor: number };
type Options = { path: string; now?: () => number; maxBytes?: number; queueLimit?: number };

function aggregate(sample: PipelineObservationSample): Aggregate {
  const values: Aggregate['values'] = {};
  for (const [key, value] of Object.entries(sample.metrics) as Array<
    [PipelineMetric, number | null]
  >) {
    if (value !== null) values[key] = { sum: value, count: 1, max: value };
  }
  return {
    first: sample.at,
    last: sample.at,
    samples: 1,
    valid:
      sample.metrics.hostCpuPercent != null || sample.metrics.hostMemoryUsedPercent != null ? 1 : 0,
    configRevision: sample.configRevision,
    build: sample.build,
    values,
  };
}
function merge(left: Aggregate, right: Aggregate): Aggregate {
  left.first = Math.min(left.first, right.first);
  left.last = Math.max(left.last, right.last);
  left.samples += right.samples;
  left.valid += right.valid;
  if (left.configRevision !== right.configRevision) left.configRevision = null;
  if (left.build !== right.build) left.build = null;
  for (const [key, value] of Object.entries(right.values) as Array<
    [PipelineMetric, NonNullable<Aggregate['values'][PipelineMetric]>]
  >) {
    const prior = left.values[key];
    left.values[key] = prior
      ? {
          sum: prior.sum + value.sum,
          count: prior.count + value.count,
          max: Math.max(prior.max, value.max),
        }
      : { ...value };
  }
  return left;
}
function point(at: number, value: Aggregate): PipelineObservationPoint {
  const metrics: PipelineMetrics = {},
    maxima: PipelineMetrics = {};
  for (const [key, metric] of Object.entries(value.values) as Array<
    [PipelineMetric, NonNullable<Aggregate['values'][PipelineMetric]>]
  >) {
    metrics[key] = metric.sum / metric.count;
    maxima[key] = metric.max;
  }
  return {
    at,
    samples: value.samples,
    metrics,
    maxima,
    configRevision: value.configRevision,
    build: value.build,
  };
}

/** Independent, disposable observation database. Never participates in a migration transaction. */
export class PipelineObservationStore {
  private db: Database.Database | undefined;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly queueLimit: number;
  private readonly mainLimit: number;
  private queue: Entry[] = [];
  private scheduled: NodeJS.Immediate | undefined;
  private dropped = 0;
  private degraded = false;
  private lastSampleAt: number | null = null;
  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.maxBytes = Math.max(1024 * 1024, options.maxBytes ?? 256 * 1024 * 1024);
    this.queueLimit = Math.max(1, Math.min(1000, options.queueLimit ?? 1000));
    this.mainLimit = this.maxBytes - Math.min(32 * 1024 * 1024, Math.floor(this.maxBytes / 3));
    try {
      const db = new Database(options.path, { timeout: 0 });
      this.db = db;
      db.pragma('auto_vacuum = INCREMENTAL');
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('busy_timeout = 0');
      db.pragma('wal_autocheckpoint = 128');
      db.pragma(
        `journal_size_limit = ${Math.min(16 * 1024 * 1024, Math.floor(this.maxBytes / 6))}`,
      );
      const pageSize = db.pragma('page_size', { simple: true }) as number;
      db.pragma(`max_page_count = ${Math.floor(this.mainLimit / pageSize)}`);
      db.exec(`CREATE TABLE IF NOT EXISTS raw(at INTEGER PRIMARY KEY,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS minutes(at INTEGER PRIMARY KEY,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,at INTEGER NOT NULL,payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS event_time ON events(at);
        CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value INTEGER NOT NULL);`);
      this.lastSampleAt =
        (db.prepare("SELECT value FROM metadata WHERE key='lastSampleAt'").pluck().get() as
          number | undefined) ?? null;
      this.maintain();
    } catch {
      try {
        this.db?.close();
      } catch {
        /* optional file */
      }
      this.db = undefined;
    }
  }
  enqueueSample(input: unknown): void {
    const parsed = PipelineObservationSampleSchema.safeParse(input);
    if (!parsed.success) {
      this.dropped += 1;
      return;
    }
    this.enqueue({ sample: parsed.data });
  }
  enqueueEvent(input: unknown): void {
    const parsed = PipelineObservationEventSchema.safeParse(input);
    if (!parsed.success) {
      this.dropped += 1;
      return;
    }
    this.enqueue({ event: parsed.data });
  }
  /** One atomic queue entry: a failed event batch never advances the durable cursor. */
  enqueueImported(events: unknown[], cursor: number): boolean {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || events.length > 100) return false;
    const parsed = PipelineObservationEventSchema.array().safeParse(events);
    if (!parsed.success) {
      this.dropped += events.length;
      return false;
    }
    return this.enqueue({ imported: parsed.data, cursor });
  }
  cursor(): number {
    try {
      return (
        (this.db?.prepare("SELECT value FROM metadata WHERE key='eventCursor'").pluck().get() as
          number | undefined) ?? 0
      );
    } catch {
      this.degraded = true;
      return 0;
    }
  }
  status(): PipelineObservationStatus {
    return {
      state: !this.db ? 'UNAVAILABLE' : this.degraded ? 'DEGRADED' : 'HEALTHY',
      storageBytes: this.storageBytes(),
      maxBytes: this.maxBytes,
      queued: this.queueSize(),
      dropped: this.dropped,
      lastSampleAt: this.lastSampleAt,
      rawRetentionDays: 7,
      minuteRetentionDays: 30,
    };
  }
  /** Small synchronous batches are scheduled outside the critical sampler/worker callback. */
  flush(): void {
    if (this.scheduled) {
      clearImmediate(this.scheduled);
      this.scheduled = undefined;
    }
    const db = this.db;
    if (!db) {
      this.dropped += this.queue.length;
      this.queue = [];
      return;
    }
    const entries = this.queue.splice(0, 100);
    try {
      db.transaction(() => {
        for (const entry of entries) {
          if ('event' in entry) {
            db.prepare('INSERT OR IGNORE INTO events(id,at,payload) VALUES(?,?,?)').run(
              entry.event.id,
              entry.event.at,
              JSON.stringify(entry.event),
            );
          } else if ('cursor' in entry) {
            for (const event of entry.imported)
              db.prepare('INSERT OR IGNORE INTO events(id,at,payload) VALUES(?,?,?)').run(
                event.id,
                event.at,
                JSON.stringify(event),
              );
            db.prepare(
              "INSERT INTO metadata(key,value) VALUES('eventCursor',?) ON CONFLICT(key) DO UPDATE SET value=max(value,excluded.value)",
            ).run(entry.cursor);
          } else {
            const sample = entry.sample;
            const inserted = db
              .prepare('INSERT OR IGNORE INTO raw(at,payload) VALUES(?,?)')
              .run(sample.at, JSON.stringify(sample));
            if (!inserted.changes) continue;
            const minute = Math.floor(sample.at / 60000) * 60000;
            const previous = db
              .prepare('SELECT payload FROM minutes WHERE at=?')
              .pluck()
              .get(minute) as string | undefined;
            const combined = previous
              ? merge(JSON.parse(previous) as Aggregate, aggregate(sample))
              : aggregate(sample);
            db.prepare(
              'INSERT INTO minutes(at,payload) VALUES(?,?) ON CONFLICT(at) DO UPDATE SET payload=excluded.payload',
            ).run(minute, JSON.stringify(combined));
            db.prepare(
              "INSERT INTO metadata(key,value) VALUES('lastSampleAt',?) ON CONFLICT(key) DO UPDATE SET value=max(value,excluded.value)",
            ).run(sample.at);
          }
        }
      })();
      this.lastSampleAt =
        (db.prepare("SELECT value FROM metadata WHERE key='lastSampleAt'").pluck().get() as
          number | undefined) ?? null;
      this.maintain();
      this.degraded = false;
    } catch {
      this.degraded = true;
      this.dropped += entries.length;
      // FULL/busy/permission issues cost telemetry, not a migration or an API restart.
      try {
        this.maintain(true);
      } catch {
        /* next sample retries */
      }
    }
    this.schedule();
  }
  history(query: PipelineObservationQuery): PipelineObservationHistory {
    const resolution =
      query.to - query.from <= 6 * 3600000 && query.from >= this.now() - 7 * DAY ? 'RAW' : 'MINUTE';
    const result: PipelineObservationHistory = {
      ...query,
      resolution,
      points: [],
      sampleCount: 0,
      firstSampleAt: null,
      lastSampleAt: null,
      coverage: 0,
      status: this.status(),
    };
    try {
      const db = this.db;
      if (!db) return result;
      const bins = new Map<number, Aggregate>();
      const width = Math.max(
        resolution === 'RAW' ? 1 : 60000,
        Math.ceil((query.to - query.from) / query.maxPoints),
      );
      const rows = db
        .prepare(
          `SELECT at,payload FROM ${resolution === 'RAW' ? 'raw' : 'minutes'} WHERE at>=? AND at<? ORDER BY at LIMIT 60000`,
        )
        .iterate(query.from, query.to) as Iterable<{ at: number; payload: string }>;
      for (const row of rows) {
        const value =
          resolution === 'RAW'
            ? aggregate(JSON.parse(row.payload) as PipelineObservationSample)
            : (JSON.parse(row.payload) as Aggregate);
        const bucket = query.from + Math.floor((row.at - query.from) / width) * width;
        const prior = bins.get(bucket);
        bins.set(bucket, prior ? merge(prior, value) : value);
      }
      let valid = 0;
      for (const [at, value] of bins) {
        result.points.push(point(at, value));
        result.sampleCount += value.samples;
        valid += value.valid;
        result.firstSampleAt =
          result.firstSampleAt === null ? value.first : Math.min(result.firstSampleAt, value.first);
        result.lastSampleAt =
          result.lastSampleAt === null ? value.last : Math.max(result.lastSampleAt, value.last);
      }
      result.coverage = Math.min(1, (valid * 10000) / (query.to - query.from));
    } catch {
      this.degraded = true;
      result.points = [];
      result.sampleCount = 0;
      result.coverage = 0;
      result.firstSampleAt = null;
      result.lastSampleAt = null;
    }
    result.status = this.status();
    return result;
  }
  events(query: { from: number; to: number; limit: number }): {
    events: PipelineObservationEvent[];
    truncated: boolean;
  } {
    try {
      const limit = Math.max(1, Math.min(1000, query.limit));
      const rows = this.db
        ?.prepare('SELECT payload FROM events WHERE at>=? AND at<=? ORDER BY at DESC,id LIMIT ?')
        .all(query.from, query.to, limit + 1) as Array<{ payload: string }> | undefined;
      return {
        events: (rows ?? [])
          .slice(0, limit)
          .map((row) => PipelineObservationEventSchema.parse(JSON.parse(row.payload))),
        truncated: (rows?.length ?? 0) > limit,
      };
    } catch {
      this.degraded = true;
      return { events: [], truncated: false };
    }
  }
  close(): void {
    while (this.queue.length) this.flush();
    if (this.scheduled) clearImmediate(this.scheduled);
    this.scheduled = undefined;
    try {
      this.db?.pragma('wal_checkpoint(TRUNCATE)');
      this.db?.close();
    } catch {
      /* optional shutdown */
    }
    this.db = undefined;
  }
  private enqueue(entry: Entry): boolean {
    const weight = 'imported' in entry ? entry.imported.length + 1 : 1;
    if (!this.db || this.queueSize() + weight > this.queueLimit) {
      this.dropped += weight;
      return false;
    }
    this.queue.push(entry);
    this.schedule();
    return true;
  }
  private queueSize(): number {
    return this.queue.reduce(
      (sum, entry) => sum + ('imported' in entry ? entry.imported.length + 1 : 1),
      0,
    );
  }
  private schedule(): void {
    if (!this.scheduled && this.queue.length)
      this.scheduled = setImmediate(() => {
        this.scheduled = undefined;
        this.flush();
      }).unref();
  }
  private storageBytes(): number {
    let bytes = 0;
    for (const suffix of ['', '-wal', '-shm'])
      try {
        bytes += statSync(this.options.path + suffix).size;
      } catch {
        /* absent */
      }
    return bytes;
  }
  private maintain(pressure = false): void {
    const db = this.db;
    if (!db) return;
    const now = this.now();
    db.prepare('DELETE FROM raw WHERE at<?').run(now - 7 * DAY);
    db.prepare('DELETE FROM minutes WHERE at<?').run(now - 30 * DAY);
    db.prepare('DELETE FROM events WHERE at<?').run(now - 30 * DAY);
    const used = () =>
      ((db.pragma('page_count', { simple: true }) as number) -
        (db.pragma('freelist_count', { simple: true }) as number)) *
      (db.pragma('page_size', { simple: true }) as number);
    for (let pass = 0; pass < 4 && (pressure || used() > this.mainLimit * 0.85); pass += 1) {
      for (const [table, key, limit] of [
        ['raw', 'at', 2000],
        ['minutes', 'at', 2000],
        ['events', 'id', 2000],
      ] as const)
        db.exec(
          `DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} ORDER BY at LIMIT ${limit})`,
        );
      pressure = false;
    }
    db.pragma('incremental_vacuum(256)');
    db.pragma('wal_checkpoint(TRUNCATE)');
  }
}
