export type SemaphorePermit = {
  release(): void;
};

export type SemaphoreObservation = {
  active: number;
  capacity: number;
};

export type SemaphoreObserver = {
  queued(observation: SemaphoreObservation & { position: number }): void;
  acquired(observation: SemaphoreObservation): void;
};

type SemaphoreWaiter = {
  signal: AbortSignal;
  observer: SemaphoreObserver | undefined;
  resolve: (permit: SemaphorePermit) => void;
  reject: (error: Error) => void;
  onAbort: () => void;
};

function abortError(): Error {
  const error = new Error('ABORTED');
  error.name = 'AbortError';
  return error;
}

export class AsyncSemaphore {
  private currentCapacity: number;
  private active = 0;
  private readonly waiters: SemaphoreWaiter[] = [];

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('INVALID_SEMAPHORE_CAPACITY');
    }
    this.currentCapacity = capacity;
  }

  get capacity(): number {
    return this.currentCapacity;
  }

  get activeCount(): number {
    return this.active;
  }

  get pendingCount(): number {
    return this.waiters.length;
  }

  acquire(signal: AbortSignal, observer?: SemaphoreObserver): Promise<SemaphorePermit> {
    if (signal.aborted) return Promise.reject(abortError());
    if (this.active < this.currentCapacity && this.waiters.length === 0) {
      this.active += 1;
      this.notifyAcquired(observer);
      return Promise.resolve(this.createPermit());
    }

    return new Promise<SemaphorePermit>((resolve, reject) => {
      const waiter: SemaphoreWaiter = {
        signal,
        observer,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          signal.removeEventListener('abort', waiter.onAbort);
          reject(abortError());
          this.notifyQueuePositions();
        },
      };
      this.waiters.push(waiter);
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.notifyQueued(waiter, this.waiters.length);
    });
  }

  /**
   * Changes future admission without interrupting work already holding a permit.
   *
   * A reduction therefore converges: active work may temporarily exceed the new
   * capacity, but no queued waiter is released until the count falls below it.
   */
  resize(capacity: number): void {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('INVALID_SEMAPHORE_CAPACITY');
    }
    this.currentCapacity = capacity;
    this.dispatch();
  }

  async run<T>(
    signal: AbortSignal,
    body: () => T | Promise<T>,
    observer?: SemaphoreObserver,
  ): Promise<T> {
    const permit = await this.acquire(signal, observer);
    try {
      return await body();
    } finally {
      permit.release();
    }
  }

  private createPermit(): SemaphorePermit {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.dispatch();
      },
    };
  }

  private dispatch(): void {
    while (this.active < this.currentCapacity && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(abortError());
        continue;
      }
      this.active += 1;
      this.notifyAcquired(waiter.observer);
      waiter.resolve(this.createPermit());
    }
    this.notifyQueuePositions();
  }

  private notifyAcquired(observer: SemaphoreObserver | undefined): void {
    try {
      observer?.acquired({ active: this.active, capacity: this.currentCapacity });
    } catch {
      // Observation must never interfere with admission or release.
    }
  }

  private notifyQueued(waiter: SemaphoreWaiter, position: number): void {
    try {
      waiter.observer?.queued({
        position,
        active: this.active,
        capacity: this.currentCapacity,
      });
    } catch {
      // Observation must never interfere with FIFO bookkeeping.
    }
  }

  private notifyQueuePositions(): void {
    this.waiters.forEach((waiter, index) => this.notifyQueued(waiter, index + 1));
  }
}

type DurableWaiter = {
  signal: AbortSignal;
  tryAcquire: () => boolean;
  resolve: () => void;
  reject: (error: unknown) => void;
  onAbort: () => void;
};

export type OffloadResourceLimits = {
  preflightConcurrency: number;
  pauseSnapshotConcurrency: number;
  hashConcurrency: number;
  /** Compatibility input for deployments predating split upload/read-back limits. */
  remoteDataConcurrency?: number;
  uploadConcurrency?: number;
  readbackConcurrency?: number;
  metadataConcurrency?: number;
};

type ResourceStats = { active: number; pending: number; capacity: number };
type ExecutingResourceStats = ResourceStats & { executing: number };

export type OffloadResourceSchedulerStats = {
  preflight: ResourceStats;
  pauseSnapshot: ResourceStats;
  hash: ResourceStats;
  upload: ExecutingResourceStats;
  readback: ExecutingResourceStats;
  remoteHeavy: ResourceStats;
};

export class OffloadResourceScheduler {
  readonly preflight: AsyncSemaphore;
  readonly pauseSnapshot: AsyncSemaphore;
  readonly hash: AsyncSemaphore;
  readonly upload: AsyncSemaphore;
  readonly readback: AsyncSemaphore;
  readonly remoteHeavy: AsyncSemaphore;
  /** Compatibility alias. New code should say upload or readback explicitly. */
  readonly remoteData: AsyncSemaphore;
  readonly metadata: AsyncSemaphore;
  private readonly pausedWaiters: DurableWaiter[] = [];
  private uploadExecuting = 0;
  private readbackExecuting = 0;

  constructor(limits: OffloadResourceLimits) {
    const uploadConcurrency = limits.uploadConcurrency ?? limits.remoteDataConcurrency ?? 1;
    const readbackConcurrency = limits.readbackConcurrency ?? limits.remoteDataConcurrency ?? 1;
    this.preflight = new AsyncSemaphore(limits.preflightConcurrency);
    this.pauseSnapshot = new AsyncSemaphore(limits.pauseSnapshotConcurrency);
    this.hash = new AsyncSemaphore(limits.hashConcurrency);
    this.upload = new AsyncSemaphore(uploadConcurrency);
    this.readback = new AsyncSemaphore(readbackConcurrency);
    this.remoteHeavy = new AsyncSemaphore(Math.max(uploadConcurrency, readbackConcurrency));
    this.remoteData = this.upload;
    this.metadata = new AsyncSemaphore(limits.metadataConcurrency ?? 2);
  }

