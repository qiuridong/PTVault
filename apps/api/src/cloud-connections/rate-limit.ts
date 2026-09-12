import type {
  CloudConnectionRateLimit,
  CloudConnectionRateLimitCode,
  CloudProvider,
} from '@ptvault/contracts';

import type { AppDatabase } from '../db/database.js';

type RuntimeRow = {
  retryAt: number | null;
  code: CloudConnectionRateLimitCode | null;
  updatedAt: number | null;
  revision: number;
};

export type CloudProviderOperationAuthority = {
  connectionId: string;
  provider: CloudProvider;
  connectionRevision: number;
  secretRefId: string;
  refreshFence?: {
    ownerId: string;
    fencingToken: number;
  };
};

/** Sanitized adapter signal: only the bounded Retry-After header crosses this boundary. */
export class CloudProviderRateLimitError extends Error {
  readonly retryAfter: string | undefined;

  constructor(retryAfter?: string) {
    super('PROVIDER_RATE_LIMITED');
    this.name = 'CloudProviderRateLimitError';
    this.retryAfter = retryAfter && retryAfter.length <= 256 ? retryAfter : undefined;
  }
}

/** The connection/credential/fence changed while a provider call was waiting. */
export class CloudProviderAuthorityStaleError extends Error {
  readonly code = 'PROVIDER_AUTHORITY_STALE';

  constructor() {
    super('PROVIDER_AUTHORITY_STALE');
    this.name = 'CloudProviderAuthorityStaleError';
  }
}

export type CloudConnectionRateLimitAuthorityOptions = {
  db: AppDatabase;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  jitter?: (maximumMilliseconds: number) => number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  wakeJitterMs?: number;
  recheckIntervalMs?: number;
};

/** Durable, connection-scoped provider backoff; never a global concurrency clamp. */
export class CloudConnectionRateLimitAuthority {
  private readonly db: AppDatabase;
  private readonly now: () => number;
  private readonly sleep: ((milliseconds: number) => Promise<void>) | null;
  private readonly jitter: (maximumMilliseconds: number) => number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly wakeJitterMs: number;
  private readonly recheckIntervalMs: number;
  private readonly wakeups = new Map<string, Promise<void>>();
  private readonly delayWaiters = new Map<string, Set<() => void>>();

  constructor(options: CloudConnectionRateLimitAuthorityOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? null;
    this.jitter =
      options.jitter ??
      ((maximum) => (maximum <= 0 ? 0 : Math.floor(Math.random() * (maximum + 1))));
    this.baseBackoffMs = options.baseBackoffMs ?? 30_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 15 * 60_000;
    this.wakeJitterMs = options.wakeJitterMs ?? 1_000;
    this.recheckIntervalMs = options.recheckIntervalMs ?? 1_000;
    if (
      this.baseBackoffMs <= 0 ||
      this.maxBackoffMs < this.baseBackoffMs ||
      this.wakeJitterMs < 0 ||
      this.recheckIntervalMs <= 0
    ) {
      throw new Error('INVALID_RATE_LIMIT_POLICY');
    }
  }

  /** Provider-adapter boundary: persist only a safe enum and parsed Retry-After. */
  reportProvider429(
    authority: CloudProviderOperationAuthority,
    retryAfter: string | undefined,
  ): number | null {
    return this.db
      .transaction(() => {
        if (!this.isCurrentProviderAuthority(authority)) return null;
        return this.report(authority.connectionId, {
          code: authority.provider === 'BAIDU' ? 'BAIDU_RATE_LIMITED' : 'ONEDRIVE_RATE_LIMITED',
          retryAt: parseProviderRetryAfter(retryAfter, this.now()),
        });
      })
      .immediate();
  }

