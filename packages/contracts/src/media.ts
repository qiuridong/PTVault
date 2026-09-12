import { z } from 'zod';

import { JobStateSchema } from './jobs.js';

/** Matches the identity used everywhere else: qB instance id plus infohash. */
const InstanceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);
const TorrentHashSchema = z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/);

/**
 * Disk pressure, in the order the governor escalates through it.
 *
 * `EVICTING` still serves playback — it only means unpinned cache is being given
 * back. `CRITICAL` is the state where the 15% reserve is at risk, so new cloud
 * reads stop being admitted rather than letting the disk fill.
 */
export const CachePressureSchema = z.enum(['NORMAL', 'EVICTING', 'CRITICAL']);

/**
 * What the API knows about one account's read-only mount that Jellyfin reads
 * through.
 *
 * One of these per storage account, not one for the library. Replicas are placed
 * by free space, so blobs are spread over accounts, and each account is mounted
 * separately — an rclone `union` over them was measured to fail closed, taking
 * healthy accounts down with the broken one.
 *
 * The consequence for any consumer: an unhealthy entry means *those* titles are
 * temporarily unplayable, never that the library is gone. Rendering a single
 * library-wide "mount down" from one bad entry would report an outage the other
 * accounts are not having.
 *
 * `mounted` and `rcReachable` are separate because they fail separately: the
 * mountpoint can still be present after rclone has stopped answering, and a
 * process that only checked one would report a healthy library that cannot
 * actually serve a byte.
 */
export const MountHealthSchema = z.object({
  accountId: z.string().min(1),
  /** Absolute path this account's crypt view is mounted at. */
  mountPoint: z.string().min(1),
  mounted: z.boolean(),
  rcReachable: z.boolean(),
  cacheBytes: z.number().int().nonnegative(),
  cacheMaxBytes: z.number().int().positive(),
  diskFreeBytes: z.number().int().nonnegative(),
  diskReserveBytes: z.number().int().positive(),
  pressure: CachePressureSchema,
  /** A stable code, never a raw rclone message — those carry remote paths. */
  lastError: z.string().nullable(),
  checkedAt: z.number().int().nonnegative().nullable(),
});

/**
 * Where a title can currently be played from.
 *
 * `LOCAL` and `CLOUD` are not exclusive in practice — a rehydrated torrent is
 * both — and the catalog prefers local, which is the whole point of the
 * local-first overlay. `UNAVAILABLE` means the mount is down, and it is
 * deliberately distinct from "the file is gone": an outage must never be
 * rendered as data loss.
 */
export const MediaAvailabilitySchema = z.enum(['LOCAL', 'CLOUD', 'BOTH', 'UNAVAILABLE']);

export const MediaCatalogEntrySchema = z.object({
  instanceId: InstanceIdSchema,
  torrentHash: TorrentHashSchema,
  name: z.string().min(1),
  /** Stable path Jellyfin sees, identical whether the bytes are local or cloud. */
  logicalPath: z.string().min(1),
  /**
   * Storage account whose mount currently backs this title, or null when no
   * replica has been promoted yet.
   *
   * Present because each account is mounted separately: this is what decides
   * which mount a link reads through, and which mount's health decides whether
   * this title is playable right now.
   */
  activeAccountId: z.string().min(1).nullable(),
  availability: MediaAvailabilitySchema,
  totalBytes: z.number().int().nonnegative(),
  /** Null when nothing of this title is cached; bytes present in the VFS cache. */
  cachedBytes: z.number().int().nonnegative().nullable(),
  pinned: z.boolean(),
  /** Bumped whenever the selected replica changes, so a refresh can be ordered. */
  catalogVersion: z.number().int().nonnegative(),
});

/**
 * The eight states a restore moves through.
 *
 * `VERIFYING_LOCAL` sits before `INSTALLING_LOCAL` on purpose: bytes are hashed
 * in a job-owned temp directory and only then renamed into the qB location, so a
 * corrupt download never overwrites the path qB is seeding from. `QB_RECHECKING`
 * precedes `QB_RESUMING` for the same reason — resuming a torrent qB has not
 * confirmed at 100% would announce data we have not verified.
 */
export const RehydrateStepSchema = z.enum([
  'RESERVING_SPACE',
  'EVICTING_CACHE',
  'DOWNLOADING_TEMP',
  'VERIFYING_LOCAL',
  'INSTALLING_LOCAL',
  'QB_RECHECKING',
  'QB_RESUMING',
  'COMPLETED',
]);

