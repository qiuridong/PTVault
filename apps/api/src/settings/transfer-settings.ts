import { createHash } from 'node:crypto';

import {
  OffloadTransferLimitsSchema,
  NetdiskTransferLimitsSchema,
  TransferSettingsStatusSchema,
  type NetdiskTransferLimits,
  type OffloadTransferLimits,
  type TransferResourceStats,
  type TransferSettingsPatch,
  type TransferSettingsStatus,
} from '@ptvault/contracts';

import type { AppMode } from '../config/env.js';
import type { AppDatabase } from '../db/database.js';

export const TRANSFER_SETTINGS_RECEIPT_TTL_MS = 24 * 60 * 60_000;

export type TransferSettingsRecord = {
  revision: number;
  updatedAt: number;
  updatedByAdminId: string | null;
  offload: OffloadTransferLimits;
  netdisk: NetdiskTransferLimits;
};

export type TransferSettingsDefaults = {
  offload: OffloadTransferLimits;
  netdisk: NetdiskTransferLimits;
};

type TransferSettingsRow = {
  revision: number;
  offloadCreationEnabled: number;
  offloadMaxInFlight: number;
  offloadPreflightConcurrency: number;
  offloadPauseSnapshotConcurrency: number;
  offloadMaxPausedPipelines: number;
  offloadHashConcurrency: number;
  offloadUploadConcurrency: number;
  offloadReadbackConcurrency: number;
  netdiskCreationEnabled: number;
  netdiskMaxInFlight: number;
  updatedAt: number;
  updatedByAdminId: string | null;
};

type ReceiptRow = {
  requestFingerprint: string;
  responseJson: string;
};

export class TransferSettingsError extends Error {
  constructor(
    readonly code:
      | 'TRANSFER_SETTINGS_REVISION_CONFLICT'
      | 'TRANSFER_SETTINGS_IDEMPOTENCY_CONFLICT'
      | 'TRANSFER_SETTINGS_INVALID_PROFILE'
      | 'OFFLOAD_RUNTIME_NOT_PROVISIONED'
      | 'NETDISK_RUNTIME_NOT_PROVISIONED'
      | 'NETDISK_SETTINGS_MOVED',
  ) {
    super(code);
    this.name = 'TransferSettingsError';
  }
}

function validateProfile(record: Pick<TransferSettingsRecord, 'offload' | 'netdisk'>): void {
  if (
    !OffloadTransferLimitsSchema.safeParse(record.offload).success ||
    !NetdiskTransferLimitsSchema.safeParse(record.netdisk).success
  ) {
    throw new TransferSettingsError('TRANSFER_SETTINGS_INVALID_PROFILE');
  }
}

function mapRow(row: TransferSettingsRow): TransferSettingsRecord {
  return {
    revision: row.revision,
    updatedAt: row.updatedAt,
    updatedByAdminId: row.updatedByAdminId,
    offload: {
      creationEnabled: row.offloadCreationEnabled === 1,
      maxInFlight: row.offloadMaxInFlight,
      preflightConcurrency: row.offloadPreflightConcurrency,
      pauseSnapshotConcurrency: row.offloadPauseSnapshotConcurrency,
      maxPausedPipelines: row.offloadMaxPausedPipelines,
      hashConcurrency: row.offloadHashConcurrency,
      uploadConcurrency: row.offloadUploadConcurrency,
      readbackConcurrency: row.offloadReadbackConcurrency,
    },
    netdisk: {
      creationEnabled: row.netdiskCreationEnabled === 1,
      maxInFlight: row.netdiskMaxInFlight,
    },
  };
}

