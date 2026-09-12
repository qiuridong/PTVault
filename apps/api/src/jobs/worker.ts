import { JobKindSchema, type JobKind, type OffloadControlEventCode } from '@ptvault/contracts';

import type { EventHub } from '../events/hub.js';
import type { Job, JobRepository } from './repository.js';

export type JobHandlerContext = {
  signal: AbortSignal;
};

export type JobHandler = (job: Job, context: JobHandlerContext) => Promise<void>;
export type JobHandlers = Partial<Record<JobKind, JobHandler>>;
export type WorkerSleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export type WorkerOptions = {
  repository: JobRepository;
  eventHub: EventHub;
  handlers: JobHandlers;
  pollIntervalMs?: number;
  sleep?: WorkerSleep;
  offloadParallel?: {
    enabled: boolean;
    maxInFlight: number | (() => number);
  };
  /**
   * Receives the cause of a handler failure.
   *
   * A failed job records only `HANDLER_FAILED`, which says a job stopped safely
   * but not why. Without this the reason is gone for good: a real trial migration
   * failed at PAUSING and the swallowed exception left nothing to diagnose from.
   * Reported out rather than thrown, so a broken reporter cannot turn a
   * safely-failed job into a crashed worker.
   */
  onHandlerError?: (job: Job, error: unknown) => void;
};

export class WorkerLoopError extends Error {
  readonly code = 'WORKER_LOOP_FAILED';

  constructor() {
    super('WORKER_LOOP_FAILED');
    this.name = 'WorkerLoopError';
  }
}

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

export class Worker {
  private readonly repository: JobRepository;
  private readonly eventHub: EventHub;
  private readonly handlers: JobHandlers;
  private readonly pollIntervalMs: number;
  private readonly sleep: WorkerSleep;
  private readonly onHandlerError: WorkerOptions['onHandlerError'];
  private readonly offloadParallelEnabled: boolean;
  private readonly maxInFlightOffloads: () => number;
  private wakeController: AbortController | undefined;
  private readonly activeJobs = new Map<
    string,
    { controller: AbortController; promise: Promise<void>; kind: string }
  >();
  private readonly activityWaiters = new Set<() => void>();
  private loop: Promise<void> | undefined;
  private loopFailure: WorkerLoopError | undefined;

