import type { AppDatabase } from '../db/database.js';
import type { NormalizedTorrentState, QbTorrent } from './types.js';

export type CloudState =
  'LOCAL' | 'MIGRATING' | 'CLOUD_COMMITTED' | 'CLOUD' | 'REHYDRATING' | 'BLOCKED';

export type QbInstanceRecord = {
  id: string;
  displayName: string;
  enabled: boolean;
  secretRef: string;
  /**
   * Per-instance container→host rewrites in the same `a=b,c=d` text the global
   * setting uses, or null to fall back to it. Stored as text rather than parsed
   * columns so one source of truth (`parsePathMaps`) validates both.
   */
  pathMaps?: string | null;
  /** When the poller last completed a pass, successful or not. */
  lastSyncAt?: number | null;
  /** Stable code from the last failed pass; null once a pass succeeds. */
  lastSyncError?: string | null;
};

type InstanceRow = {
  id: string;
  displayName: string;
  enabled: number;
  secretRef: string;
  pathMaps: string | null;
  lastSyncAt: number | null;
  lastSyncError: string | null;
};

function toInstanceRecord(row: InstanceRow): QbInstanceRecord {
  return {
    id: row.id,
    displayName: row.displayName,
    enabled: row.enabled === 1,
    secretRef: row.secretRef,
    pathMaps: row.pathMaps,
    lastSyncAt: row.lastSyncAt,
    lastSyncError: row.lastSyncError,
  };
}

export type TorrentRecord = {
  instanceId: string;
  hash: string;
  name: string;
  progress: number;
  state: NormalizedTorrentState;
  totalSize: number;
  amountLeft: number;
  contentPath: string;
  savePath: string;
  ratio: number;
  seedingSeconds: number;
  /** Unix epoch milliseconds, or null when qB reports no completion. */
  completedAt: number | null;
  cloudState: CloudState;
  firstSeenAt: number;
  lastSeenAt: number;
  absentSince: number | null;
};

export type TorrentFileRecord = {
  instanceId: string;
  torrentHash: string;
  relativePath: string;
  size: number;
  sha256: string | null;
  device: number | null;
  inode: number | null;
  linkCount: number | null;
  allocatedBytes: number | null;
  lastStatAt: number | null;
};

type TorrentRow = TorrentRecord;

export type InventoryWriteResult = {
  inserted: number;
  updated: number;
  markedAbsent: number;
};

export type InventoryRecord = Omit<QbTorrent, 'hash' | 'state'> & {
  hash: string;
  state: NormalizedTorrentState;
};

export type TorrentPage = {
  torrents: TorrentRecord[];
  total: number;
  page: number;
  size: number;
};

export class QbRepository {
  constructor(private readonly db: AppDatabase) {}

  /**
   * Writes the instance config.
   *
   * `pathMaps` is honoured only when the caller passes the key. Omitting it
   * keeps whatever is stored, because this method is also how a rename or an
   * enable/disable is saved, and those must not silently clear a mapping the
   * operator set on another screen. Passing `null` explicitly does clear it.
   *
   * The sync columns are never touched here at all: they record what the poller
   * observed, and a config save is not an observation.
   */
  upsertInstance(input: QbInstanceRecord & { pathMaps?: string | null }): void {
    const parameters = {
      id: input.id,
      displayName: input.displayName,
      enabled: input.enabled ? 1 : 0,
      secretRef: input.secretRef,
      pathMaps: input.pathMaps ?? null,
    };

    if ('pathMaps' in input) {
      this.db
        .prepare(
          `INSERT INTO qb_instances(id, display_name, enabled, secret_ref, path_maps)
           VALUES (@id, @displayName, @enabled, @secretRef, @pathMaps)
           ON CONFLICT(id) DO UPDATE SET
             display_name = excluded.display_name,
             enabled = excluded.enabled,
             secret_ref = excluded.secret_ref,
             path_maps = excluded.path_maps`,
        )
        .run(parameters);
      return;
    }

    this.db
      .prepare(
        `INSERT INTO qb_instances(id, display_name, enabled, secret_ref)
         VALUES (@id, @displayName, @enabled, @secretRef)
         ON CONFLICT(id) DO UPDATE SET
           display_name = excluded.display_name,
           enabled = excluded.enabled,
           secret_ref = excluded.secret_ref`,
      )
      .run({
        id: parameters.id,
        displayName: parameters.displayName,
        enabled: parameters.enabled,
        secretRef: parameters.secretRef,
      });
  }

  /**
   * Records what the last poll of this instance saw.
   *
   * `errorCode` is a stable code or null, never a message. Messages from qB and
   * from `fetch` carry URLs and paths, and this column is read straight into a
   * browser; a code is also the thing a UI can translate.
   */
  recordSyncOutcome(instanceId: string, outcome: { at: number; errorCode: string | null }): void {
    this.db
      .prepare(
        `UPDATE qb_instances
            SET last_sync_at = @at, last_sync_error = @errorCode
          WHERE id = @instanceId`,
      )
      .run({ instanceId, at: outcome.at, errorCode: outcome.errorCode });
  }