function mergeDefined<T extends object>(
  current: T,
  patch: { [Key in keyof T]?: T[Key] | undefined } | undefined,
): T {
  const merged = { ...current };
  if (patch === undefined) return merged;
  for (const key of Object.keys(patch) as Array<keyof T>) {
    const value = patch[key];
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

export class TransferSettingsRepository {
  constructor(
    private readonly db: AppDatabase,
    defaults: TransferSettingsDefaults,
    private readonly now: () => number = () => Date.now(),
  ) {
    validateProfile(defaults);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO transfer_runtime_settings(
           singleton, revision,
           offload_creation_enabled, offload_max_in_flight,
           offload_preflight_concurrency, offload_pause_snapshot_concurrency,
           offload_max_paused_pipelines, offload_hash_concurrency,
           offload_upload_concurrency, offload_readback_concurrency,
           netdisk_creation_enabled, netdisk_max_in_flight,
           updated_at, updated_by_admin_id
         ) VALUES (
           1, 0,
           @offloadCreationEnabled, @offloadMaxInFlight,
           @offloadPreflightConcurrency, @offloadPauseSnapshotConcurrency,
           @offloadMaxPausedPipelines, @offloadHashConcurrency,
           @offloadUploadConcurrency, @offloadReadbackConcurrency,
           @netdiskCreationEnabled, @netdiskMaxInFlight,
           @updatedAt, NULL
         )`,
      )
      .run({
        offloadCreationEnabled: defaults.offload.creationEnabled ? 1 : 0,
        offloadMaxInFlight: defaults.offload.maxInFlight,
        offloadPreflightConcurrency: defaults.offload.preflightConcurrency,
        offloadPauseSnapshotConcurrency: defaults.offload.pauseSnapshotConcurrency,
        offloadMaxPausedPipelines: defaults.offload.maxPausedPipelines,
        offloadHashConcurrency: defaults.offload.hashConcurrency,
        offloadUploadConcurrency: defaults.offload.uploadConcurrency,
        offloadReadbackConcurrency: defaults.offload.readbackConcurrency,
        netdiskCreationEnabled: defaults.netdisk.creationEnabled ? 1 : 0,
        netdiskMaxInFlight: defaults.netdisk.maxInFlight,
        updatedAt: this.now(),
      });
  }

  read(): TransferSettingsRecord {
    const row = this.db
      .prepare(
        `SELECT revision,
                offload_creation_enabled AS offloadCreationEnabled,
                offload_max_in_flight AS offloadMaxInFlight,
                offload_preflight_concurrency AS offloadPreflightConcurrency,
                offload_pause_snapshot_concurrency AS offloadPauseSnapshotConcurrency,
                offload_max_paused_pipelines AS offloadMaxPausedPipelines,
                offload_hash_concurrency AS offloadHashConcurrency,
                offload_upload_concurrency AS offloadUploadConcurrency,
                offload_readback_concurrency AS offloadReadbackConcurrency,
                COALESCE(
                  (SELECT creation_enabled FROM netdisk_settings WHERE singleton = 1),
                  netdisk_creation_enabled
                ) AS netdiskCreationEnabled,
                COALESCE(
                  (SELECT max_in_flight FROM netdisk_settings WHERE singleton = 1),
                  netdisk_max_in_flight
                ) AS netdiskMaxInFlight,
                updated_at AS updatedAt,
                updated_by_admin_id AS updatedByAdminId
         FROM transfer_runtime_settings WHERE singleton = 1`,
      )
      .get() as TransferSettingsRow | undefined;
    if (!row) throw new Error('TRANSFER_SETTINGS_NOT_INITIALIZED');
    return mapRow(row);
  }

  replay(idempotencyKey: string, requestFingerprint: string): TransferSettingsStatus | null {
    const now = this.now();
    this.db.prepare('DELETE FROM transfer_settings_requests WHERE expires_at <= ?').run(now);
    const row = this.db
      .prepare(
        `SELECT request_fingerprint AS requestFingerprint, response_json AS responseJson
         FROM transfer_settings_requests WHERE idempotency_key = ?`,
      )
      .get(idempotencyKey) as ReceiptRow | undefined;
    if (!row) return null;
    if (row.requestFingerprint !== requestFingerprint) {
      throw new TransferSettingsError('TRANSFER_SETTINGS_IDEMPOTENCY_CONFLICT');
    }
    return TransferSettingsStatusSchema.parse(JSON.parse(row.responseJson));
  }

  updateWithReceipt(input: {
    idempotencyKey: string;
    requestFingerprint: string;
    expectedRevision: number;
    patch: Pick<TransferSettingsPatch, 'offload' | 'netdisk'>;
    adminId: string;
    response: (record: TransferSettingsRecord) => TransferSettingsStatus;
  }): { record: TransferSettingsRecord; response: TransferSettingsStatus } {
    // Netdisk settings moved to /api/netdisk/settings.  Keeping the columns in
    // v22 is a read-only compatibility projection; writing both authorities is
    // deliberately forbidden.
    if (input.patch.netdisk !== undefined) {
      throw new TransferSettingsError('NETDISK_SETTINGS_MOVED');
    }
    return this.db
      .transaction(() => {
        const replayed = this.replay(input.idempotencyKey, input.requestFingerprint);
        if (replayed) return { record: this.read(), response: replayed };

        const current = this.read();
        if (current.revision !== input.expectedRevision) {
          throw new TransferSettingsError('TRANSFER_SETTINGS_REVISION_CONFLICT');
        }
        const next: TransferSettingsRecord = {
          revision: current.revision + 1,
          updatedAt: this.now(),
          updatedByAdminId: input.adminId,
          offload: mergeDefined(current.offload, input.patch.offload),
          netdisk: current.netdisk,
        };
        validateProfile(next);

        const result = this.db
          .prepare(
            `UPDATE transfer_runtime_settings SET
             revision = @revision,
             offload_creation_enabled = @offloadCreationEnabled,
             offload_max_in_flight = @offloadMaxInFlight,
             offload_preflight_concurrency = @offloadPreflightConcurrency,
             offload_pause_snapshot_concurrency = @offloadPauseSnapshotConcurrency,
             offload_max_paused_pipelines = @offloadMaxPausedPipelines,
             offload_hash_concurrency = @offloadHashConcurrency,
             offload_upload_concurrency = @offloadUploadConcurrency,
             offload_readback_concurrency = @offloadReadbackConcurrency,
             updated_at = @updatedAt,
             updated_by_admin_id = @updatedByAdminId
           WHERE singleton = 1 AND revision = @expectedRevision`,
          )
          .run({
            revision: next.revision,
            expectedRevision: current.revision,
            offloadCreationEnabled: next.offload.creationEnabled ? 1 : 0,
            offloadMaxInFlight: next.offload.maxInFlight,
            offloadPreflightConcurrency: next.offload.preflightConcurrency,
            offloadPauseSnapshotConcurrency: next.offload.pauseSnapshotConcurrency,
            offloadMaxPausedPipelines: next.offload.maxPausedPipelines,
            offloadHashConcurrency: next.offload.hashConcurrency,
            offloadUploadConcurrency: next.offload.uploadConcurrency,
            offloadReadbackConcurrency: next.offload.readbackConcurrency,
            updatedAt: next.updatedAt,
            updatedByAdminId: next.updatedByAdminId,
          });
        if (result.changes !== 1) {
          throw new TransferSettingsError('TRANSFER_SETTINGS_REVISION_CONFLICT');
        }

        const response = TransferSettingsStatusSchema.parse(input.response(next));
        this.db
          .prepare(
            `INSERT INTO transfer_settings_requests(
             idempotency_key, request_fingerprint, response_json, created_at, expires_at
           ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            input.idempotencyKey,
            input.requestFingerprint,
            JSON.stringify(response),
            next.updatedAt,
            next.updatedAt + TRANSFER_SETTINGS_RECEIPT_TTL_MS,
          );
        return { record: next, response };
      })
      .immediate();
  }
}

