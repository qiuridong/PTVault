import { z } from 'zod';

/**
 * Host telemetry for the machine this API runs on.
 *
 * Read from `/proc`, which means Linux only. Every rate in here is derived from
 * the difference between two counter readings, so it is `null` until a second
 * sample exists — a counter read once tells you the total since boot and nothing
 * at all about right now. Reporting 0 in that window would be a lie the operator
 * cannot distinguish from a genuinely idle machine.
 */
export const HostCpuSchema = z.object({
  cores: z.number().int().positive(),
  /** Busy percentage across all cores over the last sampling interval. */
  usagePercent: z.number().min(0).max(100).nullable(),
  /**
   * Kernel load averages. Comparable to `cores`: a load of 4 on 4 cores means
   * the run queue is exactly saturated, which is why `cores` travels with them.
   */
  load1: z.number().nonnegative(),
  load5: z.number().nonnegative(),
  load15: z.number().nonnegative(),
});

export const HostMemorySchema = z.object({
  totalBytes: z.number().int().nonnegative(),
  /**
   * `MemAvailable`, not `MemFree`. Free memory on a busy file server is close to
   * zero by design because the page cache uses everything spare; available is the
   * number that answers "can another process get memory without swapping".
   */
  availableBytes: z.number().int().nonnegative(),
  swapTotalBytes: z.number().int().nonnegative(),
  swapUsedBytes: z.number().int().nonnegative(),
});

export const HostInterfaceSchema = z.object({
  name: z.string().min(1),
  /** True for the interface carrying the default route — the real uplink. */
  isDefaultRoute: z.boolean(),
  rxBytesPerSecond: z.number().nonnegative().nullable(),
  txBytesPerSecond: z.number().nonnegative().nullable(),
  /** Cumulative since boot. Resets when the machine reboots, not on our schedule. */
  rxTotalBytes: z.number().int().nonnegative(),
  txTotalBytes: z.number().int().nonnegative(),
});

export const HostDiskSchema = z.object({
  name: z.string().min(1),
  readBytesPerSecond: z.number().nonnegative().nullable(),
  writeBytesPerSecond: z.number().nonnegative().nullable(),
  /**
   * Share of the interval the device had at least one request in flight. Above
   * ~90% the disk, not the network, is what a migration is waiting on.
   */
  busyPercent: z.number().min(0).max(100).nullable(),
});

/** One retained point of the rolling history, for drawing a line rather than a dot. */
export const HostSampleSchema = z.object({
  at: z.number().int().positive(),
  cpuPercent: z.number().min(0).max(100).nullable(),
  rxBytesPerSecond: z.number().nonnegative().nullable(),
  txBytesPerSecond: z.number().nonnegative().nullable(),
  readBytesPerSecond: z.number().nonnegative().nullable(),
  writeBytesPerSecond: z.number().nonnegative().nullable(),
});

/**
 * Measured migration throughput, from the jobs that actually ran.
 *
 * Two windows, because they answer different questions and differ by a lot:
 * `uploadPhase` is the `UPLOADING_STAGING → VERIFYING` leg — bytes over the wire
 * to OneDrive — and `endToEnd` is the whole thing from queueing to
 * `CLOUD_COMMITTED`, which also includes hashing every byte locally and reading
 * the whole object back down again to verify it decrypts to the same hash.
 * Estimating "when will this finish" from the upload leg alone under-reports by
 * however long verification takes.
 *
 * Weighted by bytes (total bytes ÷ total seconds), not an average of per-job
 * rates: a 700 MiB job and a 600 GiB job should not get an equal vote when the
 * number is about to be used to estimate a large one.
 */
export const ThroughputWindowSchema = z.object({
  jobs: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  seconds: z.number().nonnegative(),
  /** `null` when no completed job carried measurable bytes and time. */
  bytesPerSecond: z.number().positive().nullable(),
});

export const MigrationThroughputSchema = z.object({
  uploadPhase: ThroughputWindowSchema,
  endToEnd: ThroughputWindowSchema,
  /** Epoch ms of the most recent measured commit, or null if none. */
  lastCommittedAt: z.number().int().positive().nullable(),
});

/**
 * Why host telemetry is missing, when it is.
 *
 * Stated rather than implied by empty fields: a dashboard that renders zeros for
 * "no `/proc` on this platform" is indistinguishable from one rendering a truly
 * idle machine, and the operator would act on it.
 */
export const HostSourceSchema = z.enum(['PROC', 'UNAVAILABLE']);

export const SystemMetricsSchema = z.object({
  source: HostSourceSchema,
  /** Present only when `source` is `UNAVAILABLE`; a short code, never a path. */
  unavailableReason: z.string().nullable(),
  sampledAt: z.number().int().positive().nullable(),
  /** Interval between retained samples, so a client can label the history axis. */
  sampleIntervalMs: z.number().int().positive(),
  uptimeSeconds: z.number().nonnegative().nullable(),
  cpu: HostCpuSchema.nullable(),
  memory: HostMemorySchema.nullable(),
  interfaces: z.array(HostInterfaceSchema),
  /**
   * Interfaces left out of the list above. A Docker host has one `veth` per
   * container; listing them all would bury the uplink in noise. Reported as a
   * count rather than silently dropped.
   */
  omittedInterfaces: z.number().int().nonnegative(),
  disks: z.array(HostDiskSchema),
  history: z.array(HostSampleSchema),
  throughput: MigrationThroughputSchema,
});

/** Stable deployment facts used by the read-only System settings section. */
export const SystemInfoSchema = z.object({
  mode: z.enum(['SHADOW', 'ACTIVE']),
  /** Operator-supplied release label; null when this build was not labelled. */
  version: z.string().min(1).max(64).nullable(),
  /** Git identity supplied with the deployed artifact; may explicitly include `+dirty`. */
  buildCommit: z.string().min(7).max(128).nullable(),
  schemaVersion: z.number().int().nonnegative(),
  mounts: z.object({
    total: z.number().int().nonnegative(),
    healthy: z.number().int().nonnegative(),
  }),
  /** A full mount probe plus farm sync completed at this epoch-ms value. */
  lastReconciledAt: z.number().int().nonnegative().nullable(),
});

export type HostCpu = z.infer<typeof HostCpuSchema>;
export type HostMemory = z.infer<typeof HostMemorySchema>;
export type HostInterface = z.infer<typeof HostInterfaceSchema>;
export type HostDisk = z.infer<typeof HostDiskSchema>;
export type HostSample = z.infer<typeof HostSampleSchema>;
export type ThroughputWindow = z.infer<typeof ThroughputWindowSchema>;
export type MigrationThroughput = z.infer<typeof MigrationThroughputSchema>;
export type SystemMetrics = z.infer<typeof SystemMetricsSchema>;
export type SystemInfo = z.infer<typeof SystemInfoSchema>;
