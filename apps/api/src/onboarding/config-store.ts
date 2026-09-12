import { createHmac } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

import {
  SetupConfigViewSchema,
  SetupSecretPatchSchema,
  SetupValuesSchema,
  type SetupConfigView,
  type SetupConfigPatch,
  type SetupSecretPatch,
  type SetupValues,
} from '@ptvault/contracts';
import { z } from 'zod';

import { assertLoopbackHttpOrigin } from '../config/env.js';
import { SecretBox } from '../core/crypto.js';
import { isPathWithinRoot } from '../core/paths.js';
import { parsePathMaps } from '../qb/path-map.js';
import { ensurePrivateDirectory, readPrivateJson, writePrivateJson } from './private-files.js';

const SECRET_KEYS = ['jellyfinToken', 'baiduClientSecret', 'oneDriveClientSecret'] as const;
type SecretValues = Partial<Record<(typeof SECRET_KEYS)[number], string>>;
const SecretsSchema = z.object({
  // 4096 allowed Unicode characters can need much more than 8192 base64url bytes.
  jellyfinToken: z.string().max(32768).optional(),
  baiduClientSecret: z.string().max(8192).optional(),
  oneDriveClientSecret: z.string().max(8192).optional(),
}).strict();
const StoredValuesSchema = z.object({ values: SetupValuesSchema, secrets: SecretsSchema }).strict();
const DocumentSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  appliedRevision: z.number().int().nonnegative(),
  active: StoredValuesSchema,
  draft: StoredValuesSchema,
  lastError: z.literal('APPLY_FAILED').nullable(),
  lastRequest: z.object({ id: z.string().max(200), adminId: z.string().max(64), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict().nullable(),
}).strict();
type Document = z.infer<typeof DocumentSchema>;
export type SetupStageInput = { adminId: string; idempotencyKey: string; expectedRevision: number; values: SetupConfigPatch['values']; secrets?: SetupSecretPatch };

