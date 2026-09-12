import type { CachePressure } from '@ptvault/contracts';

import type { AppDatabase } from '../db/database.js';
import { admissibleBytes, classifyPressure, type DiskPolicy } from './disk.js';

/**
 * One step the governor wants taken, in the order it should be taken.
 *
 * `CANCEL_PREFETCH` exists so speculative work is always sacrificed before
 * anything the operator is using. Prefetch is a guess about what might be watched;
 * an open playback handle and a pin are statements about what is being watched and
 * what must stay. Giving up a guess costs nothing but bandwidth already spent.
 */
export type CacheAction =
  | { kind: 'CANCEL_PREFETCH'; jobId: string }
  | { kind: 'EVICT'; logicalPath: string; bytes: number }
  | { kind: 'PAUSE_REHYDRATE_ADMISSION' }
  | { kind: 'NOOP' };

/** A VFS cache entry as reported by rclone, plus what we know about it. */
export type CacheEntry = {
  logicalPath: string;
  bytes: number;
  /** Last access time; drives LRU ordering. */
  accessedAt: number;
  /** rclone still holds this file open — evicting it would break a read in flight. */
  open: boolean;
};

export type CacheGovernorOptions = {
  db: AppDatabase;
  policy: DiskPolicy;
  now?: () => number;
};

export type EvaluateInput = {
  /** Free space on the **cache** filesystem, not the hot root. */
  freeBytes: number;
  entries: readonly CacheEntry[];
  /** Logical paths Jellyfin currently has open for playback. */
  activePlaybackPaths: readonly string[];
  /** Queued prefetch job ids, newest last. */
  queuedPrefetchJobIds: readonly string[];
};

export type Evaluation = {
  pressure: CachePressure;
  actions: CacheAction[];
  /** Bytes the plan expects to reclaim if every action is carried out. */
  reclaimableBytes: number;
};

export class CacheGovernor {
  private readonly now: () => number;

