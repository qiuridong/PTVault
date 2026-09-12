import { dataPlaneInvariant, ImportDataPlaneError } from './errors.js';

export type RetryDecision = {
  delayMs: number;
  retryAt: number;
  source: 'retry-after' | 'exponential';
};

export function parseRetryAfter(value: string | null, now: Date): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    const milliseconds = seconds * 1000;
    return Number.isSafeInteger(seconds) &&
      Number.isSafeInteger(milliseconds) &&
      Number.isFinite(new Date(now.getTime() + milliseconds).getTime())
      ? milliseconds
      : null;
  }
  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now.getTime()) : null;
}

export function retryDecision(options: {
  attempt: number;
  retryAfterMs?: number | null;
  now?: Date;
  random?: () => number;
  baseMs?: number;
  maximumMs?: number;
}): RetryDecision {
  const now = options.now ?? new Date();
  dataPlaneInvariant(
    Number.isSafeInteger(options.attempt) && options.attempt >= 0,
    'RETRY_ATTEMPT_INVALID',
  );
  if (options.retryAfterMs !== undefined && options.retryAfterMs !== null) {
    dataPlaneInvariant(
      Number.isSafeInteger(options.retryAfterMs) && options.retryAfterMs >= 0,
      'RETRY_AFTER_INVALID',
    );
    return {
      delayMs: options.retryAfterMs,
      retryAt: now.getTime() + options.retryAfterMs,
      source: 'retry-after',
    };
  }

  const baseMs = options.baseMs ?? 30_000;
  const maximumMs = options.maximumMs ?? 30 * 60_000;
  dataPlaneInvariant(baseMs >= 1_000 && maximumMs >= baseMs, 'RETRY_CONFIG_INVALID');
  const exponent = Math.min(options.attempt, 20);
  const unjittered = Math.min(maximumMs, baseMs * 2 ** exponent);
  const sample = (options.random ?? Math.random)();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
    throw new ImportDataPlaneError('RETRY_RANDOM_INVALID');
  }
  const delayMs = Math.max(1_000, Math.round(unjittered * (0.8 + sample * 0.4)));
  return {
    delayMs,
    retryAt: now.getTime() + delayMs,
    source: 'exponential',
  };
}
