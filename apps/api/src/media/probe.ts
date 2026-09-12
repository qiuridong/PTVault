import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { MountProbe } from './mount-supervisor.js';
import type { PrefetchReader, ByteRange } from './prefetch.js';

export type RcloneRcClient = {
  /** Calls an rclone RC method over the loopback listener. */
  call(
    method: string,
    parameters: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<unknown>;
};

export type MountProbeOptions = {
  mountPoint: string;
  rc: RcloneRcClient;
  /**
   * A path under the mount that must be readable. Reading it proves the crypt
   * layer can actually decrypt, which a mountpoint check alone does not.
   */
  sentinelRelativePath?: string;
};

/**
 * Probes the real mount.
 *
 * Three separate checks because they fail separately, and a supervisor that
 * collapsed them would report a healthy library that cannot serve a byte:
 * the mountpoint can remain present after rclone stops answering, and rclone can
 * answer while the crypt view cannot decrypt anything.
 */
export function createMountProbe(options: MountProbeOptions): MountProbe {
  return {
    async mountpointPresent(): Promise<boolean> {
      try {
        const stats = await lstat(options.mountPoint);
        if (!stats.isDirectory()) return false;
        // A FUSE mount that has died leaves the directory in place but makes reads
        // fail, so the directory existing is not enough on its own.
        await readdir(options.mountPoint);
        return true;
      } catch {
        return false;
      }
    },

    async rcReachable(): Promise<boolean> {
      try {
        await options.rc.call('rc/noop', {});
        return true;
      } catch {
        return false;
      }
    },

    async sentinelReadable(): Promise<boolean> {
      // Without a sentinel this check cannot distinguish "empty library" from
      // "cannot decrypt", so it reports the weaker claim rather than a false pass.
      if (options.sentinelRelativePath === undefined) {
        try {
          const entries = await readdir(options.mountPoint);
          return entries.length >= 0;
        } catch {
          return false;
        }
      }
      try {
        const target = path.posix.join(options.mountPoint, options.sentinelRelativePath);
        const stats = await lstat(target);
        return stats.size >= 0;
      } catch {
        return false;
      }
    },

    async cacheBytes(): Promise<number> {
      try {
        const stats = await options.rc.call('vfs/stats', {});
        const used = readCacheBytes(stats);
        return used ?? 0;
      } catch {
        return 0;
      }
    },
  };
}

/**
 * Pulls the cache size out of an `vfs/stats` reply.
 *
 * Defensive about shape rather than trusting it: this is parsed from another
 * program's JSON, and a version bump that moves the field should read as "unknown"
 * instead of throwing inside a health probe.
 */
function readCacheBytes(stats: unknown): number | null {
  if (stats === null || typeof stats !== 'object') return null;
  const disk = (stats as { diskCache?: unknown }).diskCache;
  if (disk === null || typeof disk !== 'object') return null;
  const bytes = (disk as { bytesUsed?: unknown }).bytesUsed;
  return typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : null;
}

/**
 * Warms the cache by reading ranges through the farm.
 *
 * Reads through the filesystem rather than asking rclone to fetch: the point is to
 * populate the same VFS cache Jellyfin will read from, and a copy made any other
 * way would not land there.
 *
 * Through the farm rather than a mount, which is what makes that true now that each
 * account is mounted separately. The farm link for a title already resolves to the
 * mount of whichever account currently backs it, so following it warms exactly the
 * cache Jellyfin will read — and the reader never has to be told which account that
 * is. A reader pointed at a mount root would have to guess, and guessing wrong warms
 * a cache nobody reads while playback still stalls.
 */
export function createPrefetchReader(input: {
  /** Root of the symlink farm — the same path Jellyfin reads through. */
  farmRoot: string;
  open: (absolutePath: string) => Promise<{
    read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<number>;
    close(): Promise<void>;
  }>;
}): PrefetchReader {
  return {
    async readRange(logicalPath: string, range: ByteRange, signal: AbortSignal): Promise<number> {
      const absolute = path.posix.join(input.farmRoot, logicalPath);
      const handle = await input.open(absolute);
      try {
        const chunkSize = 4 * 1024 * 1024;
        const buffer = new Uint8Array(chunkSize);
        let read = 0;
        let position = range.start;
        while (position <= range.end) {
          if (signal.aborted) break;
          const want = Math.min(chunkSize, range.end - position + 1);
          const got = await handle.read(buffer, 0, want, position);
          if (got === 0) break;
          read += got;
          position += got;
        }
        return read;
      } finally {
        await handle.close();
      }
    },
  };
}
