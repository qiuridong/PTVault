import type { StorageAccountRepository } from './accounts.js';
import { classifyHealth } from './health.js';
import type { RcloneControl } from './rclone.js';

export type StorageAccountMonitorSleep = (
  milliseconds: number,
  signal: AbortSignal,
) => Promise<void>;

export type StorageAccountMonitorResult = {
  checked: number;
  healthy: number;
  failed: number;
};

export type StorageAccountMonitorOptions = {
  accounts: Pick<StorageAccountRepository, 'listEligible' | 'recordHealth'>;
  rclone: Pick<RcloneControl, 'about'>;
  intervalMs?: number;
  sleep?: StorageAccountMonitorSleep;
  now?: () => number;
  onAccountUpdated?: (accountId: string, healthy: boolean) => void;
  onTick?: (result: StorageAccountMonitorResult) => void;
  onError?: (error: unknown) => void;
};

export const DEFAULT_STORAGE_ACCOUNT_INTERVAL_MS = 300_000;

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

/** Periodically replaces registration-time quota snapshots with a real rclone reading. */
export class StorageAccountMonitor {
  private readonly accounts: StorageAccountMonitorOptions['accounts'];
  private readonly rclone: StorageAccountMonitorOptions['rclone'];
  private readonly intervalMs: number;
  private readonly sleep: StorageAccountMonitorSleep;
  private readonly now: () => number;
  private readonly onAccountUpdated: StorageAccountMonitorOptions['onAccountUpdated'];
  private readonly onTick: StorageAccountMonitorOptions['onTick'];
  private readonly onError: StorageAccountMonitorOptions['onError'];
  private controller: AbortController | undefined;
  private loop: Promise<void> | undefined;

  constructor(options: StorageAccountMonitorOptions) {
    this.accounts = options.accounts;
    this.rclone = options.rclone;
    this.intervalMs = options.intervalMs ?? DEFAULT_STORAGE_ACCOUNT_INTERVAL_MS;
    this.sleep = options.sleep ?? abortableSleep;
    this.now = options.now ?? (() => Date.now());
    this.onAccountUpdated = options.onAccountUpdated;
    this.onTick = options.onTick;
    this.onError = options.onError;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs < 1) {
      throw new Error('STORAGE_ACCOUNT_MONITOR_INVALID_INTERVAL');
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

  async tick(): Promise<StorageAccountMonitorResult> {
    const candidates = this.accounts.listEligible('HEALTH_PROBE');
    let healthy = 0;
    let failed = 0;

    // Keep quota probes sequential to bound provider load, not to coordinate
    // credentials: ProcessRunner isolates native writers across all workloads.
    for (const account of candidates) {
      const checkedAt = this.now();
      let accountHealthy = false;
      try {
        const quota = await this.rclone.about(account.rawRemote);
        const health = classifyHealth(quota);
        this.accounts.recordHealth(account.id, {
          health,
          totalBytes: quota.total,
          freeBytes: quota.free,
          checkedAt,
        });
        accountHealthy = health === 'HEALTHY';
        if (accountHealthy) healthy += 1;
        else failed += 1;
      } catch {
        // A failed probe means current capacity is unknown. Keeping yesterday's
        // number would make the UI look precise and the selector could trust stale
        // headroom, so fail closed and retain no quota claim.
        this.accounts.recordHealth(account.id, {
          health: 'OFFLINE',
          totalBytes: null,
          freeBytes: null,
          checkedAt,
        });
        failed += 1;
      }

      try {
        this.onAccountUpdated?.(account.id, accountHealthy);
      } catch {
        // A broken event/log sink must not stop the remaining account probes.
      }
    }

    return { checked: candidates.length, healthy, failed };
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const result = await this.tick();
        try {
          this.onTick?.(result);
        } catch {
          // Logging is not part of refreshing quota.
        }
      } catch (error) {
        try {
          this.onError?.(error);
        } catch {
          // A failing reporter must not kill future refreshes.
        }
      }

      if (signal.aborted) return;
      await this.sleep(this.intervalMs, signal);
    }
  }
}
