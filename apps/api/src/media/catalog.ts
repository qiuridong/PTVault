import path from 'node:path';

import type { MediaAvailability, MediaCatalogEntry } from '@ptvault/contracts';

import type { AppDatabase } from '../db/database.js';

/**
 * Maps each migrated torrent to the one stable path Jellyfin reads.
 *
 * The path is deliberately independent of where the bytes currently are. A title
 * keeps the same logical path whether it is local, in the cloud, or both — that
 * is what lets the operator migrate a subset without Jellyfin noticing, and what
 * stops a restore from creating a duplicate library entry.
 *
 * Cloud object names are content hashes (`blobs/<sha256[:2]>/<sha256>`), so the
 * mount alone shows a directory of 64-character hex names. This table is the only
 * thing that maps those back to something a media server can identify.
 */
export type MediaCatalogOptions = {
  db: AppDatabase;
  /** Where local (never-migrated or restored) media lives, e.g. `/data/downloads`. */
  hotRoot: string;
  now?: () => number;
};

type CatalogRow = {
  instanceId: string;
  torrentHash: string;
  name: string;
  logicalPath: string;
  activeAccountId: string | null;
  localHot: number;
  catalogVersion: number;
  totalBytes: number;
  pinned: number;
};

export class MediaCatalog {
  private readonly now: () => number;

