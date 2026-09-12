import path from 'node:path';

/**
 * Builds the exact argv for the read-only aggregate mount Jellyfin reads through.
 *
 * Argv arrays, never a command string. Every path here is operator-configured and
 * the media tree is full of spaces, quotes, and CJK characters — a shell string
 * would need escaping that is easy to get subtly wrong, and getting it wrong on a
 * mount command means either a failed mount or an argument landing somewhere
 * unintended.
 *
 * This module does not launch anything. The reviewed systemd unit does that, so
 * the arguments can be inspected and diffed before any process starts.
 */
export type MountSpecInput = {
  rcloneBin: string;
  nodeBin: string;
  managedRcloneCli: string;
  rcloneConfigPath: string;
  /** The crypt remote holding the blobs, e.g. `ptvault-crypt:`. */
  cryptRemote: string;
  /** Where the read-only view is exposed. */
  mountPoint: string;
  /** VFS cache directory; must be on the hot filesystem. */
  cacheDirectory: string;
  cacheMaxBytes: number;
  /** Bytes to keep free; passed to rclone as `--vfs-cache-min-free-space`. */
  minFreeBytes: number;
  /** Loopback-only RC address, e.g. `127.0.0.1:5572`. */
  rcAddress: string;
  /**
   * htpasswd file guarding the RC listener.
   *
   * `--rc-htpasswd`, not `--rc-pass`: the latter puts the password in argv, where
   * any local user can read it out of `ps`. Verified against `rclone help flags` on
   * v1.74.4 — an earlier version of this module passed a `--rc-pass-file` flag that
   * does not exist, and rclone refused to start.
   */
  rcHtpasswdFile: string;
  logLevel?: 'INFO' | 'NOTICE' | 'ERROR';
};

export type MountSpec = {
  executable: string;
  args: string[];
};

function assertAbsolute(label: string, value: string): void {
  if (value.includes('\0')) throw new Error(`MOUNT_${label}_HAS_NUL`);
  if (!path.posix.isAbsolute(value)) throw new Error(`MOUNT_${label}_NOT_ABSOLUTE`);
  if (value !== path.posix.normalize(value)) throw new Error(`MOUNT_${label}_NOT_NORMALIZED`);
}

/**
 * Loopback only. An RC port reachable off-box would let anyone who can connect
 * evict cache, read the mount's config, or stop the mount serving Jellyfin.
 */
function assertLoopback(address: string): void {
  const match = /^(127\.0\.0\.1|\[::1\]|localhost):([0-9]{1,5})$/.exec(address);
  if (!match) throw new Error('MOUNT_RC_ADDRESS_NOT_LOOPBACK');
  const port = Number(match[2]);
  if (port < 1 || port > 65_535) throw new Error('MOUNT_RC_PORT_INVALID');
}

