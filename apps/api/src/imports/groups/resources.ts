import { AsyncSemaphore } from '../../storage/resource-scheduler.js';
export type GroupResourceLimits = {
  maxResidentGroups: number;
  downloadConcurrency: number;
  extractionConcurrency: number;
  uploadConcurrency: number;
};
export type GroupResourceKind = 'IN_FLIGHT' | 'DOWNLOAD' | 'EXTRACTION' | 'UPLOAD';
export type GroupResourceEvent = {
  jobId: string;
  kind: GroupResourceKind;
  event: 'WAITING' | 'ACQUIRED' | 'RELEASED';
  at: number;
  elapsedMs: number;
  active: number;
  pending: number;
  capacity: number;
  position?: number;
};
export type GroupResourceSink = { record: (event: GroupResourceEvent) => void };

/** Group-only permits. Legacy v1/v2/v3 scheduling remains unchanged. */
export class GroupResourceScheduler {
  private readonly inFlight: AsyncSemaphore;
  private readonly download: AsyncSemaphore;
  private readonly extraction: AsyncSemaphore;
  private readonly upload: AsyncSemaphore;
  constructor(
    limits: GroupResourceLimits,
    private readonly sink?: GroupResourceSink,
    private readonly now: () => number = Date.now,
  ) {
    validate(limits);
    this.inFlight = new AsyncSemaphore(limits.maxResidentGroups);
    this.download = new AsyncSemaphore(limits.downloadConcurrency);
    this.extraction = new AsyncSemaphore(limits.extractionConcurrency);
    this.upload = new AsyncSemaphore(limits.uploadConcurrency);
  }
  applyLimits(limits: GroupResourceLimits): void {
    validate(limits);
    this.inFlight.resize(limits.maxResidentGroups);
    this.download.resize(limits.downloadConcurrency);
    this.extraction.resize(limits.extractionConcurrency);
    this.upload.resize(limits.uploadConcurrency);
  }
  stats() {
    return {
      inFlight: this.read(this.inFlight),
      download: this.read(this.download),
      extraction: this.read(this.extraction),
      upload: this.read(this.upload),
    };
  }
  withInFlight<T>(id: string, signal: AbortSignal, body: () => T | Promise<T>) {
    return this.run(this.inFlight, id, 'IN_FLIGHT', signal, body);
  }
  withDownload<T>(id: string, signal: AbortSignal, body: () => T | Promise<T>) {
    return this.run(this.download, id, 'DOWNLOAD', signal, body);
  }
  withExtraction<T>(id: string, signal: AbortSignal, body: () => T | Promise<T>) {
    return this.run(this.extraction, id, 'EXTRACTION', signal, body);
  }
  /** Includes hashing and both decrypting readbacks, not only the outbound socket. */
  withUpload<T>(id: string, signal: AbortSignal, body: () => T | Promise<T>) {
    return this.run(this.upload, id, 'UPLOAD', signal, body);
  }
  private async run<T>(
    resource: AsyncSemaphore,
    jobId: string,
    kind: GroupResourceKind,
    signal: AbortSignal,
    body: () => T | Promise<T>,
  ): Promise<T> {
    const started = this.now();
    let acquired: number | undefined;
    const record = (event: GroupResourceEvent['event'], elapsedMs: number, position?: number) => {
      try {
        this.sink?.record({
          jobId,
          kind,
          event,
          at: this.now(),
          elapsedMs,
          ...this.read(resource),
          ...(position === undefined ? {} : { position }),
        });
      } catch {
        /* optional observation */
      }
    };
    try {
      return await resource.run(signal, body, {
        queued: (value) => record('WAITING', this.now() - started, value.position),
        acquired: () => {
          acquired = this.now();
          record('ACQUIRED', acquired - started);
        },
      });
    } finally {
      record('RELEASED', acquired === undefined ? 0 : this.now() - acquired);
    }
  }
  private read(resource: AsyncSemaphore) {
    return {
      active: resource.activeCount,
      pending: resource.pendingCount,
      capacity: resource.capacity,
    };
  }
}
function validate(limits: GroupResourceLimits) {
  for (const value of [
    limits.maxResidentGroups,
    limits.downloadConcurrency,
    limits.extractionConcurrency,
    limits.uploadConcurrency,
  ])
    if (!Number.isSafeInteger(value) || value < 1 || value > 8)
      throw Error('GROUP_RESOURCE_LIMIT_INVALID');
}
