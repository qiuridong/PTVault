import type { CachePressure, MountHealth } from '@ptvault/contracts';

import type { AppDatabase } from '../db/database.js';
import { classifyPressure, type DiskPolicy } from './disk.js';

/**
 * Consecutive failures before the mount is declared unhealthy.
 *
 * Three rather than one: OneDrive throttles, and a single slow probe is normal
 * operation. Declaring an outage on the first miss would stop playback and
 * prefetch for something that resolves itself a second later.
 */
export const FAILURES_TO_UNHEALTHY = 3;

/**
 * Consecutive successes before it is declared healthy again.
 *
 * Two rather than one, and deliberately asymmetric with the above: recovery is
 * the direction where being wrong is expensive. Admitting new cloud reads against
 * a mount that is flapping produces a queue of jobs that all fail.
 */
export const SUCCESSES_TO_HEALTHY = 2;

export type MountProbe = {
  /** The mountpoint exists and is backed by the expected filesystem type. */
  mountpointPresent(): Promise<boolean>;
  /** rclone's local RC answers. */
  rcReachable(): Promise<boolean>;
  /** A known path can be statted *through* the crypt view. */
  sentinelReadable(): Promise<boolean>;
  /** Bytes currently held in the VFS cache. */
  cacheBytes(): Promise<number>;
};

/** One account's mount, and the probe that reads it. */
export type SupervisedMount = {
  accountId: string;
  mountPoint: string;
  probe: MountProbe;
  /**
   * This mount's share of the cache ceiling.
   *
   * Per-mount rather than the global figure: each mount is its own rclone process
   * with its own cache, so recording the whole ceiling against each would report a
   * total budget of N times what was approved.
   */
  cacheMaxBytes: number;
};

export type MountSupervisorOptions = {
  db: AppDatabase;
  /** Compatibility mode observes stored evidence only, including during construction. */
  readOnly?: boolean;
  mounts: SupervisedMount[];
  policy: DiskPolicy;
  /** Live parent connection/profile authority; false skips every mount/provider probe. */
  isAccountEligible?: (accountId: string) => boolean;
  /**
   * Reads real free space on the **cache** filesystem.
   *
   * The cache disk, not the hot root: every other number recorded beside it —
   * cache bytes, the ceiling, the pressure verdict — is about the disk the VFS
   * cache lives on. Reading the hot root here produced a pressure verdict that
   * compared free space on the data disk against cache held on the system disk,
   * which described neither.
   */
  readCacheFreeBytes: () => Promise<number>;
  now?: () => number;
  /**
   * Emitted when one account's health flips, so the UI and job admission can react.
   *
   * Per-account because that is the granularity of the outage: a title whose active
   * replica lives on the healthy account must keep playing while the other is down.
   */
  onHealthChange?: (accountId: string, healthy: boolean) => void;
};

type HealthRow = {
  accountId: string;
  mountPoint: string;
  mounted: number;
  rcReachable: number;
  cacheBytes: number;
  cacheMaxBytes: number;
  diskFreeBytes: number;
  diskReserveBytes: number;
  pressure: CachePressure;
  lastError: string | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  checkedAt: number | null;
};

/**
 * Watches the mounts Jellyfin reads through and records what it finds.
 *
 * All three probes must pass for a mount, because they fail independently: the
 * mountpoint can still be present after rclone has stopped answering, and rclone
 * can answer while the crypt view cannot actually decrypt a path. Checking only
 * one would report a healthy library that cannot serve a byte.
 *
 * Health is tracked per storage account, since each account is its own mount and
 * its own rclone process. One account being down must not be reported as the
 * library being down — the titles backed by every other account still play.
 *
 * The distinction this class exists to preserve: **a mount outage is not missing
 * media.** Nothing here deletes a replica, rewrites the catalog, or marks a title
 * absent. It records unavailability, and availability comes back on its own when
 * the mount does.
 */
export class MountSupervisor {
  private readonly now: () => number;
  private readonly mounts: Map<string, SupervisedMount>;

  constructor(private readonly options: MountSupervisorOptions) {
    this.now = options.now ?? (() => Date.now());
    this.mounts = new Map(options.mounts.map((mount) => [mount.accountId, mount]));
    if (!options.readOnly) for (const mount of options.mounts) this.ensureRow(mount);
  }