  constructor(private readonly options: MediaCatalogOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Records or refreshes a title's logical path.
   *
   * Called after a primary replica verifies. The logical path is derived from the
   * torrent's own content path relative to the hot root, so a restored file lands
   * back at the same place it was migrated from — anything else would leave
   * Jellyfin with a stale entry pointing at a path nobody writes to.
   */
  upsert(input: {
    instanceId: string;
    torrentHash: string;
    logicalPath: string;
    activeAccountId: string | null;
    localHot: boolean;
  }): void {
    assertRelativeLogicalPath(input.logicalPath);
    const timestamp = this.now();
    this.options.db
      .prepare(
        `INSERT INTO media_catalog(
           instance_id, torrent_hash, logical_path, active_account_id, local_hot,
           catalog_version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(instance_id, torrent_hash) DO UPDATE SET
           logical_path = excluded.logical_path,
           active_account_id = excluded.active_account_id,
           local_hot = excluded.local_hot,
           -- Bumped so a mount refresh can be ordered without diffing the tree.
           catalog_version = media_catalog.catalog_version + 1,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.instanceId,
        input.torrentHash,
        input.logicalPath,
        input.activeAccountId,
        input.localHot ? 1 : 0,
        timestamp,
        timestamp,
      );
  }

  /**
   * Promotes a verified secondary replica to primary, in one transaction.
   *
   * Refuses unless the target account already holds a VERIFIED replica of every
   * file. Promotion is for when the current primary's account is unhealthy; doing
   * it against an unverified copy would move the library to bytes nobody has read
   * back, which is the one failure mode this whole design exists to prevent.
   *
   * Never deletes or moves the outgoing replica. Demoting is a flag change, so a
   * promotion that turns out to be wrong is reversible.
   */
  promote(input: { instanceId: string; torrentHash: string; toAccountId: string }): void {
    this.options.db.transaction(() => {
      const files = this.options.db
        .prepare(
          `SELECT COUNT(*) AS total FROM cloud_replicas
           WHERE instance_id = ? AND torrent_hash = ? AND active = 1`,
        )
        .pluck()
        .get(input.instanceId, input.torrentHash) as number;
      if (files === 0) throw new Error('CATALOG_NO_ACTIVE_REPLICAS');

      const verifiedThere = this.options.db
        .prepare(
          `SELECT COUNT(*) FROM cloud_replicas
           WHERE instance_id = ? AND torrent_hash = ? AND account_id = ?
             AND active = 1 AND verification_status = 'VERIFIED'`,
        )
        .pluck()
        .get(input.instanceId, input.torrentHash, input.toAccountId) as number;

      const distinctPaths = this.options.db
        .prepare(
          `SELECT COUNT(DISTINCT relative_path) FROM cloud_replicas
           WHERE instance_id = ? AND torrent_hash = ? AND active = 1`,
        )
        .pluck()
        .get(input.instanceId, input.torrentHash) as number;

      // Every file, not merely some: a partial promotion would leave the library
      // serving a title that plays until it reaches a missing file.
      if (verifiedThere < distinctPaths) throw new Error('CATALOG_TARGET_NOT_FULLY_VERIFIED');

      const updated = this.options.db
        .prepare(
          `UPDATE media_catalog
           SET active_account_id = ?, catalog_version = catalog_version + 1, updated_at = ?
           WHERE instance_id = ? AND torrent_hash = ?`,
        )
        .run(input.toAccountId, this.now(), input.instanceId, input.torrentHash);
      if (updated.changes !== 1) throw new Error('CATALOG_ENTRY_NOT_FOUND');
    })();
  }

  /** Marks whether a local copy is present, which decides local-first precedence. */
  setLocalHot(input: { instanceId: string; torrentHash: string; localHot: boolean }): void {
    this.options.db
      .prepare(
        `UPDATE media_catalog SET local_hot = ?, catalog_version = catalog_version + 1,
           updated_at = ?
         WHERE instance_id = ? AND torrent_hash = ?`,
      )
      .run(input.localHot ? 1 : 0, this.now(), input.instanceId, input.torrentHash);
  }

  /**
   * The catalog as the UI and Jellyfin-facing layers see it.
   *
   * `isAccountHealthy` is a callback rather than a single boolean because each
   * account is mounted separately: a title is unavailable when *its* account's
   * mount is down, and the titles on every other account keep playing. Passing one
   * library-wide flag would report an outage the other accounts are not having.
   *
   * The distinction it drives is the important one: when the mount is down, a
   * cloud-only title becomes `UNAVAILABLE`, never "missing". An outage rendered as
   * absence is how an operator concludes their data is gone and starts doing
   * damage in response.
   */
  list(isAccountHealthy: (accountId: string) => boolean): MediaCatalogEntry[] {
    const rows = this.options.db
      .prepare(
        `SELECT c.instance_id AS instanceId, c.torrent_hash AS torrentHash,
                t.name AS name, c.logical_path AS logicalPath,
                c.active_account_id AS activeAccountId, c.local_hot AS localHot,
                c.catalog_version AS catalogVersion, t.total_size AS totalBytes,
                CASE WHEN p.logical_path IS NULL THEN 0 ELSE 1 END AS pinned
         FROM media_catalog c
         JOIN torrents t ON t.instance_id = c.instance_id AND t.hash = c.torrent_hash
         LEFT JOIN cache_pins p ON p.logical_path = c.logical_path
         ORDER BY c.logical_path`,
      )
      .all() as CatalogRow[];

    return rows.map((row) => ({
      instanceId: row.instanceId,
      torrentHash: row.torrentHash,
      name: row.name,
      logicalPath: row.logicalPath,
      activeAccountId: row.activeAccountId,
      availability: availabilityOf(
        row.localHot === 1,
        row.activeAccountId !== null,
        // A title with no active account has no mount to be healthy: pass false
        // rather than consulting the supervisor for an account that is not there.
        row.activeAccountId === null ? false : isAccountHealthy(row.activeAccountId),
      ),
      totalBytes: row.totalBytes,
      cachedBytes: null,
      pinned: row.pinned === 1,
      catalogVersion: row.catalogVersion,
    }));
  }

  /**
   * The farm-relative path this title is published at, or null when it has no
   * catalog row.
   *
   * Exists so a caller holding a torrent identity can ask what Jellyfin will read
   * for it. The farm plan is keyed by logical path and carries no torrent identity,
   * so without this lookup the only way to tell which link belongs to a given
   * torrent is the set of links a particular sync happened to create — which is a
   * different question, and answers it wrongly whenever something else created the
   * link first.
   */
  logicalPathOf(input: { instanceId: string; torrentHash: string }): string | null {
    const row = this.options.db
      .prepare(
        `SELECT logical_path AS logicalPath FROM media_catalog
         WHERE instance_id = ? AND torrent_hash = ?`,
      )
      .get(input.instanceId, input.torrentHash) as { logicalPath: string } | undefined;
    return row?.logicalPath ?? null;
  }

  /** Absolute path of the local copy, used to decide local-first precedence. */
  localPathFor(logicalPath: string): string {
    assertRelativeLogicalPath(logicalPath);
    return path.posix.join(this.options.hotRoot, logicalPath);
  }
}

/**
 * Local wins whenever it exists — that is the whole point of a local-first
 * overlay, and reading a local file costs nothing while a cloud read costs
 * bandwidth and cache.
 */
export function availabilityOf(
  localHot: boolean,
  hasCloudPrimary: boolean,
  mountHealthy: boolean,
): MediaAvailability {
  if (localHot && hasCloudPrimary) return mountHealthy ? 'BOTH' : 'LOCAL';
  if (localHot) return 'LOCAL';
  if (!hasCloudPrimary) return 'UNAVAILABLE';
  // Cloud-only with the mount down. `UNAVAILABLE` says "cannot be played right
  // now"; it must never be reported as the file being gone.
  return mountHealthy ? 'CLOUD' : 'UNAVAILABLE';
}

/**
 * Logical paths are relative and stay inside the library.
 *
 * An absolute path or one that climbs out with `..` would let a catalog row point
 * the overlay at somewhere outside the media tree — and the overlay is read by a
 * service running as another user.
 */
function assertRelativeLogicalPath(logicalPath: string): void {
  if (logicalPath.length === 0) throw new Error('CATALOG_LOGICAL_PATH_EMPTY');
  if (logicalPath.includes('\0')) throw new Error('CATALOG_LOGICAL_PATH_HAS_NUL');
  if (path.posix.isAbsolute(logicalPath) || /^[A-Za-z]:/.test(logicalPath)) {
    throw new Error('CATALOG_LOGICAL_PATH_NOT_RELATIVE');
  }
  const normalized = path.posix.normalize(logicalPath);
  if (normalized !== logicalPath) throw new Error('CATALOG_LOGICAL_PATH_NOT_NORMALIZED');
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error('CATALOG_LOGICAL_PATH_ESCAPES');
  }
}
