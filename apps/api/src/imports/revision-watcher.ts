import type { EventHub } from '../events/hub.js';
import type { ImportRevisionSignal } from './worker-repository.js';

export type ImportRevisionSource = {
  revisionSignals: () => ImportRevisionSignal[];
};

export type ImportRevisionWatcherSleep = (
  milliseconds: number,
  signal: AbortSignal,
) => Promise<void>;

export type ImportRevisionWatcherOptions = {
  repository: ImportRevisionSource;
  events: Pick<EventHub, 'publish'>;
  pollIntervalMs?: number;
  sleep?: ImportRevisionWatcherSleep;
  onError?: (error: unknown) => void;
};

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    signal.addEventListener('abort', finish, { once: true });
  });
}

function progress(signal: ImportRevisionSignal): number {
  const total = BigInt(signal.jobBytesTotal);
  if (total === 0n) return 0;
  const verified = BigInt(signal.jobBytesVerified);
  const millionths = (verified * 1_000_000n) / total;
  return Math.max(0, Math.min(1, Number(millionths) / 1_000_000));
}

/**
 * Turns durable import revisions into the existing SSE invalidation event.
 *
 * The data-plane may be a separate process. It writes only schema-v17 rows; this
 * watcher is the bridge that lets the API process notice those commits without
 * sharing memory or accepting an unauthenticated callback port.
 */
export class ImportRevisionWatcher {
  private readonly repository: ImportRevisionSource;
  private readonly events: Pick<EventHub, 'publish'>;
  private readonly pollIntervalMs: number;
  private readonly sleep: ImportRevisionWatcherSleep;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly revisions = new Map<string, number>();
  private primed = false;
  private controller: AbortController | undefined;
  private loop: Promise<void> | undefined;

  constructor(options: ImportRevisionWatcherOptions) {
    this.repository = options.repository;
    this.events = options.events;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.sleep = options.sleep ?? abortableSleep;
    this.onError = options.onError;
    if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs < 1) {
      throw new Error('IMPORT_REVISION_WATCHER_INVALID_INTERVAL');
    }
  }

  start(): void {
    if (this.loop) return;
    const controller = new AbortController();
    this.controller = controller;
    this.pollSafely();
    this.loop = this.run(controller.signal).finally(() => {
      if (this.controller === controller) {
        this.controller = undefined;
        this.loop = undefined;
      }
    });
  }

  async stop(): Promise<void> {
    const loop = this.loop;
    this.controller?.abort();
    if (loop) await loop;
  }

  pollOnce(): void {
    const signals = this.repository.revisionSignals();
    const currentIds = new Set<string>();
    for (const signal of signals) {
      currentIds.add(signal.jobId);
      const seenRevision = this.revisions.get(signal.jobId);
      this.revisions.set(signal.jobId, signal.revision);
      if (!this.primed || seenRevision === signal.revision) continue;
      try {
        this.events.publish({
          type: 'job.updated',
          jobId: signal.jobId,
          state: signal.state,
          progress: progress(signal),
        });
      } catch {
        // SSE invalidation is best-effort; the durable row remains authoritative.
      }
    }
    for (const jobId of this.revisions.keys()) {
      if (!currentIds.has(jobId)) this.revisions.delete(jobId);
    }
    this.primed = true;
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.sleep(this.pollIntervalMs, signal);
      } catch (error) {
        if (signal.aborted) return;
        this.report(error);
        continue;
      }
      if (signal.aborted) return;
      this.pollSafely();
    }
  }

  private pollSafely(): void {
    try {
      this.pollOnce();
    } catch (error) {
      this.report(error);
    }
  }

  private report(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      // A diagnostic sink is never allowed to stop progress observation.
    }
  }
}
