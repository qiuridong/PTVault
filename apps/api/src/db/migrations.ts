import {
  OFFLOAD_CONTROL_RECEIPT_TTL_MS,
  OFFLOAD_PAUSE_ACK_TIMEOUT_MS,
} from '../storage/offload-control-policy.js';
import { recoveryPreparationMigration } from './recovery-preparation-migration.js';
import { archiveImportMigration } from './archive-import-migration.js';
import { groupImportMigration } from './group-import-migration.js';

export type Migration = {
  version: number;
  sql: string;
};

export const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: [
      'CREATE TABLE admins (',
      'id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,',
      'password_hash TEXT NOT NULL, totp_secret TEXT NOT NULL,',
      'created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL',
      ');',
      'CREATE TABLE sessions (',
      'id TEXT PRIMARY KEY, admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,',
      'token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,',
      'expires_at INTEGER NOT NULL, revoked_at INTEGER, source_ip TEXT NOT NULL,',
      'user_agent TEXT NOT NULL',
      ');',
      'CREATE INDEX sessions_admin_expiry ON sessions(admin_id, expires_at);',
      'CREATE TABLE auth_challenges (',
      'id TEXT PRIMARY KEY, admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,',
      "kind TEXT NOT NULL CHECK(kind IN ('PASSWORD_MFA', 'PASSKEY')),",
      'payload TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,',
      'consumed_at INTEGER',
      ');',
      'CREATE TABLE audit_events (',
      'id TEXT PRIMARY KEY, actor_admin_id TEXT REFERENCES admins(id), source_ip TEXT NOT NULL,',
      'action TEXT NOT NULL, subject TEXT NOT NULL, outcome TEXT NOT NULL,',
      'correlation_id TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL',
      ');',
      'CREATE INDEX audit_created ON audit_events(created_at DESC);',
      'CREATE TABLE jobs (',
      'id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL,',
      'idempotency_key TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL,',
      'progress REAL NOT NULL DEFAULT 0 CHECK(progress >= 0 AND progress <= 1),',
      'attempt INTEGER NOT NULL DEFAULT 0, run_after INTEGER NOT NULL,',
      'created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_error_code TEXT',
      ');',
      'CREATE INDEX jobs_claim ON jobs(state, run_after, created_at);',
      'CREATE TABLE job_events (',
      'id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,',
      'event_type TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL',
      ');',
      'CREATE INDEX job_events_job_created ON job_events(job_id, created_at);',
    ].join(' '),
  },
  {
    version: 2,
    sql: [
      'ALTER TABLE auth_challenges',
      'ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0',
      'CHECK(failed_attempts BETWEEN 0 AND 5);',
    ].join(' '),
  },
  {
    version: 3,
    sql: [
      'CREATE TABLE qb_instances (',
      'id TEXT PRIMARY KEY,',
      'display_name TEXT NOT NULL,',
      'enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),',
      'secret_ref TEXT NOT NULL',
      ');',
      'CREATE TABLE torrents (',
      'instance_id TEXT NOT NULL,',
      "hash TEXT NOT NULL CHECK(length(hash) IN (40, 64) AND hash = lower(hash) AND hash NOT GLOB '*[^0-9a-f]*'),",
      'name TEXT NOT NULL,',
      'progress REAL NOT NULL CHECK(progress >= 0 AND progress <= 1),',
      "state TEXT NOT NULL CHECK(state IN ('DOWNLOADING', 'SEEDING', 'PAUSED', 'CHECKING', 'MISSING_FILES', 'ERROR', 'UNKNOWN')),",
      'total_size INTEGER NOT NULL CHECK(total_size >= 0),',
      'amount_left INTEGER NOT NULL CHECK(amount_left >= 0),',
      'content_path TEXT NOT NULL,',
      'save_path TEXT NOT NULL,',
      'ratio REAL NOT NULL CHECK(ratio >= 0),',
      'seeding_seconds INTEGER NOT NULL CHECK(seeding_seconds >= 0),',
      'completed_at INTEGER CHECK(completed_at IS NULL OR completed_at >= 0),',
      "cloud_state TEXT NOT NULL DEFAULT 'LOCAL' CHECK(cloud_state IN ('LOCAL', 'MIGRATING', 'CLOUD', 'REHYDRATING', 'BLOCKED')),",
      'first_seen_at INTEGER NOT NULL,',
      'last_seen_at INTEGER NOT NULL,',
      'absent_since INTEGER,',
      'PRIMARY KEY (instance_id, hash),',
      'FOREIGN KEY (instance_id) REFERENCES qb_instances(id) ON DELETE CASCADE',
      ');',
      'CREATE INDEX torrents_cloud_state ON torrents(cloud_state);',
      'CREATE INDEX torrents_progress ON torrents(progress);',
      'CREATE INDEX torrents_last_seen_at ON torrents(last_seen_at);',
      'CREATE TABLE torrent_files (',
      'instance_id TEXT NOT NULL,',
      'torrent_hash TEXT NOT NULL,',
      'relative_path TEXT NOT NULL CHECK(length(relative_path) > 0 AND instr(relative_path, char(0)) = 0),',
      'size INTEGER NOT NULL CHECK(size >= 0),',
      "sha256 TEXT CHECK(sha256 IS NULL OR (length(sha256) = 64 AND sha256 = lower(sha256) AND sha256 NOT GLOB '*[^0-9a-f]*')),",
      'device INTEGER CHECK(device IS NULL OR device >= 0),',
      'inode INTEGER CHECK(inode IS NULL OR inode >= 0),',
      'link_count INTEGER CHECK(link_count IS NULL OR link_count >= 1),',
      'allocated_bytes INTEGER CHECK(allocated_bytes IS NULL OR allocated_bytes >= 0),',
      'last_stat_at INTEGER CHECK(last_stat_at IS NULL OR last_stat_at >= 0),',
      'PRIMARY KEY (instance_id, torrent_hash, relative_path),',
      'FOREIGN KEY (instance_id, torrent_hash)',
      'REFERENCES torrents(instance_id, hash) ON DELETE CASCADE',
      ');',
      'CREATE INDEX torrent_files_device_inode ON torrent_files(device, inode);',
    ].join(' '),
  },
  {
    version: 4,
    sql: [
      'CREATE TABLE storage_accounts (',
      'id TEXT PRIMARY KEY,',
      'label TEXT NOT NULL,',
      "raw_remote TEXT NOT NULL CHECK(raw_remote GLOB '[A-Za-z0-9_-]*:' AND raw_remote NOT GLOB '*[^A-Za-z0-9_-]*:' AND substr(raw_remote, -1) = ':'),",
      "crypt_remote TEXT NOT NULL CHECK(crypt_remote GLOB '[A-Za-z0-9_-]*:' AND crypt_remote NOT GLOB '*[^A-Za-z0-9_-]*:' AND substr(crypt_remote, -1) = ':'),",
      "health TEXT NOT NULL DEFAULT 'OFFLINE' CHECK(health IN ('HEALTHY', 'DEGRADED', 'THROTTLED', 'AUTH_REQUIRED', 'OFFLINE')),",
      'total_bytes INTEGER CHECK(total_bytes IS NULL OR total_bytes >= 0),',
      'free_bytes INTEGER CHECK(free_bytes IS NULL OR free_bytes >= 0),',
      'reserve_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserve_bytes >= 0),',
      'circuit_open_until INTEGER CHECK(circuit_open_until IS NULL OR circuit_open_until >= 0),',
      'last_checked_at INTEGER CHECK(last_checked_at IS NULL OR last_checked_at >= 0),',
      'created_at INTEGER NOT NULL,',
      'updated_at INTEGER NOT NULL,',
      'UNIQUE(raw_remote),',
      'UNIQUE(crypt_remote)',
      ');',
      'CREATE TABLE storage_health_events (',
      'id TEXT PRIMARY KEY,',
      'account_id TEXT NOT NULL REFERENCES storage_accounts(id) ON DELETE CASCADE,',
      "health TEXT NOT NULL CHECK(health IN ('HEALTHY', 'DEGRADED', 'THROTTLED', 'AUTH_REQUIRED', 'OFFLINE')),",
      'detail_json TEXT NOT NULL,',
      'created_at INTEGER NOT NULL',
      ');',
      'CREATE INDEX storage_health_events_account ON storage_health_events(account_id, created_at DESC);',
      'CREATE TABLE cloud_replicas (',
      'id TEXT PRIMARY KEY,',
      'instance_id TEXT NOT NULL,',
      'torrent_hash TEXT NOT NULL,',
      'relative_path TEXT NOT NULL,',
      "role TEXT NOT NULL CHECK(role IN ('PRIMARY', 'SECONDARY')),",
      'account_id TEXT NOT NULL REFERENCES storage_accounts(id),',
      'logical_path TEXT NOT NULL,',
      'remote_path TEXT NOT NULL,',
      "sha256 TEXT NOT NULL CHECK(length(sha256) = 64 AND sha256 = lower(sha256) AND sha256 NOT GLOB '*[^0-9a-f]*'),",
      'size INTEGER NOT NULL CHECK(size >= 0),',
      "verification_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(verification_status IN ('PENDING', 'VERIFIED', 'FAILED')),",
      'verified_at INTEGER CHECK(verified_at IS NULL OR verified_at >= 0),',
      'active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),',
      'created_at INTEGER NOT NULL,',
      'FOREIGN KEY (instance_id, torrent_hash)',
      'REFERENCES torrents(instance_id, hash) ON DELETE CASCADE',
      ');',
      'CREATE INDEX cloud_replicas_torrent ON cloud_replicas(instance_id, torrent_hash, role);',
      'CREATE INDEX cloud_replicas_account ON cloud_replicas(account_id);',
    ].join(' '),
  },
  {
    version: 5,
    sql: [
      'CREATE TABLE recovery_settings (',
      'id INTEGER PRIMARY KEY CHECK(id = 1),',
      "public_recipient TEXT NOT NULL CHECK(public_recipient GLOB 'age1[a-z0-9]*'),",
      'recipient_generation INTEGER NOT NULL DEFAULT 1 CHECK(recipient_generation > 0),',
      'updated_at INTEGER NOT NULL',
      ');',
      'CREATE TABLE recovery_exports (',
      'version INTEGER PRIMARY KEY AUTOINCREMENT,',
      'recipient_generation INTEGER NOT NULL CHECK(recipient_generation > 0),',
      "public_recipient TEXT NOT NULL CHECK(public_recipient GLOB 'age1[a-z0-9]*'),",
      "bundle_sha256 TEXT CHECK(bundle_sha256 IS NULL OR (length(bundle_sha256) = 64 AND bundle_sha256 = lower(bundle_sha256) AND bundle_sha256 NOT GLOB '*[^0-9a-f]*')),",
      "escrow_sha256 TEXT CHECK(escrow_sha256 IS NULL OR (length(escrow_sha256) = 64 AND escrow_sha256 = lower(escrow_sha256) AND escrow_sha256 NOT GLOB '*[^0-9a-f]*')),",
      'computer_confirmed_at INTEGER CHECK(computer_confirmed_at IS NULL OR computer_confirmed_at >= 0),',
      "computer_confirmed_sha256 TEXT CHECK(computer_confirmed_sha256 IS NULL OR (length(computer_confirmed_sha256) = 64 AND computer_confirmed_sha256 = lower(computer_confirmed_sha256) AND computer_confirmed_sha256 NOT GLOB '*[^0-9a-f]*')),",
      'passphrase_verified_at INTEGER CHECK(passphrase_verified_at IS NULL OR passphrase_verified_at >= 0),',
      "passphrase_verified_sha256 TEXT CHECK(passphrase_verified_sha256 IS NULL OR (length(passphrase_verified_sha256) = 64 AND passphrase_verified_sha256 = lower(passphrase_verified_sha256) AND passphrase_verified_sha256 NOT GLOB '*[^0-9a-f]*')),",
      'created_at INTEGER NOT NULL CHECK(created_at >= 0),',
      'completed_at INTEGER CHECK(completed_at IS NULL OR completed_at >= 0)',
      ');',
      'CREATE TABLE recovery_cloud_copies (',
      'version INTEGER NOT NULL REFERENCES recovery_exports(version) ON DELETE CASCADE,',
      'account_id TEXT NOT NULL REFERENCES storage_accounts(id) ON DELETE RESTRICT,',
      "bundle_sha256 TEXT NOT NULL CHECK(length(bundle_sha256) = 64 AND bundle_sha256 = lower(bundle_sha256) AND bundle_sha256 NOT GLOB '*[^0-9a-f]*'),",
      "escrow_sha256 TEXT NOT NULL CHECK(length(escrow_sha256) = 64 AND escrow_sha256 = lower(escrow_sha256) AND escrow_sha256 NOT GLOB '*[^0-9a-f]*'),",
      'bundle_remote_path TEXT NOT NULL,',
      'escrow_remote_path TEXT NOT NULL,',
      "verification_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(verification_status IN ('PENDING', 'VERIFIED', 'FAILED')),",
      'verified_at INTEGER CHECK(verified_at IS NULL OR verified_at >= 0),',
      'created_at INTEGER NOT NULL CHECK(created_at >= 0),',
      'PRIMARY KEY(version, account_id)',
      ');',
      'CREATE INDEX recovery_cloud_copies_status ON recovery_cloud_copies(version, verification_status);',
    ].join(' '),
  },
  {
    version: 6,
    sql: [
      'CREATE TABLE offload_snapshots (',
      'job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,',
      'instance_id TEXT NOT NULL,',
      'torrent_hash TEXT NOT NULL,',
      "importance TEXT NOT NULL CHECK(importance IN ('STANDARD', 'IMPORTANT')),",
      'exported_torrent_encrypted BLOB,',
      'canonical_content_root TEXT,',
      'source_device INTEGER,',
      'source_inode INTEGER,',
      'source_size INTEGER,',
      'source_mtime_ns INTEGER,',
      'selected_account_id TEXT REFERENCES storage_accounts(id),',
      'staging_prefix TEXT,',
      'final_prefix TEXT,',
      'recovery_version INTEGER,',
      "current_step TEXT NOT NULL CHECK(current_step IN ('PREFLIGHT', 'PAUSING', 'SNAPSHOTTING', 'HASHING', 'UPLOADING_STAGING', 'VERIFYING', 'FINALIZING_REMOTE', 'CLOUD_COMMITTED', 'LOCAL_CLEANUP', 'COMPLETED')),",
      'cancelled_at INTEGER,',
      'cleanup_completed_at INTEGER,',
      'created_at INTEGER NOT NULL,',
      'updated_at INTEGER NOT NULL,',
      'FOREIGN KEY (instance_id, torrent_hash) REFERENCES torrents(instance_id, hash)',
      ');',
      'CREATE UNIQUE INDEX offload_active_identity ON offload_snapshots(instance_id, torrent_hash)',
      "WHERE current_step NOT IN ('COMPLETED') AND cancelled_at IS NULL;",
      'CREATE TABLE offload_files (',
      'job_id TEXT NOT NULL REFERENCES offload_snapshots(job_id) ON DELETE CASCADE,',
      'relative_path TEXT NOT NULL,',
      'device INTEGER NOT NULL,',
      'inode INTEGER NOT NULL,',
      'size INTEGER NOT NULL CHECK(size >= 0),',
      'allocated_bytes INTEGER NOT NULL CHECK(allocated_bytes >= 0),',
      'mtime_ns INTEGER NOT NULL CHECK(mtime_ns >= 0),',
      "sha256 TEXT CHECK(sha256 IS NULL OR (length(sha256) = 64 AND sha256 = lower(sha256) AND sha256 NOT GLOB '*[^0-9a-f]*')),",
      "upload_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(upload_status IN ('PENDING', 'STAGED', 'VERIFIED', 'FAILED')),",
      "verification_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(verification_status IN ('PENDING', 'VERIFIED', 'FAILED')),",
      'deleted_at INTEGER,',
      'PRIMARY KEY(job_id, relative_path)',
      ');',
      'CREATE INDEX offload_files_inode ON offload_files(device, inode);',
    ].join(' '),
  },
  {
    version: 7,
    sql: [
      'CREATE TABLE offload_quarantine (',
      'staging_prefix TEXT PRIMARY KEY,',
      'account_id TEXT,',
      "reason TEXT NOT NULL CHECK(reason IN ('UNKNOWN_STAGING')),",
      'created_at INTEGER NOT NULL',
      ');',
    ].join(' '),
  },
  {
    // API-C2: enforce at most one *active* replica per (instance, torrent,
    // path, role). Without this a stale copy could linger active alongside a
    // fresh one and satisfy the verified-primary guard for the wrong content.
    // Partial index mirrors the offload_active_identity precedent (version 6);
    // existing dedup never inserted a second active row, so this is consistent
    // with any pre-existing data.
    version: 8,
    sql: [
      'CREATE UNIQUE INDEX cloud_replica_active_identity',
      'ON cloud_replicas(instance_id, torrent_hash, relative_path, role)',
      'WHERE active = 1;',
    ].join(' '),
  },
  {
    // qB credentials: encrypted storage for qB instance WebUI URL + username + password.
    // qb_instances.secret_ref references this table's id. Credentials are sealed with
    // SecretBox(master_key) so they never appear plaintext in the database or in
    // GET /api/qb/instances responses. Users can update credentials via the web UI;
    // changes take effect after the next sync poll.
    version: 9,
    sql: [
      'CREATE TABLE qb_instance_secrets (',
      'id TEXT PRIMARY KEY,',
      'base_url TEXT NOT NULL,',
      'username TEXT NOT NULL,',
      'encrypted_password TEXT NOT NULL,',
      'created_at INTEGER NOT NULL,',
      'updated_at INTEGER NOT NULL',
      ');',
    ].join(' '),
  },
  {
    // Step-up MFA for the mutation surface: an offload trigger carries a fresh
    // TOTP code, and this table makes each code single-use. Only the digest is
    // stored, never the code. The primary key is what enforces it — replay is a
    // constraint violation, not a check that could race between two requests.
    // Rows are pruned by period_start; a durable table (not an in-memory set) is
    // required so a restart cannot reopen a code's window.
    version: 10,
    sql: [
      'CREATE TABLE mfa_step_up_uses (',
      'admin_id TEXT NOT NULL,',
      'code_hash TEXT NOT NULL,',
      'period_start INTEGER NOT NULL,',
      'created_at INTEGER NOT NULL,',
      'PRIMARY KEY (admin_id, code_hash, period_start)',
      ');',
    ].join(' '),
  },
  {
    // Media playback surface: the mount Jellyfin reads through, the cache that
    // backs it, and the space accounting that keeps the 15% reserve intact.
    //
    // `mount_health` is a single row (id = 1). It is a durable cache of the last
    // probe rather than derived state, because a restart must not report a healthy
    // mount it has not actually checked yet.
    //
    // `space_reservations` exists so two concurrent restores cannot both be told
    // the same free bytes are theirs. The partial unique index makes one active
    // reservation per job a constraint rather than a check that could race.
    version: 11,
    sql: [
      'CREATE TABLE mount_health (',
      'id INTEGER PRIMARY KEY CHECK(id = 1),',
      'mounted INTEGER NOT NULL DEFAULT 0 CHECK(mounted IN (0, 1)),',
      'rc_reachable INTEGER NOT NULL DEFAULT 0 CHECK(rc_reachable IN (0, 1)),',
      'cache_bytes INTEGER NOT NULL DEFAULT 0 CHECK(cache_bytes >= 0),',
      'cache_max_bytes INTEGER NOT NULL CHECK(cache_max_bytes > 0),',
      'disk_free_bytes INTEGER NOT NULL DEFAULT 0 CHECK(disk_free_bytes >= 0),',
      'disk_reserve_bytes INTEGER NOT NULL CHECK(disk_reserve_bytes > 0),',
      "pressure TEXT NOT NULL DEFAULT 'NORMAL' " +
        "CHECK(pressure IN ('NORMAL', 'EVICTING', 'CRITICAL')),",
      // A stable code only. Raw rclone errors carry remote paths and account hints.
      'last_error TEXT,',
      'consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0),',
      'consecutive_successes INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_successes >= 0),',
      'checked_at INTEGER CHECK(checked_at IS NULL OR checked_at >= 0),',
      'updated_at INTEGER NOT NULL',
      ');',

      // Pinned titles survive eviction. Keyed by logical path because that is what
      // both Jellyfin and the VFS cache address, and it stays stable across a
      // primary-replica promotion.
      'CREATE TABLE cache_pins (',
      'logical_path TEXT PRIMARY KEY,',
      'instance_id TEXT NOT NULL,',
      "torrent_hash TEXT NOT NULL CHECK(length(torrent_hash) IN (40, 64) AND torrent_hash = lower(torrent_hash) AND torrent_hash NOT GLOB '*[^0-9a-f]*'),",
      'pinned_at INTEGER NOT NULL,',
      'FOREIGN KEY (instance_id, torrent_hash) REFERENCES torrents(instance_id, hash)',
      ');',

      'CREATE TABLE space_reservations (',
      'job_id TEXT PRIMARY KEY,',
      "kind TEXT NOT NULL CHECK(kind IN ('REHYDRATE', 'PREFETCH', 'VERIFY')),",
      'bytes INTEGER NOT NULL CHECK(bytes >= 0),',
      'created_at INTEGER NOT NULL,',
      'released_at INTEGER CHECK(released_at IS NULL OR released_at >= 0)',
      ');',
      // Only unreleased rows count against free space; released ones are history.
      'CREATE INDEX space_reservations_active ON space_reservations(released_at)',
      'WHERE released_at IS NULL;',

      // One row per migrated torrent: the stable path Jellyfin sees and which
      // replica currently backs it. `catalog_version` is bumped on promotion so a
      // mount refresh can be ordered without diffing the whole tree.
      'CREATE TABLE media_catalog (',
      'instance_id TEXT NOT NULL,',
      "torrent_hash TEXT NOT NULL CHECK(length(torrent_hash) IN (40, 64) AND torrent_hash = lower(torrent_hash) AND torrent_hash NOT GLOB '*[^0-9a-f]*'),",
      'logical_path TEXT NOT NULL,',
      'active_account_id TEXT REFERENCES storage_accounts(id),',
      'local_hot INTEGER NOT NULL DEFAULT 0 CHECK(local_hot IN (0, 1)),',
      'catalog_version INTEGER NOT NULL DEFAULT 1 CHECK(catalog_version >= 1),',
      'created_at INTEGER NOT NULL,',
      'updated_at INTEGER NOT NULL,',
      'PRIMARY KEY (instance_id, torrent_hash),',
      'FOREIGN KEY (instance_id, torrent_hash) REFERENCES torrents(instance_id, hash)',
      ');',
      // One logical path per title: two catalog rows claiming the same path would
      // make the overlay serve whichever the filesystem happened to resolve.
      'CREATE UNIQUE INDEX media_catalog_logical_path ON media_catalog(logical_path);',
    ].join(' '),
  },
  {
    // Rehydrate: pulling a migrated torrent back to local disk and resuming its
    // seed. The mirror image of an offload, and it carries the same obligation —
    // never overwrite the path qB is seeding from with bytes that have not been
    // verified, and never announce data to a tracker that qB has not confirmed.
    //
    // The partial unique index is the important line. Two concurrent restores of
    // one torrent would download into two temp directories and race to rename over
    // the same destination; making that a constraint violation is cheaper than
    // detecting it afterwards.
    version: 12,
    sql: [
      'CREATE TABLE rehydrate_snapshots (',
      'job_id TEXT PRIMARY KEY,',
      'instance_id TEXT NOT NULL,',
      "torrent_hash TEXT NOT NULL CHECK(length(torrent_hash) IN (40, 64) AND torrent_hash = lower(torrent_hash) AND torrent_hash NOT GLOB '*[^0-9a-f]*'),",
      "current_step TEXT NOT NULL DEFAULT 'RESERVING_SPACE' CHECK(current_step IN (" +
        "'RESERVING_SPACE', 'EVICTING_CACHE', 'DOWNLOADING_TEMP', 'VERIFYING_LOCAL'," +
        "'INSTALLING_LOCAL', 'QB_RECHECKING', 'QB_RESUMING', 'COMPLETED')),",
      'auto_resume INTEGER NOT NULL DEFAULT 1 CHECK(auto_resume IN (0, 1)),',
      'reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes >= 0),',
      // Set when admission failed, so the operator is told the exact deficit
      // rather than a bare "not enough space".
      'blocked_missing_bytes INTEGER CHECK(blocked_missing_bytes IS NULL OR blocked_missing_bytes >= 0),',
      // The job-owned temp directory. Recorded so a crashed job's directory can be
      // identified and removed without guessing at paths.
      'temp_directory TEXT,',
      // Set once the rename into the qB location succeeds. After this point a
      // failure must leave local files in place and qB paused — never roll back.
      'installed_at INTEGER CHECK(installed_at IS NULL OR installed_at >= 0),',
      'cancelled_at INTEGER CHECK(cancelled_at IS NULL OR cancelled_at >= 0),',
      'created_at INTEGER NOT NULL,',
      'updated_at INTEGER NOT NULL,',
      'FOREIGN KEY (instance_id, torrent_hash) REFERENCES torrents(instance_id, hash)',
      ');',
      'CREATE UNIQUE INDEX rehydrate_active_identity',
      'ON rehydrate_snapshots(instance_id, torrent_hash)',
      "WHERE current_step != 'COMPLETED' AND cancelled_at IS NULL;",
      'CREATE INDEX rehydrate_step ON rehydrate_snapshots(current_step);',
    ].join(' '),
  },
  {
    // One mount per storage account, replacing v11's single-row `mount_health`.
    //
    // v11 assumed one aggregate mount over every account. That does not hold:
    // `selectAccount` places replicas by free space, so blobs are spread across
    // accounts, and an rclone `union` over them was measured to fail closed — one
    // revoked token made the whole view unreadable, including blobs on healthy
    // upstreams. See `media/mount-layout.ts` for the measurement.
    //
    // Written as a new table rather than an edit to v11 because a database already
    // at v11 or v12 would never re-run an edited v11, and would then carry the old
    // schema while the code expected the new one. Dropping and recreating is safe
    // here specifically because every column is a cache of the last probe: losing
    // it costs one probe cycle, and a fresh row that claims nothing is checked yet
    // is the correct starting state anyway.
    version: 13,
    sql: [
      'DROP TABLE mount_health;',
      'CREATE TABLE mount_health (',
      'account_id TEXT PRIMARY KEY REFERENCES storage_accounts(id),',
      // Where this account's crypt view is mounted. Recorded so an operator reading
      // the table can tell which path a verdict refers to without recomputing it.
      'mount_point TEXT NOT NULL,',
      'mounted INTEGER NOT NULL DEFAULT 0 CHECK(mounted IN (0, 1)),',
      'rc_reachable INTEGER NOT NULL DEFAULT 0 CHECK(rc_reachable IN (0, 1)),',
      'cache_bytes INTEGER NOT NULL DEFAULT 0 CHECK(cache_bytes >= 0),',
      'cache_max_bytes INTEGER NOT NULL CHECK(cache_max_bytes > 0),',
      'disk_free_bytes INTEGER NOT NULL DEFAULT 0 CHECK(disk_free_bytes >= 0),',
      'disk_reserve_bytes INTEGER NOT NULL CHECK(disk_reserve_bytes > 0),',
      "pressure TEXT NOT NULL DEFAULT 'NORMAL' " +
        "CHECK(pressure IN ('NORMAL', 'EVICTING', 'CRITICAL')),",
      // A stable code only. Raw rclone errors carry remote paths and account hints.
      'last_error TEXT,',
      'consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0),',
      'consecutive_successes INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_successes >= 0),',
      'checked_at INTEGER CHECK(checked_at IS NULL OR checked_at >= 0),',
      'updated_at INTEGER NOT NULL',
      ');',
      // Two accounts must not claim one mount point: both rclone processes would
      // mount over the same path and the second would shadow the first silently.
      'CREATE UNIQUE INDEX mount_health_mount_point ON mount_health(mount_point);',
    ].join(' '),
  },
  {
    // Distinguish "verified in cloud, local still present" from both LOCAL and
    // CLOUD. SQLite cannot alter a CHECK constraint in place, so rebuild only the
    // torrents table while preserving every row and its composite primary key.
    version: 14,
    sql: [
      'ALTER TABLE torrents RENAME TO torrents_v13;',
      'CREATE TABLE torrents (',
      'instance_id TEXT NOT NULL,',
      "hash TEXT NOT NULL CHECK(length(hash) IN (40, 64) AND hash = lower(hash) AND hash NOT GLOB '*[^0-9a-f]*'),",
      'name TEXT NOT NULL,',
      'progress REAL NOT NULL CHECK(progress >= 0 AND progress <= 1),',
      "state TEXT NOT NULL CHECK(state IN ('DOWNLOADING', 'SEEDING', 'PAUSED', 'CHECKING', 'MISSING_FILES', 'ERROR', 'UNKNOWN')),",
      'total_size INTEGER NOT NULL CHECK(total_size >= 0),',
      'amount_left INTEGER NOT NULL CHECK(amount_left >= 0),',
      'content_path TEXT NOT NULL,',
      'save_path TEXT NOT NULL,',
      'ratio REAL NOT NULL CHECK(ratio >= 0),',
      'seeding_seconds INTEGER NOT NULL CHECK(seeding_seconds >= 0),',
      'completed_at INTEGER CHECK(completed_at IS NULL OR completed_at >= 0),',
      "cloud_state TEXT NOT NULL DEFAULT 'LOCAL' CHECK(cloud_state IN ('LOCAL', 'MIGRATING', 'CLOUD_COMMITTED', 'CLOUD', 'REHYDRATING', 'BLOCKED')),",
      'first_seen_at INTEGER NOT NULL,',
      'last_seen_at INTEGER NOT NULL,',
      'absent_since INTEGER,',
      'PRIMARY KEY (instance_id, hash),',
      'FOREIGN KEY (instance_id) REFERENCES qb_instances(id) ON DELETE CASCADE',
      ');',
      'INSERT INTO torrents SELECT * FROM torrents_v13;',
      'DROP TABLE torrents_v13;',
      'CREATE INDEX torrents_cloud_state ON torrents(cloud_state);',
      'CREATE INDEX torrents_progress ON torrents(progress);',
      'CREATE INDEX torrents_last_seen_at ON torrents(last_seen_at);',
    ].join(' '),
  },
  {
    // Persist whether the qB content root was one file or a directory. Manifest
    // paths are relative to that root, so the restore side cannot safely infer the
    // filesystem object it must atomically rename from the first path segment.
    version: 15,
    sql: [
      'ALTER TABLE offload_snapshots ADD COLUMN content_root_kind TEXT',
      "CHECK(content_root_kind IS NULL OR content_root_kind IN ('FILE', 'DIRECTORY'));",
    ].join(' '),
  },
  {
    // Per-instance polling state and path mapping.
    //
    // `path_maps` moves the container→host rewrite from a single global env var
    // onto the instance it describes. Two qB containers can mount their media at
    // different paths, and one global map is then wrong for one of them — which
    // surfaces as preflight reporting a missing file that is plainly on disk.
    // NULL means "no per-instance override", so existing rows keep falling back
    // to the global setting and a single-instance install is unaffected.
    //
    // `last_sync_at` / `last_sync_error` make the result of the five-minute poll
    // durable. It only ever existed as a log line, so an operator could not tell
    // a healthy quiet instance from one that had been failing to answer for a
    // day. The error column stores a stable code, never a message: messages here
    // would carry paths into a surface that renders in a browser.
    version: 16,
    sql: [
      'ALTER TABLE qb_instances ADD COLUMN path_maps TEXT;',
      'ALTER TABLE qb_instances ADD COLUMN last_sync_at INTEGER;',
      'ALTER TABLE qb_instances ADD COLUMN last_sync_error TEXT;',
    ].join(' '),
  },
  {
    // Netdisk import control plane. These tables intentionally do not reuse
    // `jobs`, `cloud_replicas`, or `media_catalog`: those rows are keyed by a
    // real qB torrent identity, while an imported Baidu object has no torrent
    // hash to truthfully supply. Byte counters and provider fsids are TEXT so a
    // 64-bit identifier or a multi-object total never crosses JavaScript's
    // integer precision boundary.
    version: 17,
    sql: [
      'CREATE TABLE import_plans (',
      'id TEXT PRIMARY KEY,',
      "source_kind TEXT NOT NULL CHECK(source_kind IN ('BAIDU_SHARE', 'BAIDU_APP_DIR', 'OTHER')),",
      'source_alias TEXT NOT NULL,',
      'source_requires_passcode INTEGER NOT NULL CHECK(source_requires_passcode IN (0, 1)),',
      "source_auth_state TEXT NOT NULL CHECK(source_auth_state IN ('AUTHORIZED', 'PASSCODE_REQUIRED', 'UNAUTHORIZED', 'UNKNOWN')),",
      'selection_json_sanitized TEXT NOT NULL,',
      'secret_ref TEXT,',
      'destination_id TEXT NOT NULL,',
      'destination_display_name TEXT NOT NULL,',
      "destination_kind TEXT NOT NULL CHECK(destination_kind IN ('ONEDRIVE_RAW', 'STANDALONE_CRYPT', 'PT_VAULT_IMPORT')),",
      'object_count INTEGER NOT NULL CHECK(object_count >= 0),',
      "total_bytes TEXT NOT NULL CHECK(length(total_bytes) > 0 AND total_bytes NOT GLOB '*[^0-9]*'),",
      "largest_object_bytes TEXT NOT NULL CHECK(length(largest_object_bytes) > 0 AND largest_object_bytes NOT GLOB '*[^0-9]*'),",
      "required_spool_bytes TEXT NOT NULL CHECK(length(required_spool_bytes) > 0 AND required_spool_bytes NOT GLOB '*[^0-9]*'),",
      'path_conflicts_json_sanitized TEXT NOT NULL,',
      'limit_issues_json_sanitized TEXT NOT NULL,',
      "planned_policy TEXT NOT NULL CHECK(planned_policy IN ('ARCHIVE_ONLY', 'PUBLISH_TO_JELLYFIN')),",
      "mode TEXT NOT NULL CHECK(mode IN ('SHADOW', 'ACTIVE')),",
      'expires_at INTEGER NOT NULL CHECK(expires_at >= 0),',
      'created_at INTEGER NOT NULL CHECK(created_at >= 0)',
      ');',
      'CREATE INDEX import_plans_expiry ON import_plans(expires_at);',
      'CREATE TABLE import_jobs (',
      'id TEXT PRIMARY KEY,',
      'plan_id TEXT NOT NULL UNIQUE REFERENCES import_plans(id),',
      'source_kind TEXT NOT NULL,',
      'source_alias TEXT NOT NULL,',
      'source_requires_passcode INTEGER NOT NULL CHECK(source_requires_passcode IN (0, 1)),',
      'selection_json_sanitized TEXT NOT NULL,',
      'secret_ref TEXT,',
      'destination_id TEXT NOT NULL,',
      'destination_display_name TEXT NOT NULL,',
      'destination_kind TEXT NOT NULL,',
      "publication_policy TEXT NOT NULL CHECK(publication_policy IN ('ARCHIVE_ONLY', 'PUBLISH_TO_JELLYFIN')),",
      "state TEXT NOT NULL CHECK(state IN ('QUEUED', 'RUNNING', 'RETRY_WAIT', 'BLOCKED', 'FAILED_SAFE', 'CANCELLED_SAFE', 'COMPLETED')),",
      "current_step TEXT NOT NULL CHECK(current_step IN ('SHARE_TRANSFER', 'DISCOVERING', 'SOURCE_PREFLIGHT', 'DOWNLOADING', 'LOCAL_LANDING', 'HASHING', 'UPLOADING_STAGING', 'STAGING_READBACK', 'COMMITTING', 'COMMITTED_READBACK', 'CONTROL_PLANE_BACKUP', 'SPOOL_CLEANUP', 'COMPLETED', 'MEDIA_PUBLISH')),",
      "current_condition TEXT CHECK(current_condition IS NULL OR current_condition IN ('AUTH_REQUIRED', 'RATE_LIMITED', 'RESOURCE_WAIT', 'SOURCE_CHANGED', 'DESTINATION_UNAVAILABLE')),",
      'paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0, 1)),',
      'pause_requested_at INTEGER CHECK(pause_requested_at IS NULL OR pause_requested_at >= 0),',
      'cancel_requested_at INTEGER CHECK(cancel_requested_at IS NULL OR cancel_requested_at >= 0),',
      'revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),',
      'idempotency_key TEXT NOT NULL UNIQUE,',
      "request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint) = 64 AND request_fingerprint = lower(request_fingerprint) AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),",
      'object_index INTEGER NOT NULL DEFAULT 0 CHECK(object_index >= 0),',
      'object_count INTEGER NOT NULL CHECK(object_count >= 0),',
      'current_object_alias TEXT,',
      "object_bytes_done TEXT NOT NULL DEFAULT '0' CHECK(length(object_bytes_done) > 0 AND object_bytes_done NOT GLOB '*[^0-9]*'),",
      "object_bytes_total TEXT NOT NULL DEFAULT '0' CHECK(length(object_bytes_total) > 0 AND object_bytes_total NOT GLOB '*[^0-9]*'),",
      "job_bytes_verified TEXT NOT NULL DEFAULT '0' CHECK(length(job_bytes_verified) > 0 AND job_bytes_verified NOT GLOB '*[^0-9]*'),",
      "job_bytes_total TEXT NOT NULL CHECK(length(job_bytes_total) > 0 AND job_bytes_total NOT GLOB '*[^0-9]*'),",
      "download_rate_bps TEXT CHECK(download_rate_bps IS NULL OR (length(download_rate_bps) > 0 AND download_rate_bps NOT GLOB '*[^0-9]*')),",
      "upload_rate_bps TEXT CHECK(upload_rate_bps IS NULL OR (length(upload_rate_bps) > 0 AND upload_rate_bps NOT GLOB '*[^0-9]*')),",
      "verify_rate_bps TEXT CHECK(verify_rate_bps IS NULL OR (length(verify_rate_bps) > 0 AND verify_rate_bps NOT GLOB '*[^0-9]*')),",
      'eta_seconds INTEGER CHECK(eta_seconds IS NULL OR eta_seconds >= 0),',
      'retry_at INTEGER CHECK(retry_at IS NULL OR retry_at >= 0),',
      'last_checkpoint_at INTEGER NOT NULL CHECK(last_checkpoint_at >= 0),',
      'attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),',
      'created_at INTEGER NOT NULL CHECK(created_at >= 0),',
      'updated_at INTEGER NOT NULL CHECK(updated_at >= 0),',
      'started_at INTEGER CHECK(started_at IS NULL OR started_at >= 0),',
      'completed_at INTEGER CHECK(completed_at IS NULL OR completed_at >= 0)',
      ');',
      'CREATE INDEX import_jobs_state_retry ON import_jobs(state, retry_at, created_at);',
      'CREATE TABLE import_objects (',
      'id TEXT PRIMARY KEY,',
      'job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,',
      "source_fsid TEXT NOT NULL CHECK(length(source_fsid) > 0 AND source_fsid NOT GLOB '*[^0-9]*'),",
      'relative_path TEXT NOT NULL,',
      "source_size TEXT NOT NULL CHECK(length(source_size) > 0 AND source_size NOT GLOB '*[^0-9]*'),",
      'source_mtime TEXT NOT NULL,',
      'source_reported_md5 TEXT,',
      'state TEXT NOT NULL,',
      "partial_bytes TEXT NOT NULL DEFAULT '0' CHECK(length(partial_bytes) > 0 AND partial_bytes NOT GLOB '*[^0-9]*'),",
      'local_sha256 TEXT,',
      'destination_account_id TEXT REFERENCES storage_accounts(id),',
      'staging_key TEXT,',
      'committed_key TEXT,',
      'staging_sha256 TEXT,',
      'committed_sha256 TEXT,',
      'attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),',
      'last_error_code TEXT,',
      'created_at INTEGER NOT NULL,',
      'updated_at INTEGER NOT NULL,',
      'UNIQUE(job_id, source_fsid)',
      ');',
      'CREATE INDEX import_objects_job_state ON import_objects(job_id, state, relative_path);',
      'CREATE TABLE import_checkpoints (',
      'object_id TEXT PRIMARY KEY REFERENCES import_objects(id) ON DELETE CASCADE,',
      'job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,',
      'completed_bytes TEXT NOT NULL,',
      'source_snapshot_json_sanitized TEXT NOT NULL,',
      'download_lease_id TEXT,',
      'download_lease_expires_at INTEGER,',
      'partial_path TEXT NOT NULL,',
      'partial_device TEXT,',
      'partial_inode TEXT,',
      'updated_at INTEGER NOT NULL',
      ');',
      'CREATE TABLE import_attempts (',
      'id TEXT PRIMARY KEY,',
      'job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,',
      'object_id TEXT REFERENCES import_objects(id) ON DELETE CASCADE,',
      'stage TEXT NOT NULL,',
      'started_at INTEGER NOT NULL,',
      'ended_at INTEGER,',
      'outcome TEXT,',
      'error_class TEXT,',
      'retry_at INTEGER',
      ');',
      'CREATE TABLE import_events (',
      'id TEXT PRIMARY KEY,',
      'job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,',
      'object_id TEXT REFERENCES import_objects(id) ON DELETE CASCADE,',
      'event_code TEXT NOT NULL,',
      'idempotency_key TEXT UNIQUE,',
      'step TEXT,',
      'detail_sanitized TEXT,',
      'bytes TEXT,',
      'elapsed_ms TEXT,',
      'rate_bytes_per_second TEXT,',
      'error_class TEXT,',
      'provider_request_id TEXT,',
      'retry_at INTEGER,',
      'created_at INTEGER NOT NULL',
      ');',
      'CREATE INDEX import_events_job_created ON import_events(job_id, created_at, id);',
      'CREATE TABLE import_receipts (',
      'id TEXT PRIMARY KEY,',
      'job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,',
      'object_id TEXT REFERENCES import_objects(id) ON DELETE CASCADE,',
      'kind TEXT NOT NULL,',
      'idempotency_key TEXT NOT NULL UNIQUE,',
      'size TEXT,',
      'sha256 TEXT,',
      'provider_request_id TEXT,',
      'evidence_json_sanitized TEXT NOT NULL,',
      'created_at INTEGER NOT NULL',
      ');',
      'CREATE TABLE destination_commits (',
      'job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,',
      'object_id TEXT NOT NULL REFERENCES import_objects(id) ON DELETE CASCADE,',
      'destination_account_id TEXT NOT NULL REFERENCES storage_accounts(id),',
      'staging_key TEXT NOT NULL,',
      'committed_key TEXT NOT NULL,',
      'commit_state TEXT NOT NULL,',
      'provider_request_id TEXT,',
      'committed_at INTEGER,',
      'committed_stat_json_sanitized TEXT,',
      'PRIMARY KEY(job_id, object_id, destination_account_id)',
      ');',
      'CREATE TABLE media_publications (',
      'id TEXT PRIMARY KEY,',
      'job_id TEXT NOT NULL UNIQUE REFERENCES import_jobs(id) ON DELETE CASCADE,',
      "state TEXT NOT NULL CHECK(state IN ('PENDING', 'RUNNING', 'PUBLISHED', 'FAILED_SAFE', 'UNPUBLISHED')),",
      "media_type TEXT NOT NULL CHECK(media_type IN ('MOVIE', 'SERIES')),",
      'library_id TEXT NOT NULL,',
      'library_display_name TEXT NOT NULL,',
      'container_path TEXT NOT NULL,',
      'logical_path TEXT NOT NULL,',
      'mount_account_label TEXT,',
      "read_probe TEXT NOT NULL DEFAULT 'NOT_RUN' CHECK(read_probe IN ('PASSED', 'FAILED', 'NOT_RUN')),",
      'jellyfin_notified INTEGER CHECK(jellyfin_notified IS NULL OR jellyfin_notified IN (0, 1)),',
      'last_error TEXT,',
      'created_at INTEGER NOT NULL,',
      'updated_at INTEGER NOT NULL',
      ');',
    ].join(' '),
  },
  {
    version: 18,
    sql: [
      "ALTER TABLE offload_snapshots ADD COLUMN step_bytes_done TEXT CHECK(step_bytes_done IS NULL OR (length(step_bytes_done) BETWEEN 1 AND 30 AND step_bytes_done NOT GLOB '*[^0-9]*' AND (step_bytes_done = '0' OR substr(step_bytes_done, 1, 1) BETWEEN '1' AND '9')));",
      "ALTER TABLE offload_snapshots ADD COLUMN step_bytes_total TEXT CHECK(step_bytes_total IS NULL OR (length(step_bytes_total) BETWEEN 1 AND 30 AND step_bytes_total NOT GLOB '*[^0-9]*' AND (step_bytes_total = '0' OR substr(step_bytes_total, 1, 1) BETWEEN '1' AND '9')));",
      "ALTER TABLE offload_snapshots ADD COLUMN verified_bytes TEXT CHECK(verified_bytes IS NULL OR (length(verified_bytes) BETWEEN 1 AND 30 AND verified_bytes NOT GLOB '*[^0-9]*' AND (verified_bytes = '0' OR substr(verified_bytes, 1, 1) BETWEEN '1' AND '9')));",
      "ALTER TABLE offload_snapshots ADD COLUMN total_bytes TEXT CHECK(total_bytes IS NULL OR (length(total_bytes) BETWEEN 1 AND 30 AND total_bytes NOT GLOB '*[^0-9]*' AND (total_bytes = '0' OR substr(total_bytes, 1, 1) BETWEEN '1' AND '9')));",
      "ALTER TABLE offload_snapshots ADD COLUMN files_done INTEGER CHECK(files_done IS NULL OR (typeof(files_done) = 'integer' AND files_done >= 0));",
      "ALTER TABLE offload_snapshots ADD COLUMN file_count INTEGER CHECK(file_count IS NULL OR (typeof(file_count) = 'integer' AND file_count >= 0));",
      'ALTER TABLE offload_snapshots ADD COLUMN current_file_alias TEXT CHECK(current_file_alias IS NULL OR (length(current_file_alias) BETWEEN 1 AND 300));',
      "ALTER TABLE offload_snapshots ADD COLUMN upload_rate_bps TEXT CHECK(upload_rate_bps IS NULL OR (length(upload_rate_bps) BETWEEN 1 AND 30 AND upload_rate_bps NOT GLOB '*[^0-9]*' AND (upload_rate_bps = '0' OR substr(upload_rate_bps, 1, 1) BETWEEN '1' AND '9')));",
      "ALTER TABLE offload_snapshots ADD COLUMN hash_rate_bps TEXT CHECK(hash_rate_bps IS NULL OR (length(hash_rate_bps) BETWEEN 1 AND 30 AND hash_rate_bps NOT GLOB '*[^0-9]*' AND (hash_rate_bps = '0' OR substr(hash_rate_bps, 1, 1) BETWEEN '1' AND '9')));",
      "ALTER TABLE offload_snapshots ADD COLUMN verify_rate_bps TEXT CHECK(verify_rate_bps IS NULL OR (length(verify_rate_bps) BETWEEN 1 AND 30 AND verify_rate_bps NOT GLOB '*[^0-9]*' AND (verify_rate_bps = '0' OR substr(verify_rate_bps, 1, 1) BETWEEN '1' AND '9')));",
      "ALTER TABLE offload_snapshots ADD COLUMN eta_seconds INTEGER CHECK(eta_seconds IS NULL OR (typeof(eta_seconds) = 'integer' AND eta_seconds >= 0));",
      "ALTER TABLE offload_snapshots ADD COLUMN rates_sampled_at INTEGER CHECK(rates_sampled_at IS NULL OR (typeof(rates_sampled_at) = 'integer' AND rates_sampled_at >= 0));",
    ].join(' '),
  },
  {
    version: 19,
    sql: [
      "ALTER TABLE offload_snapshots ADD COLUMN pause_requested_at INTEGER CHECK(pause_requested_at IS NULL OR (typeof(pause_requested_at) = 'integer' AND pause_requested_at >= 0));",
      "ALTER TABLE offload_snapshots ADD COLUMN paused_at INTEGER CHECK(paused_at IS NULL OR (typeof(paused_at) = 'integer' AND paused_at >= 0));",
      'CREATE TABLE offload_scheduler_control (',
      'singleton INTEGER PRIMARY KEY CHECK(singleton = 1),',
      "state TEXT NOT NULL CHECK(state IN ('RUNNING', 'PAUSING', 'PAUSED')),",
      "revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision) = 'integer' AND revision >= 0),",
      "updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= 0)",
      ');',
      "INSERT INTO offload_scheduler_control(singleton, state, revision, updated_at) VALUES (1, 'RUNNING', 0, 0);",
      'CREATE TABLE offload_control_requests (',
      'idempotency_key TEXT PRIMARY KEY CHECK(length(idempotency_key) BETWEEN 8 AND 200),',
      "scope TEXT NOT NULL CHECK(scope IN ('JOB', 'ALL')),",
      "action TEXT NOT NULL CHECK(action IN ('PAUSE', 'RESUME', 'PAUSE_ALL', 'RESUME_ALL')),",
      'job_id TEXT REFERENCES offload_snapshots(job_id) ON DELETE CASCADE,',
      'response_json TEXT NOT NULL,',
      "created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),",
      "CHECK((scope = 'JOB' AND action IN ('PAUSE', 'RESUME') AND job_id IS NOT NULL) OR",
      "      (scope = 'ALL' AND action IN ('PAUSE_ALL', 'RESUME_ALL') AND job_id IS NULL))",
      ');',
    ].join(' '),
  },
  {
    version: 20,
    sql: [
      "ALTER TABLE offload_snapshots ADD COLUMN pause_ack_deadline_at INTEGER CHECK(pause_ack_deadline_at IS NULL OR (typeof(pause_ack_deadline_at) = 'integer' AND pause_ack_deadline_at >= 0));",
      "ALTER TABLE offload_snapshots ADD COLUMN qb_paused_at INTEGER CHECK(qb_paused_at IS NULL OR (typeof(qb_paused_at) = 'integer' AND qb_paused_at >= 0));",
      `UPDATE offload_snapshots
       SET pause_ack_deadline_at = pause_requested_at + ${OFFLOAD_PAUSE_ACK_TIMEOUT_MS}
       WHERE pause_requested_at IS NOT NULL;`,
      'CREATE TABLE offload_control_requests_v20 (',
      'idempotency_key TEXT PRIMARY KEY CHECK(length(idempotency_key) BETWEEN 8 AND 200),',
      "scope TEXT NOT NULL CHECK(scope IN ('JOB', 'ALL')),",
      "action TEXT NOT NULL CHECK(action IN ('PAUSE', 'RESUME', 'PAUSE_ALL', 'RESUME_ALL')),",
      'job_id TEXT REFERENCES offload_snapshots(job_id) ON DELETE CASCADE,',
      'response_json TEXT NOT NULL,',
      "created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),",
      "expires_at INTEGER NOT NULL CHECK(typeof(expires_at) = 'integer' AND expires_at > created_at),",
      "CHECK((scope = 'JOB' AND action IN ('PAUSE', 'RESUME') AND job_id IS NOT NULL) OR",
      "      (scope = 'ALL' AND action IN ('PAUSE_ALL', 'RESUME_ALL') AND job_id IS NULL))",
      ');',
      `INSERT INTO offload_control_requests_v20(
         idempotency_key, scope, action, job_id, response_json, created_at, expires_at
       ) SELECT idempotency_key, scope, action, job_id, response_json, created_at,
                created_at + ${OFFLOAD_CONTROL_RECEIPT_TTL_MS}
         FROM offload_control_requests;`,
      'DROP TABLE offload_control_requests;',
      'ALTER TABLE offload_control_requests_v20 RENAME TO offload_control_requests;',
      'CREATE INDEX offload_control_requests_expiry ON offload_control_requests(expires_at, idempotency_key);',
    ].join(' '),
  },
  {
    version: 21,
    sql: [
      'CREATE TABLE offload_control_requests_v21 (',
      'idempotency_key TEXT PRIMARY KEY CHECK(length(idempotency_key) BETWEEN 8 AND 200),',
      "scope TEXT NOT NULL CHECK(scope IN ('JOB', 'ALL')),",
      "action TEXT NOT NULL CHECK(action IN ('PAUSE', 'RESUME', 'CANCEL', 'PAUSE_ALL', 'RESUME_ALL')),",
      'job_id TEXT REFERENCES offload_snapshots(job_id) ON DELETE CASCADE,',
      'response_json TEXT NOT NULL,',
      "created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),",
      "expires_at INTEGER NOT NULL CHECK(typeof(expires_at) = 'integer' AND expires_at > created_at),",
      "CHECK((scope = 'JOB' AND action IN ('PAUSE', 'RESUME', 'CANCEL') AND job_id IS NOT NULL) OR",
      "      (scope = 'ALL' AND action IN ('PAUSE_ALL', 'RESUME_ALL') AND job_id IS NULL))",
      ');',
      `INSERT INTO offload_control_requests_v21(
         idempotency_key, scope, action, job_id, response_json, created_at, expires_at
       ) SELECT idempotency_key, scope, action, job_id, response_json, created_at, expires_at
         FROM offload_control_requests;`,
      'DROP TABLE offload_control_requests;',
      'ALTER TABLE offload_control_requests_v21 RENAME TO offload_control_requests;',
      'CREATE INDEX offload_control_requests_expiry ON offload_control_requests(expires_at, idempotency_key);',
    ].join(' '),
  },
  {
    version: 22,
    sql: [
      'CREATE TABLE transfer_runtime_settings (',
      'singleton INTEGER PRIMARY KEY CHECK(singleton = 1),',
      "revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 0),",
      'offload_creation_enabled INTEGER NOT NULL CHECK(offload_creation_enabled IN (0, 1)),',
      "offload_max_in_flight INTEGER NOT NULL CHECK(typeof(offload_max_in_flight) = 'integer' AND offload_max_in_flight BETWEEN 2 AND 32),",
      "offload_preflight_concurrency INTEGER NOT NULL CHECK(typeof(offload_preflight_concurrency) = 'integer' AND offload_preflight_concurrency BETWEEN 1 AND 32),",
      "offload_pause_snapshot_concurrency INTEGER NOT NULL CHECK(typeof(offload_pause_snapshot_concurrency) = 'integer' AND offload_pause_snapshot_concurrency BETWEEN 1 AND 8),",
      "offload_max_paused_pipelines INTEGER NOT NULL CHECK(typeof(offload_max_paused_pipelines) = 'integer' AND offload_max_paused_pipelines BETWEEN 1 AND 31),",
      "offload_hash_concurrency INTEGER NOT NULL CHECK(typeof(offload_hash_concurrency) = 'integer' AND offload_hash_concurrency BETWEEN 1 AND 8),",
      "offload_upload_concurrency INTEGER NOT NULL CHECK(typeof(offload_upload_concurrency) = 'integer' AND offload_upload_concurrency BETWEEN 1 AND 4),",
      "offload_readback_concurrency INTEGER NOT NULL CHECK(typeof(offload_readback_concurrency) = 'integer' AND offload_readback_concurrency BETWEEN 1 AND 2),",
      'netdisk_creation_enabled INTEGER NOT NULL CHECK(netdisk_creation_enabled IN (0, 1)),',
      "netdisk_max_in_flight INTEGER NOT NULL CHECK(typeof(netdisk_max_in_flight) = 'integer' AND netdisk_max_in_flight BETWEEN 1 AND 4),",
      "updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= 0),",
      'updated_by_admin_id TEXT REFERENCES admins(id) ON DELETE SET NULL,',
      'CHECK(offload_max_paused_pipelines < offload_max_in_flight),',
      'CHECK(offload_preflight_concurrency <= offload_max_in_flight),',
      'CHECK(offload_pause_snapshot_concurrency <= offload_max_paused_pipelines),',
      'CHECK(offload_hash_concurrency <= offload_max_in_flight),',
      'CHECK(offload_upload_concurrency <= offload_max_in_flight),',
      'CHECK(offload_readback_concurrency <= offload_max_in_flight)',
      ');',
      'CREATE TABLE transfer_settings_requests (',
      'idempotency_key TEXT PRIMARY KEY CHECK(length(idempotency_key) BETWEEN 8 AND 200),',
      "request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint) = 64 AND request_fingerprint = lower(request_fingerprint) AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),",
      'response_json TEXT NOT NULL,',
      "created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),",
      "expires_at INTEGER NOT NULL CHECK(typeof(expires_at) = 'integer' AND expires_at > created_at)",
      ');',
      'CREATE INDEX transfer_settings_requests_expiry ON transfer_settings_requests(expires_at, idempotency_key);',
      "ALTER TABLE offload_snapshots ADD COLUMN resource_wait TEXT CHECK(resource_wait IS NULL OR resource_wait IN ('PREFLIGHT_SLOT', 'PAUSE_SNAPSHOT_SLOT', 'HASH_SLOT', 'UPLOAD_SLOT', 'READBACK_SLOT'));",
      "ALTER TABLE offload_snapshots ADD COLUMN resource_queue_position INTEGER CHECK(resource_queue_position IS NULL OR (typeof(resource_queue_position) = 'integer' AND resource_queue_position >= 1));",
      "ALTER TABLE offload_snapshots ADD COLUMN resource_active INTEGER CHECK(resource_active IS NULL OR (typeof(resource_active) = 'integer' AND resource_active >= 0));",
      "ALTER TABLE offload_snapshots ADD COLUMN resource_capacity INTEGER CHECK(resource_capacity IS NULL OR (typeof(resource_capacity) = 'integer' AND resource_capacity >= 1));",
    ].join(' '),
  },
  {
    version: 23,
    sql: [
      'CREATE TABLE offload_account_reservations (',
      'job_id TEXT PRIMARY KEY REFERENCES offload_snapshots(job_id) ON DELETE RESTRICT,',
      'account_id TEXT NOT NULL REFERENCES storage_accounts(id) ON DELETE RESTRICT,',
      "reserved_bytes INTEGER NOT NULL CHECK(typeof(reserved_bytes) = 'integer' AND reserved_bytes >= 0),",
      "created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0)",
      ');',
      'CREATE INDEX offload_account_reservations_account ON offload_account_reservations(account_id, created_at, job_id);',
    ].join(' '),
  },
  {
    version: 24,
    sql: [
      // v22 used a column-level CHECK with the original five physical waits.
      // Rename/copy/drop widens that constraint without dropping/recreating this
      // heavily referenced parent table or losing an in-flight durable wait.
      'ALTER TABLE offload_snapshots RENAME COLUMN resource_wait TO resource_wait_v22;',
      "ALTER TABLE offload_snapshots ADD COLUMN resource_wait TEXT CHECK(resource_wait IS NULL OR resource_wait IN ('PREFLIGHT_SLOT', 'PAUSE_SNAPSHOT_SLOT', 'HASH_SLOT', 'UPLOAD_SLOT', 'READBACK_SLOT', 'REMOTE_HEAVY_SLOT'));",
      'UPDATE offload_snapshots SET resource_wait = resource_wait_v22;',
      'ALTER TABLE offload_snapshots DROP COLUMN resource_wait_v22;',
    ].join(' '),
  },
  {
    // Unified cloud-login authority. This migration is deliberately additive:
    // existing rclone aliases and every row that references storage_accounts
    // remain untouched and are represented explicitly as LEGACY_RCLONE.
    version: 25,
    sql: [
      'CREATE TABLE encrypted_secrets (',
      'id TEXT PRIMARY KEY,',
      "kind TEXT NOT NULL CHECK(kind IN ('OAUTH_CONNECTION_CREDENTIAL', 'OAUTH_FLOW_VERIFIER', 'ENCRYPTION_PROFILE_SECRET', 'IMPORT_JOB_CREDENTIAL')),",
      'encrypted_payload TEXT NOT NULL CHECK(length(encrypted_payload) > 0),',
      'wrapping_key_id TEXT NOT NULL CHECK(length(wrapping_key_id) > 0),',
      "wrapping_key_version INTEGER NOT NULL CHECK(typeof(wrapping_key_version) = 'integer' AND wrapping_key_version > 0),",
      "created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),",
      "updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= created_at)",
      ');',
      'CREATE INDEX encrypted_secrets_kind ON encrypted_secrets(kind, id);',
      'CREATE TRIGGER encrypted_secret_identity_immutable',
      'BEFORE UPDATE OF id, kind ON encrypted_secrets',
      "WHEN NEW.id <> OLD.id OR NEW.kind <> OLD.kind BEGIN SELECT RAISE(ABORT, 'ENCRYPTED_SECRET_IDENTITY_IMMUTABLE'); END;",

      'CREATE TABLE cloud_connections (',
      'id TEXT PRIMARY KEY,',
      "provider TEXT NOT NULL CHECK(provider IN ('BAIDU', 'ONEDRIVE')),",
      'label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 64),',
      'external_account_id TEXT NOT NULL CHECK(length(external_account_id) BETWEEN 1 AND 256),',
      'principal_masked TEXT NOT NULL CHECK(length(principal_masked) BETWEEN 1 AND 256),',
      "auth_state TEXT NOT NULL CHECK(auth_state IN ('CONNECTED', 'REAUTH_REQUIRED', 'DISABLED', 'DISCONNECTED', 'ERROR')),",
      'secret_ref TEXT REFERENCES encrypted_secrets(id) ON DELETE RESTRICT,',
      "scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json) AND json_type(scopes_json) = 'array'),",
      "capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json) AND json_type(capabilities_json) = 'array'),",
      "access_expires_at INTEGER CHECK(access_expires_at IS NULL OR (typeof(access_expires_at) = 'integer' AND access_expires_at >= 0)),",
      "provision_state TEXT NOT NULL DEFAULT 'NOT_REQUESTED' CHECK(provision_state IN ('NOT_REQUESTED', 'PROVISIONING', 'READY', 'PROVISION_FAILED')),",
      "revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision) = 'integer' AND revision >= 0),",
      "last_checked_at INTEGER CHECK(last_checked_at IS NULL OR (typeof(last_checked_at) = 'integer' AND last_checked_at >= 0)),",
      "created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),",
      "updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= created_at),",
      "disconnected_at INTEGER CHECK(disconnected_at IS NULL OR (typeof(disconnected_at) = 'integer' AND disconnected_at >= created_at)),",
      "CHECK((auth_state = 'DISCONNECTED' AND disconnected_at IS NOT NULL) OR (auth_state <> 'DISCONNECTED' AND disconnected_at IS NULL)),",
      "CHECK(auth_state <> 'CONNECTED' OR secret_ref IS NOT NULL),",
      'UNIQUE(provider, external_account_id)',
      ');',
      'CREATE INDEX cloud_connections_state ON cloud_connections(provider, auth_state, updated_at);',
      'CREATE TRIGGER cloud_connections_secret_kind_insert',
      'BEFORE INSERT ON cloud_connections',
      "WHEN NEW.secret_ref IS NOT NULL AND NOT EXISTS (SELECT 1 FROM encrypted_secrets WHERE id = NEW.secret_ref AND kind = 'OAUTH_CONNECTION_CREDENTIAL')",
      "BEGIN SELECT RAISE(ABORT, 'OAUTH_CONNECTION_CREDENTIAL_KIND_REQUIRED'); END;",
      'CREATE TRIGGER cloud_connections_secret_kind_update',
      'BEFORE UPDATE OF secret_ref ON cloud_connections',
      "WHEN NEW.secret_ref IS NOT NULL AND NOT EXISTS (SELECT 1 FROM encrypted_secrets WHERE id = NEW.secret_ref AND kind = 'OAUTH_CONNECTION_CREDENTIAL')",
      "BEGIN SELECT RAISE(ABORT, 'OAUTH_CONNECTION_CREDENTIAL_KIND_REQUIRED'); END;",

      'CREATE TABLE oauth_flows (',
      'id TEXT PRIMARY KEY,',
      "provider TEXT NOT NULL CHECK(provider IN ('BAIDU', 'ONEDRIVE')),",
      "state_hash TEXT NOT NULL UNIQUE CHECK(length(state_hash) = 64 AND state_hash = lower(state_hash) AND state_hash NOT GLOB '*[^0-9a-f]*'),",
      'pkce_verifier_ref TEXT REFERENCES encrypted_secrets(id) ON DELETE RESTRICT,',
      'admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,',
      "session_fingerprint TEXT NOT NULL CHECK(length(session_fingerprint) = 64 AND session_fingerprint = lower(session_fingerprint) AND session_fingerprint NOT GLOB '*[^0-9a-f]*'),",
      "redirect_uri TEXT NOT NULL CHECK(instr(redirect_uri, '?') = 0 AND instr(redirect_uri, '#') = 0 AND ((provider = 'BAIDU' AND redirect_uri GLOB 'https://*/api/storage/connections/oauth/callback/BAIDU') OR (provider = 'ONEDRIVE' AND redirect_uri GLOB 'https://*/api/storage/connections/oauth/callback/ONEDRIVE'))),",
      "return_to TEXT NOT NULL CHECK(return_to IN ('/storage-accounts', '/imports', '/settings/netdisk')),",
      "expires_at INTEGER NOT NULL CHECK(typeof(expires_at) = 'integer' AND expires_at > created_at AND expires_at <= created_at + 600000),",
      "used_at INTEGER CHECK(used_at IS NULL OR (typeof(used_at) = 'integer' AND used_at >= created_at)),",
      'completed_connection_id TEXT REFERENCES cloud_connections(id) ON DELETE RESTRICT,',
      'target_connection_id TEXT REFERENCES cloud_connections(id) ON DELETE RESTRICT,',
      "target_connection_revision INTEGER CHECK(target_connection_revision IS NULL OR (typeof(target_connection_revision) = 'integer' AND target_connection_revision >= 0)),",
      "status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'EXPIRED')),",
      "failure_code TEXT CHECK(failure_code IS NULL OR failure_code IN ('STATE_INVALID', 'FLOW_EXPIRED', 'FLOW_ALREADY_USED', 'PROVIDER_MISMATCH', 'SESSION_MISMATCH', 'REDIRECT_URI_MISMATCH', 'TOKEN_EXCHANGE_FAILED', 'IDENTITY_MISMATCH', 'USER_CANCELLED', 'NOT_PROVISIONED')),",
      "created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),",
      'CHECK((target_connection_id IS NULL AND target_connection_revision IS NULL) OR (target_connection_id IS NOT NULL AND target_connection_revision IS NOT NULL)),',
      "CHECK((status = 'PENDING' AND used_at IS NULL AND completed_connection_id IS NULL AND failure_code IS NULL) OR (status = 'PROCESSING' AND used_at IS NOT NULL AND completed_connection_id IS NULL AND failure_code IS NULL) OR (status = 'COMPLETED' AND used_at IS NOT NULL AND completed_connection_id IS NOT NULL AND failure_code IS NULL) OR (status = 'FAILED' AND used_at IS NOT NULL AND completed_connection_id IS NULL AND failure_code IS NOT NULL) OR (status = 'EXPIRED' AND completed_connection_id IS NULL AND failure_code = 'FLOW_EXPIRED'))",
      ');',
      'CREATE INDEX oauth_flows_admin_status ON oauth_flows(admin_id, status, expires_at);',
      'CREATE INDEX oauth_flows_expiry ON oauth_flows(status, expires_at);',
      'CREATE TRIGGER oauth_flows_verifier_kind_insert',
      'BEFORE INSERT ON oauth_flows',
      "WHEN NEW.pkce_verifier_ref IS NOT NULL AND NOT EXISTS (SELECT 1 FROM encrypted_secrets WHERE id = NEW.pkce_verifier_ref AND kind = 'OAUTH_FLOW_VERIFIER')",
      "BEGIN SELECT RAISE(ABORT, 'OAUTH_FLOW_VERIFIER_KIND_REQUIRED'); END;",
      'CREATE TRIGGER oauth_flows_verifier_kind_update',
      'BEFORE UPDATE OF pkce_verifier_ref ON oauth_flows',
      "WHEN NEW.pkce_verifier_ref IS NOT NULL AND NOT EXISTS (SELECT 1 FROM encrypted_secrets WHERE id = NEW.pkce_verifier_ref AND kind = 'OAUTH_FLOW_VERIFIER')",
      "BEGIN SELECT RAISE(ABORT, 'OAUTH_FLOW_VERIFIER_KIND_REQUIRED'); END;",

      'CREATE TABLE cloud_connection_runtime (',
      'connection_id TEXT PRIMARY KEY REFERENCES cloud_connections(id) ON DELETE CASCADE,',
      "rate_limited_until INTEGER CHECK(rate_limited_until IS NULL OR (typeof(rate_limited_until) = 'integer' AND rate_limited_until >= 0)),",
      "rate_limit_code TEXT CHECK(rate_limit_code IS NULL OR rate_limit_code IN ('PROVIDER_RATE_LIMITED', 'BAIDU_RATE_LIMITED', 'ONEDRIVE_RATE_LIMITED')),",
      "rate_limit_updated_at INTEGER CHECK(rate_limit_updated_at IS NULL OR (typeof(rate_limit_updated_at) = 'integer' AND rate_limit_updated_at >= 0)),",
      "runtime_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(runtime_revision) = 'integer' AND runtime_revision >= 0),",
      'CHECK((rate_limited_until IS NULL AND rate_limit_code IS NULL AND rate_limit_updated_at IS NULL) OR (rate_limited_until IS NOT NULL AND rate_limit_code IS NOT NULL AND rate_limit_updated_at IS NOT NULL))',
      ');',

      'CREATE TABLE cloud_connection_refresh_leases (',
      'connection_id TEXT PRIMARY KEY REFERENCES cloud_connections(id) ON DELETE CASCADE,',
      'owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 128),',
      "fencing_token INTEGER NOT NULL CHECK(typeof(fencing_token) = 'integer' AND fencing_token > 0),",
      "lease_expires_at INTEGER NOT NULL CHECK(typeof(lease_expires_at) = 'integer' AND lease_expires_at > updated_at),",
      "acquired_at INTEGER NOT NULL CHECK(typeof(acquired_at) = 'integer' AND acquired_at >= 0),",
      "updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= acquired_at)",
      ');',
      'CREATE INDEX cloud_refresh_leases_expiry ON cloud_connection_refresh_leases(lease_expires_at);',
      'CREATE TRIGGER cloud_refresh_lease_fence_monotonic',
      'BEFORE UPDATE OF fencing_token ON cloud_connection_refresh_leases',
      "WHEN NEW.fencing_token <= OLD.fencing_token BEGIN SELECT RAISE(ABORT, 'REFRESH_FENCING_TOKEN_NOT_MONOTONIC'); END;",

      'CREATE TABLE encryption_profiles (',
      'id TEXT PRIMARY KEY,',
      "version INTEGER NOT NULL CHECK(typeof(version) = 'integer' AND version > 0),",
      'wrapped_secret_bundle TEXT NOT NULL UNIQUE REFERENCES encrypted_secrets(id) ON DELETE RESTRICT,',
      'wrapping_key_id TEXT NOT NULL CHECK(length(wrapping_key_id) > 0),',
      "wrapping_key_version INTEGER NOT NULL CHECK(typeof(wrapping_key_version) = 'integer' AND wrapping_key_version > 0),",
      "escrow_state TEXT NOT NULL CHECK(escrow_state IN ('PENDING', 'VERIFIED', 'FAILED')),",
      'escrow_receipt_ref TEXT,',
      "crypt_roundtrip_state TEXT NOT NULL CHECK(crypt_roundtrip_state IN ('NOT_RUN', 'PASSED', 'FAILED')),",
      "created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),",
      "CHECK((escrow_state = 'VERIFIED' AND escrow_receipt_ref IS NOT NULL AND length(escrow_receipt_ref) > 0) OR (escrow_state <> 'VERIFIED' AND escrow_receipt_ref IS NULL))",
      ');',
      'CREATE TRIGGER encryption_profiles_secret_kind_insert',
      'BEFORE INSERT ON encryption_profiles',
      "WHEN NOT EXISTS (SELECT 1 FROM encrypted_secrets WHERE id = NEW.wrapped_secret_bundle AND kind = 'ENCRYPTION_PROFILE_SECRET')",
      "BEGIN SELECT RAISE(ABORT, 'ENCRYPTION_PROFILE_SECRET_KIND_REQUIRED'); END;",
      'CREATE TRIGGER encryption_profiles_secret_immutable',
      'BEFORE UPDATE ON encryption_profiles',
      'WHEN NEW.id <> OLD.id OR NEW.version <> OLD.version OR NEW.wrapped_secret_bundle <> OLD.wrapped_secret_bundle OR NEW.created_at <> OLD.created_at',
      "BEGIN SELECT RAISE(ABORT, 'ENCRYPTION_PROFILE_SECRET_IMMUTABLE'); END;",

      'ALTER TABLE storage_accounts ADD COLUMN connection_id TEXT REFERENCES cloud_connections(id) ON DELETE RESTRICT;',
      "ALTER TABLE storage_accounts ADD COLUMN provider TEXT NOT NULL DEFAULT 'ONEDRIVE' CHECK(provider = 'ONEDRIVE');",
      "ALTER TABLE storage_accounts ADD COLUMN provisioning_mode TEXT NOT NULL DEFAULT 'LEGACY_RCLONE' CHECK(provisioning_mode IN ('LEGACY_RCLONE', 'WEB_OAUTH'));",
      'ALTER TABLE storage_accounts ADD COLUMN encryption_profile_id TEXT REFERENCES encryption_profiles(id) ON DELETE RESTRICT;',
      'ALTER TABLE storage_accounts ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1));',
      "ALTER TABLE storage_accounts ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision) = 'integer' AND revision >= 0);",
      'CREATE UNIQUE INDEX storage_accounts_connection ON storage_accounts(connection_id) WHERE connection_id IS NOT NULL;',
      'CREATE UNIQUE INDEX storage_accounts_encryption_profile ON storage_accounts(encryption_profile_id) WHERE encryption_profile_id IS NOT NULL;',
      'CREATE TRIGGER storage_account_profile_immutable',
      'BEFORE UPDATE OF encryption_profile_id ON storage_accounts',
      'WHEN OLD.encryption_profile_id IS NOT NULL AND NEW.encryption_profile_id IS NOT OLD.encryption_profile_id',
      "BEGIN SELECT RAISE(ABORT, 'STORAGE_ENCRYPTION_PROFILE_IMMUTABLE'); END;",
      'CREATE TRIGGER storage_account_web_binding_insert',
      'BEFORE INSERT ON storage_accounts',
      "WHEN NEW.provisioning_mode = 'WEB_OAUTH' AND NOT EXISTS (SELECT 1 FROM cloud_connections AS connection JOIN encryption_profiles AS profile ON profile.id = NEW.encryption_profile_id WHERE connection.id = NEW.connection_id AND connection.provider = 'ONEDRIVE')",
      "BEGIN SELECT RAISE(ABORT, 'WEB_OAUTH_STORAGE_BINDING_INVALID'); END;",
      'CREATE TRIGGER storage_account_web_binding_update',
      'BEFORE UPDATE OF connection_id, provisioning_mode, encryption_profile_id ON storage_accounts',
      "WHEN NEW.provisioning_mode = 'WEB_OAUTH' AND NOT EXISTS (SELECT 1 FROM cloud_connections AS connection JOIN encryption_profiles AS profile ON profile.id = NEW.encryption_profile_id WHERE connection.id = NEW.connection_id AND connection.provider = 'ONEDRIVE')",
      "BEGIN SELECT RAISE(ABORT, 'WEB_OAUTH_STORAGE_BINDING_INVALID'); END;",
      'CREATE TRIGGER storage_account_web_enabled_insert',
      'BEFORE INSERT ON storage_accounts',
      "WHEN NEW.provisioning_mode = 'WEB_OAUTH' AND NEW.enabled = 1 AND NOT EXISTS (SELECT 1 FROM cloud_connections AS connection JOIN encryption_profiles AS profile ON profile.id = NEW.encryption_profile_id WHERE connection.id = NEW.connection_id AND connection.provider = 'ONEDRIVE' AND connection.provision_state = 'READY' AND connection.auth_state = 'CONNECTED' AND profile.escrow_state = 'VERIFIED' AND profile.crypt_roundtrip_state = 'PASSED')",
      "BEGIN SELECT RAISE(ABORT, 'WEB_OAUTH_STORAGE_NOT_READY'); END;",
      'CREATE TRIGGER storage_account_web_enabled_update',
      'BEFORE UPDATE OF connection_id, provisioning_mode, encryption_profile_id, enabled ON storage_accounts',
      "WHEN NEW.provisioning_mode = 'WEB_OAUTH' AND NEW.enabled = 1 AND NOT EXISTS (SELECT 1 FROM cloud_connections AS connection JOIN encryption_profiles AS profile ON profile.id = NEW.encryption_profile_id WHERE connection.id = NEW.connection_id AND connection.provider = 'ONEDRIVE' AND connection.provision_state = 'READY' AND connection.auth_state = 'CONNECTED' AND profile.escrow_state = 'VERIFIED' AND profile.crypt_roundtrip_state = 'PASSED')",
      "BEGIN SELECT RAISE(ABORT, 'WEB_OAUTH_STORAGE_NOT_READY'); END;",

      'ALTER TABLE import_plans ADD COLUMN source_connection_id TEXT REFERENCES cloud_connections(id) ON DELETE RESTRICT;',
      'ALTER TABLE import_jobs ADD COLUMN source_connection_id TEXT REFERENCES cloud_connections(id) ON DELETE RESTRICT;',
      'CREATE INDEX import_plans_source_connection ON import_plans(source_connection_id, created_at);',
      'CREATE INDEX import_jobs_source_connection_state ON import_jobs(source_connection_id, state, created_at);',
    ].join(' '),
  },
  {
    version: 26,
    sql: [
      'CREATE TABLE cloud_connection_operation_receipts (',
      'admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,',
      "operation TEXT NOT NULL CHECK(operation IN ('START_OAUTH', 'TEST', 'EDIT', 'REAUTHORIZE', 'ENABLE', 'DISABLE', 'DISCONNECT')),",
      'resource_id TEXT NOT NULL CHECK(length(resource_id) BETWEEN 1 AND 256),',
      'idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),',
      "request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint) = 64 AND request_fingerprint = lower(request_fingerprint) AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),",
      "status TEXT NOT NULL CHECK(status IN ('IN_PROGRESS', 'COMPLETED')),",
      'owner_token TEXT NOT NULL CHECK(length(owner_token) BETWEEN 16 AND 128),',
      "http_status INTEGER CHECK(http_status IS NULL OR (typeof(http_status) = 'integer' AND http_status BETWEEN 200 AND 599)),",
      'response_json TEXT CHECK(response_json IS NULL OR (json_valid(response_json) AND length(response_json) <= 65536)),',
      "created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),",
      "updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= created_at),",
      'PRIMARY KEY(admin_id, operation, resource_id, idempotency_key),',
      "CHECK((status = 'IN_PROGRESS' AND http_status IS NULL AND response_json IS NULL) OR (status = 'COMPLETED' AND http_status IS NOT NULL AND response_json IS NOT NULL))",
      ');',
      'CREATE INDEX cloud_connection_operation_receipts_status',
      'ON cloud_connection_operation_receipts(status, updated_at);',
      "ALTER TABLE oauth_flows ADD COLUMN processing_deadline_at INTEGER CHECK(processing_deadline_at IS NULL OR (typeof(processing_deadline_at) = 'integer' AND processing_deadline_at >= created_at));",
    ].join(' '),
  },
  {
    // Durable OneDrive provisioning journal.  The candidate is intentionally
    // separate from storage_accounts: only a completely verified candidate is
    // atomically promoted into the live binding table.
    version: 27,
    sql: [
      'CREATE TABLE cloud_connection_provision_attempts (',
      'id TEXT PRIMARY KEY,',
      'connection_id TEXT NOT NULL REFERENCES cloud_connections(id) ON DELETE RESTRICT,',
      "connection_revision INTEGER NOT NULL CHECK(typeof(connection_revision) = 'integer' AND connection_revision >= 0),",
      'profile_id TEXT NOT NULL UNIQUE REFERENCES encryption_profiles(id) ON DELETE RESTRICT,',
      'candidate_account_id TEXT NOT NULL UNIQUE,',
      "raw_remote TEXT NOT NULL CHECK(raw_remote GLOB '[A-Za-z0-9_-]*:' AND raw_remote NOT GLOB '*[^A-Za-z0-9_-]*:' AND substr(raw_remote, -1) = ':'),",
      "crypt_remote TEXT NOT NULL CHECK(crypt_remote GLOB '[A-Za-z0-9_-]*:' AND crypt_remote NOT GLOB '*[^A-Za-z0-9_-]*:' AND substr(crypt_remote, -1) = ':'),",
      "state TEXT NOT NULL CHECK(state IN ('PREPARING', 'VERIFIED', 'ACTIVATED', 'FAILED')),",
      'escrow_receipt_ref TEXT,',
      "failure_code TEXT CHECK(failure_code IS NULL OR (length(failure_code) BETWEEN 3 AND 80 AND failure_code NOT GLOB '*[^A-Z0-9_]*')),",
      "diagnostic_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(diagnostic_json) AND json_type(diagnostic_json) = 'object' AND length(diagnostic_json) <= 4096),",
      "created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),",
      "updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= created_at),",
      "completed_at INTEGER CHECK(completed_at IS NULL OR (typeof(completed_at) = 'integer' AND completed_at >= created_at)),",
      "CHECK((state = 'FAILED' AND failure_code IS NOT NULL AND completed_at IS NOT NULL) OR (state = 'ACTIVATED' AND failure_code IS NULL AND completed_at IS NOT NULL) OR (state IN ('PREPARING', 'VERIFIED') AND failure_code IS NULL AND completed_at IS NULL))",
      ');',
      'CREATE UNIQUE INDEX cloud_provision_one_active_per_connection',
      "ON cloud_connection_provision_attempts(connection_id) WHERE state IN ('PREPARING', 'VERIFIED');",
      'CREATE INDEX cloud_provision_connection_history',
      'ON cloud_connection_provision_attempts(connection_id, created_at DESC, id);',
    ].join(' '),
  },
  {
    // Freeze import source/provider identity and expose durable resource waits.
    // Legacy rows remain explicitly unbound; the production source resolver
    // refuses those rows instead of falling back to one process-global token.
    version: 28,
    sql: [
      "ALTER TABLE import_plans ADD COLUMN source_provider TEXT CHECK(source_provider IS NULL OR source_provider = 'BAIDU');",
      'ALTER TABLE import_plans ADD COLUMN source_external_account_id TEXT;',
      "ALTER TABLE import_plans ADD COLUMN source_manifest_revision INTEGER CHECK(source_manifest_revision IS NULL OR (typeof(source_manifest_revision) = 'integer' AND source_manifest_revision >= 0));",
      "ALTER TABLE import_jobs ADD COLUMN source_provider TEXT CHECK(source_provider IS NULL OR source_provider = 'BAIDU');",
      'ALTER TABLE import_jobs ADD COLUMN source_external_account_id TEXT;',
      "ALTER TABLE import_jobs ADD COLUMN source_manifest_revision INTEGER CHECK(source_manifest_revision IS NULL OR (typeof(source_manifest_revision) = 'integer' AND source_manifest_revision >= 0));",
      'ALTER TABLE import_jobs ADD COLUMN destination_account_id TEXT REFERENCES storage_accounts(id) ON DELETE RESTRICT;',
      "ALTER TABLE import_jobs ADD COLUMN resource_wait_kind TEXT CHECK(resource_wait_kind IS NULL OR resource_wait_kind IN ('MAX_IN_FLIGHT', 'LOCAL_PREPARATION', 'UPLOAD', 'SPOOL_CAPACITY'));",
      "ALTER TABLE import_jobs ADD COLUMN resource_queue_position INTEGER CHECK(resource_queue_position IS NULL OR (typeof(resource_queue_position) = 'integer' AND resource_queue_position > 0));",
      "ALTER TABLE import_jobs ADD COLUMN resource_wait_since INTEGER CHECK(resource_wait_since IS NULL OR (typeof(resource_wait_since) = 'integer' AND resource_wait_since >= 0));",
      'CREATE INDEX import_jobs_resource_wait ON import_jobs(resource_wait_kind, resource_wait_since, id);',
      'CREATE TRIGGER import_plan_source_binding_insert',
      'BEFORE INSERT ON import_plans',
      'WHEN NOT ((NEW.source_connection_id IS NULL AND NEW.source_provider IS NULL AND NEW.source_external_account_id IS NULL AND NEW.source_manifest_revision IS NULL) OR (NEW.source_connection_id IS NOT NULL AND NEW.source_provider IS NOT NULL AND NEW.source_external_account_id IS NOT NULL AND NEW.source_manifest_revision IS NOT NULL))',
      "BEGIN SELECT RAISE(ABORT, 'IMPORT_SOURCE_BINDING_INCOMPLETE'); END;",
      'CREATE TRIGGER import_plan_source_authority_insert',
      'BEFORE INSERT ON import_plans',
      'WHEN NEW.source_connection_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cloud_connections AS connection WHERE connection.id = NEW.source_connection_id AND connection.provider = NEW.source_provider AND connection.external_account_id = NEW.source_external_account_id)',
      "BEGIN SELECT RAISE(ABORT, 'IMPORT_SOURCE_IDENTITY_DRIFT'); END;",
      'CREATE TRIGGER import_plan_source_binding_immutable',
      'BEFORE UPDATE OF source_connection_id, source_provider, source_external_account_id, source_manifest_revision ON import_plans',
      'WHEN NEW.source_connection_id IS NOT OLD.source_connection_id OR NEW.source_provider IS NOT OLD.source_provider OR NEW.source_external_account_id IS NOT OLD.source_external_account_id OR NEW.source_manifest_revision IS NOT OLD.source_manifest_revision',
      "BEGIN SELECT RAISE(ABORT, 'IMPORT_SOURCE_BINDING_IMMUTABLE'); END;",
      'CREATE TRIGGER import_job_source_binding_insert',
      'BEFORE INSERT ON import_jobs',
      'WHEN NOT EXISTS (SELECT 1 FROM import_plans AS plan WHERE plan.id = NEW.plan_id AND plan.source_connection_id IS NEW.source_connection_id AND plan.source_provider IS NEW.source_provider AND plan.source_external_account_id IS NEW.source_external_account_id AND plan.source_manifest_revision IS NEW.source_manifest_revision)',
      "BEGIN SELECT RAISE(ABORT, 'IMPORT_JOB_SOURCE_BINDING_MISMATCH'); END;",
      'CREATE TRIGGER import_job_source_binding_immutable',
      'BEFORE UPDATE OF source_connection_id, source_provider, source_external_account_id, source_manifest_revision, destination_account_id ON import_jobs',
      'WHEN NEW.source_connection_id IS NOT OLD.source_connection_id OR NEW.source_provider IS NOT OLD.source_provider OR NEW.source_external_account_id IS NOT OLD.source_external_account_id OR NEW.source_manifest_revision IS NOT OLD.source_manifest_revision OR NEW.destination_account_id IS NOT OLD.destination_account_id',
      "BEGIN SELECT RAISE(ABORT, 'IMPORT_JOB_BINDING_IMMUTABLE'); END;",
      'CREATE TRIGGER import_job_resource_wait_insert',
      'BEFORE INSERT ON import_jobs',
      'WHEN NOT ((NEW.resource_wait_kind IS NULL AND NEW.resource_queue_position IS NULL AND NEW.resource_wait_since IS NULL) OR (NEW.resource_wait_kind IS NOT NULL AND NEW.resource_queue_position IS NOT NULL AND NEW.resource_wait_since IS NOT NULL))',
      "BEGIN SELECT RAISE(ABORT, 'IMPORT_RESOURCE_WAIT_INCOMPLETE'); END;",
      'CREATE TRIGGER import_job_resource_wait_update',
      'BEFORE UPDATE OF resource_wait_kind, resource_queue_position, resource_wait_since ON import_jobs',
      'WHEN NOT ((NEW.resource_wait_kind IS NULL AND NEW.resource_queue_position IS NULL AND NEW.resource_wait_since IS NULL) OR (NEW.resource_wait_kind IS NOT NULL AND NEW.resource_queue_position IS NOT NULL AND NEW.resource_wait_since IS NOT NULL))',
      "BEGIN SELECT RAISE(ABORT, 'IMPORT_RESOURCE_WAIT_INCOMPLETE'); END;",
    ].join(' '),
  },
  {
    // Netdisk/import settings are an independent authority from the qB/offload
    // scheduler.  The SELECT is a one-time compatibility projection for an
    // existing v22-v28 database; a fresh database is seeded by the repository
    // after transfer_runtime_settings receives its own first-start defaults.
    version: 29,
    sql: [
      'CREATE TABLE netdisk_settings (',
      'singleton INTEGER PRIMARY KEY CHECK(singleton = 1),',
      "revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 0),",
      'creation_enabled INTEGER NOT NULL CHECK(creation_enabled IN (0, 1)),',
      "max_in_flight INTEGER NOT NULL CHECK(typeof(max_in_flight) = 'integer' AND max_in_flight BETWEEN 1 AND 8),",
      "local_preparation_concurrency INTEGER NOT NULL CHECK(typeof(local_preparation_concurrency) = 'integer' AND local_preparation_concurrency BETWEEN 1 AND 4),",
      "upload_concurrency INTEGER NOT NULL CHECK(typeof(upload_concurrency) = 'integer' AND upload_concurrency BETWEEN 1 AND 4),",
      "spool_max_bytes TEXT NOT NULL CHECK(length(spool_max_bytes) BETWEEN 1 AND 30 AND spool_max_bytes NOT GLOB '*[^0-9]*' AND spool_max_bytes <> '0' AND substr(spool_max_bytes, 1, 1) BETWEEN '1' AND '9'),",
      "spool_reserve_bytes TEXT NOT NULL CHECK(length(spool_reserve_bytes) BETWEEN 1 AND 30 AND spool_reserve_bytes NOT GLOB '*[^0-9]*' AND (spool_reserve_bytes = '0' OR substr(spool_reserve_bytes, 1, 1) BETWEEN '1' AND '9')),",
      'default_source_connection_id TEXT REFERENCES cloud_connections(id) ON DELETE SET NULL,',
      'default_destination_account_id TEXT REFERENCES storage_accounts(id) ON DELETE SET NULL,',
      "default_publication_policy TEXT NOT NULL CHECK(default_publication_policy IN ('ARCHIVE_ONLY', 'PUBLISH_TO_JELLYFIN')),",
      'source_staging_cleanup_enabled INTEGER NOT NULL CHECK(source_staging_cleanup_enabled IN (0, 1)),',
      'source_delete_enabled INTEGER NOT NULL CHECK(source_delete_enabled IN (0, 1)),',
      "source_delete_grace_seconds INTEGER NOT NULL CHECK(typeof(source_delete_grace_seconds) = 'integer' AND source_delete_grace_seconds BETWEEN 0 AND 2592000),",
      "updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= 0),",
      'updated_by_admin_id TEXT REFERENCES admins(id) ON DELETE SET NULL',
      ');',
      'CREATE TRIGGER netdisk_settings_capacity_insert',
      'BEFORE INSERT ON netdisk_settings',
      'WHEN length(NEW.spool_reserve_bytes) > length(NEW.spool_max_bytes)',
      'OR (length(NEW.spool_reserve_bytes) = length(NEW.spool_max_bytes)',
      'AND NEW.spool_reserve_bytes >= NEW.spool_max_bytes)',
      "BEGIN SELECT RAISE(ABORT, 'NETDISK_SPOOL_RESERVE_INVALID'); END;",
      'CREATE TRIGGER netdisk_settings_capacity_update',
      'BEFORE UPDATE OF spool_max_bytes, spool_reserve_bytes ON netdisk_settings',
      'WHEN length(NEW.spool_reserve_bytes) > length(NEW.spool_max_bytes)',
      'OR (length(NEW.spool_reserve_bytes) = length(NEW.spool_max_bytes)',
      'AND NEW.spool_reserve_bytes >= NEW.spool_max_bytes)',
      "BEGIN SELECT RAISE(ABORT, 'NETDISK_SPOOL_RESERVE_INVALID'); END;",
      'CREATE TRIGGER netdisk_settings_source_insert',
      'BEFORE INSERT ON netdisk_settings',
      'WHEN NEW.default_source_connection_id IS NOT NULL AND NOT EXISTS (',
      'SELECT 1 FROM cloud_connections WHERE id = NEW.default_source_connection_id',
      "AND provider = 'BAIDU')",
      "BEGIN SELECT RAISE(ABORT, 'NETDISK_DEFAULT_SOURCE_INVALID'); END;",
      'CREATE TRIGGER netdisk_settings_source_update',
      'BEFORE UPDATE OF default_source_connection_id ON netdisk_settings',
      'WHEN NEW.default_source_connection_id IS NOT NULL AND NOT EXISTS (',
      'SELECT 1 FROM cloud_connections WHERE id = NEW.default_source_connection_id',
      "AND provider = 'BAIDU')",
      "BEGIN SELECT RAISE(ABORT, 'NETDISK_DEFAULT_SOURCE_INVALID'); END;",
      'INSERT INTO netdisk_settings(',
      'singleton, revision, creation_enabled, max_in_flight,',
      'local_preparation_concurrency, upload_concurrency,',
      'spool_max_bytes, spool_reserve_bytes,',
      'default_source_connection_id, default_destination_account_id,',
      'default_publication_policy, source_staging_cleanup_enabled,',
      'source_delete_enabled, source_delete_grace_seconds, updated_at, updated_by_admin_id',
      ') SELECT 1, 0, netdisk_creation_enabled, netdisk_max_in_flight,',
      'MIN(netdisk_max_in_flight, 4), 1,',
      "'1099511627776', '10737418240', NULL, NULL, 'ARCHIVE_ONLY', 0, 0, 604800,",
      'updated_at, updated_by_admin_id',
      'FROM transfer_runtime_settings WHERE singleton = 1;',
      'CREATE TABLE netdisk_settings_requests (',
      'admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,',
      'idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 200),',
      "request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint) = 64 AND request_fingerprint = lower(request_fingerprint) AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),",
      "response_json TEXT NOT NULL CHECK(json_valid(response_json) AND json_type(response_json) = 'object' AND length(response_json) <= 65536),",
      "created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),",
      "expires_at INTEGER NOT NULL CHECK(typeof(expires_at) = 'integer' AND expires_at > created_at),",
      'PRIMARY KEY(admin_id, idempotency_key)',
      ');',
      'CREATE INDEX netdisk_settings_requests_expiry',
      'ON netdisk_settings_requests(expires_at, admin_id, idempotency_key);',
      'CREATE TABLE import_spool_reservations (',
      'job_id TEXT PRIMARY KEY REFERENCES import_jobs(id) ON DELETE CASCADE,',
      "reserved_bytes TEXT NOT NULL CHECK(length(reserved_bytes) BETWEEN 1 AND 30 AND reserved_bytes NOT GLOB '*[^0-9]*' AND (reserved_bytes = '0' OR substr(reserved_bytes, 1, 1) BETWEEN '1' AND '9')),",
      "created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),",
      "updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= created_at)",
      ');',
      'CREATE INDEX import_spool_reservations_created',
      'ON import_spool_reservations(created_at, job_id);',
    ].join(' '),
  },
  {
    // Extend the durable cloud-operation receipt authority for the two explicit
    // OneDrive binding mutations.  The table is unreferenced, so copy/swap keeps
    // every completed or in-progress v26 receipt without weakening its key.
    version: 30,
    sql: [
      'CREATE TABLE cloud_connection_operation_receipts_v30 (',
      'admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,',
      "operation TEXT NOT NULL CHECK(operation IN ('START_OAUTH', 'TEST', 'EDIT', 'REAUTHORIZE', 'ENABLE', 'DISABLE', 'DISCONNECT', 'PROVISION', 'TAKEOVER_LEGACY')),",
      'resource_id TEXT NOT NULL CHECK(length(resource_id) BETWEEN 1 AND 256),',
      'idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),',
      "request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint) = 64 AND request_fingerprint = lower(request_fingerprint) AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),",
      "status TEXT NOT NULL CHECK(status IN ('IN_PROGRESS', 'COMPLETED')),",
      'owner_token TEXT NOT NULL CHECK(length(owner_token) BETWEEN 16 AND 128),',
      "http_status INTEGER CHECK(http_status IS NULL OR (typeof(http_status) = 'integer' AND http_status BETWEEN 200 AND 599)),",
      'response_json TEXT CHECK(response_json IS NULL OR (json_valid(response_json) AND length(response_json) <= 65536)),',
      "created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),",
      "updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= created_at),",
      'PRIMARY KEY(admin_id, operation, resource_id, idempotency_key),',
      "CHECK((status = 'IN_PROGRESS' AND http_status IS NULL AND response_json IS NULL) OR (status = 'COMPLETED' AND http_status IS NOT NULL AND response_json IS NOT NULL))",
      ');',
      'INSERT INTO cloud_connection_operation_receipts_v30(',
      'admin_id, operation, resource_id, idempotency_key, request_fingerprint,',
      'status, owner_token, http_status, response_json, created_at, updated_at',
      ') SELECT admin_id, operation, resource_id, idempotency_key, request_fingerprint,',
      'status, owner_token, http_status, response_json, created_at, updated_at',
      'FROM cloud_connection_operation_receipts;',
      'DROP TABLE cloud_connection_operation_receipts;',
      'ALTER TABLE cloud_connection_operation_receipts_v30',
      'RENAME TO cloud_connection_operation_receipts;',
      'CREATE INDEX cloud_connection_operation_receipts_status',
      'ON cloud_connection_operation_receipts(status, updated_at);',
    ].join(' '),
  },
  {
    // Import publication is a catalog projection over already verified cloud
    // objects.  It deliberately has its own revision, per-object journal and
    // idempotency authority: publication failure must never rewrite the import
    // job or weaken its committed-object receipts.
    version: 31,
    sql: [
      'ALTER TABLE media_publications ADD COLUMN library_key TEXT;',
      'ALTER TABLE media_publications ADD COLUMN mount_account_id TEXT REFERENCES storage_accounts(id) ON DELETE RESTRICT;',
      "ALTER TABLE media_publications ADD COLUMN publication_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(publication_revision) = 'integer' AND publication_revision >= 0);",
      "ALTER TABLE media_publications ADD COLUMN object_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(object_count) = 'integer' AND object_count >= 0);",
      "ALTER TABLE media_publications ADD COLUMN receipt_json_sanitized TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(receipt_json_sanitized) AND json_type(receipt_json_sanitized) = 'object' AND length(receipt_json_sanitized) <= 65536);",
      'ALTER TABLE media_publications ADD COLUMN execution_owner_token TEXT CHECK(execution_owner_token IS NULL OR length(execution_owner_token) BETWEEN 16 AND 128);',
      "ALTER TABLE media_publications ADD COLUMN execution_lease_expires_at INTEGER CHECK(execution_lease_expires_at IS NULL OR (typeof(execution_lease_expires_at) = 'integer' AND execution_lease_expires_at >= 0));",
      'CREATE TRIGGER media_publication_execution_lease_insert',
      'BEFORE INSERT ON media_publications',
      'WHEN (NEW.execution_owner_token IS NULL) <> (NEW.execution_lease_expires_at IS NULL)',
      "BEGIN SELECT RAISE(ABORT, 'MEDIA_PUBLICATION_EXECUTION_LEASE_INVALID'); END;",
      'CREATE TRIGGER media_publication_execution_lease_update',
      'BEFORE UPDATE OF execution_owner_token, execution_lease_expires_at ON media_publications',
      'WHEN (NEW.execution_owner_token IS NULL) <> (NEW.execution_lease_expires_at IS NULL)',
      "BEGIN SELECT RAISE(ABORT, 'MEDIA_PUBLICATION_EXECUTION_LEASE_INVALID'); END;",
      'CREATE INDEX media_publications_state_updated ON media_publications(state, updated_at, id);',
      'CREATE TABLE import_publication_objects (',
      'publication_id TEXT NOT NULL REFERENCES media_publications(id) ON DELETE CASCADE,',
      'job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,',
      'object_id TEXT NOT NULL REFERENCES import_objects(id) ON DELETE CASCADE,',
      'account_id TEXT NOT NULL REFERENCES storage_accounts(id) ON DELETE RESTRICT,',
      'cloud_logical_path TEXT NOT NULL CHECK(length(cloud_logical_path) BETWEEN 1 AND 4096),',
      'link_relative_path TEXT NOT NULL CHECK(length(link_relative_path) BETWEEN 1 AND 4096),',
      "media_type TEXT NOT NULL CHECK(media_type IN ('MOVIE', 'SERIES')),",
      'library_id TEXT NOT NULL CHECK(length(library_id) BETWEEN 1 AND 64),',
      "publication_revision INTEGER NOT NULL CHECK(typeof(publication_revision) = 'integer' AND publication_revision > 0),",
      "status TEXT NOT NULL CHECK(status IN ('LINK_PENDING', 'LINKED', 'PROBED', 'PUBLISHED', 'FAILED_SAFE', 'UNPUBLISHED')),",
      "read_probe TEXT NOT NULL DEFAULT 'NOT_RUN' CHECK(read_probe IN ('PASSED', 'FAILED', 'NOT_RUN')),",
      "receipt_json_sanitized TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(receipt_json_sanitized) AND json_type(receipt_json_sanitized) = 'object' AND length(receipt_json_sanitized) <= 65536),",
      "created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),",
      "updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= created_at),",
      'PRIMARY KEY(publication_id, object_id)',
      ');',
      'CREATE INDEX import_publication_objects_job ON import_publication_objects(job_id, publication_id, object_id);',
      'CREATE INDEX import_publication_objects_account_path ON import_publication_objects(account_id, cloud_logical_path);',
      'CREATE UNIQUE INDEX import_publication_objects_live_link',
      'ON import_publication_objects(link_relative_path)',
      "WHERE status IN ('LINK_PENDING', 'LINKED', 'PROBED', 'PUBLISHED');",
      'CREATE TABLE media_publication_operations (',
      'idempotency_key TEXT PRIMARY KEY CHECK(length(idempotency_key) BETWEEN 8 AND 200),',
      'publication_id TEXT NOT NULL REFERENCES media_publications(id) ON DELETE CASCADE,',
      "operation TEXT NOT NULL CHECK(operation IN ('REQUEST', 'RETRY', 'UNPUBLISH')),",
      "request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint) = 64 AND request_fingerprint = lower(request_fingerprint) AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),",
      "response_json TEXT CHECK(response_json IS NULL OR (json_valid(response_json) AND json_type(response_json) = 'object' AND length(response_json) <= 65536)),",
      "created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),",
      "updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= created_at)",
      ');',
      'CREATE INDEX media_publication_operations_publication',
      'ON media_publication_operations(publication_id, operation, created_at);',
    ].join(' '),
  },
  {
    // Source cleanup is an independently gated, admin-scoped workflow. Preview
    // snapshots, per-object provider journals and source-identity locks make the
    // preflight/execution race and both provider crash gaps explicit.
    version: 32,
    sql: [
      "ALTER TABLE import_jobs ADD COLUMN source_cleanup_policy TEXT NOT NULL DEFAULT 'KEEP' CHECK(source_cleanup_policy IN ('KEEP', 'JOB_STAGING_ONLY', 'SELECTED_SOURCE'));",
      'ALTER TABLE import_jobs ADD COLUMN source_cleanup_requires_publication INTEGER NOT NULL DEFAULT 0 CHECK(source_cleanup_requires_publication IN (0, 1));',
      'CREATE TRIGGER import_job_cleanup_policy_immutable',
      'BEFORE UPDATE OF source_cleanup_policy, source_cleanup_requires_publication ON import_jobs',
      'WHEN NEW.source_cleanup_policy IS NOT OLD.source_cleanup_policy OR NEW.source_cleanup_requires_publication IS NOT OLD.source_cleanup_requires_publication',
      "BEGIN SELECT RAISE(ABORT, 'IMPORT_SOURCE_CLEANUP_POLICY_IMMUTABLE'); END;",
      'CREATE TABLE source_cleanup_previews (',
      'id TEXT PRIMARY KEY,',
      'job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,',
      'admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,',
      "policy TEXT NOT NULL CHECK(policy IN ('JOB_STAGING_ONLY', 'SELECTED_SOURCE')),",
      "job_revision INTEGER NOT NULL CHECK(typeof(job_revision) = 'integer' AND job_revision >= 0),",
      "preview_revision INTEGER NOT NULL CHECK(typeof(preview_revision) = 'integer' AND preview_revision > 0),",
      "fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64 AND fingerprint = lower(fingerprint) AND fingerprint NOT GLOB '*[^0-9a-f]*'),",
      "manifest_fingerprint TEXT NOT NULL CHECK(length(manifest_fingerprint) = 64 AND manifest_fingerprint = lower(manifest_fingerprint) AND manifest_fingerprint NOT GLOB '*[^0-9a-f]*'),",
      'source_connection_id TEXT NOT NULL REFERENCES cloud_connections(id) ON DELETE RESTRICT,',
      'source_external_account_id TEXT NOT NULL CHECK(length(source_external_account_id) BETWEEN 1 AND 256),',
      'source_account_masked TEXT NOT NULL CHECK(length(source_account_masked) BETWEEN 1 AND 256),',
      'exact_source_root TEXT NOT NULL CHECK(length(exact_source_root) BETWEEN 1 AND 4096),',
      "object_count INTEGER NOT NULL CHECK(typeof(object_count) = 'integer' AND object_count >= 0),",
      "total_bytes TEXT NOT NULL CHECK(length(total_bytes) BETWEEN 1 AND 30 AND total_bytes NOT GLOB '*[^0-9]*'),",
      "gates_json_sanitized TEXT NOT NULL CHECK(json_valid(gates_json_sanitized) AND json_type(gates_json_sanitized) = 'array' AND length(gates_json_sanitized) <= 65536),",
      'eligible INTEGER NOT NULL CHECK(eligible IN (0, 1)),',
      "created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),",
      "expires_at INTEGER NOT NULL CHECK(typeof(expires_at) = 'integer' AND expires_at > created_at),",
      "consumed_at INTEGER CHECK(consumed_at IS NULL OR (typeof(consumed_at) = 'integer' AND consumed_at >= created_at))",
      ');',
      'CREATE INDEX source_cleanup_previews_job ON source_cleanup_previews(job_id, created_at DESC, id);',
      'CREATE INDEX source_cleanup_previews_expiry ON source_cleanup_previews(expires_at, consumed_at);',
      'CREATE TABLE source_cleanup_preview_objects (',
      'preview_id TEXT NOT NULL REFERENCES source_cleanup_previews(id) ON DELETE CASCADE,',
      'object_id TEXT NOT NULL REFERENCES import_objects(id) ON DELETE CASCADE,',
      "source_fsid TEXT NOT NULL CHECK(length(source_fsid) BETWEEN 1 AND 40 AND source_fsid NOT GLOB '*[^0-9]*'),",
      'source_path TEXT NOT NULL CHECK(length(source_path) BETWEEN 1 AND 4096),',
      "source_size TEXT NOT NULL CHECK(length(source_size) BETWEEN 1 AND 30 AND source_size NOT GLOB '*[^0-9]*'),",
      'source_mtime TEXT NOT NULL CHECK(length(source_mtime) BETWEEN 1 AND 40),',
      "source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64 AND source_sha256 = lower(source_sha256) AND source_sha256 NOT GLOB '*[^0-9a-f]*'),",
      "preflight_fingerprint TEXT NOT NULL CHECK(length(preflight_fingerprint) = 64 AND preflight_fingerprint = lower(preflight_fingerprint) AND preflight_fingerprint NOT GLOB '*[^0-9a-f]*'),",
      'PRIMARY KEY(preview_id, object_id)',
      ');',
      'CREATE TABLE source_cleanups (',
      'id TEXT PRIMARY KEY,',
      'preview_id TEXT NOT NULL UNIQUE REFERENCES source_cleanup_previews(id) ON DELETE RESTRICT,',
      'job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,',
      'admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,',
      "policy TEXT NOT NULL CHECK(policy IN ('JOB_STAGING_ONLY', 'SELECTED_SOURCE')),",
      "status TEXT NOT NULL CHECK(status IN ('RUNNING', 'COMPLETED', 'PARTIAL', 'FOLLOW_UP_REQUIRED', 'FAILED_SAFE')),",
      'source_connection_id TEXT NOT NULL REFERENCES cloud_connections(id) ON DELETE RESTRICT,',
      'source_external_account_id TEXT NOT NULL CHECK(length(source_external_account_id) BETWEEN 1 AND 256),',
      'source_account_masked TEXT NOT NULL CHECK(length(source_account_masked) BETWEEN 1 AND 256),',
      'exact_source_root TEXT NOT NULL CHECK(length(exact_source_root) BETWEEN 1 AND 4096),',
      "job_revision INTEGER NOT NULL CHECK(typeof(job_revision) = 'integer' AND job_revision >= 0),",
      "preview_fingerprint TEXT NOT NULL CHECK(length(preview_fingerprint) = 64 AND preview_fingerprint = lower(preview_fingerprint) AND preview_fingerprint NOT GLOB '*[^0-9a-f]*'),",
      "provider_semantics TEXT NOT NULL CHECK(provider_semantics = 'RECYCLE_BIN'),",
      "object_count INTEGER NOT NULL CHECK(typeof(object_count) = 'integer' AND object_count >= 0),",
      "completed_object_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(completed_object_count) = 'integer' AND completed_object_count >= 0),",
      "failed_object_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(failed_object_count) = 'integer' AND failed_object_count >= 0),",
      "total_bytes TEXT NOT NULL CHECK(length(total_bytes) BETWEEN 1 AND 30 AND total_bytes NOT GLOB '*[^0-9]*'),",
      "completed_bytes TEXT NOT NULL DEFAULT '0' CHECK(length(completed_bytes) BETWEEN 1 AND 30 AND completed_bytes NOT GLOB '*[^0-9]*'),",
      'follow_up_required INTEGER NOT NULL DEFAULT 0 CHECK(follow_up_required IN (0, 1)),',
      "receipt_json_sanitized TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(receipt_json_sanitized) AND json_type(receipt_json_sanitized) = 'object' AND length(receipt_json_sanitized) <= 65536),",
      'execution_owner_token TEXT CHECK(execution_owner_token IS NULL OR length(execution_owner_token) BETWEEN 16 AND 128),',
      "execution_lease_expires_at INTEGER CHECK(execution_lease_expires_at IS NULL OR (typeof(execution_lease_expires_at) = 'integer' AND execution_lease_expires_at >= 0)),",
      "created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),",
      "updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= created_at),",
      "completed_at INTEGER CHECK(completed_at IS NULL OR (typeof(completed_at) = 'integer' AND completed_at >= created_at)),",
      'CHECK((execution_owner_token IS NULL AND execution_lease_expires_at IS NULL) OR (execution_owner_token IS NOT NULL AND execution_lease_expires_at IS NOT NULL))',
      ');',
      'CREATE INDEX source_cleanups_job ON source_cleanups(job_id, created_at DESC, id);',
      'CREATE TABLE source_cleanup_objects (',
      'cleanup_id TEXT NOT NULL REFERENCES source_cleanups(id) ON DELETE CASCADE,',
      'object_id TEXT NOT NULL REFERENCES import_objects(id) ON DELETE RESTRICT,',
      'source_connection_id TEXT NOT NULL REFERENCES cloud_connections(id) ON DELETE RESTRICT,',
      "source_fsid TEXT NOT NULL CHECK(length(source_fsid) BETWEEN 1 AND 40 AND source_fsid NOT GLOB '*[^0-9]*'),",
      'source_path TEXT NOT NULL CHECK(length(source_path) BETWEEN 1 AND 4096),',
      "source_size TEXT NOT NULL CHECK(length(source_size) BETWEEN 1 AND 30 AND source_size NOT GLOB '*[^0-9]*'),",
      'source_mtime TEXT NOT NULL CHECK(length(source_mtime) BETWEEN 1 AND 40),',
      "source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64 AND source_sha256 = lower(source_sha256) AND source_sha256 NOT GLOB '*[^0-9a-f]*'),",
      "preflight_fingerprint TEXT NOT NULL CHECK(length(preflight_fingerprint) = 64 AND preflight_fingerprint = lower(preflight_fingerprint) AND preflight_fingerprint NOT GLOB '*[^0-9a-f]*'),",
      "status TEXT NOT NULL CHECK(status IN ('PENDING', 'PREFLIGHT_VERIFIED', 'PROVIDER_REQUESTED', 'COMPLETED', 'FOLLOW_UP_REQUIRED')),",
      'provider_idempotency_key TEXT NOT NULL CHECK(length(provider_idempotency_key) BETWEEN 8 AND 200),',
      'provider_request_id TEXT CHECK(provider_request_id IS NULL OR length(provider_request_id) BETWEEN 1 AND 256),',
      "provider_semantics TEXT CHECK(provider_semantics IS NULL OR provider_semantics = 'RECYCLE_BIN'),",
      "error_code TEXT CHECK(error_code IS NULL OR (length(error_code) BETWEEN 3 AND 80 AND error_code NOT GLOB '*[^A-Z0-9_]*')),",
      'follow_up_required INTEGER NOT NULL DEFAULT 0 CHECK(follow_up_required IN (0, 1)),',
      "attempt INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempt) = 'integer' AND attempt >= 0),",
      "created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),",
      "updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= created_at),",
      "completed_at INTEGER CHECK(completed_at IS NULL OR (typeof(completed_at) = 'integer' AND completed_at >= created_at)),",
      'PRIMARY KEY(cleanup_id, object_id),',
      'UNIQUE(provider_idempotency_key)',
      ');',
      'CREATE INDEX source_cleanup_objects_status ON source_cleanup_objects(cleanup_id, status, source_fsid);',
      'CREATE TABLE source_cleanup_locks (',
      'source_connection_id TEXT NOT NULL REFERENCES cloud_connections(id) ON DELETE RESTRICT,',
      'source_fsid TEXT NOT NULL,',
      'cleanup_id TEXT NOT NULL REFERENCES source_cleanups(id) ON DELETE CASCADE,',
      "created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),",
      'PRIMARY KEY(source_connection_id, source_fsid)',
      ');',
      'CREATE TRIGGER import_object_cleanup_lock_insert',
      'BEFORE INSERT ON import_objects',
      'WHEN EXISTS (',
      'SELECT 1 FROM import_jobs AS job JOIN source_cleanup_locks AS cleanup_lock',
      'ON cleanup_lock.source_connection_id = job.source_connection_id',
      'WHERE job.id = NEW.job_id AND cleanup_lock.source_fsid = NEW.source_fsid',
      ')',
      "BEGIN SELECT RAISE(ABORT, 'IMPORT_SOURCE_CLEANUP_LOCKED'); END;",
      'CREATE TABLE source_cleanup_operations (',
      'admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,',
      'idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 200),',
      "operation TEXT NOT NULL CHECK(operation IN ('PREVIEW', 'EXECUTE')),",
      'resource_id TEXT NOT NULL CHECK(length(resource_id) BETWEEN 1 AND 256),',
      "request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint) = 64 AND request_fingerprint = lower(request_fingerprint) AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),",
      "response_json TEXT CHECK(response_json IS NULL OR (json_valid(response_json) AND json_type(response_json) = 'object' AND length(response_json) <= 262144)),",
      "created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),",
      "updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= created_at),",
      'PRIMARY KEY(admin_id, idempotency_key)',
      ');',
      'CREATE INDEX source_cleanup_operations_resource ON source_cleanup_operations(operation, resource_id, created_at);',
    ].join(' '),
  },
  {
    version: 33,
    // Credential validity and an immutable storage profile have independent
    // lifecycles. The nullable stamp fences old runtime config until revalidated.
    sql: `
      CREATE TABLE cloud_connection_materializations (
        connection_id TEXT PRIMARY KEY REFERENCES cloud_connections(id) ON DELETE CASCADE,
        materialized_secret_ref TEXT,
        owner_token TEXT,
        lease_expires_at INTEGER,
        failure_code TEXT,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO cloud_connection_materializations(connection_id, materialized_secret_ref, updated_at)
        SELECT connection.id, CASE WHEN connection.provision_state = 'READY' THEN connection.secret_ref ELSE NULL END, connection.updated_at
        FROM cloud_connections AS connection
        WHERE connection.provider = 'ONEDRIVE' AND EXISTS (SELECT 1 FROM storage_accounts WHERE connection_id = connection.id);
      CREATE TRIGGER cloud_connection_materialization_reauth
      AFTER UPDATE OF secret_ref ON cloud_connections
      WHEN NEW.provider = 'ONEDRIVE' AND NEW.secret_ref IS NOT OLD.secret_ref
        AND EXISTS (SELECT 1 FROM storage_accounts WHERE connection_id = NEW.id)
      BEGIN
        INSERT INTO cloud_connection_materializations(connection_id, materialized_secret_ref, updated_at)
          VALUES (NEW.id, NULL, NEW.updated_at)
          ON CONFLICT(connection_id) DO UPDATE SET materialized_secret_ref = NULL,
            owner_token = NULL, lease_expires_at = NULL, failure_code = NULL, updated_at = excluded.updated_at;
      END;
      CREATE TRIGGER cloud_connection_materialization_token_refresh
      AFTER UPDATE OF encrypted_payload ON encrypted_secrets
      WHEN NEW.kind = 'OAUTH_CONNECTION_CREDENTIAL' AND NEW.encrypted_payload IS NOT OLD.encrypted_payload
      BEGIN
        INSERT INTO cloud_connection_materializations(connection_id, materialized_secret_ref, updated_at)
          SELECT connection.id, NULL, NEW.updated_at FROM cloud_connections AS connection
          WHERE connection.provider = 'ONEDRIVE' AND connection.secret_ref = NEW.id
            AND EXISTS (SELECT 1 FROM storage_accounts WHERE connection_id = connection.id)
          ON CONFLICT(connection_id) DO UPDATE SET materialized_secret_ref = NULL,
            owner_token = NULL, lease_expires_at = NULL, failure_code = NULL, updated_at = excluded.updated_at;
      END;
    `,
  },
  {
    version: 34,
    sql: `
      ALTER TABLE import_plans ADD COLUMN source_manifest_json TEXT
        CHECK(source_manifest_json IS NULL OR (json_valid(source_manifest_json) AND length(source_manifest_json) <= 67108864));
      ALTER TABLE import_plans ADD COLUMN source_manifest_digest TEXT
        CHECK(source_manifest_digest IS NULL OR (length(source_manifest_digest) = 64 AND source_manifest_digest NOT GLOB '*[^0-9a-f]*'));
      ALTER TABLE import_jobs ADD COLUMN source_manifest_digest TEXT
        CHECK(source_manifest_digest IS NULL OR (length(source_manifest_digest) = 64 AND source_manifest_digest NOT GLOB '*[^0-9a-f]*'));
      CREATE TRIGGER import_plan_manifest_immutable BEFORE UPDATE ON import_plans
      WHEN NEW.source_manifest_json IS NOT OLD.source_manifest_json OR NEW.source_manifest_digest IS NOT OLD.source_manifest_digest
        OR (OLD.source_manifest_digest IS NOT NULL AND (NEW.selection_json_sanitized IS NOT OLD.selection_json_sanitized
          OR NEW.object_count IS NOT OLD.object_count OR NEW.total_bytes IS NOT OLD.total_bytes OR NEW.source_kind IS NOT OLD.source_kind))
      BEGIN SELECT RAISE(ABORT, 'IMPORT_PLAN_MANIFEST_IMMUTABLE'); END;
      CREATE TRIGGER import_job_manifest_immutable BEFORE UPDATE OF source_manifest_digest, plan_id ON import_jobs
      WHEN NEW.source_manifest_digest IS NOT OLD.source_manifest_digest OR NEW.plan_id IS NOT OLD.plan_id
      BEGIN SELECT RAISE(ABORT, 'IMPORT_JOB_MANIFEST_IMMUTABLE'); END;
      CREATE TRIGGER import_job_manifest_binding BEFORE INSERT ON import_jobs
      WHEN NEW.source_manifest_digest IS NOT (SELECT source_manifest_digest FROM import_plans WHERE id = NEW.plan_id)
      BEGIN SELECT RAISE(ABORT, 'IMPORT_PLAN_MANIFEST_MISMATCH'); END;
    `,
  },
  {
    version: 35,
    sql: `
      CREATE TABLE storage_capacity_reservations (
        owner_kind TEXT NOT NULL CHECK(owner_kind IN ('IMPORT', 'SECONDARY')),
        owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 256),
        account_id TEXT NOT NULL REFERENCES storage_accounts(id) ON DELETE RESTRICT,
        reserved_bytes TEXT NOT NULL CHECK(length(reserved_bytes) BETWEEN 1 AND 30 AND reserved_bytes NOT GLOB '*[^0-9]*'),
        generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
        write_started INTEGER NOT NULL DEFAULT 0 CHECK(write_started IN (0,1)),
        state TEXT NOT NULL CHECK(state IN ('ACTIVE','SETTLED')),
        settled_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(owner_kind, owner_id),
        CHECK((state = 'ACTIVE' AND settled_at IS NULL) OR (state = 'SETTLED' AND settled_at IS NOT NULL))
      );
      CREATE INDEX storage_capacity_account ON storage_capacity_reservations(account_id, state);
    `,
  },
  {
    version: 36,
    sql: `
      CREATE TABLE legacy_environment_connections (
        connection_id TEXT PRIMARY KEY REFERENCES cloud_connections(id) ON DELETE RESTRICT,
        config_fingerprint TEXT NOT NULL UNIQUE, token_fingerprint TEXT NOT NULL,
        app_id TEXT NOT NULL, client_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE legacy_import_source_bindings (
        job_id TEXT PRIMARY KEY REFERENCES import_jobs(id) ON DELETE RESTRICT,
        plan_id TEXT NOT NULL UNIQUE REFERENCES import_plans(id) ON DELETE RESTRICT,
        connection_id TEXT NOT NULL REFERENCES legacy_environment_connections(connection_id) ON DELETE RESTRICT,
        external_account_id TEXT NOT NULL, binding_revision INTEGER NOT NULL,
        proof_json TEXT NOT NULL CHECK(json_valid(proof_json)), proof_digest TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TRIGGER legacy_import_binding_immutable BEFORE UPDATE ON legacy_import_source_bindings
      BEGIN SELECT RAISE(ABORT, 'IMPORT_LEGACY_BINDING_IMMUTABLE'); END;
      CREATE TRIGGER legacy_import_binding_delete BEFORE DELETE ON legacy_import_source_bindings
      BEGIN SELECT RAISE(ABORT, 'IMPORT_LEGACY_BINDING_IMMUTABLE'); END;
    `,
  },
  {
    version: 37,
    sql: `
      CREATE TRIGGER legacy_import_binding_identity BEFORE INSERT ON legacy_import_source_bindings
      WHEN NOT EXISTS (
        SELECT 1 FROM import_jobs AS job JOIN cloud_connections AS connection ON connection.id=NEW.connection_id
        WHERE job.id=NEW.job_id AND job.plan_id=NEW.plan_id
          AND job.source_kind IN ('BAIDU_APP_DIR','BAIDU_SHARE') AND job.state<>'RUNNING'
          AND job.source_connection_id IS NULL AND job.source_provider IS NULL
          AND job.source_external_account_id IS NULL AND job.source_manifest_revision IS NULL
          AND connection.provider='BAIDU' AND connection.external_account_id=NEW.external_account_id
          AND connection.revision=NEW.binding_revision AND connection.auth_state='CONNECTED' AND connection.secret_ref IS NOT NULL
      ) OR length(NEW.proof_digest)<>64 OR NEW.proof_digest GLOB '*[^0-9a-f]*'
      BEGIN SELECT RAISE(ABORT, 'IMPORT_LEGACY_BINDING_INVALID'); END;
      CREATE TABLE legacy_import_binding_operations (
        admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,
        idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 200),
        job_id TEXT NOT NULL REFERENCES legacy_import_source_bindings(job_id) ON DELETE RESTRICT,
        request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
        created_at INTEGER NOT NULL,
        PRIMARY KEY(admin_id,idempotency_key)
      );
      CREATE TRIGGER legacy_import_operation_immutable BEFORE UPDATE ON legacy_import_binding_operations
      BEGIN SELECT RAISE(ABORT, 'IMPORT_LEGACY_BINDING_IMMUTABLE'); END;
      CREATE TRIGGER legacy_import_operation_delete BEFORE DELETE ON legacy_import_binding_operations
      BEGIN SELECT RAISE(ABORT, 'IMPORT_LEGACY_BINDING_IMMUTABLE'); END;
    `,
  },
  {
    // Import list observability. Semaphore occupancy is persisted as a pair so a
    // queued job can say how much of that exact resource is occupied without
    // pretending it is executing. The sample timestamp gives rate/ETA figures a
    // freshness boundary; entering any durable wait clears the old readings.
    version: 38,
    sql: `
      ALTER TABLE import_jobs ADD COLUMN resource_wait_active INTEGER
        CHECK(resource_wait_active IS NULL OR (typeof(resource_wait_active) = 'integer' AND resource_wait_active >= 0));
      ALTER TABLE import_jobs ADD COLUMN resource_wait_capacity INTEGER
        CHECK(resource_wait_capacity IS NULL OR (typeof(resource_wait_capacity) = 'integer' AND resource_wait_capacity > 0));
      ALTER TABLE import_jobs ADD COLUMN rates_sampled_at INTEGER
        CHECK(rates_sampled_at IS NULL OR (typeof(rates_sampled_at) = 'integer' AND rates_sampled_at >= 0));

      UPDATE import_jobs
         SET download_rate_bps = NULL, upload_rate_bps = NULL,
             verify_rate_bps = NULL, eta_seconds = NULL, rates_sampled_at = NULL
       WHERE resource_wait_kind IS NOT NULL;

      DROP TRIGGER import_job_resource_wait_insert;
      DROP TRIGGER import_job_resource_wait_update;
      CREATE TRIGGER import_job_resource_wait_insert
      BEFORE INSERT ON import_jobs
      WHEN NOT (
        (NEW.resource_wait_kind IS NULL AND NEW.resource_queue_position IS NULL
          AND NEW.resource_wait_since IS NULL AND NEW.resource_wait_active IS NULL
          AND NEW.resource_wait_capacity IS NULL)
        OR
        (NEW.resource_wait_kind IS NOT NULL AND NEW.resource_queue_position IS NOT NULL
          AND NEW.resource_wait_since IS NOT NULL
          AND ((NEW.resource_wait_active IS NULL AND NEW.resource_wait_capacity IS NULL)
            OR (NEW.resource_wait_active IS NOT NULL AND NEW.resource_wait_capacity IS NOT NULL)))
      )
      BEGIN SELECT RAISE(ABORT, 'IMPORT_RESOURCE_WAIT_OCCUPANCY_INCOMPLETE'); END;
      CREATE TRIGGER import_job_resource_wait_update
      BEFORE UPDATE OF resource_wait_kind, resource_queue_position, resource_wait_since,
                       resource_wait_active, resource_wait_capacity ON import_jobs
      WHEN NOT (
        (NEW.resource_wait_kind IS NULL AND NEW.resource_queue_position IS NULL
          AND NEW.resource_wait_since IS NULL AND NEW.resource_wait_active IS NULL
          AND NEW.resource_wait_capacity IS NULL)
        OR
        (NEW.resource_wait_kind IS NOT NULL AND NEW.resource_queue_position IS NOT NULL
          AND NEW.resource_wait_since IS NOT NULL
          AND ((NEW.resource_wait_active IS NULL AND NEW.resource_wait_capacity IS NULL)
            OR (NEW.resource_wait_active IS NOT NULL AND NEW.resource_wait_capacity IS NOT NULL)))
      )
      BEGIN SELECT RAISE(ABORT, 'IMPORT_RESOURCE_WAIT_OCCUPANCY_INCOMPLETE'); END;
    `,
  },
  {
    version: 39,
    sql: `
      CREATE TABLE baidu_profile_environment_connections (
        connection_id TEXT PRIMARY KEY REFERENCES cloud_connections(id) ON DELETE RESTRICT,
        config_fingerprint TEXT NOT NULL UNIQUE,
        token_fingerprint TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        client_fingerprint TEXT NOT NULL CHECK(length(client_fingerprint)=64 AND client_fingerprint NOT GLOB '*[^0-9a-f]*'),
        source_commit TEXT NOT NULL CHECK(length(source_commit)=40 AND source_commit NOT GLOB '*[^0-9a-f]*'),
        source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TRIGGER baidu_profile_binding_immutable
      BEFORE UPDATE OF connection_id,config_fingerprint,profile_id,client_id,client_fingerprint,source_commit,source_sha256,created_at
      ON baidu_profile_environment_connections
      BEGIN SELECT RAISE(ABORT, 'BAIDU_PROFILE_BINDING_IMMUTABLE'); END;
    `,
  },
  recoveryPreparationMigration,
  archiveImportMigration,
  groupImportMigration,
];
