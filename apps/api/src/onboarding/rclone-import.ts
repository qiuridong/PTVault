import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import {
  RcloneImportResultSchema,
  type RcloneImportPending,
  type RcloneImportPreview,
  type RcloneImportResult,
} from '@ptvault/contracts';
import { z } from 'zod';
import {
  CloudConnectionOperationReceiptRepository,
  fingerprintCloudConnectionOperation,
} from '../cloud-connections/idempotency.js';
import type { AppDatabase } from '../db/database.js';
import { StorageAccountRepository } from '../storage/accounts.js';
import { classifyHealth, type QuotaSnapshot } from '../storage/health.js';
import {
  configDigest,
  MAX_RCLONE_CONFIG_BYTES,
  parseRcloneConfig,
  prepareRcloneConfigSwap,
  readRcloneConfig,
  sectionIdentity,
  syncConfigDirectory,
  withRcloneConfigLock,
  type RcloneSections,
} from '../storage/rclone-config-files.js';
import {
  ensurePrivateDirectory,
  readPrivateJson,
  readPrivateText,
  writePrivateJson,
  writePrivateText,
} from './private-files.js';
import {
  inspectRcloneImportSource,
  RcloneImportError,
  renderRcloneSections,
  selectRcloneImportSections,
  type RcloneImportSource,
} from './rclone-import-source.js';

type Input = { adminId: string; idempotencyKey: string; previewId: string; pairIds: string[] };
const Quota = z
  .object({
    total: z.number().int().nonnegative().safe().nullable(),
    free: z.number().int().nonnegative().safe().nullable(),
  })
  .strict();
const Journal = z
  .object({
    version: z.literal(1),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    intent: z
      .object({
        adminId: z.string().min(1).max(128),
        idempotencyKey: z.string().min(8).max(128),
        previewId: z.string().uuid(),
        pairIds: z.array(z.string().min(1).max(128)).min(1).max(2),
      })
      .strict(),
    identities: z.record(z.string().regex(/^[a-f0-9]{64}$/)),
    accounts: z
      .array(
        z
          .object({ rawName: z.string(), cryptName: z.string(), label: z.string().max(128) })
          .strict(),
      )
      .min(1)
      .max(2),
    verified: z
      .object({
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        quotas: z.array(Quota).min(1).max(2),
        checkedAt: z.number().int(),
      })
      .strict()
      .nullable(),
  })
  .strict();
type JournalData = z.infer<typeof Journal>;
type Options = {
  db: AppDatabase;
  stateDir: string;
  configPath: string;
  probe: (candidate: string, rawRemote: string, cryptRemote: string) => Promise<QuotaSnapshot>;
  now?: () => number;
};

/** Additive copy/import. A private prepared descriptor closes the unavoidable
 * filesystem-rename / SQLite-commit crash window without restoring old tokens. */
