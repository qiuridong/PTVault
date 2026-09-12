import { randomUUID } from 'node:crypto';

import { StorageAccountSchema, type StorageAccount, type StorageHealth } from '@ptvault/contracts';

import {
  StorageEligibilityAuthority,
  type StorageEligibilityAuthorityOptions,
  type StorageEligibilityPurpose,
} from '../cloud-connections/eligibility.js';
import type { AppDatabase } from '../db/database.js';
import { NoAccountCapacityError, selectAccount } from './selector.js';

export type CapacityOwnerKind = 'IMPORT' | 'SECONDARY';
export type SharedCapacityClaim = {
  ownerKind: CapacityOwnerKind;
  ownerId: string;
  requiredBytes: string;
  accountId?: string;
  excludeAccountIds?: readonly string[];
  generation?: number;
};

const REMOTE_ALIAS = /^[A-Za-z0-9_-]+:$/;

export type RegisterAccountInput = {
  label: string;
  rawRemote: string;
  cryptRemote: string;
  reserveBytes: number;
};

export type HealthUpdate = {
  health: StorageHealth;
  totalBytes: number | null;
  freeBytes: number | null;
  checkedAt: number;
};

export type OffloadCapacityReservationInput = {
  jobId: string;
  requiredBytes: number;
  stagingPrefix: string;
};

type AccountRow = {
  id: string;
  label: string;
  raw_remote: string;
  crypt_remote: string;
  health: string;
  total_bytes: number | null;
  free_bytes: number | null;
  reserve_bytes: number;
  circuit_open_until: number | null;
  last_checked_at: number | null;
  revision: number;
};

type CapacityReservationRow = {
  accountId: string;
  reservedBytes: number;
};

type CapacitySnapshotRow = {
  selectedAccountId: string | null;
  stagingPrefix: string | null;
  currentStep: string;
  cancelledAt: number | null;
};

const TERMINAL_OFFLOAD_STEPS = "'CLOUD_COMMITTED', 'LOCAL_CLEANUP', 'COMPLETED'";

function accountValues(row: AccountRow) {
  return {
    id: row.id,
    label: row.label,
    rawRemote: row.raw_remote,
    cryptRemote: row.crypt_remote,
    health: row.health,
    totalBytes: row.total_bytes,
    freeBytes: row.free_bytes,
    reserveBytes: row.reserve_bytes,
    circuitOpenUntil: row.circuit_open_until,
    lastCheckedAt: row.last_checked_at,
    revision: row.revision,
  };
}

function toAccount(row: AccountRow): StorageAccount {
  return StorageAccountSchema.parse(accountValues(row));
}

function toCapacityAccount(row: AccountRow): StorageAccount {
  // Capacity and public reads share the same opaque-id domain; no private
  // schema bypass can let the scheduler select an account the UI cannot read.
  return toAccount(row);
}

export class UnknownRemoteError extends Error {
  readonly code = 'UNKNOWN_REMOTE';

  constructor(remote: string) {
    super(`UNKNOWN_REMOTE: ${remote}`);
    this.name = 'UnknownRemoteError';
  }
}

