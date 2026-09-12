import type { OffloadControlEventCode, OffloadSnapshot, ServerEvent } from '@ptvault/contracts';

export const OFFLOAD_SSE_COALESCE_WINDOW_MS = 750;

export type OffloadSnapshotPublication = 'COALESCED' | 'IMMEDIATE';

export type OffloadEventTimer = { cancel(): void };
export type OffloadEventSchedule = (callback: () => void, delayMs: number) => OffloadEventTimer;

export type OffloadSnapshotEventPublisherOptions = {
  sink: { publish(input: unknown): unknown };
  coalesceWindowMs?: number;
  schedule?: OffloadEventSchedule;
};

const scheduleTimer: OffloadEventSchedule = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
};

/**
 * Keeps the public per-job SSE contract while aligning ordinary OFFLOAD telemetry
 * onto one process-wide flush window. A Map stores only the latest invalidation
 * for each job, so eight parallel pipelines still own one timer rather than eight
 * independent SSE timers. Durable state/file/control boundaries bypass the window.
 */
export class OffloadSnapshotEventPublisher {
  private readonly sink: OffloadSnapshotEventPublisherOptions['sink'];
  private readonly coalesceWindowMs: number;
  private readonly schedule: OffloadEventSchedule;
  private readonly pending = new Map<string, ServerEvent>();
  private timer: OffloadEventTimer | undefined;
  private timerGeneration = 0;
  private closed = false;

  constructor(options: OffloadSnapshotEventPublisherOptions) {
    this.sink = options.sink;
    this.coalesceWindowMs = options.coalesceWindowMs ?? OFFLOAD_SSE_COALESCE_WINDOW_MS;
    this.schedule = options.schedule ?? scheduleTimer;
    if (
      !Number.isInteger(this.coalesceWindowMs) ||
      this.coalesceWindowMs < 500 ||
      this.coalesceWindowMs > 1_000
    ) {
      throw new Error('INVALID_OFFLOAD_SSE_COALESCE_WINDOW');
    }
  }

  publish(
    snapshot: OffloadSnapshot,
    eventCode?: OffloadControlEventCode,
    publication: OffloadSnapshotPublication = 'IMMEDIATE',
  ): void {
    if (this.closed) return;
    const event: ServerEvent = {
      type: 'job.updated',
      jobId: snapshot.jobId,
      state: snapshot.jobState,
      progress: snapshot.currentStep === 'CLOUD_COMMITTED' ? 1 : 0,
      ...(eventCode ? { eventCode } : {}),
    };
    if (publication === 'IMMEDIATE') {
      // The boundary snapshot supersedes any stale ordinary update for this job.
      this.pending.delete(snapshot.jobId);
      this.publishBestEffort(event);
      return;
    }

    this.pending.set(snapshot.jobId, event);
    this.ensureTimer();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.timerGeneration += 1;
    this.timer?.cancel();
    this.timer = undefined;
    this.pending.clear();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    const generation = ++this.timerGeneration;
    this.timer = this.schedule(() => {
      if (this.closed || generation !== this.timerGeneration) return;
      this.timer = undefined;
      const events = [...this.pending.values()];
      this.pending.clear();
      for (const event of events) this.publishBestEffort(event);
    }, this.coalesceWindowMs);
  }

  private publishBestEffort(event: ServerEvent): void {
    try {
      this.sink.publish(event);
    } catch {
      // SSE is advisory; the snapshot was committed before it reached this class.
    }
  }
}