  constructor(private readonly options: CacheGovernorOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Total bytes claimed by jobs that have not released their reservation. */
  outstandingReservedBytes(): number {
    const total = this.options.db
      .prepare('SELECT COALESCE(SUM(bytes), 0) FROM space_reservations WHERE released_at IS NULL')
      .pluck()
      .get() as number;
    return total;
  }

  /** The active claim held by one job, or null when it currently holds none. */
  activeReservationBytes(jobId: string): number | null {
    const value = this.options.db
      .prepare('SELECT bytes FROM space_reservations WHERE job_id = ? AND released_at IS NULL')
      .pluck()
      .get(jobId) as number | undefined;
    return value ?? null;
  }

  /** Logical paths the operator pinned, which eviction must never touch. */
  pinnedPaths(): Set<string> {
    const rows = this.options.db
      .prepare('SELECT logical_path AS logicalPath FROM cache_pins')
      .all() as Array<{ logicalPath: string }>;
    return new Set(rows.map((row) => row.logicalPath));
  }

  /**
   * Decides what to do about current disk pressure.
   *
   * The action order is the policy: cancel speculative prefetch, then evict cold
   * unpinned entries oldest-first, and only if that is still not enough, stop
   * admitting restores. Nothing here evicts an open or pinned entry at any pressure
   * level — a `CRITICAL` disk is not a reason to break the playback the operator is
   * watching, and it is never a reason to drop something they explicitly kept.
   *
   * ⚠️ **Nothing calls this yet, and a restore blocked on space is not what would
   * call it.** The plan it returns governs the *VFS cache*, and on the reference
   * deployment that cache sits on a different filesystem from the hot root where
   * restores land — the system disk rather than the data disk — so no amount of
   * eviction frees a byte a restore could use. `RehydrateHandler` therefore checks
   * the two for a shared filesystem before it will park a job in `EVICTING_CACHE`
   * at all. Wiring this up is worth doing for cache pressure in its own right; it
   * is not the fix for a full hot disk, and treating it as one is what made the
   * step look recoverable when it was not.
   */
  evaluate(input: EvaluateInput): Evaluation {
    const pressure = classifyPressure({
      freeBytes: input.freeBytes,
      reserveBytes: this.options.policy.cacheReserveBytes,
      cacheBytes: input.entries.reduce((sum, entry) => sum + entry.bytes, 0),
      cacheMaxBytes: this.options.policy.cacheMaxBytes,
    });

    if (pressure === 'NORMAL') {
      return { pressure, actions: [{ kind: 'NOOP' }], reclaimableBytes: 0 };
    }

    const actions: CacheAction[] = [];

    // Speculative work first, always. Cancelling a guess is free; the bandwidth it
    // already spent is spent either way.
    if (pressure === 'CRITICAL') {
      for (const jobId of input.queuedPrefetchJobIds) {
        actions.push({ kind: 'CANCEL_PREFETCH', jobId });
      }
    }

    const pinned = this.pinnedPaths();
    const active = new Set(input.activePlaybackPaths);
    const evictable = input.entries
      .filter(
        (entry) => !entry.open && !pinned.has(entry.logicalPath) && !active.has(entry.logicalPath),
      )
      // Oldest access first: the least likely to be wanted again soon.
      .sort((left, right) => left.accessedAt - right.accessedAt);

    const shortfall = this.shortfallBytes(input);
    let reclaimed = 0;
    for (const entry of evictable) {
      if (reclaimed >= shortfall) break;
      actions.push({ kind: 'EVICT', logicalPath: entry.logicalPath, bytes: entry.bytes });
      reclaimed += entry.bytes;
    }

    // Everything evictable is planned and the reserve is still breached: the only
    // remaining lever is refusing new restores. Said explicitly rather than by
    // silently letting admission math fail later.
    if (pressure === 'CRITICAL' && reclaimed < shortfall) {
      actions.push({ kind: 'PAUSE_REHYDRATE_ADMISSION' });
    }

    if (actions.length === 0) actions.push({ kind: 'NOOP' });
    return { pressure, actions, reclaimableBytes: reclaimed };
  }

  /**
   * How many bytes must be freed to get back inside policy.
   *
   * Two independent shortfalls, and the larger wins: the disk reserve, and the
   * cache's own ceiling. Satisfying one while ignoring the other would leave the
   * system still out of policy in the other direction.
   */
  private shortfallBytes(input: EvaluateInput): number {
    const cacheBytes = input.entries.reduce((sum, entry) => sum + entry.bytes, 0);
    const reserveShortfall = Math.max(
      0,
      this.options.policy.cacheReserveBytes - input.freeBytes + this.headroomTarget(),
    );
    const ceilingShortfall = Math.max(0, cacheBytes - this.options.policy.cacheMaxBytes);
    return Math.max(reserveShortfall, ceilingShortfall);
  }

  /**
   * A margin freed beyond the bare minimum, so the next write does not immediately
   * re-trigger eviction. Ten percent of the reserve mirrors the `EVICTING`
   * threshold in `classifyPressure`, keeping one notion of "close to the line".
   */
  private headroomTarget(): number {
    return Math.ceil(this.options.policy.cacheReserveBytes * 0.1);
  }

  /**
   * Claims space for a job before it writes anything.
   *
   * A row per job rather than a running total: two concurrent restores must not
   * both be told the same free bytes are theirs, and a crashed job's claim has to
   * be identifiable so it can be released.
   */
  reserve(input: {
    jobId: string;
    kind: 'REHYDRATE' | 'PREFETCH' | 'VERIFY';
    bytes: number;
    freeBytes: number;
  }): { reserved: true } | { reserved: false; missingBytes: number } {
    return this.options.db.transaction(() => {
      // Re-admitting the same durable job must not count its existing claim twice.
      // This is what lets a worker restart resume a download without falsely
      // deciding that the reservation it already owns has consumed its space.
      const ownReservation = this.activeReservationBytes(input.jobId) ?? 0;
      const available = admissibleBytes({
        freeBytes: input.freeBytes,
        reserveBytes: this.options.policy.reserveBytes,
        outstandingReservedBytes: Math.max(0, this.outstandingReservedBytes() - ownReservation),
      });
      if (available < input.bytes) {
        return { reserved: false as const, missingBytes: input.bytes - available };
      }
      this.options.db
        .prepare(
          `INSERT INTO space_reservations(job_id, kind, bytes, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(job_id) DO UPDATE SET
             bytes = excluded.bytes, kind = excluded.kind, released_at = NULL`,
        )
        .run(input.jobId, input.kind, input.bytes, this.now());
      return { reserved: true as const };
    })();
  }

  /** Releases a claim. Idempotent: releasing twice is not an error worth failing on. */
  release(jobId: string): void {
    this.options.db
      .prepare(
        'UPDATE space_reservations SET released_at = ? WHERE job_id = ? AND released_at IS NULL',
      )
      .run(this.now(), jobId);
  }

  pin(input: { logicalPath: string; instanceId: string; torrentHash: string }): void {
    this.options.db
      .prepare(
        `INSERT INTO cache_pins(logical_path, instance_id, torrent_hash, pinned_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(logical_path) DO NOTHING`,
      )
      .run(input.logicalPath, input.instanceId, input.torrentHash, this.now());
  }

  unpin(logicalPath: string): void {
    this.options.db.prepare('DELETE FROM cache_pins WHERE logical_path = ?').run(logicalPath);
  }
}