  async runProviderOperation<T>(
    authority: CloudProviderOperationAuthority,
    operation: () => Promise<T>,
  ): Promise<T> {
    await this.waitUntilAvailable(authority.connectionId);
    // Waiting for a shared backoff can outlive a reauthorization, disable or
    // refresh fence. Never send the stale credential merely because the gate is
    // open now; bind the call itself to the authority that requested it.
    if (!this.isCurrentProviderAuthority(authority)) {
      throw new CloudProviderAuthorityStaleError();
    }
    try {
      return await operation();
    } catch (error) {
      if (error instanceof CloudProviderRateLimitError) {
        this.reportProvider429(authority, error.retryAfter);
      }
      throw error;
    }
  }

  report(
    connectionId: string,
    input: { code: CloudConnectionRateLimitCode; retryAt: number | null },
  ): number {
    const timestamp = this.now();
    const existing = this.row(connectionId);
    const fallbackDelay = Math.min(
      this.maxBackoffMs,
      this.baseBackoffMs * 2 ** Math.min(existing?.revision ?? 0, 10) +
        boundedJitter(this.jitter(this.baseBackoffMs), this.baseBackoffMs),
    );
    const requested =
      Number.isFinite(input.retryAt) && input.retryAt !== null && input.retryAt > timestamp
        ? input.retryAt
        : timestamp + fallbackDelay;
    // A syntactically valid provider Retry-After is authoritative even when it
    // exceeds the local fallback ceiling. The ceiling applies only to fallback.
    const retryAt = requested;
    this.db
      .prepare(
        `INSERT INTO cloud_connection_runtime(
           connection_id, rate_limited_until, rate_limit_code,
           rate_limit_updated_at, runtime_revision
         ) VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(connection_id) DO UPDATE SET
           rate_limited_until = CASE
             WHEN cloud_connection_runtime.rate_limited_until IS NULL
               THEN excluded.rate_limited_until
             ELSE MAX(cloud_connection_runtime.rate_limited_until, excluded.rate_limited_until)
           END,
           rate_limit_code = excluded.rate_limit_code,
           rate_limit_updated_at = excluded.rate_limit_updated_at,
           runtime_revision = cloud_connection_runtime.runtime_revision + 1`,
      )
      .run(connectionId, retryAt, input.code, timestamp);
    return this.current(connectionId).retryAt!;
  }

  current(connectionId: string): CloudConnectionRateLimit {
    const row = this.row(connectionId);
    if (row === null) {
      return { retryAt: null, code: null, updatedAt: null, revision: 0 };
    }
    if (row.retryAt !== null && this.now() >= row.retryAt) {
      this.clearExpiredObserved(connectionId, row.retryAt, row.revision);
      return this.row(connectionId) ?? { retryAt: null, code: null, updatedAt: null, revision: 0 };
    }
    return row;
  }

  /**
   * Compare-and-swap clear for a previously observed expired gate. Exposed so
   * callers coordinating across SQLite connections can preserve a newer 429
   * written after their read instead of erasing it with a stale clear.
   */
  clearExpiredObserved(
    connectionId: string,
    observedRetryAt: number,
    observedRevision: number,
  ): boolean {
    if (this.now() < observedRetryAt) return false;
    const cleared = this.db
      .prepare(
        `UPDATE cloud_connection_runtime
         SET rate_limited_until = NULL, rate_limit_code = NULL,
             rate_limit_updated_at = NULL, runtime_revision = runtime_revision + 1
         WHERE connection_id = ? AND rate_limited_until = ?
           AND runtime_revision = ?`,
      )
      .run(connectionId, observedRetryAt, observedRevision);
    if (cleared.changes === 1) this.notifyDelayWaiters(connectionId);
    return cleared.changes === 1;
  }

  waitUntilAvailable(connectionId: string): Promise<void> {
    const existing = this.wakeups.get(connectionId);
    if (existing) return existing;
    const wait = this.waitLoop(connectionId).finally(() => {
      if (this.wakeups.get(connectionId) === wait) this.wakeups.delete(connectionId);
    });
    this.wakeups.set(connectionId, wait);
    return wait;
  }

