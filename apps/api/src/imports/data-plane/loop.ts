import type { ImportDataPlaneProcessor, ImportDataPlaneRunResult } from './processor.js';

export type ImportDataPlaneSleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

type ImportDataPlaneRunner = Pick<ImportDataPlaneProcessor, 'reconcileInterruptedJobs' | 'runOnce'>;

export type ImportDataPlaneLoopOptions = {
  processor: ImportDataPlaneRunner;
  pollIntervalMs?: number;
  sleep?: ImportDataPlaneSleep;
  maxInFlight?: number | (() => number);
  onProcessorError?: (error: unknown) => void;
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

export class ImportDataPlaneLoopError extends Error {
  readonly code = 'IMPORT_DATA_PLANE_LOOP_FAILED';

  constructor() {
    super('IMPORT_DATA_PLANE_LOOP_FAILED');
    this.name = 'ImportDataPlaneLoopError';
  }
}

type ActiveProcessor = {
  controller: AbortController;
  promise: Promise<void>;
};

export class ImportDataPlaneLoop {
  private readonly processor: ImportDataPlaneRunner;
  private readonly pollIntervalMs: number;
  private readonly sleep: ImportDataPlaneSleep;
  private readonly maxInFlight: () => number;
  private readonly onProcessorError: (error: unknown) => void;
  private wakeController: AbortController | undefined;
  private delayController: AbortController | undefined;
  private readonly active = new Map<symbol, ActiveProcessor>();
  private readonly activityWaiters = new Set<() => void>();
  private readonly completed: ImportDataPlaneRunResult[] = [];
  private running: Promise<void> | undefined;
  private loopFailure: ImportDataPlaneLoopError | undefined;
  private processorFailure: Error | undefined;

  constructor(options: ImportDataPlaneLoopOptions) {
    this.processor = options.processor;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.sleep = options.sleep ?? abortableSleep;
    const configuredMaximum = options.maxInFlight;
    this.maxInFlight =
      typeof configuredMaximum === 'function' ? configuredMaximum : () => configuredMaximum ?? 1;
    this.onProcessorError = options.onProcessorError ?? (() => undefined);
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 1) {
      throw new ImportDataPlaneLoopError();
    }
    this.assertMaxInFlight(this.maxInFlight());
  }

  get activeJobCount(): number {
    return this.active.size;
  }

  /** Re-evaluates a dynamic limit and interrupts only the scheduler's idle wait. */
  notifyCapacityChanged(): void {
    this.delayController?.abort();
    this.notifyActivity();
  }

  async start(): Promise<void> {
    if (this.running !== undefined) return;
    if (this.loopFailure !== undefined) throw this.loopFailure;
    try {
      this.processor.reconcileInterruptedJobs();
    } catch {
      throw new ImportDataPlaneLoopError();
    }
    const wakeController = new AbortController();
    this.wakeController = wakeController;
    this.running = this.run(wakeController.signal)
      .catch(() => {
        this.loopFailure = new ImportDataPlaneLoopError();
      })
      .finally(() => {
        if (this.wakeController === wakeController) {
          this.wakeController = undefined;
          this.running = undefined;
        }
      });
    await Promise.resolve();
  }

  async stop(): Promise<void> {
    const running = this.running;
    this.wakeController?.abort();
    this.delayController?.abort();
    for (const { controller } of this.active.values()) controller.abort();
    this.notifyActivity();
    if (running !== undefined) await running;
    const failure = this.loopFailure;
    this.loopFailure = undefined;
    this.processorFailure = undefined;
    if (failure !== undefined) throw failure;
  }

  private async run(wakeSignal: AbortSignal): Promise<void> {
    try {
      while (!wakeSignal.aborted) {
        const maximum = this.maxInFlight();
        this.assertMaxInFlight(maximum);
        while (!wakeSignal.aborted && this.active.size < maximum) this.launch(wakeSignal);

        if (wakeSignal.aborted) break;
        if (this.active.size === 0) {
          await this.waitForPoll(wakeSignal);
          continue;
        }

        await this.waitForActivity(wakeSignal);
        if (this.processorFailure !== undefined) throw this.processorFailure;
        const completed = this.completed.splice(0);
        if (completed.some(({ outcome }) => outcome === 'IDLE')) {
          // One claim finding no row is a complete queue probe for this tick. Do
          // not hammer SQLite from every newly empty slot while peers are busy.
          await this.waitForPoll(wakeSignal);
        }
      }
    } finally {
      await Promise.allSettled([...this.active.values()].map(({ promise }) => promise));
      this.active.clear();
      this.completed.length = 0;
    }
    if (this.processorFailure !== undefined) throw this.processorFailure;
  }

  private launch(wakeSignal: AbortSignal): void {
    const token = Symbol('import-data-plane-job');
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    wakeSignal.addEventListener('abort', abort, { once: true });
    const active: ActiveProcessor = { controller, promise: Promise.resolve() };
    const promise = Promise.resolve()
      .then(() => this.processor.runOnce(controller.signal))
      .then((result) => {
        this.completed.push(result);
      })
      .catch((error: unknown) => {
        if (wakeSignal.aborted && controller.signal.aborted) return;
        if (this.processorFailure === undefined) {
          const failure =
            error instanceof Error
              ? error
              : new Error('IMPORT_DATA_PLANE_PROCESSOR_FAILED', { cause: error });
          this.processorFailure = failure;
          try {
            this.onProcessorError(failure);
          } catch {
            // Diagnostics are advisory and must not replace the processor cause.
          }
          for (const peer of this.active.values()) peer.controller.abort();
          this.wakeController?.abort();
        }
      })
      .finally(() => {
        wakeSignal.removeEventListener('abort', abort);
        if (this.active.get(token) === active) this.active.delete(token);
        this.notifyActivity();
      });
    active.promise = promise;
    this.active.set(token, active);
  }

  private async waitForActivity(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    let resolveActivity!: () => void;
    const activity = new Promise<void>((resolve) => {
      resolveActivity = resolve;
      this.activityWaiters.add(resolve);
    });
    const onAbort = (): void => resolveActivity();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await activity;
    } finally {
      this.activityWaiters.delete(resolveActivity);
      signal.removeEventListener('abort', onAbort);
    }
  }

  private async waitForPoll(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const delay = new AbortController();
    const onAbort = (): void => delay.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    this.delayController = delay;
    try {
      await this.sleep(this.pollIntervalMs, delay.signal);
    } catch (error) {
      if (!delay.signal.aborted) throw error;
    } finally {
      if (this.delayController === delay) this.delayController = undefined;
      signal.removeEventListener('abort', onAbort);
    }
  }

  private notifyActivity(): void {
    for (const wake of this.activityWaiters) wake();
    this.activityWaiters.clear();
  }

  private assertMaxInFlight(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1 || value > 8) {
      throw new ImportDataPlaneLoopError();
    }
  }
}
