import type { InventoryCoordinatorReport } from './sync.js';

export type InventoryScheduleSleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export type InventoryScheduleOptions = {
  coordinator: { runEnabled: () => Promise<InventoryCoordinatorReport> };
  intervalMs?: number;
  sleep?: InventoryScheduleSleep;
  /** Called after every tick so the caller can log; never throws into the loop. */
  onTick?: (report: InventoryCoordinatorReport) => void;
  onError?: (error: unknown) => void;
};

export const DEFAULT_INVENTORY_INTERVAL_MS = 300_000;

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    // Unref so a pending tick never keeps the process alive on shutdown.
    timer.unref();
    signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Periodically refreshes the qB inventory.
 *
 * Read-only by construction: it drives `QbInventoryCoordinator.runEnabled`, whose
 * only qB call is `torrents/info`. It cannot pause, delete, or move anything, so
 * running it on a timer needs no mutation gate.
 *
 * Sleep comes first, so startup is not blocked on reaching two qB instances — the
 * web UI's manual refresh covers the "I want it now" case.
 */
export class QbInventoryScheduler {
  private readonly coordinator: InventoryScheduleOptions['coordinator'];
  private readonly intervalMs: number;
  private readonly sleep: InventoryScheduleSleep;
  private readonly onTick: ((report: InventoryCoordinatorReport) => void) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private controller: AbortController | undefined;
  private loop: Promise<void> | undefined;

  constructor(options: InventoryScheduleOptions) {
    this.coordinator = options.coordinator;
    this.intervalMs = options.intervalMs ?? DEFAULT_INVENTORY_INTERVAL_MS;
    this.sleep = options.sleep ?? abortableSleep;
    this.onTick = options.onTick;
    this.onError = options.onError;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs < 1) {
      throw new Error('QB_SCHEDULER_INVALID_INTERVAL');
    }
  }

  start(): void {
    if (this.loop) return;

    const controller = new AbortController();
    this.controller = controller;
    this.loop = this.run(controller.signal).finally(() => {
      if (this.controller === controller) {
        this.loop = undefined;
        this.controller = undefined;
      }
    });
  }

  async stop(): Promise<void> {
    const loop = this.loop;
    this.controller?.abort();
    if (loop) await loop;
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.sleep(this.intervalMs, signal);
      if (signal.aborted) return;

      // A tick must never kill the loop: an unreachable qB is an expected state,
      // and the whole point of a periodic refresh is that it retries later.
      try {
        const report = await this.coordinator.runEnabled();
        this.onTick?.(report);
      } catch (error) {
        try {
          this.onError?.(error);
        } catch {
          // A failing logger must not stop inventory refreshes either.
        }
      }
    }
  }
}