  clearForIdentityChange(connectionId: string): void {
    this.db
      .prepare(
        `UPDATE cloud_connection_runtime
         SET rate_limited_until = NULL, rate_limit_code = NULL,
             rate_limit_updated_at = NULL, runtime_revision = runtime_revision + 1
         WHERE connection_id = ?`,
      )
      .run(connectionId);
    this.notifyDelayWaiters(connectionId);
  }

  private async waitLoop(connectionId: string): Promise<void> {
    for (;;) {
      const current = this.current(connectionId);
      if (current.retryAt === null) return;
      const delay = Math.max(1, current.retryAt - this.now());
      const wakeJitter = boundedJitter(this.jitter(this.wakeJitterMs), this.wakeJitterMs);
      // A bounded recheck observes clears performed by another API process;
      // every local caller still shares this one loop, not one timer per job.
      const waitFor = delay > this.recheckIntervalMs ? this.recheckIntervalMs : delay + wakeJitter;
      await this.waitForDelay(connectionId, waitFor);
    }
  }

  private waitForDelay(connectionId: string, milliseconds: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        const waiters = this.delayWaiters.get(connectionId);
        waiters?.delete(finish);
        if (waiters?.size === 0) this.delayWaiters.delete(connectionId);
        resolve();
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        const waiters = this.delayWaiters.get(connectionId);
        waiters?.delete(finish);
        if (waiters?.size === 0) this.delayWaiters.delete(connectionId);
        reject(error instanceof Error ? error : new Error('RATE_LIMIT_SLEEP_FAILED'));
      };
      const waiters = this.delayWaiters.get(connectionId) ?? new Set<() => void>();
      waiters.add(finish);
      this.delayWaiters.set(connectionId, waiters);
      if (this.sleep === null) {
        timer = setTimeout(finish, milliseconds);
      } else {
        void this.sleep(milliseconds).then(finish, fail);
      }
    });
  }

  private notifyDelayWaiters(connectionId: string): void {
    const waiters = this.delayWaiters.get(connectionId);
    if (!waiters) return;
    this.delayWaiters.delete(connectionId);
    for (const wake of waiters) wake();
  }

  private row(connectionId: string): RuntimeRow | null {
    const row = this.db
      .prepare(
        `SELECT rate_limited_until AS retryAt, rate_limit_code AS code,
                rate_limit_updated_at AS updatedAt, runtime_revision AS revision
         FROM cloud_connection_runtime WHERE connection_id = ?`,
      )
      .get(connectionId) as RuntimeRow | undefined;
    return row ?? null;
  }

  private isCurrentProviderAuthority(authority: CloudProviderOperationAuthority): boolean {
    const connection = this.db
      .prepare(
        `SELECT 1 FROM cloud_connections
         WHERE id = @connectionId AND provider = @provider
           AND revision = @connectionRevision AND secret_ref = @secretRefId
           AND auth_state = 'CONNECTED' AND disconnected_at IS NULL`,
      )
      .get(authority) as { 1: number } | undefined;
    if (!connection) return false;
    if (authority.refreshFence === undefined) return true;
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM cloud_connection_refresh_leases
           WHERE connection_id = @connectionId
             AND owner_id = @ownerId AND fencing_token = @fencingToken
             AND lease_expires_at > @now`,
        )
        .get({
          connectionId: authority.connectionId,
          ownerId: authority.refreshFence.ownerId,
          fencingToken: authority.refreshFence.fencingToken,
          now: this.now(),
        }),
    );
  }
}

export function parseProviderRetryAfter(raw: string | undefined, now: number): number | null {
  if (raw === undefined) return null;
  const value = raw.trim();
  if (/^[0-9]+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds)) return null;
    const retryAt = now + seconds * 1_000;
    return Number.isSafeInteger(retryAt) && retryAt > now ? retryAt : null;
  }
  if (/^[+-]?[0-9]+$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > now ? parsed : null;
}

function boundedJitter(value: number, maximum: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(maximum, Math.trunc(value)));
}
