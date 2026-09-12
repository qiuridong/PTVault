import type { ImportProgressSnapshot } from '@ptvault/contracts';

/** A rate/ETA sample older than this no longer describes current transfer work. */
export const IMPORT_TELEMETRY_STALE_AFTER_MS = 15_000;

export type ImportTelemetryState = 'waiting' | 'stale' | 'fresh' | 'missing';

/**
 * One authority for rate and ETA freshness in both the list and detail views.
 *
 * A durable resource wait always wins: the job holds no permit and therefore is
 * not transferring even if an older API left figures on the row. Missing sample
 * time remains a separate legacy state, while future timestamps are treated as
 * fresh rather than being aged out by clock skew in the wrong direction.
 */
export function importTelemetryState(
  progress: ImportProgressSnapshot,
  now: number,
): ImportTelemetryState {
  if (
    progress.resourceWait !== undefined ||
    progress.state === 'RETRY_WAIT' ||
    (progress.state === 'RUNNING' && progress.downloadRetryInPlace)
  )
    return 'waiting';
  if (progress.ratesSampledAt === undefined) return 'missing';
  return now - progress.ratesSampledAt > IMPORT_TELEMETRY_STALE_AFTER_MS ? 'stale' : 'fresh';
}

/** Only these states may expose the associated rate and ETA figures. */
export function importTelemetryIsVisible(state: ImportTelemetryState): boolean {
  return state === 'fresh' || state === 'missing';
}