export type TransferSettingsActivity = {
  offloadActiveHandlers: () => number;
  offloadResources: () => {
    preflight: TransferResourceStats;
    pauseSnapshot: TransferResourceStats;
    hash: TransferResourceStats;
    upload: TransferResourceStats;
    readback: TransferResourceStats;
    remoteHeavy?: TransferResourceStats;
  };
  netdiskActiveJobs: () => number;
};

export type TransferSettingsProvision = {
  mode: AppMode;
  offloadRuntimeConfigured: boolean;
  offloadParallelEnabled: boolean;
  netdiskRuntimeConfigured: boolean;
};

const EMPTY_RESOURCE: TransferResourceStats = { active: 0, pending: 0, capacity: 1 };

export class TransferSettingsService {
  constructor(
    readonly repository: TransferSettingsRepository,
    private readonly provision: TransferSettingsProvision,
    private readonly activity: Partial<TransferSettingsActivity> = {},
    private readonly onApplied: (record: TransferSettingsRecord) => void = () => undefined,
  ) {
    this.onApplied(this.repository.read());
  }

  currentRecord(): TransferSettingsRecord {
    return this.repository.read();
  }

  status(
    record = this.repository.read(),
    projectAppliedCapacities = false,
  ): TransferSettingsStatus {
    const offloadReason =
      this.provision.mode !== 'ACTIVE'
        ? 'MODE_NOT_ACTIVE'
        : !this.provision.offloadRuntimeConfigured
          ? 'RUNTIME_NOT_CONFIGURED'
          : !this.provision.offloadParallelEnabled
            ? 'PARALLEL_RUNTIME_DISABLED'
            : 'READY';
    const netdiskReason =
      this.provision.mode !== 'ACTIVE'
        ? 'MODE_NOT_ACTIVE'
        : this.provision.netdiskRuntimeConfigured
          ? 'READY'
          : 'RUNTIME_NOT_CONFIGURED';
    const resources = this.activity.offloadResources?.() ?? {
      preflight: EMPTY_RESOURCE,
      pauseSnapshot: EMPTY_RESOURCE,
      hash: EMPTY_RESOURCE,
      upload: EMPTY_RESOURCE,
      readback: EMPTY_RESOURCE,
    };
    const reportedResources =
      projectAppliedCapacities && !this.provision.offloadParallelEnabled
        ? {
            preflight: { ...resources.preflight, capacity: 1 },
            pauseSnapshot: { ...resources.pauseSnapshot, capacity: 1 },
            hash: { ...resources.hash, capacity: 1 },
            upload: { ...resources.upload, capacity: 1 },
            readback: { ...resources.readback, capacity: 1 },
            ...(resources.remoteHeavy === undefined
              ? {}
              : { remoteHeavy: { ...resources.remoteHeavy, capacity: 1 } }),
          }
        : projectAppliedCapacities
          ? {
              preflight: {
                ...resources.preflight,
                capacity: record.offload.preflightConcurrency,
              },
              pauseSnapshot: {
                ...resources.pauseSnapshot,
                capacity: record.offload.pauseSnapshotConcurrency,
              },
              hash: { ...resources.hash, capacity: record.offload.hashConcurrency },
              upload: { ...resources.upload, capacity: record.offload.uploadConcurrency },
              readback: { ...resources.readback, capacity: record.offload.readbackConcurrency },
              ...(resources.remoteHeavy === undefined
                ? {}
                : {
                    remoteHeavy: {
                      ...resources.remoteHeavy,
                      capacity: Math.max(
                        record.offload.uploadConcurrency,
                        record.offload.readbackConcurrency,
                      ),
                    },
                  }),
            }
          : resources;
    return TransferSettingsStatusSchema.parse({
      revision: record.revision,
      updatedAt: record.updatedAt,
      offload: {
        provisioned: offloadReason === 'READY',
        provisionReason: offloadReason,
        configured: record.offload,
        effective: {
          ...record.offload,
          // The parallel rollout flag does not disable the established serial
          // offload path. It only makes the configured concurrency profile
          // unavailable, which is reported separately by provisionReason.
          creationEnabled:
            this.provision.mode === 'ACTIVE' &&
            this.provision.offloadRuntimeConfigured &&
            record.offload.creationEnabled,
        },
        activity: {
          activeHandlers: this.activity.offloadActiveHandlers?.() ?? 0,
          resources: reportedResources,
        },
      },
      netdisk: {
        provisioned: netdiskReason === 'READY',
        provisionReason: netdiskReason,
        configured: record.netdisk,
        effective: {
          ...record.netdisk,
          creationEnabled: netdiskReason === 'READY' && record.netdisk.creationEnabled,
        },
        activity: { activeJobs: this.activity.netdiskActiveJobs?.() ?? 0 },
      },
    });
  }