  /** Public installs can add accounts without restarting an active worker graph. */
  replaceMounts(mounts: readonly SupervisedMount[]): void {
    if (this.options.readOnly) throw new Error('RECOVERY_COMPATIBILITY_READ_ONLY');
    if (new Set(mounts.map(mount=>mount.accountId)).size!==mounts.length) throw new Error('MOUNT_ACCOUNT_DUPLICATE');
    this.options.db.transaction(()=>{ for (const mount of mounts) this.ensureRow(mount); })();
    this.mounts.clear();
    for (const mount of mounts) this.mounts.set(mount.accountId,mount);
    this.options.mounts.splice(0,this.options.mounts.length,...mounts);
  }

  private ensureRow(mount: SupervisedMount): void {
    this.options.db
      .prepare(
        `INSERT INTO mount_health(
           account_id, mount_point, cache_max_bytes, disk_reserve_bytes, updated_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           -- Refreshed rather than ignored: a mount point or budget changed in
           -- config must not leave the table describing the previous layout.
           mount_point = excluded.mount_point,
           cache_max_bytes = excluded.cache_max_bytes,
           disk_reserve_bytes = excluded.disk_reserve_bytes,
           updated_at = excluded.updated_at`,
      )
      .run(
        mount.accountId,
        mount.mountPoint,
        mount.cacheMaxBytes,
        this.options.policy.cacheReserveBytes,
        this.now(),
      );
  }

  /**
   * Whether cloud playback and prefetch may be admitted for one account.
   *
   * Reads the *recorded verdict*, not the last probe result. Those differ during a
   * run of failures below the threshold, and that gap is the entire point of the
   * hysteresis: including `consecutiveFailures` here would make one slow probe stop
   * playback, which is what the three-strike rule exists to avoid.
   *
   * An unknown account is not healthy. Treating a missing row as playable would
   * admit reads against a mount nothing has ever checked.
   */
  isHealthy(accountId: string): boolean {
    if (!this.mounts.has(accountId)) return false;
    const row = this.tryRead(accountId);
    return row !== null && row.mounted === 1;
  }

  /** True when at least one account can serve reads. */
  isAnyHealthy(): boolean {
    return this.options.mounts.some((mount) => this.isHealthy(mount.accountId));
  }

  current(accountId: string): MountHealth {
    return toHealth(this.requireRow(accountId));
  }

  /** Every supervised mount's health, ordered by account id for stable rendering. */
  list(): MountHealth[] {
    return [...this.mounts.keys()].sort().flatMap((accountId) => {
      const row = this.tryRead(accountId);
      if (row === null && this.options.readOnly) return [];
      return [toHealth(row ?? this.requireRow(accountId))];
    });
  }

  /**
   * Runs one probe cycle for every mount and updates recorded health.
   *
   * Never throws, and one mount's failure never skips the others: a supervisor that
   * propagated a probe failure would take down the scheduler that calls it, turning
   * "a mount is down" into "the service is down" — and the second is strictly
   * worse, because the API is what tells the operator about the first.
   */
  async check(): Promise<MountHealth[]> {
    if (this.options.readOnly) return this.list();
    for (const mount of [...this.options.mounts]) {
      await this.checkOne(mount);
    }
    return this.list();
  }

