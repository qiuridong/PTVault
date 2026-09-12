import path from 'node:path';

/**
 * Where each account's read-only crypt view is mounted — the single source of
 * truth for mount paths, as `blob-path.ts` is for remote object names.
 *
 * One mount per storage account, not one aggregate view over all of them. An
 * rclone `union` was measured on the real machine first, and it fails the wrong
 * way: with one upstream's token revoked, `lsd` on the union returned exit 1 with
 * `couldn't fetch token: invalid_grant`, and reading a blob that lives on the
 * *healthy* upstream failed too. A union constructs its filesystem at mount time,
 * so one bad account takes the whole library offline.
 *
 * That is backwards for this design. `REPLICA_PROMOTE` exists so an important
 * title survives losing an account; putting both accounts behind a union would
 * make the second copy double the outage surface instead of halving it. With one
 * mount each, a dead account costs exactly the titles whose active replica lives
 * there, and every other title keeps playing.
 *
 * The layout is `<root>/<accountId>`, and the root itself is a plain directory.
 * Mounts nested under it propagate into the Jellyfin container through the single
 * `rslave` bind on the root — verified on the real machine with a throwaway
 * container: a tmpfs mounted on a subdirectory *after* the container started
 * appeared in the container's `/proc/mounts` and its file was readable. So adding
 * an account never requires touching compose or recreating a container.
 */

/** Account ids are uuids; this also rejects anything that is not one path segment. */
const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Rejects an account id that could not be one path segment.
 *
 * Exported so every caller enforces the same rule at the point it validates its own
 * inputs. The farm needs it *before* it resolves a mount point: an id containing
 * `..` or `/` is a bad plan entry regardless of whether the mount root is usable,
 * and reporting the root first would hide it.
 */
export function assertAccountId(accountId: string): void {
  if (!ACCOUNT_ID.test(accountId)) throw new Error('MOUNT_ACCOUNT_ID_INVALID');
}

function assertMountRoot(mountRoot: string): void {
  if (mountRoot.includes('\0')) throw new Error('MOUNT_ROOT_HAS_NUL');
  if (!path.posix.isAbsolute(mountRoot)) throw new Error('MOUNT_ROOT_NOT_ABSOLUTE');
  if (mountRoot !== path.posix.normalize(mountRoot)) throw new Error('MOUNT_ROOT_NOT_NORMALIZED');
  // `/` would make every account id a top-level directory on the host.
  if (mountRoot === '/') throw new Error('MOUNT_ROOT_IS_FILESYSTEM_ROOT');
}

/**
 * Absolute mount point for one account.
 *
 * The account id is validated rather than escaped: it reaches a mount command and
 * a symlink target, and a value containing `..` or `/` would place a mount, or
 * point a link, outside the tree Jellyfin is allowed to read.
 */
export function mountPointForAccount(mountRoot: string, accountId: string): string {
  // Account id first: it is the caller-supplied value, and reporting the root's
  // shape ahead of it would mask a bad id behind an unrelated complaint.
  assertAccountId(accountId);
  assertMountRoot(mountRoot);
  return path.posix.join(mountRoot, accountId);
}

/**
 * Per-account VFS cache directory.
 *
 * Separate directories because each mount is its own rclone process with its own
 * cache; pointing two at one directory would have them evicting each other's
 * entries while both believed they were within budget.
 */
export function cacheDirectoryForAccount(cacheRoot: string, accountId: string): string {
  assertAccountId(accountId);
  assertMountRoot(cacheRoot);
  return path.posix.join(cacheRoot, accountId);
}

/**
 * Loopback RC port for one account's mount, derived from its index.
 *
 * Each rclone process needs its own RC listener. Derived from a stable ordering
 * rather than assigned at random so a restart reaches the same port it recorded.
 */
export function rcAddressForIndex(basePort: number, index: number): string {
  if (!Number.isSafeInteger(basePort) || basePort < 1024 || basePort > 65_535) {
    throw new Error('MOUNT_RC_BASE_PORT_INVALID');
  }
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('MOUNT_RC_INDEX_INVALID');
  const port = basePort + index;
  if (port > 65_535) throw new Error('MOUNT_RC_PORT_EXHAUSTED');
  return `127.0.0.1:${port}`;
}

/**
 * Splits the cache ceiling across mounts.
 *
 * The approved 500 GiB ceiling covers the cache as a whole, so N mounts each get
 * a share rather than N times the budget. Floor, and a floor of at least one
 * byte: rounding the per-mount share up would let the total exceed what the
 * operator agreed to once every mount filled.
 */
export function perMountCacheMaxBytes(totalCacheMaxBytes: number, mountCount: number): number {
  if (!Number.isSafeInteger(totalCacheMaxBytes) || totalCacheMaxBytes <= 0) {
    throw new Error('MOUNT_CACHE_TOTAL_INVALID');
  }
  if (!Number.isSafeInteger(mountCount) || mountCount <= 0) {
    throw new Error('MOUNT_COUNT_INVALID');
  }
  return Math.max(1, Math.floor(totalCacheMaxBytes / mountCount));
}
