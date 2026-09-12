import { retryDecision } from './backoff.js';
import { dataPlaneInvariant, ImportDataPlaneError } from './errors.js';
import { isSourceNetworkRetryCode } from './network-retry.js';

export type DownloadContinuityOptions = {
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
};
type RetryNotice = { error: ImportDataPlaneError; sequence: number; retryAt: number };
type Operation<T> = {
  signal: AbortSignal;
  completedBytes: () => string;
  run: (retrying: boolean) => Promise<T>;
  onRetry: (notice: RetryNotice) => void | Promise<void>;
};

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      const reason: unknown = signal.reason;
      reject(
        reason instanceof Error ? reason : new ImportDataPlaneError('DOWNLOAD_RECOVERY_ABORTED'),
      );
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Read only a finite provider minimum. Invalid headers never become a 1ms timer. */
export function providerRetryAfterMs(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('retryAfterMs' in error)) return null;
  const value = error.retryAfterMs;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Keeps a short recovery episode with its current owner and durable checkpoint.
 * The caller releases download permits between attempts; this class owns none.
 * Three no-progress reconnects / a two-minute retry window are deliberately
 * distinct from the duration of a healthy multi-hour download. Real byte
 * progress starts a new recovery episode; counters never reset merely on claim.
 */
export class DownloadContinuity {
  private readonly now: () => number;
  private readonly sleep: NonNullable<DownloadContinuityOptions['sleep']>;
  private readonly random: () => number;
  constructor(options: DownloadContinuityOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleep;
    this.random = options.random ?? Math.random;
  }
  async run<T>(operation: Operation<T>): Promise<T> {
    let consecutive = 0,
      sequence = 0,
      episodeAt: number | undefined;
    for (;;) {
      operation.signal.throwIfAborted();
      const before = this.bytes(operation.completedBytes());
      try {
        return await operation.run(sequence > 0);
      } catch (error) {
        operation.signal.throwIfAborted();
        if (
          !(error instanceof ImportDataPlaneError) ||
          !isSourceNetworkRetryCode(error.code) ||
          error.downloadDiagnostic?.kind === 'TLS_FAILED'
        )
          throw error;
        const completed = this.bytes(operation.completedBytes());
        dataPlaneInvariant(completed >= before, 'DOWNLOAD_PROGRESS_REGRESSED');
        const now = this.now();
        if (completed > before || episodeAt === undefined) {
          consecutive = 0;
          episodeAt = now;
        }
        if (consecutive >= 3) throw error;
        const decision = retryDecision({
          attempt: consecutive,
          retryAfterMs: providerRetryAfterMs(error),
          now: new Date(now),
          random: this.random,
          baseMs: 5000,
          maximumMs: 30000,
        });
        if (decision.retryAt > episodeAt + 120000) throw error;
        sequence++;
        consecutive++;
        await operation.onRetry({ error, sequence, retryAt: decision.retryAt });
        operation.signal.throwIfAborted();
        await this.sleep(Math.max(0, decision.retryAt - this.now()), operation.signal);
      }
    }
  }
  private bytes(value: string): bigint {
    dataPlaneInvariant(/^(0|[1-9]\d{0,29})$/.test(value), 'DOWNLOAD_PROGRESS_INVALID');
    return BigInt(value);
  }
}
