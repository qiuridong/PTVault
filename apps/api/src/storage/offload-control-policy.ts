/**
 * A pause normally unwinds rclone in seconds. Thirty seconds is long enough for
 * graceful termination plus forced-kill escalation, while still giving the UI a
 * bounded point at which it must say "stalled" instead of "still pausing".
 */
export const OFFLOAD_PAUSE_ACK_TIMEOUT_MS = 30_000;

/**
 * Control receipts only protect operator retries around a request/reconnect.
 * Seven days covers long maintenance windows without making global receipts an
 * unbounded table (global rows have no job foreign key to cascade-delete them).
 */
export const OFFLOAD_CONTROL_RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/** Small transactions keep receipt housekeeping from delaying worker claims. */
export const OFFLOAD_CONTROL_RECEIPT_PRUNE_BATCH = 100;