export class StorageAccountRepository {
  private readonly eligibility: StorageEligibilityAuthority;

  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => number = () => Date.now(),
    eligibilityOptions: Omit<StorageEligibilityAuthorityOptions, 'now'> = {},
  ) {
    this.eligibility = new StorageEligibilityAuthority(db, {
      ...eligibilityOptions,
      now,
    });
  }

  register(input: RegisterAccountInput, registeredRemotes: ReadonlySet<string>): StorageAccount {
    for (const remote of [input.rawRemote, input.cryptRemote]) {
      if (!REMOTE_ALIAS.test(remote)) {
        throw new Error(`INVALID_REMOTE_ALIAS: ${remote}`);
      }
      if (!registeredRemotes.has(remote)) {
        throw new UnknownRemoteError(remote);
      }
    }
    if (!Number.isInteger(input.reserveBytes) || input.reserveBytes < 0) {
      throw new Error('INVALID_RESERVE_BYTES');
    }

    const id = randomUUID();
    const timestamp = this.now();
    this.db
      .prepare(
        `INSERT INTO storage_accounts(
           id, label, raw_remote, crypt_remote, health,
           total_bytes, free_bytes, reserve_bytes, circuit_open_until, last_checked_at,
           created_at, updated_at
         ) VALUES (@id, @label, @rawRemote, @cryptRemote, 'AUTH_REQUIRED',
           NULL, NULL, @reserveBytes, NULL, NULL, @timestamp, @timestamp)`,
      )
      .run({
        id,
        label: input.label,
        rawRemote: input.rawRemote,
        cryptRemote: input.cryptRemote,
        reserveBytes: input.reserveBytes,
        timestamp,
      });

    return this.get(id);
  }

  recordHealth(id: string, update: HealthUpdate): void {
    this.db
      .transaction(() => {
        const changed = this.db
          .prepare(
            `UPDATE storage_accounts
             SET health = @health, total_bytes = @totalBytes, free_bytes = @freeBytes,
                 last_checked_at = @checkedAt, updated_at = @updatedAt
             WHERE id = @id`,
          )
          .run({
            id,
            health: update.health,
            totalBytes: update.totalBytes,
            freeBytes: update.freeBytes,
            checkedAt: update.checkedAt,
            updatedAt: this.now(),
          });
        if (changed.changes === 0) throw new Error('ACCOUNT_NOT_FOUND');

        // A reservation represents bytes that may not yet be reflected by the
        // account's quota snapshot. Nonterminal jobs therefore keep it across
        // every probe. A terminal job releases it only when a successful quota
        // reading was *started after* the durable terminal boundary.
        if (update.freeBytes !== null) {
          this.db
            .prepare(
              `DELETE FROM storage_capacity_reservations
            WHERE account_id = ? AND state = 'SETTLED' AND settled_at < ?`,
            )
            .run(id, update.checkedAt);
          this.db
            .prepare(
              `DELETE FROM offload_account_reservations
               WHERE account_id = @accountId
                 AND EXISTS (
                   SELECT 1
                   FROM offload_snapshots AS snapshot
                   WHERE snapshot.job_id = offload_account_reservations.job_id
                     AND (
                       (snapshot.cancelled_at IS NOT NULL
                         AND @checkedAt > snapshot.cancelled_at)
                       OR (
                         snapshot.cancelled_at IS NULL
                         AND snapshot.current_step IN (${TERMINAL_OFFLOAD_STEPS})
                         AND @checkedAt > COALESCE(
                           (
                             SELECT MIN(event.created_at)
                             FROM job_events AS event
                             WHERE event.job_id = snapshot.job_id
                               AND event.event_type = 'OFFLOAD_CLOUD_COMMITTED'
                           ),
                           snapshot.updated_at
                         )
                       )
                     )
                 )`,
            )
            .run({ accountId: id, checkedAt: update.checkedAt });
        }

        this.db
          .prepare(
            `INSERT INTO storage_health_events(id, account_id, health, detail_json, created_at)
             VALUES (@id, @accountId, @health, @detail, @createdAt)`,
          )
          .run({
            id: randomUUID(),
            accountId: id,
            health: update.health,
            detail: JSON.stringify({ totalBytes: update.totalBytes, freeBytes: update.freeBytes }),
            createdAt: update.checkedAt,
          });
      })
      .immediate();
  }

  /**
   * Select an account and persist the job's capacity claim in one IMMEDIATE
   * SQLite transaction. The write lock makes the read/choose/reserve sequence
   * serializable across independent service processes using the same database.
   */
  reserveOffloadCapacity(input: OffloadCapacityReservationInput): StorageAccount {
    if (!Number.isSafeInteger(input.requiredBytes) || input.requiredBytes < 0) {
      throw new Error('INVALID_REQUIRED_BYTES');
    }
    if (input.stagingPrefix.length === 0 || input.stagingPrefix.includes('\0')) {
      throw new Error('INVALID_STAGING_PREFIX');
    }

    return this.db
      .transaction(() => {
        const snapshot = this.db
          .prepare(
            `SELECT selected_account_id AS selectedAccountId,
                    staging_prefix AS stagingPrefix,
                    current_step AS currentStep,
                    cancelled_at AS cancelledAt
             FROM offload_snapshots WHERE job_id = ?`,
          )
          .get(input.jobId) as CapacitySnapshotRow | undefined;
        if (!snapshot) throw new Error('OFFLOAD_NOT_FOUND');

        const existing = this.db
          .prepare(
            `SELECT account_id AS accountId, reserved_bytes AS reservedBytes
             FROM offload_account_reservations WHERE job_id = ?`,
          )
          .get(input.jobId) as CapacityReservationRow | undefined;
        if (existing) {
          if (snapshot.selectedAccountId !== existing.accountId) {
            throw new Error('OFFLOAD_CAPACITY_RESERVATION_CORRUPT');
          }
          if (input.requiredBytes > existing.reservedBytes) {
            const candidate = this.adjustedAccounts(input.jobId, 'EXISTING_WORK').find(
              (account) => account.id === existing.accountId,
            );
            if (!candidate) throw new Error('OFFLOAD_ACCOUNT_NOT_FOUND');
            selectAccount([candidate], input.requiredBytes, this.now());
            this.db
              .prepare(
                `UPDATE offload_account_reservations
                 SET reserved_bytes = ? WHERE job_id = ?`,
              )
              .run(input.requiredBytes, input.jobId);
          }
          if (snapshot.stagingPrefix === null) {
            this.db
              .prepare(
                `UPDATE offload_snapshots SET staging_prefix = ?, updated_at = ?
                 WHERE job_id = ? AND staging_prefix IS NULL`,
              )
              .run(input.stagingPrefix, this.now(), input.jobId);
          }
          return this.getEligible(existing.accountId, 'EXISTING_WORK');
        }

        // A selected row without a v23 reservation was created by an older
        // binary. Do not silently arm it during migration/retry. Other jobs
        // still count its manifest as a conservative synthetic reservation.
        if (snapshot.selectedAccountId !== null) {
          if (snapshot.stagingPrefix === null) {
            this.db
              .prepare(
                `UPDATE offload_snapshots SET staging_prefix = ?, updated_at = ?
                 WHERE job_id = ? AND staging_prefix IS NULL`,
              )
              .run(input.stagingPrefix, this.now(), input.jobId);
          }
          return this.getEligible(snapshot.selectedAccountId, 'EXISTING_WORK');
        }

        if (snapshot.cancelledAt !== null || snapshot.currentStep !== 'UPLOADING_STAGING') {
          throw new Error('OFFLOAD_CAPACITY_NOT_ADMISSIBLE');
        }

        const adjusted = this.adjustedAccounts();
        const selected = selectAccount(adjusted, input.requiredBytes, this.now());
        const original = this.getEligible(selected.id, 'NEW_WORK');
        const timestamp = this.now();
        const changed = this.db
          .prepare(
            `UPDATE offload_snapshots
             SET selected_account_id = ?, staging_prefix = COALESCE(staging_prefix, ?),
                 updated_at = ?
             WHERE job_id = ? AND selected_account_id IS NULL
               AND cancelled_at IS NULL AND current_step = 'UPLOADING_STAGING'`,
          )
          .run(selected.id, input.stagingPrefix, timestamp, input.jobId);
        if (changed.changes !== 1) throw new Error('OFFLOAD_CAPACITY_ADMISSION_CONFLICT');
        this.db
          .prepare(
            `INSERT INTO offload_account_reservations(
               job_id, account_id, reserved_bytes, created_at
             ) VALUES (?, ?, ?, ?)`,
          )
          .run(input.jobId, selected.id, input.requiredBytes, timestamp);
        return original;
      })
      .immediate();
  }

  openCircuit(id: string, until: number): void {
    const changed = this.db
      .prepare(
        `UPDATE storage_accounts SET circuit_open_until = @until, updated_at = @updatedAt WHERE id = @id`,
      )
      .run({ id, until, updatedAt: this.now() });
    if (changed.changes === 0) throw new Error('ACCOUNT_NOT_FOUND');
  }

  availableCapacity(accountId: string): string | null {
    const account = this.adjustedAccounts(undefined, 'EXISTING_WORK').find(
      (entry) => entry.id === accountId,
    );
    return account === undefined || account.freeBytes === null
      ? null
      : String(Math.max(0, account.freeBytes - account.reserveBytes));
  }

  reserveCapacity(input: SharedCapacityClaim): StorageAccount {
    if (
      !/^(?:0|[1-9][0-9]{0,29})$/.test(input.requiredBytes) ||
      BigInt(input.requiredBytes) > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new NoAccountCapacityError();
    if (
      input.ownerId.length === 0 ||
      !Number.isSafeInteger(input.generation ?? 0) ||
      (input.generation ?? 0) < 0
    )
      throw new Error('CAPACITY_OWNER_INVALID');
    return this.db
      .transaction(() => {
        const prior = this.db
          .prepare(
            `SELECT account_id AS accountId, reserved_bytes AS bytes, generation, write_started AS writeStarted
        FROM storage_capacity_reservations WHERE owner_kind = ? AND owner_id = ?`,
          )
          .get(input.ownerKind, input.ownerId) as
          | { accountId: string; bytes: string; generation: number; writeStarted: number }
          | undefined;
        if (
          prior !== undefined &&
          (prior.generation > (input.generation ?? 0) ||
            (input.accountId !== undefined && input.accountId !== prior.accountId))
        )
          throw new Error('CAPACITY_OWNER_CONFLICT');
        const required =
          prior?.writeStarted === 1
            ? Math.max(Number(prior.bytes), Number(input.requiredBytes))
            : Number(input.requiredBytes);
        const accountId = prior?.accountId ?? input.accountId;
        const candidates = this.adjustedAccounts(
          undefined,
          prior === undefined ? 'NEW_WORK' : 'EXISTING_WORK',
          input,
        ).filter((entry) => accountId === undefined || entry.id === accountId);
        const selected = selectAccount(candidates, required, this.now(), {
          excludeAccountIds: input.excludeAccountIds ?? [],
        });
        this.db
          .prepare(
            `INSERT INTO storage_capacity_reservations(owner_kind,owner_id,account_id,reserved_bytes,generation,state,created_at,updated_at)
        VALUES (?,?,?,?,?,'ACTIVE',?,?) ON CONFLICT(owner_kind,owner_id) DO UPDATE SET reserved_bytes=excluded.reserved_bytes,
        generation=excluded.generation,state='ACTIVE',settled_at=NULL,updated_at=excluded.updated_at`,
          )
          .run(
            input.ownerKind,
            input.ownerId,
            selected.id,
            String(required),
            input.generation ?? 0,
            this.now(),
            this.now(),
          );
        return toCapacityAccount(
          this.db
            .prepare('SELECT * FROM storage_accounts WHERE id=?')
            .get(selected.id) as AccountRow,
        );
      })
      .immediate();
  }

  beginCapacityWrite(kind: CapacityOwnerKind, id: string, generation?: number): void {
    const result = this.db
      .prepare(
        `UPDATE storage_capacity_reservations SET write_started=1,updated_at=?
      WHERE owner_kind=? AND owner_id=? AND state='ACTIVE' AND (? IS NULL OR generation=?)`,
      )
      .run(this.now(), kind, id, generation ?? null, generation ?? null);
    if (result.changes !== 1) throw new Error('CAPACITY_RESERVATION_REQUIRED');
  }

  releaseCapacity(kind: CapacityOwnerKind, id: string, generation?: number): void {
    this.db
      .transaction(() => {
        this.db
          .prepare(
            `DELETE FROM storage_capacity_reservations WHERE owner_kind=? AND owner_id=? AND write_started=0
        AND (? IS NULL OR generation=?)`,
          )
          .run(kind, id, generation ?? null, generation ?? null);
        // Release execution ownership immediately; retain a conservative quota debit
        // only for bytes that may have reached the provider, until a newer quota probe.
        this.db
          .prepare(
            `UPDATE storage_capacity_reservations SET state='SETTLED',settled_at=?,updated_at=?
        WHERE owner_kind=? AND owner_id=? AND state='ACTIVE' AND (? IS NULL OR generation=?)`,
          )
          .run(this.now(), this.now(), kind, id, generation ?? null, generation ?? null);
      })
      .immediate();
  }

  get(id: string): StorageAccount {
    const row = this.db.prepare(`SELECT * FROM storage_accounts WHERE id = ?`).get(id) as
      AccountRow | undefined;
    if (!row) throw new Error('ACCOUNT_NOT_FOUND');
    return toAccount(row);
  }

  getEligible(id: string, purpose: StorageEligibilityPurpose): StorageAccount {
    this.eligibility.require(id, purpose);
    return this.get(id);
  }

  list(): StorageAccount[] {
    const rows = this.db
      .prepare(`SELECT * FROM storage_accounts ORDER BY label ASC`)
      .all() as AccountRow[];
    return rows.map(toAccount);
  }

  listEligible(purpose: StorageEligibilityPurpose): StorageAccount[] {
    const eligibleIds = this.eligibility.eligibleAccountIds(purpose);
    return this.list().filter((account) => eligibleIds.has(account.id));
  }

  private adjustedAccounts(
    excludeReservationJobId?: string,
    purpose: StorageEligibilityPurpose = 'NEW_WORK',
    excludeClaim?: Pick<SharedCapacityClaim, 'ownerKind' | 'ownerId'>,
  ): StorageAccount[] {
    const reserved = new Map<string, number>();
    const explicit = this.db
      .prepare(
        `SELECT account_id AS accountId, reserved_bytes AS reservedBytes
         FROM offload_account_reservations
         WHERE @excludedJobId IS NULL OR job_id <> @excludedJobId`,
      )
      .all({ excludedJobId: excludeReservationJobId ?? null }) as CapacityReservationRow[];
    for (const row of explicit) addReservedBytes(reserved, row.accountId, row.reservedBytes);
    const shared = this.db
      .prepare(
        `SELECT account_id AS accountId, reserved_bytes AS reservedBytes FROM storage_capacity_reservations
      WHERE NOT (owner_kind = @kind AND owner_id = @id)`,
      )
      .all({ kind: excludeClaim?.ownerKind ?? '', id: excludeClaim?.ownerId ?? '' }) as Array<{
      accountId: string;
      reservedBytes: string;
    }>;
    for (const row of shared) addReservedBytes(reserved, row.accountId, Number(row.reservedBytes));

    // v22 selected jobs have no reservation row. Count their immutable manifest
    // until a later capacity probe has absorbed their terminal remote state. A
    // missing manifest fails closed by reserving the account's whole free claim.
    const legacy = this.db
      .prepare(
        `SELECT snapshot.selected_account_id AS accountId,
                CASE WHEN COUNT(file.job_id) = 0
                     THEN account.free_bytes
                     ELSE COALESCE(SUM(file.size), 0)
                END AS reservedBytes
         FROM offload_snapshots AS snapshot
         JOIN storage_accounts AS account ON account.id = snapshot.selected_account_id
         LEFT JOIN offload_account_reservations AS reservation
                ON reservation.job_id = snapshot.job_id
         LEFT JOIN offload_files AS file ON file.job_id = snapshot.job_id
         WHERE reservation.job_id IS NULL
           AND snapshot.selected_account_id IS NOT NULL
           AND (
             (
               snapshot.cancelled_at IS NULL
               AND snapshot.current_step NOT IN (${TERMINAL_OFFLOAD_STEPS})
             )
             OR (
               (snapshot.cancelled_at IS NOT NULL
                 OR snapshot.current_step IN (${TERMINAL_OFFLOAD_STEPS}))
               AND (
                 account.last_checked_at IS NULL
                 OR account.last_checked_at <= CASE
                   WHEN snapshot.cancelled_at IS NOT NULL THEN snapshot.cancelled_at
                   ELSE COALESCE(
                     (
                       SELECT MIN(event.created_at)
                       FROM job_events AS event
                       WHERE event.job_id = snapshot.job_id
                         AND event.event_type = 'OFFLOAD_CLOUD_COMMITTED'
                     ),
                     snapshot.updated_at
                   )
                 END
               )
             )
           )
         GROUP BY snapshot.job_id, snapshot.selected_account_id, account.free_bytes`,
      )
      .all() as CapacityReservationRow[];
    for (const row of legacy) addReservedBytes(reserved, row.accountId, row.reservedBytes);

    const eligibleIds = this.eligibility.eligibleAccountIds(purpose);
    const enabledAccounts = this.db
      .prepare(`SELECT * FROM storage_accounts WHERE enabled = 1 ORDER BY label ASC`)
      .all() as AccountRow[];
    return enabledAccounts
      .map(toCapacityAccount)
      .filter((account) => eligibleIds.has(account.id))
      .map((account) => {
        if (account.freeBytes === null) return account;
        return {
          ...account,
          freeBytes: Math.max(0, account.freeBytes - (reserved.get(account.id) ?? 0)),
        };
      });
  }
}

function addReservedBytes(target: Map<string, number>, accountId: string, value: number): void {
  const safeValue = Number.isSafeInteger(value) && value >= 0 ? value : Number.MAX_SAFE_INTEGER;
  const current = target.get(accountId) ?? 0;
  target.set(
    accountId,
    current > Number.MAX_SAFE_INTEGER - safeValue ? Number.MAX_SAFE_INTEGER : current + safeValue,
  );
}