  constructor(options: WorkerOptions) {
    this.repository = options.repository;
    this.eventHub = options.eventHub;
    this.handlers = options.handlers;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.sleep = options.sleep ?? abortableSleep;
    this.onHandlerError = options.onHandlerError;
    this.offloadParallelEnabled = options.offloadParallel?.enabled ?? false;
    const configuredMaximum = options.offloadParallel?.maxInFlight;
    this.maxInFlightOffloads =
      typeof configuredMaximum === 'function' ? configuredMaximum : () => configuredMaximum ?? 1;
    if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs < 1) {
      throw new Error('WORKER_INVALID_POLL_INTERVAL');
    }
    if (
      !Number.isInteger(this.maxInFlightOffloads()) ||
      this.maxInFlightOffloads() < 1 ||
      this.maxInFlightOffloads() > 32
    ) {
      throw new Error('WORKER_INVALID_MAX_IN_FLIGHT');
    }
  }

  get activeJobCount(): number {
    return this.activeJobs.size;
  }

  get activeOffloadJobCount(): number {
    return [...this.activeJobs.values()].filter(({ kind }) => kind === 'OFFLOAD').length;
  }

  get pendingActivityWaiterCount(): number {
    return this.activityWaiters.size;
  }

  /** Re-evaluates a dynamic limit without interrupting any active handler. */
  notifyCapacityChanged(): void {
    for (const wake of this.activityWaiters) wake();
    this.activityWaiters.clear();
  }

  /** Abort one durable operator-pause request without disturbing peer jobs. */
  requestOffloadPause(jobId: string): boolean {
    const active = this.activeJobs.get(jobId);
    if (!active || active.kind !== 'OFFLOAD') return false;
    if (!this.repository.isOperatorPauseRequested(jobId)) return false;
    active.controller.abort(new DOMException('Operator pause', 'AbortError'));
    return true;
  }

  /** Abort only the cancelled OFFLOAD; peers and the scheduler loop keep running. */
  requestOffloadCancel(jobId: string): boolean {
    const active = this.activeJobs.get(jobId);
    if (!active || active.kind !== 'OFFLOAD') return false;
    active.controller.abort(new DOMException('Operator cancel', 'AbortError'));
    return true;
  }

  /** Abort all currently active OFFLOAD handlers after pause-all closed the DB gate. */
  requestAllOffloadPauses(): number {
    let targeted = 0;
    for (const [jobId, active] of this.activeJobs) {
      if (active.kind !== 'OFFLOAD' || !this.repository.isOperatorPauseRequested(jobId)) continue;
      targeted += 1;
      active.controller.abort(new DOMException('Operator pause-all', 'AbortError'));
    }
    return targeted;
  }

  async start(): Promise<void> {
    if (this.loop) return;
    if (this.loopFailure) throw this.loopFailure;

    const wakeController = new AbortController();
    this.wakeController = wakeController;
    let reconciled: Job[];
    try {
      reconciled = this.repository.reconcileRunningAfterRestart();
      if (this.repository.settleOffloadSchedulerPause(0)) {
        this.publishSchedulerBestEffort();
      }
    } catch {
      this.wakeController = undefined;
      throw new WorkerLoopError();
    }
    for (const job of reconciled) this.publishBestEffort(job);

    const managedLoop = this.run(wakeController.signal)
      .catch(() => {
        this.loopFailure = new WorkerLoopError();
      })
      .finally(() => {
        if (this.wakeController === wakeController) {
          this.loop = undefined;
          this.wakeController = undefined;
        }
      });
    this.loop = managedLoop;
    await Promise.resolve();
  }

  async stop(): Promise<void> {
    const loop = this.loop;
    // Stop the command before waiting for the loop. Long rclone operations can
    // run for hours, while systemd gives the service only a bounded shutdown
    // window. The job deliberately stays RUNNING when this abort reaches the
    // handler; the next process turns that durable row back into QUEUED through
    // reconcileRunningAfterRestart() and resumes from its per-file checkpoints.
    this.wakeController?.abort();
    for (const { controller } of this.activeJobs.values()) controller.abort();
    if (loop) await loop;

    const failure = this.loopFailure;
    this.loopFailure = undefined;
    if (failure) throw failure;
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let launched = false;
      while (!signal.aborted) {
        const job = this.claimForAvailableSlot();
        if (!job) break;
        launched = true;
        this.publishBestEffort(job);
        this.launch(job, signal);
      }

      if (signal.aborted) break;
      if (this.activeJobs.size > 0) {
        try {
          await this.waitForActiveChangeOrPoll(signal);
        } catch (error) {
          if (signal.aborted) break;
          throw error;
        }
        continue;
      }

      if (!launched) {
        try {
          await this.sleep(this.pollIntervalMs, signal);
        } catch (error) {
          if (signal.aborted) return;
          throw error;
        }
      }
    }

    await Promise.allSettled([...this.activeJobs.values()].map(({ promise }) => promise));
  }

  private claimForAvailableSlot(): Job | null {
    if (!this.offloadParallelEnabled) {
      if (this.activeJobs.size > 0) return null;
      return this.repository.claimNext();
    }

    const hasActiveExclusive = [...this.activeJobs.values()].some(({ kind }) => kind !== 'OFFLOAD');
    if (hasActiveExclusive) return null;

    const activeOffloads = [...this.activeJobs.values()].filter(({ kind }) => kind === 'OFFLOAD');
    const maxInFlightOffloads = this.maxInFlightOffloads();
    if (
      !Number.isInteger(maxInFlightOffloads) ||
      maxInFlightOffloads < 1 ||
      maxInFlightOffloads > 32
    ) {
      throw new Error('WORKER_INVALID_MAX_IN_FLIGHT');
    }
    if (this.repository.hasDueExclusive()) {
      if (activeOffloads.length === 0) return this.repository.claimNext({ scope: 'EXCLUSIVE' });
      // Stop admitting fresh PREFLIGHT work as soon as an exclusive barrier is
      // visible. A queued, already-paused recovery is the one exception: an
      // active OFFLOAD may itself be waiting for that durable pipeline to retry
      // and release paused admission. Blocking the recovery would make both the
      // active job and the exclusive barrier wait forever. The set is bounded by
      // the durable paused limit, so this drains an existing dependency rather
      // than reopening the queue to continuously arriving OFFLOAD work.
      if (activeOffloads.length < maxInFlightOffloads && this.repository.hasDuePausedOffload()) {
        return this.repository.claimNext({ scope: 'OFFLOAD', preferPausedOffload: true });
      }
      return null;
    }
    if (activeOffloads.length >= maxInFlightOffloads) return null;
    if (this.repository.hasDuePausedOffload()) {
      return this.repository.claimNext({ scope: 'OFFLOAD', preferPausedOffload: true });
    }
    const retryReservations = Math.min(
      maxInFlightOffloads,
      this.repository.countPausedOffloadsAwaitingRetry(),
    );
    if (activeOffloads.length >= maxInFlightOffloads - retryReservations) return null;
    return this.repository.claimNext({ scope: 'OFFLOAD', preferPausedOffload: true });
  }

  private async waitForActiveChangeOrPoll(signal: AbortSignal): Promise<void> {
    const pollController = new AbortController();
    const abortPoll = (): void => pollController.abort();
    let resolveActivity!: () => void;
    const activityChanged = new Promise<void>((resolve) => {
      resolveActivity = resolve;
      this.activityWaiters.add(resolve);
    });
    signal.addEventListener('abort', abortPoll, { once: true });
    try {
      await Promise.race([activityChanged, this.sleep(this.pollIntervalMs, pollController.signal)]);
    } finally {
      this.activityWaiters.delete(resolveActivity);
      signal.removeEventListener('abort', abortPoll);
      pollController.abort();
    }
  }

  private launch(job: Job, workerSignal: AbortSignal): void {
    const jobController = new AbortController();
    const abortFromWorker = (): void => jobController.abort();
    workerSignal.addEventListener('abort', abortFromWorker, { once: true });
    const active = {
      controller: jobController,
      kind: job.kind,
      promise: Promise.resolve(),
    };
    const promise = Promise.resolve()
      .then(() => this.process(job, jobController))
      .catch(() => {
        this.loopFailure ??= new WorkerLoopError();
        this.wakeController?.abort();
      })
      .finally(() => {
        workerSignal.removeEventListener('abort', abortFromWorker);
        if (this.activeJobs.get(job.id) === active) this.activeJobs.delete(job.id);
        try {
          if (this.repository.settleOffloadSchedulerPause(this.activeOffloadJobCount)) {
            this.publishSchedulerBestEffort();
          }
        } catch {
          this.loopFailure ??= new WorkerLoopError();
          this.wakeController?.abort();
        }
        for (const wake of this.activityWaiters) wake();
        this.activityWaiters.clear();
      });
    active.promise = promise;
    this.activeJobs.set(job.id, active);
  }

  private async process(job: Job, jobController: AbortController): Promise<void> {
    try {
      if (jobController.signal.aborted) return;
      const parsedKind = JobKindSchema.safeParse(job.kind);
      const handler = parsedKind.success ? this.handlers[parsedKind.data] : undefined;
      if (!handler) {
        const blocked = this.repository.transition({
          id: job.id,
          from: 'RUNNING',
          to: 'BLOCKED',
          eventType: 'JOB_BLOCKED',
          lastErrorCode: 'HANDLER_NOT_REGISTERED',
        });
        this.publishBestEffort(blocked);
        return;
      }

      try {
        await handler(job, { signal: jobController.signal });
      } catch (error) {
        // A command handler may coordinate an external cancellation while this
        // worker still owns the call. Once it has durably finalized CANCELLED_SAFE
        // there is nothing to fail, and attempting RUNNING -> FAILED_SAFE would
        // itself be a transition conflict that kills the loop.
        const current = this.repository.get(job.id);
        if (current?.state === 'CANCELLED_SAFE') {
          this.publishBestEffort(current);
          return;
        }
        if (job.kind === 'OFFLOAD' && this.repository.isOffloadCloudCommitted(job.id)) {
          this.complete(job);
          return;
        }
        if (job.kind === 'OFFLOAD' && this.repository.isOperatorPauseRequested(job.id)) {
          const paused = this.repository.acknowledgeOperatorPause(job.id);
          this.publishBestEffort(paused, 'OFFLOAD_PAUSED');
          return;
        }
        // A service shutdown is a handoff, not a failed migration. Keeping the
        // row RUNNING is intentional: startup reconciliation is the single
        // durable authority that requeues interrupted work. Marking FAILED_SAFE
        // here would make every deployment kill rclone and demand another MFA
        // code even though no transfer invariant was violated.
        if (jobController.signal.aborted) return;
        // Reported before the transition so the cause is out even if the
        // transition itself throws, and wrapped because a throwing reporter must
        // not escalate a safely-failed job into a crashed worker loop.
        try {
          this.onHandlerError?.(job, error);
        } catch {
          /* a broken reporter is not worth failing the loop over */
        }
        const failed = this.repository.transition({
          id: job.id,
          from: 'RUNNING',
          to: 'FAILED_SAFE',
          eventType: 'JOB_FAILED_SAFE',
          lastErrorCode: 'HANDLER_FAILED',
        });
        this.publishBestEffort(failed);
        return;
      }

      const current = this.repository.get(job.id);
      if (current?.state === 'CANCELLED_SAFE') {
        this.publishBestEffort(current);
        return;
      }
      if (job.kind === 'OFFLOAD' && this.repository.isOperatorPauseRequested(job.id)) {
        const paused = this.repository.acknowledgeOperatorPause(job.id);
        this.publishBestEffort(paused, 'OFFLOAD_PAUSED');
        return;
      }
      const offloadCommitted =
        job.kind === 'OFFLOAD' && this.repository.isOffloadCloudCommitted(job.id);
      if (jobController.signal.aborted && !offloadCommitted) return;

      this.complete(job);
    } finally {
      // The active entry is removed by launch() only after this method settles.
    }
  }

  private complete(job: Job): void {
    const completed = this.repository.transition({
      id: job.id,
      from: 'RUNNING',
      to: 'COMPLETED',
      eventType: 'JOB_COMPLETED',
      progress: 1,
      lastErrorCode: null,
    });
    this.publishBestEffort(completed);
  }

  private publishBestEffort(job: Job, eventCode?: OffloadControlEventCode): void {
    try {
      this.eventHub.publish({
        type: 'job.updated',
        jobId: job.id,
        state: job.state,
        progress: job.progress,
        ...(eventCode ? { eventCode } : {}),
      });
    } catch {
      return;
    }
  }

  private publishSchedulerBestEffort(): void {
    try {
      const control = this.repository.getOffloadSchedulerControl();
      this.eventHub.publish({
        type: 'scheduler.updated',
        component: 'offload-scheduler',
        schedulerState: control.state,
        revision: control.revision,
      });
    } catch {
      // Scheduler state is already durable; notification is only an invalidation hint.
    }
  }
}
