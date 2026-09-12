import {
  AsyncSemaphore,
  type SemaphoreObservation,
  type SemaphoreObserver,
} from '../../storage/resource-scheduler.js';

export type ImportResourceKind = 'MAX_IN_FLIGHT' | 'LOCAL_PREPARATION' | 'UPLOAD';

export type ImportResourceLimits = {
  maxInFlight: number;
  localPreparationConcurrency: number;
  uploadConcurrency: number;
};

export type ImportResourceObservation = SemaphoreObservation & { position: number };

export interface ImportResourceWaitSink {
  waiting(jobId: string, kind: ImportResourceKind, observation: ImportResourceObservation): void;
  acquired(jobId: string, kind: ImportResourceKind, observation: SemaphoreObservation): void;
  released(jobId: string, kind: ImportResourceKind): void;
}

export type ImportResourceStats = {
  active: number;
  pending: number;
  capacity: number;
  executing: number;
};

export type ImportResourceSchedulerStats = {
  maxInFlight: ImportResourceStats;
  localPreparation: ImportResourceStats;
  upload: ImportResourceStats;
};

const NOOP_SINK: ImportResourceWaitSink = {
  waiting: () => undefined,
  acquired: () => undefined,
  released: () => undefined,
};

/** Three independent import resources; no hidden future-concurrency bucket. */
export class ImportResourceScheduler {
  private readonly maxInFlight: AsyncSemaphore;
  private readonly localPreparation: AsyncSemaphore;
  private readonly upload: AsyncSemaphore;
  private readonly sink: ImportResourceWaitSink;
  private readonly executing = new Map<ImportResourceKind, number>([
    ['MAX_IN_FLIGHT', 0],
    ['LOCAL_PREPARATION', 0],
    ['UPLOAD', 0],
  ]);

  constructor(limits: ImportResourceLimits, sink: ImportResourceWaitSink = NOOP_SINK) {
    validateLimits(limits);
    this.maxInFlight = new AsyncSemaphore(limits.maxInFlight);
    this.localPreparation = new AsyncSemaphore(limits.localPreparationConcurrency);
    this.upload = new AsyncSemaphore(limits.uploadConcurrency);
    this.sink = sink;
  }

  applyLimits(limits: ImportResourceLimits): void {
    validateLimits(limits);
    this.maxInFlight.resize(limits.maxInFlight);
    this.localPreparation.resize(limits.localPreparationConcurrency);
    this.upload.resize(limits.uploadConcurrency);
  }

  stats(): ImportResourceSchedulerStats {
    return {
      maxInFlight: this.read(this.maxInFlight, 'MAX_IN_FLIGHT'),
      localPreparation: this.read(this.localPreparation, 'LOCAL_PREPARATION'),
      upload: this.read(this.upload, 'UPLOAD'),
    };
  }

  withMaxInFlight<T>(jobId: string, signal: AbortSignal, body: () => T | Promise<T>): Promise<T> {
    return this.run(this.maxInFlight, jobId, 'MAX_IN_FLIGHT', signal, body);
  }

  withLocalPreparation<T>(
    jobId: string,
    signal: AbortSignal,
    body: () => T | Promise<T>,
  ): Promise<T> {
    return this.run(this.localPreparation, jobId, 'LOCAL_PREPARATION', signal, body);
  }

  withUpload<T>(jobId: string, signal: AbortSignal, body: () => T | Promise<T>): Promise<T> {
    return this.run(this.upload, jobId, 'UPLOAD', signal, body);
  }

  private async run<T>(
    semaphore: AsyncSemaphore,
    jobId: string,
    kind: ImportResourceKind,
    signal: AbortSignal,
    body: () => T | Promise<T>,
  ): Promise<T> {
    let acquired = false;
    const observer: SemaphoreObserver = {
      queued: (observation) => this.sink.waiting(jobId, kind, observation),
      acquired: (observation) => {
        acquired = true;
        this.sink.acquired(jobId, kind, observation);
      },
    };
    try {
      return await semaphore.run(
        signal,
        async () => {
          this.executing.set(kind, (this.executing.get(kind) ?? 0) + 1);
          try {
            return await body();
          } finally {
            this.executing.set(kind, Math.max(0, (this.executing.get(kind) ?? 1) - 1));
          }
        },
        observer,
      );
    } finally {
      // Also runs on queued abort so a durable wait cannot survive cancellation.
      if (acquired || signal.aborted) this.sink.released(jobId, kind);
    }
  }

  private read(semaphore: AsyncSemaphore, kind: ImportResourceKind): ImportResourceStats {
    return {
      active: semaphore.activeCount,
      pending: semaphore.pendingCount,
      capacity: semaphore.capacity,
      executing: this.executing.get(kind) ?? 0,
    };
  }
}

function validateLimits(limits: ImportResourceLimits): void {
  for (const value of [
    limits.maxInFlight,
    limits.localPreparationConcurrency,
    limits.uploadConcurrency,
  ]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 8) {
      throw new Error('IMPORT_RESOURCE_LIMIT_INVALID');
    }
  }
}