export const RehydrateRequestSchema = z.object({
  instanceId: InstanceIdSchema,
  torrentHash: TorrentHashSchema,
  /**
   * Whether qB should resume seeding once the local copy verifies. Defaults on
   * because restoring in order to seed is the point; a false value is for
   * restoring a file to watch without re-announcing to the tracker.
   */
  autoResume: z.boolean().default(true),
});

export const RehydrateSnapshotSchema = z.object({
  jobId: z.string().uuid(),
  instanceId: InstanceIdSchema,
  torrentHash: TorrentHashSchema,
  currentStep: RehydrateStepSchema,
  /** Worker ownership/state, separate from the durable rehydrate step. */
  jobState: JobStateSchema,
  autoResume: z.boolean(),
  /** Bytes reserved on the hot filesystem for this job, including temp overhead. */
  reservedBytes: z.number().int().nonnegative(),
  /** Set when admission failed: exactly how many bytes were missing. */
  blockedMissingBytes: z.number().int().nonnegative().nullable(),
  /**
   * When the verified bytes were renamed into the qB location.
   *
   * Load-bearing rather than informational: once set, cancelling would mean
   * deleting files qB is about to recheck, so the UI must stop offering it.
   */
  installedAt: z.number().int().nonnegative().nullable(),
  cancelledAt: z.number().int().nonnegative().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

/**
 * The health endpoint's payload: one entry per supervised mount.
 *
 * A wrapped list rather than a bare array so the shape can grow without breaking
 * clients, and deliberately not a single object — an empty list is a real state
 * (no storage account registered yet), and so is "one account down, two fine".
 * Collapsing those into one verdict is precisely the report an operator would act
 * on wrongly.
 */
export const MountHealthListSchema = z.object({
  mounts: z.array(MountHealthSchema),
});

/**
 * One filesystem's capacity, as this service sees it.
 *
 * Reported per pool because the hot root and the VFS cache are separate disks on
 * the reference machine — 4 TB of media on one, a 125 GB system SSD holding
 * temporary viewing cache on the other. Free space on one says nothing about the
 * other, and a single figure standing for both describes neither.
 */
export const DiskUsageSchema = z.object({
  path: z.string().min(1),
  totalBytes: z.number().int().nonnegative(),
  freeBytes: z.number().int().nonnegative(),
  /** The 15% line this pool must not cross. */
  reserveBytes: z.number().int().nonnegative(),
});

/**
 * What the migrations have bought, counted in SQL rather than in the browser.
 *
 * Aggregated server-side on purpose: the alternative is shipping the whole torrent
 * table to the client so it can sum a column, which makes the number's correctness
 * depend on the client having fetched all of it. One `GROUP BY` has one source of
 * truth and one place to assert against.
 */
export const StorageSavingsSchema = z.object({
  /** Local copy deleted; the bytes live only in the cloud now. */
  cloudCount: z.number().int().nonnegative(),
  cloudBytes: z.number().int().nonnegative(),
  /** Verified in the cloud but the local copy is deliberately still present. */
  awaitingCount: z.number().int().nonnegative(),
  awaitingBytes: z.number().int().nonnegative(),
});

export const DisksResponseSchema = z.object({
  hot: DiskUsageSchema,
  /**
   * On a single-disk deployment this carries the same `path` as `hot`; the caller
   * is expected to notice and render one disk rather than two identical ones.
   */
  cache: DiskUsageSchema.extend({
    cacheMaxBytes: z.number().int().nonnegative(),
  }),
  savings: StorageSavingsSchema,
});

export type DiskUsageReport = z.infer<typeof DiskUsageSchema>;
export type StorageSavings = z.infer<typeof StorageSavingsSchema>;
export type DisksResponse = z.infer<typeof DisksResponseSchema>;
export type CachePressure = z.infer<typeof CachePressureSchema>;
export type MountHealth = z.infer<typeof MountHealthSchema>;
export type MountHealthList = z.infer<typeof MountHealthListSchema>;
export type MediaAvailability = z.infer<typeof MediaAvailabilitySchema>;
export type MediaCatalogEntry = z.infer<typeof MediaCatalogEntrySchema>;
export type RehydrateStep = z.infer<typeof RehydrateStepSchema>;
export type RehydrateRequest = z.infer<typeof RehydrateRequestSchema>;
export type RehydrateSnapshot = z.infer<typeof RehydrateSnapshotSchema>;