  applyLimits(limits: {
    preflightConcurrency: number;
    pauseSnapshotConcurrency: number;
    hashConcurrency: number;
    uploadConcurrency: number;
    readbackConcurrency: number;
  }): void {
    this.preflight.resize(limits.preflightConcurrency);
    this.pauseSnapshot.resize(limits.pauseSnapshotConcurrency);
    this.hash.resize(limits.hashConcurrency);
    this.upload.resize(limits.uploadConcurrency);
    this.readback.resize(limits.readbackConcurrency);
    this.remoteHeavy.resize(Math.max(limits.uploadConcurrency, limits.readbackConcurrency));
    // maxPausedPipelines lives in the durable machine rather than a semaphore.
    // The same settings application changes its provider, so wake those FIFO
    // waiters to re-read the new limit as well.
    this.notifyPausedCapacityChanged();
  }

  stats(): OffloadResourceSchedulerStats {
    const read = (semaphore: AsyncSemaphore) => ({
      active: semaphore.activeCount,
      pending: semaphore.pendingCount,
      capacity: semaphore.capacity,
    });
    return {
      preflight: read(this.preflight),
      pauseSnapshot: read(this.pauseSnapshot),
      hash: read(this.hash),
      upload: { ...read(this.upload), executing: this.uploadExecuting },
      readback: { ...read(this.readback), executing: this.readbackExecuting },
      remoteHeavy: read(this.remoteHeavy),
    };
  }

  withPreflight<T>(
    signal: AbortSignal,
    body: () => T | Promise<T>,
    observer?: SemaphoreObserver,
  ): Promise<T> {
    return this.preflight.run(signal, body, observer);
  }

  withPauseSnapshot<T>(
    signal: AbortSignal,
    body: () => T | Promise<T>,
    observer?: SemaphoreObserver,
  ): Promise<T> {
    return this.pauseSnapshot.run(signal, body, observer);
  }

  withHash<T>(
    signal: AbortSignal,
    body: () => T | Promise<T>,
    observer?: SemaphoreObserver,
  ): Promise<T> {
    return this.hash.run(signal, body, observer);
  }

  withRemoteData<T>(
    signal: AbortSignal,
    body: () => T | Promise<T>,
    observer?: SemaphoreObserver,
    remoteHeavyObserver?: SemaphoreObserver,
  ): Promise<T> {
    return this.withUpload(signal, body, observer, remoteHeavyObserver);
  }

  withUpload<T>(
    signal: AbortSignal,
    body: () => T | Promise<T>,
    observer?: SemaphoreObserver,
    remoteHeavyObserver?: SemaphoreObserver,
  ): Promise<T> {
    return this.upload.run(
      signal,
      () =>
        this.remoteHeavy.run(signal, () => this.runExecuting('upload', body), remoteHeavyObserver),
      observer,
    );
  }

  withReadback<T>(
    signal: AbortSignal,
    body: () => T | Promise<T>,
    observer?: SemaphoreObserver,
    remoteHeavyObserver?: SemaphoreObserver,
  ): Promise<T> {
    return this.readback.run(
      signal,
      () =>
        this.remoteHeavy.run(
          signal,
          () => this.runExecuting('readback', body),
          remoteHeavyObserver,
        ),
      observer,
    );
  }

  withMetadata<T>(signal: AbortSignal, body: () => T | Promise<T>): Promise<T> {
    return this.metadata.run(signal, body);
  }

  private async runExecuting<T>(
    kind: 'upload' | 'readback',
    body: () => T | Promise<T>,
  ): Promise<T> {
    if (kind === 'upload') this.uploadExecuting += 1;
    else this.readbackExecuting += 1;
    try {
      return await body();
    } finally {
      if (kind === 'upload') this.uploadExecuting -= 1;
      else this.readbackExecuting -= 1;
    }
  }

  waitForPausedAdmission(signal: AbortSignal, tryAcquire: () => boolean): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    if (this.pausedWaiters.length === 0) {
      try {
        if (tryAcquire()) return Promise.resolve();
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error('PAUSED_ADMISSION_FAILED', { cause: error }),
        );
      }
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: DurableWaiter = {
        signal,
        tryAcquire,
        resolve,
        reject,
        onAbort: () => {
          const index = this.pausedWaiters.indexOf(waiter);
          if (index >= 0) this.pausedWaiters.splice(index, 1);
          signal.removeEventListener('abort', waiter.onAbort);
          reject(abortError());
          this.drainPausedWaiters();
        },
      };
      this.pausedWaiters.push(waiter);
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    });
  }

  notifyPausedCapacityChanged(): void {
    this.drainPausedWaiters();
  }

  private drainPausedWaiters(): void {
    while (this.pausedWaiters.length > 0) {
      const waiter = this.pausedWaiters[0]!;
      if (waiter.signal.aborted) {
        this.pausedWaiters.shift();
        waiter.signal.removeEventListener('abort', waiter.onAbort);
        waiter.reject(abortError());
        continue;
      }
      let acquired: boolean;
      try {
        acquired = waiter.tryAcquire();
      } catch (error) {
        this.pausedWaiters.shift();
        waiter.signal.removeEventListener('abort', waiter.onAbort);
        waiter.reject(
          error instanceof Error ? error : new Error('PAUSED_ADMISSION_FAILED', { cause: error }),
        );
        continue;
      }
      if (!acquired) return;
      this.pausedWaiters.shift();
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.resolve();
    }
  }
}