  listInstances(options: { enabledOnly?: boolean } = {}): QbInstanceRecord[] {
    const where = options.enabledOnly ? ' WHERE enabled = 1' : '';
    const rows = this.db
      .prepare(
        `SELECT id, display_name AS displayName, enabled, secret_ref AS secretRef,
                path_maps AS pathMaps, last_sync_at AS lastSyncAt,
                last_sync_error AS lastSyncError
         FROM qb_instances${where} ORDER BY id`,
      )
      .all() as InstanceRow[];
    return rows.map(toInstanceRecord);
  }

  getInstance(instanceId: string): QbInstanceRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, display_name AS displayName, enabled, secret_ref AS secretRef,
                path_maps AS pathMaps, last_sync_at AS lastSyncAt,
                last_sync_error AS lastSyncError
         FROM qb_instances WHERE id = ?`,
      )
      .get(instanceId) as InstanceRow | undefined;
    return row ? toInstanceRecord(row) : null;
  }

  getTorrent(instanceId: string, hash: string): TorrentRecord | null {
    const row = this.db
      .prepare(
        `SELECT instance_id AS instanceId, hash, name, progress, state,
                total_size AS totalSize, amount_left AS amountLeft,
                content_path AS contentPath, save_path AS savePath, ratio,
                seeding_seconds AS seedingSeconds, completed_at AS completedAt,
                cloud_state AS cloudState, first_seen_at AS firstSeenAt,
                last_seen_at AS lastSeenAt, absent_since AS absentSince
         FROM torrents WHERE instance_id = ? AND hash = ?`,
      )
      .get(instanceId, canonicalHash(hash)) as TorrentRow | undefined;
    return row ?? null;
  }

  listTorrents(instanceId?: string): TorrentRecord[] {
    const rows = this.db
      .prepare(
        `SELECT instance_id AS instanceId, hash, name, progress, state,
                total_size AS totalSize, amount_left AS amountLeft,
                content_path AS contentPath, save_path AS savePath, ratio,
                seeding_seconds AS seedingSeconds, completed_at AS completedAt,
                cloud_state AS cloudState, first_seen_at AS firstSeenAt,
                last_seen_at AS lastSeenAt, absent_since AS absentSince
         FROM torrents${instanceId === undefined ? '' : ' WHERE instance_id = ?'}
         ORDER BY instance_id, hash`,
      )
      .all(...(instanceId === undefined ? [] : [instanceId])) as TorrentRow[];
    return rows;
  }

  listTorrentsPage(input: { instanceId?: string; page: number; size: number }): TorrentPage {
    const where = input.instanceId === undefined ? '' : ' WHERE instance_id = ?';
    const params = input.instanceId === undefined ? [] : [input.instanceId];

    return this.db.transaction(() => {
      const total = this.db
        .prepare(`SELECT COUNT(*) FROM torrents${where}`)
        .pluck()
        .get(...params) as number;
      const lastPage = Math.max(1, Math.ceil(total / input.size));
      const page = Math.min(input.page, lastPage);
      const offset = (page - 1) * input.size;
      const torrents = this.db
        .prepare(
          `SELECT instance_id AS instanceId, hash, name, progress, state,
                  total_size AS totalSize, amount_left AS amountLeft,
                  content_path AS contentPath, save_path AS savePath, ratio,
                  seeding_seconds AS seedingSeconds, completed_at AS completedAt,
                  cloud_state AS cloudState, first_seen_at AS firstSeenAt,
                  last_seen_at AS lastSeenAt, absent_since AS absentSince
           FROM torrents${where}
           ORDER BY instance_id, hash
           LIMIT ? OFFSET ?`,
        )
        .all(...params, input.size, offset) as TorrentRow[];
      return { torrents, total, page, size: input.size };
    })();
  }

  /**
   * How much local disk the migrations have actually bought back.
   *
   * One `GROUP BY` rather than shipping the torrent table to the browser to sum a
   * column there. At the measured 546 bytes per torrent a full inventory is about
   * 4 MiB, and a number computed from a payload that large is only as right as the
   * client's luck in fetching all of it. Here it has one source of truth.
   *
   * `CLOUD` and `CLOUD_COMMITTED` are counted separately because they mean
   * opposite things about the local disk: the first has had its local copy
   * deleted, the second still holds every byte and is waiting for the operator to
   * approve that deletion. Adding them together would report space as freed while
   * it is still occupied.
   */
  storageSavings(): {
    cloudCount: number;
    cloudBytes: number;
    awaitingCount: number;
    awaitingBytes: number;
  } {
    const rows = this.db
      .prepare(
        `SELECT cloud_state AS cloudState, COUNT(*) AS n,
                COALESCE(SUM(total_size), 0) AS bytes
         FROM torrents
         WHERE cloud_state IN ('CLOUD', 'CLOUD_COMMITTED')
         GROUP BY cloud_state`,
      )
      .all() as Array<{ cloudState: string; n: number; bytes: number }>;

    const of = (state: string): { n: number; bytes: number } =>
      rows.find((row) => row.cloudState === state) ?? { n: 0, bytes: 0 };
    const cloud = of('CLOUD');
    const awaiting = of('CLOUD_COMMITTED');
    // Zeroes rather than absent keys when nothing has been migrated: a missing
    // field reads downstream as "unknown", and "nothing migrated yet" is a fact.
    return {
      cloudCount: cloud.n,
      cloudBytes: cloud.bytes,
      awaitingCount: awaiting.n,
      awaitingBytes: awaiting.bytes,
    };
  }

  listTorrentFiles(instanceId: string, hash: string): TorrentFileRecord[] {
    const rows = this.db
      .prepare(
        `SELECT instance_id AS instanceId, torrent_hash AS torrentHash,
                relative_path AS relativePath, size, sha256,
                device, inode, link_count AS linkCount,
                allocated_bytes AS allocatedBytes, last_stat_at AS lastStatAt
         FROM torrent_files
         WHERE instance_id = ? AND torrent_hash = ?
         ORDER BY relative_path`,
      )
      .all(instanceId, canonicalHash(hash)) as TorrentFileRecord[];
    return rows;
  }

  listAllTorrentFiles(): TorrentFileRecord[] {
    const rows = this.db
      .prepare(
        `SELECT instance_id AS instanceId, torrent_hash AS torrentHash,
                relative_path AS relativePath, size, sha256,
                device, inode, link_count AS linkCount,
                allocated_bytes AS allocatedBytes, last_stat_at AS lastStatAt
         FROM torrent_files
         ORDER BY instance_id, torrent_hash, relative_path`,
      )
      .all() as TorrentFileRecord[];
    return rows;
  }

  setCloudState(instanceId: string, hash: string, cloudState: CloudState): void {
    this.db
      .prepare('UPDATE torrents SET cloud_state = ? WHERE instance_id = ? AND hash = ?')
      .run(cloudState, instanceId, canonicalHash(hash));
  }

  reconcile(
    instanceId: string,
    records: readonly InventoryRecord[],
    timestamp: number,
  ): InventoryWriteResult {
    const transaction = this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT hash, absent_since AS absentSince FROM torrents WHERE instance_id = ?')
        .all(instanceId) as Array<{ hash: string; absentSince: number | null }>;
      const existingHashes = new Set(existing.map((row) => row.hash));
      const seenHashes = new Set(records.map((record) => canonicalHash(record.hash)));
      let inserted = 0;
      let updated = 0;

      const upsert = this.db.prepare(
        `INSERT INTO torrents(
           instance_id, hash, name, progress, state, total_size, amount_left,
           content_path, save_path, ratio, seeding_seconds, completed_at,
           first_seen_at, last_seen_at, absent_since
         ) VALUES (
           @instanceId, @hash, @name, @progress, @state, @totalSize, @amountLeft,
           @contentPath, @savePath, @ratio, @seedingSeconds, @completedAt,
           @timestamp, @timestamp, NULL
         )
         ON CONFLICT(instance_id, hash) DO UPDATE SET
           name = excluded.name,
           progress = excluded.progress,
           state = excluded.state,
           total_size = excluded.total_size,
           amount_left = excluded.amount_left,
           content_path = excluded.content_path,
           save_path = excluded.save_path,
           ratio = excluded.ratio,
           seeding_seconds = excluded.seeding_seconds,
           completed_at = excluded.completed_at,
           last_seen_at = excluded.last_seen_at,
           absent_since = NULL`,
      );

      for (const record of records) {
        const hash = canonicalHash(record.hash);
        upsert.run({
          instanceId,
          hash,
          name: record.name,
          progress: record.progress,
          state: record.state,
          totalSize: record.size,
          amountLeft: record.amount_left,
          contentPath: record.content_path,
          savePath: record.save_path,
          ratio: record.ratio,
          seedingSeconds: record.seeding_time,
          completedAt: record.completion_on < 0 ? null : record.completion_on * 1000,
          timestamp,
        });
        if (existingHashes.has(hash)) updated += 1;
        else inserted += 1;
      }

      const missing = existing.filter(
        (row) => !seenHashes.has(row.hash) && row.absentSince === null,
      );
      if (missing.length > 0) {
        const mark = this.db.prepare(
          `UPDATE torrents SET absent_since = ?
           WHERE instance_id = ? AND hash = ? AND absent_since IS NULL`,
        );
        for (const row of missing) mark.run(timestamp, instanceId, row.hash);
      }

      return { inserted, updated, markedAbsent: missing.length };
    });
    return transaction();
  }
}

export function canonicalHash(hash: string): string {
  return hash.toLowerCase();
}