export class RcloneImportService {
  private readonly now: () => number;
  private readonly directory: string;
  private readonly receipts: CloudConnectionOperationReceiptRepository;
  private readonly previews = new Map<
    string,
    { adminId: string; expiresAt: number; source: RcloneImportSource }
  >();
  private running:
    { operationId: string; fingerprint: string; promise: Promise<RcloneImportResult> } | undefined;

  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.directory = path.join(options.stateDir, 'setup', 'rclone-import');
    this.receipts = new CloudConnectionOperationReceiptRepository(options.db, this.now);
  }

  preview(adminId: string, filename: string): RcloneImportPreview {
    for (const [id, preview] of this.previews)
      if (preview.expiresAt <= this.now()) this.previews.delete(id);
    if (this.previews.size >= 4) this.previews.delete(this.previews.keys().next().value!);
    const source = inspectRcloneImportSource(filename);
    const previewId = randomUUID();
    const expiresAt = this.now() + 10 * 60_000;
    this.previews.set(previewId, { adminId, source, expiresAt });
    return { previewId, expiresAt, pairs: source.pairs, skippedCount: source.skippedCount };
  }

  pending(adminId: string): RcloneImportPending {
    if (!existsSync(this.directory)) return [];
    const result: RcloneImportPending = [];
    for (const name of readdirSync(this.directory)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      const descriptor = path.join(this.directory, name, 'intent.json');
      if (!existsSync(descriptor)) continue;
      const journal = Journal.parse(readPrivateJson(descriptor));
      if (journal.intent.adminId !== adminId) continue;
      const scope = {
        adminId,
        operation: 'PROVISION' as const,
        resourceId: 'setup-rclone-import',
        idempotencyKey: journal.intent.idempotencyKey,
        requestFingerprint: journal.fingerprint,
      };
      if (!this.receipts.lookupCompleted(scope))
        result.push({
          idempotencyKey: journal.intent.idempotencyKey,
          previewId: journal.intent.previewId,
          pairIds: journal.intent.pairIds,
          stage: journal.verified ? 'READY_TO_SAVE' : 'CHECKING',
        });
    }
    return result;
  }

  import(
    input: Input,
    approve: () => void,
    onCommit?: (result: RcloneImportResult) => void,
  ): Promise<RcloneImportResult> {
    const fingerprint = fingerprintCloudConnectionOperation({
      previewId: input.previewId,
      pairIds: input.pairIds,
    });
    const operationId = configDigest(JSON.stringify([input.adminId, input.idempotencyKey]));
    if (this.running) {
      if (this.running.operationId !== operationId)
        return Promise.reject(new RcloneImportError('RCLONE_IMPORT_BUSY'));
      if (this.running.fingerprint !== fingerprint)
        return Promise.reject(new RcloneImportError('RCLONE_IMPORT_INTENT_CONFLICT'));
      return this.running.promise;
    }
    const promise = this.perform(input, operationId, fingerprint, approve, onCommit).finally(() => {
      this.running = undefined;
    });
    this.running = { operationId, fingerprint, promise };
    return promise;
  }

  private async perform(
    input: Input,
    operationId: string,
    fingerprint: string,
    approve: () => void,
    onCommit?: (result: RcloneImportResult) => void,
  ): Promise<RcloneImportResult> {
    const scope = {
      adminId: input.adminId,
      operation: 'PROVISION' as const,
      resourceId: 'setup-rclone-import',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint,
    };
    const completed = this.receipts.lookupCompleted(scope);
    if (completed) return RcloneImportResultSchema.parse(completed.body);
    ensurePrivateDirectory(this.directory);
    const directory = path.join(this.directory, operationId);
    const descriptor = path.join(directory, 'intent.json');
    const candidate = path.join(directory, 'candidate.conf');
    let journal: JournalData;
    if (existsSync(descriptor)) {
      journal = Journal.parse(readPrivateJson(descriptor));
      if (journal.fingerprint !== fingerprint)
        throw new RcloneImportError('RCLONE_IMPORT_INTENT_CONFLICT');
    } else {
      const preview = this.previews.get(input.previewId);
      if (!preview || preview.adminId !== input.adminId || preview.expiresAt <= this.now())
        throw new RcloneImportError('RCLONE_IMPORT_PREVIEW_EXPIRED');
      const sections = selectRcloneImportSections(
        preview.source,
        input.pairIds,
        `imp_${operationId.slice(0, 24)}`,
      );
      await this.rejectExistingDrives(sections);
      if (!existsSync(directory) && this.pending(input.adminId).length >= 32)
        throw new RcloneImportError('RCLONE_IMPORT_RECOVERY_REQUIRED');
      approve();
      if (existsSync(directory)) throw new RcloneImportError('RCLONE_IMPORT_RECOVERY_REQUIRED');
      journal = {
        version: 1,
        fingerprint,
        intent: input,
        identities: Object.fromEntries(
          [...sections].map(([name, fields]) => [name, configDigest(sectionIdentity(fields))]),
        ),
        accounts: input.pairIds.map((id, index) => ({
          label: id,
          rawName: `imp_${operationId.slice(0, 24)}_raw${index}`,
          cryptName: `imp_${operationId.slice(0, 24)}_crypt${index}`,
        })),
        verified: null,
      };
      // Publish candidate + descriptor as one prepared directory. No native
      // process may see the candidate before this rename completes.
      const preparing = mkdtempSync(path.join(this.directory, '.preparing-'));
      let published = false;
      try {
        writePrivateText(path.join(preparing, 'candidate.conf'), renderRcloneSections(sections));
        writePrivateJson(path.join(preparing, 'intent.json'), journal);
        renameSync(preparing, directory);
        published = true;
        syncConfigDirectory(this.directory);
      } catch {
        throw new RcloneImportError(
          published ? 'RCLONE_IMPORT_SAVE_RETRYABLE' : 'RCLONE_IMPORT_PREPARE_FAILED',
        );
      } finally {
        if (!published) {
          for (const name of ['candidate.conf', 'intent.json']) {
            try {
              unlinkSync(path.join(preparing, name));
            } catch {
              /* Private preparation only; never a refreshed candidate. */
            }
          }
          try {
            rmdirSync(preparing);
          } catch {
            /* Keep any unexpected file, never recursively erase it. */
          }
        }
      }
      this.previews.delete(input.previewId);
    }

    if (!journal.verified) {
      const quotas: QuotaSnapshot[] = [];
      try {
        this.validateCandidate(readPrivateText(candidate), journal);
        for (const account of journal.accounts)
          quotas.push(
            Quota.parse(
              await this.options.probe(candidate, `${account.rawName}:`, `${account.cryptName}:`),
            ),
          );
        const final = readPrivateText(candidate);
        this.validateCandidate(final, journal);
        journal.verified = { digest: configDigest(final), quotas, checkedAt: this.now() };
        writePrivateJson(descriptor, journal);
      } catch {
        throw new RcloneImportError('RCLONE_IMPORT_PROBE_FAILED');
      }
    }
    const verified = journal.verified;
    const final = readPrivateText(candidate);
    if (configDigest(final) !== verified.digest)
      throw new RcloneImportError('RCLONE_IMPORT_INTENT_CONFLICT');
    const selected = this.validateCandidate(final, journal);
    try {
      return await withRcloneConfigLock(this.options.configPath, async (canonical) => {
        const current = await readRcloneConfig(canonical);
        const currentSections = parseRcloneConfig(current);
        const present = [...selected.keys()].filter((name) => currentSections.has(name));
        if (
          present.length > 0 &&
          (present.length !== selected.size ||
            present.some((name) => !exactSection(currentSections.get(name)!, selected.get(name)!)))
        )
          throw new RcloneImportError('RCLONE_IMPORT_CONFIG_CONFLICT');
        try {
          this.assertUniqueDrives(selected, currentSections);
        } catch {
          throw new RcloneImportError('RCLONE_IMPORT_CONFIG_CONFLICT');
        }
        const merged = `${current}${current.endsWith('\n') ? '' : '\n'}\n${final}`;
        if (present.length === 0 && Buffer.byteLength(merged) > MAX_RCLONE_CONFIG_BYTES)
          throw new RcloneImportError('RCLONE_IMPORT_CONFIG_TOO_LARGE');
        const swap =
          present.length === 0
            ? await prepareRcloneConfigSwap(canonical, merged, current)
            : undefined;
        try {
          return RcloneImportResultSchema.parse(
            this.receipts.executeSync(scope, () => {
              // Short transaction; no provider or filesystem await can interleave.
              const repo = new StorageAccountRepository(this.options.db, this.now);
              const remotes = new Set([...selected.keys()].map((name) => `${name}:`));
              const accountIds = journal.accounts.map((account, index) => {
                const created = repo.register(
                  {
                    label: account.label,
                    rawRemote: `${account.rawName}:`,
                    cryptRemote: `${account.cryptName}:`,
                    reserveBytes: 0,
                  },
                  remotes,
                );
                const quota = verified.quotas[index]!;
                repo.recordHealth(created.id, {
                  health: classifyHealth(quota),
                  totalBytes: quota.total,
                  freeBytes: quota.free,
                  checkedAt: verified.checkedAt,
                });
                return created.id;
              });
              swap?.apply();
              const result: RcloneImportResult = { status: 'IMPORTED', accountIds };
              onCommit?.(result);
              return { statusCode: 200, body: result };
            }).response.body,
          );
        } finally {
          await swap?.dispose().catch(() => undefined);
        }
      });
    } catch (error) {
      if (error instanceof RcloneImportError) throw error;
      throw new RcloneImportError('RCLONE_IMPORT_SAVE_RETRYABLE');
    }
  }

  private validateCandidate(text: string, journal: JournalData): RcloneSections {
    const selected = parseRcloneConfig(text);
    if (
      selected.size !== Object.keys(journal.identities).length ||
      [...selected].some(
        ([name, fields]) => journal.identities[name] !== configDigest(sectionIdentity(fields)),
      )
    )
      throw new RcloneImportError('RCLONE_IMPORT_CONFIG_CONFLICT');
    return selected;
  }
  private async rejectExistingDrives(selected: RcloneSections): Promise<void> {
    this.assertUniqueDrives(
      selected,
      parseRcloneConfig(await readRcloneConfig(this.options.configPath)),
    );
  }
  private assertUniqueDrives(selected: RcloneSections, current: RcloneSections): void {
    const drives = new Set(
      [...selected.values()]
        .filter((fields) => fields.get('type') === 'onedrive')
        .map((fields) => fields.get('drive_id')),
    );
    if (
      [...current].some(
        ([name, fields]) =>
          !selected.has(name) &&
          fields.get('type') === 'onedrive' &&
          drives.has(fields.get('drive_id')),
      )
    )
      throw new RcloneImportError('RCLONE_IMPORT_DUPLICATE_DRIVE');
    // Also catch OAuth accounts whose current materialization is unavailable.
    for (const drive of drives)
      if (
        this.options.db
          .prepare(
            "SELECT 1 FROM cloud_connections WHERE provider='ONEDRIVE' AND external_account_id=? AND disconnected_at IS NULL",
          )
          .get(drive)
      )
        throw new RcloneImportError('RCLONE_IMPORT_DUPLICATE_DRIVE');
  }
}

function exactSection(left: Map<string, string>, right: Map<string, string>): boolean {
  return left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
}
