import type { MediaServices } from './services.js';
import type { FarmSyncResult } from './symlink-farm.js';

export type MediaScheduleSleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export type MediaReconcilerOptions = {
  /** The pieces of the media graph a reconcile tick needs. */
  media: Pick<MediaServices, 'supervisor' | 'farm' | 'buildFarmPlan'>;
  intervalMs?: number;
  sleep?: MediaScheduleSleep;
  now?: () => number;
  /** Called after every tick so the caller can log; never throws into the loop. */
  onTick?: (result: MediaReconcileResult) => void;
  onError?: (error: unknown) => void;
};

export type MediaReconcileResult = {
  /** One entry per supervised mount, after this tick's probe. */
  healthy: number;
  mounts: number;
  farm: FarmSyncResult;
};

export type MediaReconcileStatus = {
  /** Null until a complete probe and farm sync have succeeded in this process. */
  lastReconciledAt: number | null;
};

/**
 * Shorter than the qB inventory's five minutes.
 *
 * This is what turns a mount outage into a recorded fact, and the hysteresis needs
 * three consecutive failures before it declares one — at this interval that is
 * about three minutes of a dead mount before playback stops being admitted, which
 * is late enough to ride out an OneDrive hiccup and early enough to be useful.
 */
export const DEFAULT_MEDIA_RECONCILE_INTERVAL_MS = 60_000;

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
 * Probes every mount and reconciles the symlink farm on a timer.
 *
 * Exists because both halves were unreachable without it: nothing called
 * `supervisor.check()`, so recorded health stayed at its construction defaults and
 * `checkedAt` was null forever; and nothing called `farm.sync()`, so the tree
 * Jellyfin reads was never built even when the catalog had rows to build it from.
 *
 * **Read-only by construction**, which is what makes running it on a timer safe
 * without a mutation gate — the same argument as `QbInventoryScheduler`. The probe
 * only stats a mountpoint and reads a sentinel; the farm only creates, repoints,
 * and removes symlinks under its own root, and a link is not the media. Nothing
 * here pauses a torrent, uploads a byte, or deletes a local file.
 *
 * Health is probed *before* the farm is reconciled, deliberately: the plan asks
 * which accounts can serve, and reconciling against a stale verdict would point
 * links at a mount that has been down since the last tick.
 */
export class MediaReconciler {
  private readonly media: MediaReconcilerOptions['media'];
  private readonly intervalMs: number;
  private readonly sleep: MediaScheduleSleep;
  private readonly now: () => number;
  private readonly onTick: ((result: MediaReconcileResult) => void) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private controller: AbortController | undefined;
  private loop: Promise<void> | undefined;
  private lastReconciledAt: number | null = null;

  constructor(options: MediaReconcilerOptions) {
    this.media = options.media;
    this.intervalMs = options.intervalMs ?? DEFAULT_MEDIA_RECONCILE_INTERVAL_MS;
    this.sleep = options.sleep ?? abortableSleep;
    this.now = options.now ?? (() => Date.now());
    this.onTick = options.onTick;
    this.onError = options.onError;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs < 1) {
      throw new Error('MEDIA_RECONCILER_INVALID_INTERVAL');
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

  status(): MediaReconcileStatus {
    return { lastReconciledAt: this.lastReconciledAt };
  }

  /**
   * One probe-and-reconcile pass.
   *
   * Public so the caller can run it once at startup or from a manual refresh
   * without waiting out an interval.
   */
  async tick(): Promise<MediaReconcileResult> {
    const health = await this.media.supervisor.check();
    const farm = await this.media.farm.sync(this.media.buildFarmPlan);
    this.lastReconciledAt = this.now();
    return {
      healthy: health.filter((entry) => entry.mounted).length,
      mounts: health.length,
      farm,
    };
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.sleep(this.intervalMs, signal);
      if (signal.aborted) return;

      // A tick must never kill the loop. An unreachable mount is an expected
      // state — it is the very thing being watched for — and a farm write can
      // fail transiently; the point of a periodic reconcile is that it retries.
      try {
        const result = await this.tick();
        this.onTick?.(result);
      } catch (error) {
        try {
          this.onError?.(error);
        } catch {
          // A failing logger must not stop reconciles either.
        }
      }
    }
  }
}