  async checkOne(mount: SupervisedMount): Promise<MountHealth> {
    if (this.options.readOnly) throw new Error('RECOVERY_COMPATIBILITY_READ_ONLY');
    let mounted = false;
    let rcReachable = false;
    let sentinelOk = false;
    let cacheBytes = 0;
    let failureCode: string | null = null;
    const accountEligible = this.options.isAccountEligible?.(mount.accountId) ?? true;

    try {
      if (!accountEligible) {
        failureCode = 'MOUNT_ACCOUNT_INELIGIBLE';
      } else {
        mounted = await mount.probe.mountpointPresent();
        if (!mounted) failureCode = 'MOUNT_NOT_PRESENT';

        rcReachable = await mount.probe.rcReachable();
        if (mounted && !rcReachable) failureCode ??= 'MOUNT_RC_UNREACHABLE';

        if (mounted && rcReachable) {
          sentinelOk = await mount.probe.sentinelReadable();
          if (!sentinelOk) failureCode ??= 'MOUNT_SENTINEL_UNREADABLE';
          cacheBytes = await mount.probe.cacheBytes();
        }
      }
    } catch {
      // A stable code, never the thrown message: rclone errors carry remote paths
      // and account hints, and this value is rendered in the UI.
      failureCode ??= 'MOUNT_PROBE_FAILED';
    }

    let freeBytes = 0;
    try {
      freeBytes = await this.options.readCacheFreeBytes();
    } catch {
      failureCode ??= 'DISK_UNREADABLE';
    }

    const ok = accountEligible && mounted && rcReachable && sentinelOk;
    const previous = this.requireRow(mount.accountId);
    // Only `mounted` carries the verdict. Reading the raw probe columns here would
    // let a single failure flip `wasHealthy`, and then the threshold crossing two
    // probes later would not look like a transition at all — the callback that
    // stops job admission would never fire.
    const wasHealthy = previous.mounted === 1;

    const consecutiveFailures = ok ? 0 : previous.consecutiveFailures + 1;
    const consecutiveSuccesses = ok ? previous.consecutiveSuccesses + 1 : 0;

    // Hysteresis in both directions, with different thresholds. Until a boundary
    // is crossed the previously recorded verdict stands, so a single slow probe
    // neither stops playback nor prematurely resumes it.
    let healthy = wasHealthy;
    if (!ok && consecutiveFailures >= FAILURES_TO_UNHEALTHY) healthy = false;
    if (ok && consecutiveSuccesses >= SUCCESSES_TO_HEALTHY) healthy = true;

    const pressure = classifyPressure({
      freeBytes,
      reserveBytes: this.options.policy.cacheReserveBytes,
      cacheBytes,
      cacheMaxBytes: mount.cacheMaxBytes,
    });

    this.options.db
      .prepare(
        `UPDATE mount_health SET
           mounted = ?, rc_reachable = ?, cache_bytes = ?, cache_max_bytes = ?,
           disk_free_bytes = ?, disk_reserve_bytes = ?, pressure = ?, last_error = ?,
           consecutive_failures = ?, consecutive_successes = ?, checked_at = ?,
           updated_at = ?
         WHERE account_id = ?`,
      )
      .run(
        // The verdict, subject to hysteresis.
        healthy ? 1 : 0,
        // The last raw probe result, reported as-is so the UI can show *which*
        // half is broken while the verdict still says healthy.
        rcReachable ? 1 : 0,
        cacheBytes,
        mount.cacheMaxBytes,
        freeBytes,
        this.options.policy.cacheReserveBytes,
        pressure,
        ok ? null : failureCode,
        consecutiveFailures,
        consecutiveSuccesses,
        this.now(),
        this.now(),
        mount.accountId,
      );

    if (healthy !== wasHealthy) this.options.onHealthChange?.(mount.accountId, healthy);
    return this.current(mount.accountId);
  }

  private requireRow(accountId: string): HealthRow {
    const row = this.tryRead(accountId);
    if (!row) throw new Error('MOUNT_HEALTH_ROW_MISSING');
    return row;
  }

  private tryRead(accountId: string): HealthRow | null {
    const row = this.options.db
      .prepare(
        `SELECT account_id AS accountId, mount_point AS mountPoint, mounted,
                rc_reachable AS rcReachable, cache_bytes AS cacheBytes,
                cache_max_bytes AS cacheMaxBytes, disk_free_bytes AS diskFreeBytes,
                disk_reserve_bytes AS diskReserveBytes, pressure,
                last_error AS lastError, consecutive_failures AS consecutiveFailures,
                consecutive_successes AS consecutiveSuccesses, checked_at AS checkedAt
         FROM mount_health WHERE account_id = ?`,
      )
      .get(accountId) as HealthRow | undefined;
    return row ?? null;
  }
}

function toHealth(row: HealthRow): MountHealth {
  return {
    accountId: row.accountId,
    mountPoint: row.mountPoint,
    mounted: row.mounted === 1,
    rcReachable: row.rcReachable === 1,
    cacheBytes: row.cacheBytes,
    cacheMaxBytes: row.cacheMaxBytes,
    diskFreeBytes: row.diskFreeBytes,
    diskReserveBytes: row.diskReserveBytes,
    pressure: row.pressure,
    lastError: row.lastError,
    checkedAt: row.checkedAt,
  };
}