  fingerprint(patch: TransferSettingsPatch): string {
    return createHash('sha256')
      .update(
        stableJson({
          revision: patch.revision,
          offload: patch.offload ?? null,
          netdisk: patch.netdisk ?? null,
        }),
      )
      .digest('hex');
  }

  replay(idempotencyKey: string, patch: TransferSettingsPatch): TransferSettingsStatus | null {
    return this.repository.replay(idempotencyKey, this.fingerprint(patch));
  }

  update(input: {
    idempotencyKey: string;
    patch: TransferSettingsPatch;
    adminId: string;
  }): TransferSettingsStatus {
    if (input.patch.netdisk !== undefined) {
      throw new TransferSettingsError('NETDISK_SETTINGS_MOVED');
    }
    const replayed = this.replay(input.idempotencyKey, input.patch);
    if (replayed !== null) return replayed;
    const current = this.repository.read();
    if (
      input.patch.offload?.creationEnabled === true &&
      !current.offload.creationEnabled &&
      (this.provision.mode !== 'ACTIVE' || !this.provision.offloadRuntimeConfigured)
    ) {
      throw new TransferSettingsError('OFFLOAD_RUNTIME_NOT_PROVISIONED');
    }
    const result = this.repository.updateWithReceipt({
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: this.fingerprint(input.patch),
      expectedRevision: input.patch.revision,
      patch: {
        ...(input.patch.offload === undefined ? {} : { offload: input.patch.offload }),
      },
      adminId: input.adminId,
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