export class SetupConfigError extends Error {
  constructor(readonly code: string) { super(code); }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Resolve existing ancestors as well as the not-yet-created suffix. A lexical
// comparison alone misses symlink/junction aliases and Windows short names.
function canonicalFuturePath(filename: string): string {
  let ancestor = path.resolve(filename);
  const suffix: string[] = [];
  for (;;) {
    try { return path.join(realpathSync.native(ancestor), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new SetupConfigError('SETUP_PATH_INVALID');
      try {
        if (lstatSync(ancestor).isSymbolicLink()) throw new SetupConfigError('SETUP_PATH_INVALID');
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new SetupConfigError('SETUP_PATH_INVALID');
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

export class SetupConfigStore {
  readonly filename: string;
  private readonly directory: string;
  private readonly box: SecretBox;

  constructor(private readonly options: { stateDir: string; masterKey: Buffer }) {
    this.directory = path.join(path.resolve(options.stateDir), 'setup');
    this.filename = path.join(this.directory, 'configuration.json');
    this.box = new SecretBox(options.masterKey);
  }

  initialize(): SetupConfigView {
    ensurePrivateDirectory(this.directory);
    try {
      lstatSync(this.filename);
      return this.view();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const values: SetupValues = {
      useCases: [],
      spoolRoot: path.join(path.resolve(this.options.stateDir), 'spool'),
      sourceRoots: [],
      mediaHotRoot: null,
      jellyfinUrl: null,
      jellyfinPathMaps: [],
      recoveryAccountIds: [],
      baiduClient: 'DEFAULT',
      baiduClientId: null,
      baiduAppId: null,
      oneDriveClientId: null,
      oneDriveTenant: 'common',
      oauthCallbackOrigin: null,
    };
    writePrivateJson(this.filename, {
      version: 1, revision: 0, appliedRevision: 0,
      active: { values, secrets: {} }, draft: { values, secrets: {} },
      lastError: null, lastRequest: null,
    } satisfies Document);
    return this.view();
  }

  private read(): Document {
    ensurePrivateDirectory(this.directory);
    const parsed = DocumentSchema.safeParse(readPrivateJson(this.filename));
    if (!parsed.success || parsed.data.appliedRevision > parsed.data.revision) {
      throw new SetupConfigError('SETUP_FILE_INVALID');
    }
    return parsed.data;
  }

  private write(record: Document): void {
    const parsed = DocumentSchema.safeParse(record);
    if (!parsed.success) throw new SetupConfigError('SETUP_CONFIG_INVALID');
    writePrivateJson(this.filename, parsed.data);
  }

  private project(record: Document): SetupConfigView {
    return SetupConfigViewSchema.parse({
      revision: record.revision,
      appliedRevision: record.appliedRevision,
      values: record.draft.values,
      credentials: Object.fromEntries(SECRET_KEYS.map((key) => [key, record.draft.secrets[key] !== undefined])),
      pendingChanges: stableJson(record.active) !== stableJson(record.draft),
      lastError: record.lastError,
    });
  }

  view(): SetupConfigView { return this.project(this.read()); }

  private unpack(stored: Document['active']): { values: SetupValues; secrets: SecretValues } {
    const secrets: SecretValues = {};
    for (const key of SECRET_KEYS) {
      const sealed = stored.secrets[key];
      if (sealed !== undefined) secrets[key] = this.box.open(sealed);
    }
    return { values: stored.values, secrets };
  }

  active() { return this.unpack(this.read().active); }

  candidate(expectedRevision: number) {
    const record = this.read();
    if (record.revision !== expectedRevision) throw new SetupConfigError('SETUP_REVISION_CONFLICT');
    return this.unpack(record.draft);
  }

  private fingerprint(input: SetupStageInput): string {
    return createHmac('sha256', this.options.masterKey).update(stableJson({
      adminId: input.adminId, revision: input.expectedRevision,
      values: SetupValuesSchema.partial().parse(input.values),
      secrets: SetupSecretPatchSchema.parse(input.secrets ?? {}),
    })).digest('hex');
  }

  replay(input: SetupStageInput): SetupConfigView | null {
    const record = this.read();
    if (record.lastRequest?.id !== input.idempotencyKey) return null;
    if (record.lastRequest.adminId !== input.adminId || record.lastRequest.fingerprint !== this.fingerprint(input)) {
      throw new SetupConfigError('SETUP_IDEMPOTENCY_CONFLICT');
    }
    return this.project(record);
  }

  stage(input: SetupStageInput): SetupConfigView {
    const record = this.read();
    const patch = SetupValuesSchema.partial().parse(input.values);
    const secretPatch = SetupSecretPatchSchema.parse(input.secrets ?? {});
    const fingerprint = this.fingerprint(input);
    if (record.lastRequest?.id === input.idempotencyKey) {
      if (record.lastRequest.adminId !== input.adminId || record.lastRequest.fingerprint !== fingerprint) {
        throw new SetupConfigError('SETUP_IDEMPOTENCY_CONFLICT');
      }
      return this.project(record);
    }
    if (record.revision !== input.expectedRevision) throw new SetupConfigError('SETUP_REVISION_CONFLICT');
    const values = SetupValuesSchema.parse({ ...record.draft.values, ...patch });
    this.assertPaths(values);
    const secrets = { ...record.draft.secrets };
    for (const key of SECRET_KEYS) {
      const value = secretPatch[key];
      if (value === null) delete secrets[key];
      else if (value !== undefined && (secrets[key] === undefined || this.box.open(secrets[key]) !== value)) {
        secrets[key] = this.box.seal(value);
      }
    }
    record.draft = { values, secrets };
    record.revision += 1;
    record.lastRequest = { id: input.idempotencyKey, adminId: input.adminId, fingerprint };
    record.lastError = null;
    this.write(record);
    return this.project(record);
  }

  commitActivation(expectedRevision: number): SetupConfigView {
    const record = this.read();
    if (record.revision !== expectedRevision) throw new SetupConfigError('SETUP_REVISION_CONFLICT');
    record.active = record.draft;
    record.appliedRevision = record.revision;
    record.lastError = null;
    this.write(record);
    return this.project(record);
  }

  markActivationFailed(expectedRevision: number): void {
    const record = this.read();
    if (record.revision !== expectedRevision) throw new SetupConfigError('SETUP_REVISION_CONFLICT');
    record.lastError = 'APPLY_FAILED';
    this.write(record);
  }

  private assertPaths(values: SetupValues): void {
    const paths = [values.spoolRoot, ...values.sourceRoots, ...(values.mediaHotRoot === null ? [] : [values.mediaHotRoot])];
    if (paths.some((entry) => !path.isAbsolute(entry) || entry.includes(path.delimiter))) {
      throw new SetupConfigError('SETUP_PATH_INVALID');
    }
    if (values.jellyfinPathMaps.some((entry) => entry.includes(','))) throw new SetupConfigError('SETUP_PATH_INVALID');
    try { parsePathMaps(values.jellyfinPathMaps); } catch { throw new SetupConfigError('SETUP_PATH_INVALID'); }
    const overlaps = (left: string, right: string) => isPathWithinRoot(left, right) || isPathWithinRoot(right, left);
    const spool = canonicalFuturePath(values.spoolRoot);
    const state = canonicalFuturePath(this.options.stateDir);
    if (values.sourceRoots.some((root) => overlaps(canonicalFuturePath(root), spool) || overlaps(canonicalFuturePath(root), state))) {
      throw new SetupConfigError('SETUP_PATH_OVERLAP');
    }
    if (values.jellyfinUrl !== null) {
      try { assertLoopbackHttpOrigin(values.jellyfinUrl); } catch { throw new SetupConfigError('SETUP_JELLYFIN_URL_INVALID'); }
    }
    if (values.oauthCallbackOrigin !== null) {
      const url = new URL(values.oauthCallbackOrigin);
      if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
        throw new SetupConfigError('SETUP_CALLBACK_ORIGIN_INVALID');
      }
    }
  }
}
