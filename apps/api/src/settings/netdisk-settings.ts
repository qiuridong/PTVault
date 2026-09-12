import { createHash } from 'node:crypto';

import {
  NetdiskSettingsStatusSchema,
  NetdiskSettingsValuesSchema,
  type NetdiskSettingsPatch,
  type NetdiskSettingsStatus,
  type NetdiskSettingsValues,
  type TransferResourceStats,
} from '@ptvault/contracts';

import type { AppMode } from '../config/env.js';
import type { AppDatabase } from '../db/database.js';

export const NETDISK_SETTINGS_RECEIPT_TTL_MS = 24 * 60 * 60_000;

export type NetdiskSettingsRecord = {
  revision: number;
  updatedAt: number;
  updatedByAdminId: string | null;
  values: NetdiskSettingsValues;
};

export type NetdiskSettingsDefaults = NetdiskSettingsValues;

type NetdiskSettingsRow = {
  revision: number;
  creationEnabled: number;
  maxInFlight: number;
  localPreparationConcurrency: number;
  uploadConcurrency: number;
  spoolMaxBytes: string;
  spoolReserveBytes: string;
  defaultSourceConnectionId: string | null;
  defaultDestinationAccountId: string | null;
  defaultPublicationPolicy: NetdiskSettingsValues['defaultPublicationPolicy'];
  sourceStagingCleanupEnabled: number;
  sourceDeleteEnabled: number;
  sourceDeleteGraceSeconds: number;
  updatedAt: number;
  updatedByAdminId: string | null;
};

type ReceiptRow = {
  requestFingerprint: string;
  responseJson: string;
};

type LegacySeedRow = {
  creationEnabled: number;
  maxInFlight: number;
  updatedAt: number;
  updatedByAdminId: string | null;
};

export class NetdiskSettingsError extends Error {
  constructor(
    readonly code:
      | 'NETDISK_SETTINGS_REVISION_CONFLICT'
      | 'NETDISK_SETTINGS_IDEMPOTENCY_CONFLICT'
      | 'NETDISK_SETTINGS_INVALID_PROFILE'
      | 'NETDISK_DEFAULT_SOURCE_INVALID'
      | 'NETDISK_DEFAULT_DESTINATION_INVALID',
  ) {
    super(code);
    this.name = 'NetdiskSettingsError';
  }
}

function validateValues(values: NetdiskSettingsValues): NetdiskSettingsValues {
  const parsed = NetdiskSettingsValuesSchema.safeParse(values);
  if (!parsed.success) throw new NetdiskSettingsError('NETDISK_SETTINGS_INVALID_PROFILE');
  return parsed.data;
}

function mapRow(row: NetdiskSettingsRow): NetdiskSettingsRecord {
  return {
    revision: row.revision,
    updatedAt: row.updatedAt,
    updatedByAdminId: row.updatedByAdminId,
    values: validateValues({
      creationEnabled: row.creationEnabled === 1,
      maxInFlight: row.maxInFlight,
      localPreparationConcurrency: row.localPreparationConcurrency,
      uploadConcurrency: row.uploadConcurrency,
      spoolMaxBytes: row.spoolMaxBytes,
      spoolReserveBytes: row.spoolReserveBytes,
      defaultSourceConnectionId: row.defaultSourceConnectionId,
      defaultDestinationAccountId: row.defaultDestinationAccountId,
      defaultPublicationPolicy: row.defaultPublicationPolicy,
      sourceStagingCleanupEnabled: row.sourceStagingCleanupEnabled === 1,
      sourceDeleteEnabled: row.sourceDeleteEnabled === 1,
      sourceDeleteGraceSeconds: row.sourceDeleteGraceSeconds,
    }),
  };
}