export function buildMountSpec(input: MountSpecInput): MountSpec {
  assertAbsolute('RCLONE_BIN', input.rcloneBin);
  assertAbsolute('NODE_BIN', input.nodeBin);
  assertAbsolute('MANAGED_RCLONE_CLI', input.managedRcloneCli);
  assertAbsolute('RCLONE_CONFIG', input.rcloneConfigPath);
  assertAbsolute('MOUNT_POINT', input.mountPoint);
  assertAbsolute('CACHE_DIR', input.cacheDirectory);
  assertAbsolute('RC_HTPASSWD_FILE', input.rcHtpasswdFile);
  assertLoopback(input.rcAddress);

  if (!/^[A-Za-z0-9_-]+:$/.test(input.cryptRemote)) throw new Error('MOUNT_REMOTE_INVALID');
  if (!Number.isSafeInteger(input.cacheMaxBytes) || input.cacheMaxBytes <= 0) {
    throw new Error('MOUNT_CACHE_MAX_INVALID');
  }
  if (!Number.isSafeInteger(input.minFreeBytes) || input.minFreeBytes <= 0) {
    throw new Error('MOUNT_MIN_FREE_INVALID');
  }
  // The cache is inside the mount it caches for: rclone would be writing cache
  // entries into the filesystem it is serving, which deadlocks under read load.
  if (
    input.cacheDirectory === input.mountPoint ||
    input.cacheDirectory.startsWith(`${input.mountPoint}/`)
  ) {
    throw new Error('MOUNT_CACHE_DIR_INSIDE_MOUNT');
  }

  return {
    executable: input.nodeBin,
    args: [
      input.managedRcloneCli,
      '--rclone-bin',
      input.rcloneBin,
      '--',
      'mount',
      `${input.cryptRemote}blobs`,
      input.mountPoint,
      '--config',
      input.rcloneConfigPath,
      // Read-only is the load-bearing flag on this whole feature. Jellyfin scans,
      // writes trickplay images, and would happily create files next to media; a
      // writable mount turns any of that into a mutation of the cloud library.
      '--read-only',
      // Jellyfin reads this mount as a different uid inside its container, and a
      // FUSE mount is private to its mounter by default — without this the container
      // gets EACCES on every path. Requires `user_allow_other` in /etc/fuse.conf.
      '--allow-other',
      // Read-only for everyone else: `--allow-other` alone would also grant write
      // permission bits, and this view must stay unwritable no matter who reads it.
      '--umask',
      '0222',
      // `full` because playback seeks. Lesser modes re-fetch on every seek, which
      // is what made crypt playback unusable before.
      '--vfs-cache-mode',
      'full',
      '--vfs-cache-max-size',
      bytesFlag(input.cacheMaxBytes),
      // rclone's own floor, independent of our governor. Two layers on purpose:
      // ours reacts to policy, this one is enforced by the process writing bytes.
      '--vfs-cache-min-free-space',
      bytesFlag(input.minFreeBytes),
      '--cache-dir',
      input.cacheDirectory,
      // Sized for 1080p seeking against OneDrive: measured ~8.9 MiB/s sequential
      // and 1.2–1.35 s first byte, so a 32 MiB read-ahead covers roughly four
      // seconds of a 30–40 Mbps stream without inflating first-byte latency.
      '--vfs-read-ahead',
      '32M',
      '--buffer-size',
      '32M',
      // Chunked so a seek does not pull a whole 40 GiB object, growing for
      // sustained playback.
      '--vfs-read-chunk-size',
      '16M',
      '--vfs-read-chunk-size-limit',
      '128M',
      // The library changes only when this API changes it, so directory listings
      // can be cached aggressively; the API pokes the RC on catalog changes.
      '--dir-cache-time',
      '72h',
      '--poll-interval',
      '0',
      // Present so this process can ask for cache stats and targeted forgets
      // instead of touching the cache directory by hand.
      '--rc',
      '--rc-addr',
      input.rcAddress,
      '--rc-htpasswd',
      input.rcHtpasswdFile,
      '--log-level',
      input.logLevel ?? 'NOTICE',
      // Structured output so a supervisor can read errors instead of scraping.
      '--use-json-log',
      // No mount-time listing: a cold aggregate mount would otherwise block for
      // minutes on startup before Jellyfin can read anything.
      '--no-checksum',
      '--no-modtime',
    ],
  };
}

/**
 * Renders a byte count for an rclone SIZE flag.
 *
 * The `B` is not decoration. rclone's SIZE options — `--vfs-cache-max-size`,
 * `--vfs-cache-min-free-space` and friends — take **KiB** when the value carries
 * no suffix, so a bare byte count is silently multiplied by 1024. Measured on the
 * deployed v1.74.4 rather than inferred: passing `56988994355` made rclone report
 * a ceiling of 58356579644211 (53 TiB instead of 53 GiB), and the same number with
 * a `B` reported 56988847308 — the intended 53 GiB, give or take rclone's own
 * float rounding.
 *
 * What that cost while it was wrong: the min-free-space floor became 18.7 TiB on a
 * 116 GiB disk, i.e. 170× the whole filesystem. rclone therefore believed it was
 * permanently out of space and purged the playback cache continuously — the cache
 * held 108 MB during a stream and was empty half an hour later. The feature was not
 * merely misconfigured, it was inoperative, and nothing reported an error because
 * both values parsed perfectly well.
 */
function bytesFlag(bytes: number): string {
  return `${bytes}B`;
}
