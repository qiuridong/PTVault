import { stat, statfs } from 'node:fs/promises';

const GiB = 1024 ** 3;

/**
 * The hard ceiling on VFS cache, independent of configuration.
 *
 * 500 GiB is the figure the operator approved. Treated as a ceiling rather than a
 * default so a larger configured value is clamped instead of honoured — a
 * mistyped config must not be able to hand the cache more disk than was agreed.
 */
export const CACHE_MAX_CEILING_BYTES = 500 * GiB;

/**
 * Fraction of each filesystem kept free at all times.
 *
 * Applied to both pools, for different reasons. On the hot disk it is what keeps
 * a restore from starving the torrents this system exists to preserve; on the
 * cache disk it is what keeps the operating system's own disk from filling up
 * with video nobody is watching any more.
 */
export const DISK_RESERVE_FRACTION = 0.15;

/**
 * The two disks are separate, and conflating them is a real bug this type exists
 * to prevent.
 *
 * The hot root is where torrents live and where a restore lands — the 4 TB data
 * disk on the reference machine. The VFS cache is temporary viewing space, and
 * the operator put it on the system SSD: smaller, faster, and deliberately not
 * the disk qB is writing to. Free space on one says nothing about the other, so a
 * single `reserveBytes` compared against a single `freeBytes` produced a pressure
 * verdict about neither.
 */
export type DiskPolicy = {
  /** Ceiling for the rclone VFS cache, on the cache filesystem. */
  cacheMaxBytes: number;
  /** Bytes kept free on the hot filesystem, so a restore cannot starve qB. */
  reserveBytes: number;
  /** Bytes kept free on the cache filesystem, so viewing cache cannot fill the system disk. */
  cacheReserveBytes: number;
};

/**
 * Derives both pools' lines from the disk each one actually lives on.
 *
 * The cache ceiling is now bounded by the cache disk rather than only by the
 * approved figure. Before, it was `min(configured, 500 GiB)` with the disk's size
 * never consulted, so on the 125 GB system SSD the API believed it had a 500 GiB
 * ceiling — 250 GiB per mount — while rclone, the thing that actually enforces it,
 * had been rendered at 53.1 GiB per mount from that disk's real size. The two
 * never agreed, and the API's figure was the wrong one.
 *
 * `Math.ceil` on the reserves rather than floor: rounding a safety margin down
 * would give the cache the rounding error, and every rounding decision here should
 * favour free space.
 */
export function calculateDiskPolicy(input: {
  /** Total size of the filesystem holding the hot root. */
  hotTotalBytes: number;
  /** Total size of the filesystem holding the VFS cache. */
  cacheTotalBytes: number;
  configuredCacheMaxBytes?: number;
}): DiskPolicy {
  const configured = input.configuredCacheMaxBytes ?? CACHE_MAX_CEILING_BYTES;
  if (!Number.isSafeInteger(input.hotTotalBytes) || input.hotTotalBytes <= 0) {
    throw new Error('DISK_TOTAL_INVALID');
  }
  if (!Number.isSafeInteger(input.cacheTotalBytes) || input.cacheTotalBytes <= 0) {
    throw new Error('DISK_CACHE_TOTAL_INVALID');
  }
  if (!Number.isSafeInteger(configured) || configured <= 0) {
    throw new Error('DISK_CACHE_MAX_INVALID');
  }

  const cacheReserveBytes = Math.ceil(input.cacheTotalBytes * DISK_RESERVE_FRACTION);
  return {
    // Whatever is smallest: the approved ceiling, any configured value, and what
    // the cache disk can actually give up without breaching its own reserve.
    cacheMaxBytes: Math.max(
      1,
      Math.min(configured, CACHE_MAX_CEILING_BYTES, input.cacheTotalBytes - cacheReserveBytes),
    ),
    reserveBytes: Math.ceil(input.hotTotalBytes * DISK_RESERVE_FRACTION),
    cacheReserveBytes,
  };
}

export type DiskUsage = {
  totalBytes: number;
  freeBytes: number;
};

/**
 * Reads real capacity for the filesystem holding `path`.
 *
 * Uses `bavail` (blocks available to unprivileged users), not `bfree`. The
 * difference is the root-only reserve, and counting it as usable would let the
 * cache plan against space this service — running as `ptvault` — cannot have.
 */
export async function readDiskUsage(path: string): Promise<DiskUsage> {
  const stats = await statfs(path);
  const blockSize = Number(stats.bsize);
  const total = Number(stats.blocks) * blockSize;
  const free = Number(stats.bavail) * blockSize;
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(free)) {
    throw new Error('DISK_USAGE_UNREADABLE');
  }
  return { totalBytes: total, freeBytes: free };
}

/**
 * Whether two paths sit on the same filesystem.
 *
 * Asked because "free some cache to make room for a restore" is only true when the
 * cache and the restore land on the same device. On the reference machine they do
 * not: the hot root is the 4 TB data disk and the VFS cache is on the 125 GB system
 * disk, so evicting every cached byte would not free a single byte where a restore
 * needs one. Measured rather than assumed — the two paths are independent settings
 * and an operator may well put them together.
 */
export async function isSameFilesystem(left: string, right: string): Promise<boolean> {
  const [leftStats, rightStats] = await Promise.all([stat(left), stat(right)]);
  return leftStats.dev === rightStats.dev;
}

/**
 * How many bytes may still be handed out, after the reserve and any space other
 * jobs have already claimed.
 *
 * Clamped at zero rather than returning a negative: callers ask "how much can I
 * take", and a negative answer invites arithmetic that accidentally admits work.
 */
export function admissibleBytes(input: {
  freeBytes: number;
  reserveBytes: number;
  outstandingReservedBytes: number;
}): number {
  const available = input.freeBytes - input.reserveBytes - input.outstandingReservedBytes;
  return available > 0 ? available : 0;
}

export type PressureInput = {
  freeBytes: number;
  reserveBytes: number;
  cacheBytes: number;
  cacheMaxBytes: number;
};

/**
 * Classifies current disk pressure.
 *
 * `CRITICAL` means free space is already at or under the reserve — nothing new is
 * admitted until eviction recovers headroom. `EVICTING` covers two different
 * situations that call for the same response: approaching the reserve, or a cache
 * that has grown past its ceiling. Both are fixed by giving unpinned cache back.
 */
export function classifyPressure(input: PressureInput): 'NORMAL' | 'EVICTING' | 'CRITICAL' {
  if (input.freeBytes <= input.reserveBytes) return 'CRITICAL';
  if (input.cacheBytes > input.cacheMaxBytes) return 'EVICTING';
  // Within a tenth of the reserve line: act before the reserve is breached
  // rather than after, since eviction is not instantaneous.
  if (input.freeBytes - input.reserveBytes <= Math.ceil(input.reserveBytes * 0.1)) {
    return 'EVICTING';
  }
  return 'NORMAL';
}