function mergeDefined<T extends object>(
  current: T,
  patch: { [Key in keyof T]?: T[Key] | undefined },
): T {
  const merged = { ...current };
  for (const key of Object.keys(patch) as Array<keyof T>) {
    const value = patch[key];
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

export class NetdiskSettingsRepository {
  constructor(
    private readonly db: AppDatabase,
    defaults: NetdiskSettingsDefaults,
    private readonly now: () => number = () => Date.now(),
  ) {
    const validated = validateValues(defaults);
    const legacy = this.db
      .prepare(
        `SELECT netdisk_creation_enabled AS creationEnabled,
                netdisk_max_in_flight AS maxInFlight,
                updated_at AS updatedAt,
                updated_by_admin_id AS updatedByAdminId
         FROM transfer_runtime_settings WHERE singleton = 1`,
      )
      .get() as LegacySeedRow | undefined;
    const creationEnabled =
      legacy?.creationEnabled === undefined
        ? validated.creationEnabled
        : legacy.creationEnabled === 1;
    const maxInFlight = legacy?.maxInFlight ?? validated.maxInFlight;
    const localPreparationConcurrency = Math.min(
      validated.localPreparationConcurrency,
      maxInFlight,
    );
    this.db
      .prepare(
        `INSERT OR IGNORE INTO netdisk_settings(
           singleton, revision, creation_enabled, max_in_flight,
           local_preparation_concurrency, upload_concurrency,
           spool_max_bytes, spool_reserve_bytes,
           default_source_connection_id, default_destination_account_id,
           default_publication_policy, source_staging_cleanup_enabled,
           source_delete_enabled, source_delete_grace_seconds,
           updated_at, updated_by_admin_id
         ) VALUES (
           1, 0, @creationEnabled, @maxInFlight,
           @localPreparationConcurrency, @uploadConcurrency,
           @spoolMaxBytes, @spoolReserveBytes,
           @defaultSourceConnectionId, @defaultDestinationAccountId,
           @defaultPublicationPolicy, @sourceStagingCleanupEnabled,
           @sourceDeleteEnabled, @sourceDeleteGraceSeconds,
           @updatedAt, @updatedByAdminId
         )`,
      )
      .run({
        creationEnabled: creationEnabled ? 1 : 0,
        maxInFlight,
        localPreparationConcurrency,
        uploadConcurrency: validated.uploadConcurrency,
        spoolMaxBytes: validated.spoolMaxBytes,
        spoolReserveBytes: validated.spoolReserveBytes,
        defaultSourceConnectionId: validated.defaultSourceConnectionId,
        defaultDestinationAccountId: validated.defaultDestinationAccountId,
        defaultPublicationPolicy: validated.defaultPublicationPolicy,
        sourceStagingCleanupEnabled: validated.sourceStagingCleanupEnabled ? 1 : 0,
        sourceDeleteEnabled: validated.sourceDeleteEnabled ? 1 : 0,
        sourceDeleteGraceSeconds: validated.sourceDeleteGraceSeconds,
        updatedAt: legacy?.updatedAt ?? this.now(),
        updatedByAdminId: legacy?.updatedByAdminId ?? null,
      });
  }

  read(): NetdiskSettingsRecord {
    const row = this.db
      .prepare(
        `SELECT revision, creation_enabled AS creationEnabled,
                max_in_flight AS maxInFlight,
                local_preparation_concurrency AS localPreparationConcurrency,
                upload_concurrency AS uploadConcurrency,
                spool_max_bytes AS spoolMaxBytes,
                spool_reserve_bytes AS spoolReserveBytes,
                default_source_connection_id AS defaultSourceConnectionId,
                default_destination_account_id AS defaultDestinationAccountId,
                default_publication_policy AS defaultPublicationPolicy,
                source_staging_cleanup_enabled AS sourceStagingCleanupEnabled,
                source_delete_enabled AS sourceDeleteEnabled,
                source_delete_grace_seconds AS sourceDeleteGraceSeconds,
                updated_at AS updatedAt,
                updated_by_admin_id AS updatedByAdminId
         FROM netdisk_settings WHERE singleton = 1`,
      )
      .get() as NetdiskSettingsRow | undefined;
    if (row === undefined) throw new Error('NETDISK_SETTINGS_NOT_INITIALIZED');
    return mapRow(row);
  }

  replay(
    adminId: string,
    idempotencyKey: string,
    requestFingerprint: string,
  ): NetdiskSettingsStatus | null {
    const now = this.now();
    this.db.prepare('DELETE FROM netdisk_settings_requests WHERE expires_at <= ?').run(now);
    const row = this.db
      .prepare(
        `SELECT request_fingerprint AS requestFingerprint, response_json AS responseJson
         FROM netdisk_settings_requests
         WHERE admin_id = ? AND idempotency_key = ?`,
      )
      .get(adminId, idempotencyKey) as ReceiptRow | undefined;
    if (row === undefined) return null;
    if (row.requestFingerprint !== requestFingerprint) {
      throw new NetdiskSettingsError('NETDISK_SETTINGS_IDEMPOTENCY_CONFLICT');
    }
    return NetdiskSettingsStatusSchema.parse(JSON.parse(row.responseJson));
  }

  updateWithReceipt(input: {
    adminId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    expectedRevision: number;
    patch: NetdiskSettingsPatch['settings'];
    response: (record: NetdiskSettingsRecord) => NetdiskSettingsStatus;
  }): { record: NetdiskSettingsRecord; response: NetdiskSettingsStatus } {
    return this.db
      .transaction(() => {
        const replayed = this.replay(input.adminId, input.idempotencyKey, input.requestFingerprint);
        if (replayed !== null) return { record: this.read(), response: replayed };

        const current = this.read();
        if (current.revision !== input.expectedRevision) {
          throw new NetdiskSettingsError('NETDISK_SETTINGS_REVISION_CONFLICT');
        }
        const values = validateValues(mergeDefined(current.values, input.patch));
        this.validateReferences(values);
        const next: NetdiskSettingsRecord = {
          revision: current.revision + 1,
          updatedAt: this.now(),
          updatedByAdminId: input.adminId,
          values,
        };
        const changed = this.db
          .prepare(
            `UPDATE netdisk_settings SET
               revision = @revision,
               creation_enabled = @creationEnabled,
               max_in_flight = @maxInFlight,
               local_preparation_concurrency = @localPreparationConcurrency,
               upload_concurrency = @uploadConcurrency,
               spool_max_bytes = @spoolMaxBytes,
               spool_reserve_bytes = @spoolReserveBytes,
               default_source_connection_id = @defaultSourceConnectionId,
               default_destination_account_id = @defaultDestinationAccountId,
               default_publication_policy = @defaultPublicationPolicy,
               source_staging_cleanup_enabled = @sourceStagingCleanupEnabled,
               source_delete_enabled = @sourceDeleteEnabled,
               source_delete_grace_seconds = @sourceDeleteGraceSeconds,
               updated_at = @updatedAt,
               updated_by_admin_id = @updatedByAdminId
             WHERE singleton = 1 AND revision = @expectedRevision`,
          )
          .run({
            revision: next.revision,
            expectedRevision: current.revision,
            creationEnabled: values.creationEnabled ? 1 : 0,
            maxInFlight: values.maxInFlight,
            localPreparationConcurrency: values.localPreparationConcurrency,
            uploadConcurrency: values.uploadConcurrency,
            spoolMaxBytes: values.spoolMaxBytes,
            spoolReserveBytes: values.spoolReserveBytes,
            defaultSourceConnectionId: values.defaultSourceConnectionId,
            defaultDestinationAccountId: values.defaultDestinationAccountId,
            defaultPublicationPolicy: values.defaultPublicationPolicy,
            sourceStagingCleanupEnabled: values.sourceStagingCleanupEnabled ? 1 : 0,
            sourceDeleteEnabled: values.sourceDeleteEnabled ? 1 : 0,
            sourceDeleteGraceSeconds: values.sourceDeleteGraceSeconds,
            updatedAt: next.updatedAt,
            updatedByAdminId: next.updatedByAdminId,
          });
        if (changed.changes !== 1) {
          throw new NetdiskSettingsError('NETDISK_SETTINGS_REVISION_CONFLICT');
        }

        const response = NetdiskSettingsStatusSchema.parse(input.response(next));
        this.db
          .prepare(
            `INSERT INTO netdisk_settings_requests(
               admin_id, idempotency_key, request_fingerprint,
               response_json, created_at, expires_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.adminId,
            input.idempotencyKey,
            input.requestFingerprint,
            JSON.stringify(response),
            next.updatedAt,
            next.updatedAt + NETDISK_SETTINGS_RECEIPT_TTL_MS,
          );
        return { record: next, response };
      })
      .immediate();
  }

  activeJobs(): number {
    return Number(
      this.db.prepare("SELECT COUNT(*) FROM import_jobs WHERE state = 'RUNNING'").pluck().get() ??
        0,
    );
  }

  waitingJobs(): number {
    return Number(
      this.db
        .prepare('SELECT COUNT(*) FROM import_jobs WHERE resource_wait_kind IS NOT NULL')
        .pluck()
        .get() ?? 0,
    );
  }

  reservedSpoolBytes(): string {
    const rows = this.db
      .prepare('SELECT reserved_bytes AS reservedBytes FROM import_spool_reservations')
      .all() as Array<{ reservedBytes: string }>;
    return rows.reduce((sum, row) => sum + BigInt(row.reservedBytes), 0n).toString();
  }

  private validateReferences(values: NetdiskSettingsValues): void {
    if (values.defaultSourceConnectionId !== null) {
      const source = this.db
        .prepare("SELECT 1 FROM cloud_connections WHERE id = ? AND provider = 'BAIDU'")
        .get(values.defaultSourceConnectionId);
      if (source === undefined) {
        throw new NetdiskSettingsError('NETDISK_DEFAULT_SOURCE_INVALID');
      }
    }
    if (values.defaultDestinationAccountId !== null) {
      const destination = this.db
        .prepare('SELECT 1 FROM storage_accounts WHERE id = ?')
        .get(values.defaultDestinationAccountId);
      if (destination === undefined) {
        throw new NetdiskSettingsError('NETDISK_DEFAULT_DESTINATION_INVALID');
      }
    }
  }
}

export type NetdiskSettingsProvision = {
  mode: AppMode;
  runtimeConfigured: boolean;
  runtimeMissing?: NetdiskSettingsStatus['runtimeMissing'];
  sourceStagingCleanupExecutorConfigured?: boolean;
  sourceDeleteExecutorConfigured?: boolean;
};

export type NetdiskSettingsActivity = {
  activeJobs: () => number;
  waitingJobs: () => number;
  resources: () => {
    maxInFlight: TransferResourceStats;
    localPreparation: TransferResourceStats;
    upload: TransferResourceStats;
  };
  reservedSpoolBytes: () => string;
};

const EMPTY_RESOURCE: TransferResourceStats = { active: 0, pending: 0, capacity: 1 };

export class NetdiskSettingsService {
  constructor(
    readonly repository: NetdiskSettingsRepository,
    private readonly provision: NetdiskSettingsProvision,
    private readonly activity: Partial<NetdiskSettingsActivity> = {},
    private readonly onApplied: (record: NetdiskSettingsRecord) => void = () => undefined,
  ) {
    this.onApplied(this.repository.read());
  }

  currentRecord(): NetdiskSettingsRecord {
    return this.repository.read();
  }

  status(record = this.repository.read(), projectAppliedCapacities = false): NetdiskSettingsStatus {
    const provisionReason =
      this.provision.mode !== 'ACTIVE'
        ? 'MODE_NOT_ACTIVE'
        : this.provision.runtimeConfigured
          ? 'READY'
          : 'RUNTIME_NOT_CONFIGURED';
    const configured = record.values;
    const effective: NetdiskSettingsValues = {
      ...configured,
      creationEnabled: provisionReason === 'READY' && configured.creationEnabled,
      sourceStagingCleanupEnabled:
        provisionReason === 'READY' &&
        this.provision.sourceStagingCleanupExecutorConfigured === true &&
        configured.sourceStagingCleanupEnabled,
      sourceDeleteEnabled:
        provisionReason === 'READY' &&
        this.provision.sourceDeleteExecutorConfigured === true &&
        configured.sourceDeleteEnabled,
    };
    const clamps: NetdiskSettingsStatus['clamps'] = [];
    if (configured.creationEnabled && !effective.creationEnabled) {
      clamps.push({
        field: 'creationEnabled',
        reason: provisionReason === 'MODE_NOT_ACTIVE' ? 'MODE_NOT_ACTIVE' : 'RUNTIME_UNPROVISIONED',
      });
    }
    if (configured.sourceStagingCleanupEnabled && !effective.sourceStagingCleanupEnabled) {
      clamps.push({ field: 'sourceStagingCleanupEnabled', reason: 'EXECUTOR_UNSUPPORTED' });
    }
    if (configured.sourceDeleteEnabled && !effective.sourceDeleteEnabled) {
      clamps.push({ field: 'sourceDeleteEnabled', reason: 'EXECUTOR_UNSUPPORTED' });
    }

    const observed = this.activity.resources?.() ?? {
      maxInFlight: EMPTY_RESOURCE,
      localPreparation: EMPTY_RESOURCE,
      upload: EMPTY_RESOURCE,
    };
    const resources = projectAppliedCapacities
      ? {
          maxInFlight: { ...observed.maxInFlight, capacity: configured.maxInFlight },
          localPreparation: {
            ...observed.localPreparation,
            capacity: configured.localPreparationConcurrency,
          },
          upload: { ...observed.upload, capacity: configured.uploadConcurrency },
        }
      : observed;
    const reservedBytes =
      this.activity.reservedSpoolBytes?.() ?? this.repository.reservedSpoolBytes();
    const usable = BigInt(configured.spoolMaxBytes) - BigInt(configured.spoolReserveBytes);
    const available = usable > BigInt(reservedBytes) ? usable - BigInt(reservedBytes) : 0n;

    return NetdiskSettingsStatusSchema.parse({
      revision: record.revision,
      updatedAt: record.updatedAt,
      provisioned: provisionReason === 'READY',
      provisionReason,
      ...(this.provision.runtimeMissing ? { runtimeMissing: this.provision.runtimeMissing } : {}),
      configured,
      effective,
      clamps,
      activity: {
        activeJobs: this.activity.activeJobs?.() ?? this.repository.activeJobs(),
        waitingJobs: this.activity.waitingJobs?.() ?? this.repository.waitingJobs(),
        resources,
        spool: {
          reservedBytes,
          maxBytes: configured.spoolMaxBytes,
          reserveBytes: configured.spoolReserveBytes,
          availableBytes: available.toString(),
        },
      },
    });
  }

  fingerprint(patch: NetdiskSettingsPatch): string {
    return createHash('sha256')
      .update(stableJson({ revision: patch.revision, settings: patch.settings }))
      .digest('hex');
  }

  replay(
    adminId: string,
    idempotencyKey: string,
    patch: NetdiskSettingsPatch,
  ): NetdiskSettingsStatus | null {
    return this.repository.replay(adminId, idempotencyKey, this.fingerprint(patch));
  }

  update(input: {
    adminId: string;
    idempotencyKey: string;
    patch: NetdiskSettingsPatch;
  }): NetdiskSettingsStatus {
    const replayed = this.replay(input.adminId, input.idempotencyKey, input.patch);
    if (replayed !== null) return replayed;
    const result = this.repository.updateWithReceipt({
      adminId: input.adminId,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: this.fingerprint(input.patch),
      expectedRevision: input.patch.revision,
      patch: input.patch.settings,
      response: (record) => this.status(record, true),
    });
    this.onApplied(result.record);
    return result.response;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
