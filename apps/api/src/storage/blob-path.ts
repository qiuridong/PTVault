/**
 * Content-addressed remote object naming — the single source of truth for every
 * cloud path this service writes.
 *
 * Why content addressing at all: the original plan mirrored the source tree into
 * the crypt remote (`library/<torrentHash>/<relative path>`). A 2026-08-02
 * preflight against the real media tree proved that shape unusable — rclone's
 * `standard` filename encryption inflates each segment by roughly 1.29x of its
 * *byte* length, and CJK names run three bytes per character, so a 246-byte
 * filename encrypts to ~410 characters and blows OneDrive's 255-character
 * segment limit. 1266 of 9372 files (13.5%) were over a limit, the worst full
 * path measuring 784 of 400 allowed characters.
 *
 * A SHA-256 digest is 64 ASCII characters no matter what the source is called,
 * so every path built here is a fixed, provably safe length: ~104 characters per
 * encrypted segment and ~231 for the longest full path, against limits of 255
 * and 400. Path length stops depending on the source filename entirely.
 *
 * The two-character shard prefix keeps any single remote directory from
 * accumulating the whole library, which providers list slowly.
 *
 * Original filenames are not lost: `cloud_replicas.relative_path` still records
 * the source-relative path for every replica, and the recovery bundle carries it
 * too. Only the *remote* object name is content-addressed.
 */

/** A lowercase hex SHA-256 digest — the only accepted blob identity. */
const SHA256_HEX = /^[a-f0-9]{64}$/;

/** Root prefix for permanently committed objects. */
export const LIBRARY_BLOB_ROOT = 'blobs';

/**
 * Guards every digest before it reaches a remote path. A `null`, truncated, or
 * uppercase digest reaching rclone would create an object nothing can find
 * again, so this throws rather than coercing.
 */
function assertDigest(sha256: string): void {
  if (!SHA256_HEX.test(sha256)) throw new Error('INVALID_BLOB_DIGEST');
}

/**
 * The digest-derived portion shared by every namespace:
 * `<first two hex characters>/<full digest>`.
 */
export function blobRelativePath(sha256: string): string {
  assertDigest(sha256);
  return `${sha256.slice(0, 2)}/${sha256}`;
}

/** Permanent location of committed bytes: `blobs/<shard>/<digest>`. */
export function libraryBlobPath(sha256: string): string {
  return `${LIBRARY_BLOB_ROOT}/${blobRelativePath(sha256)}`;
}

/**
 * Location under a staging prefix: `<staging prefix>/<shard>/<digest>`.
 *
 * The caller's prefix still carries its job id (`staging/<jobId>` or
 * `staging-secondary/<jobId>`) on purpose — `ReconcileService` identifies orphan
 * upload areas by matching `offload_snapshots.staging_prefix` exactly, so
 * flattening staging into a global blob namespace would break crash-recovery
 * quarantine.
 */
export function stagingBlobPath(stagingPrefix: string, sha256: string): string {
  if (stagingPrefix.length === 0) throw new Error('INVALID_STAGING_PREFIX');
  return `${stagingPrefix}/${blobRelativePath(sha256)}`;
}
