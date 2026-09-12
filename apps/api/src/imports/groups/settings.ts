import { createHash } from 'node:crypto';
import {
  GroupSettingsPatchSchema,
  GroupSettingsStatusSchema,
  GroupSettingsValuesSchema,
  type GroupSettingsPatch,
  type GroupSettingsStatus,
  type GroupSettingsValues,
} from '@ptvault/contracts';
import type { AppDatabase } from '../../db/database.js';
import { ImportControlError } from '../errors.js';
import type { GroupResourceScheduler } from './resources.js';

export const DEFAULT_GROUP_SETTINGS: GroupSettingsValues = {
  maxResidentGroups: 3,
  downloadConcurrency: 1,
  fileDownloadConnections: 5,
  extractionConcurrency: 1,
  uploadConcurrency: 1,
  waitingCacheMaxBytes: null,
};
type Row = { revision: number; values_json: string; updated_at: number };
type Options = {
  db: AppDatabase;
  residentBudgetBytes: () => string;
  provisioned: () => boolean;
  resources?: GroupResourceScheduler;
  now?: () => number;
  onApplied?: (status: GroupSettingsStatus) => void;
};
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** Group-only controls; legacy concurrency, creation intent and delete gates are untouched. */
export class GroupSettingsService {
  private readonly now: () => number;
  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    options.db
      .prepare(
        'INSERT OR IGNORE INTO import_pipeline_settings(singleton,revision,values_json,updated_at) VALUES(1,0,?,?)',
      )
      .run(JSON.stringify(DEFAULT_GROUP_SETTINGS), this.now());
    this.options.resources?.applyLimits(this.status().effective);
  }
  status(): GroupSettingsStatus {
    const row = this.options.db
      .prepare(
        'SELECT revision,values_json,updated_at FROM import_pipeline_settings WHERE singleton=1',
      )
      .get() as Row;
    const configured = GroupSettingsValuesSchema.parse(JSON.parse(row.values_json));
    const rawBudget = this.options.residentBudgetBytes();
    if (!/^(0|[1-9]\d{0,29})$/.test(rawBudget)) throw Error('GROUP_BUDGET_INVALID');
    const budget = BigInt(rawBudget);
    const cache =
      configured.waitingCacheMaxBytes === null
        ? min(64n * 1024n ** 3n, budget / 4n)
        : min(BigInt(configured.waitingCacheMaxBytes), budget);
    const effective = { ...configured, waitingCacheMaxBytes: cache.toString() };
    const empty = (capacity: number) => ({ active: 0, pending: 0, capacity });
    return GroupSettingsStatusSchema.parse({
      revision: row.revision,
      updatedAt: row.updated_at,
      provisioned: this.options.provisioned(),
      configured,
      effective,
      residentBudgetBytes: budget.toString(),
      resources: this.options.resources?.stats() ?? {
        inFlight: empty(effective.maxResidentGroups),
        download: empty(effective.downloadConcurrency),
        extraction: empty(effective.extractionConcurrency),
        upload: empty(effective.uploadConcurrency),
      },
    });
  }
  replay(adminId: string, key: string, input: GroupSettingsPatch): GroupSettingsStatus | null {
    const fingerprint = this.fingerprint(input);
    const db = this.options.db;
    db.prepare('DELETE FROM import_pipeline_settings_requests WHERE expires_at<=?').run(this.now());
    const row = db
      .prepare(
        'SELECT request_fingerprint,response_json FROM import_pipeline_settings_requests WHERE admin_id=? AND idempotency_key=?',
      )
      .get(adminId, key) as { request_fingerprint: string; response_json: string } | undefined;
    if (!row) return null;
    if (row.request_fingerprint !== fingerprint)
      throw new ImportControlError('GROUP_SETTINGS_IDEMPOTENCY_CONFLICT', 409);
    return GroupSettingsStatusSchema.parse(JSON.parse(row.response_json));
  }
  update(adminId: string, key: string, input: GroupSettingsPatch): GroupSettingsStatus {
    const parsed = GroupSettingsPatchSchema.safeParse(input);
    if (!parsed.success) throw new ImportControlError('GROUP_SETTINGS_INVALID', 400);
    const patch = parsed.data;
    const prior = this.replay(adminId, key, patch);
    if (prior) return prior;
    const result = this.options.db
      .transaction(() => {
        const current = this.status();
        if (current.revision !== patch.revision)
          throw new ImportControlError('GROUP_SETTINGS_REVISION_CONFLICT', 409);
        const values = GroupSettingsValuesSchema.safeParse({
          ...current.configured,
          ...patch.settings,
        });
        if (!values.success) throw new ImportControlError('GROUP_SETTINGS_INVALID', 400);
        this.options.db
          .prepare(
            'UPDATE import_pipeline_settings SET revision=revision+1,values_json=?,updated_at=?,updated_by_admin_id=? WHERE singleton=1',
          )
          .run(JSON.stringify(values.data), this.now(), adminId);
        const status = this.status();
        for (const [name, capacity] of Object.entries({
          inFlight: values.data.maxResidentGroups,
          download: values.data.downloadConcurrency,
          extraction: values.data.extractionConcurrency,
          upload: values.data.uploadConcurrency,
        }) as Array<[keyof GroupSettingsStatus['resources'], number]>)
          status.resources[name].capacity = capacity;
        this.options.db
          .prepare(
            'INSERT INTO import_pipeline_settings_requests(admin_id,idempotency_key,request_fingerprint,response_json,expires_at) VALUES(?,?,?,?,?)',
          )
          .run(
            adminId,
            key,
            this.fingerprint(patch),
            JSON.stringify(status),
            this.now() + 86400000,
          );
        return status;
      })
      .immediate();
    this.options.resources?.applyLimits(result.effective);
    try {
      this.options.onApplied?.(result);
    } catch {
      /* optional observation */
    }
    return result;
  }
  private fingerprint(input: GroupSettingsPatch): string {
    const parsed = GroupSettingsPatchSchema.safeParse(input);
    if (!parsed.success) throw new ImportControlError('GROUP_SETTINGS_INVALID', 400);
    return createHash('sha256')
      .update(JSON.stringify({ revision: parsed.data.revision, settings: parsed.data.settings }))
      .digest('hex');
  }
}
