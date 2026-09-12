import { createHash } from 'node:crypto';
import { ImportFileIdentitySchema } from '@ptvault/contracts';

import type { ImportPlanConflict, ImportPlanLimitIssue, PlannerResult } from './model.js';
import { ImportControlError } from './errors.js';
import type { ImportSecretStore } from './secret-store.js';
import type { ImportPlanner, ImportPlannerInput } from './service.js';
import { BaiduApiError, type BaiduPlanningGateway } from './baidu-official-gateway.js';
import type { BaiduTransferredObject } from './data-plane/baidu-source.js';
import { buildFileSourceManifest, buildSourceManifest } from './source-manifest.js';

export type BaiduImportPlannerOptions = {
  gateway: BaiduPlanningGateway;
  secrets: Pick<ImportSecretStore, 'read'>;
};

const DECIMAL = /^(?:0|[1-9][0-9]{0,29})$/;

function selectionRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ImportControlError('IMPORT_SELECTION_INVALID', 400);
  }
  return value as Record<string, unknown>;
}

function pathAlias(relativePath: string): string {
  return `对象 · ${createHash('sha256').update(relativePath).digest('hex').slice(0, 12)}`;
}

function conflictSummary(objects: readonly BaiduTransferredObject[]): ImportPlanConflict[] {
  const exact = new Map<string, string>();
  const folded = new Map<string, string>();
  const conflicts: ImportPlanConflict[] = [];
  for (const object of objects) {
    const normalized = object.relativePath.replaceAll('\\', '/');
    const previousExact = exact.get(normalized);
    if (previousExact !== undefined) {
      conflicts.push({ pathAlias: pathAlias(normalized), kind: 'DUPLICATE_PATH' });
    } else {
      exact.set(normalized, object.fsid);
      const caseKey = normalized.toLocaleLowerCase('en-US');
      const previousCase = folded.get(caseKey);
      if (previousCase !== undefined && previousCase !== normalized) {
        conflicts.push({ pathAlias: pathAlias(normalized), kind: 'CASE_COLLISION' });
      } else {
        folded.set(caseKey, normalized);
      }
    }
    if (conflicts.length >= 500) break;
  }
  return conflicts;
}

function planFromObjects(
  objects: readonly BaiduTransferredObject[],
  sourceRequiresPasscode: boolean,
  availableBytes: string | null | undefined,
): PlannerResult {
  if (objects.length === 0) throw new ImportControlError('IMPORT_SOURCE_EMPTY', 409);
  if (!Number.isSafeInteger(objects.length)) {
    throw new ImportControlError('IMPORT_SOURCE_TOO_LARGE', 409);
  }
  let total = 0n;
  let largest = 0n;
  for (const object of objects) {
    if (!DECIMAL.test(object.size)) throw new ImportControlError('IMPORT_SOURCE_INVALID', 502);
    const size = BigInt(object.size);
    total += size;
    if (size > largest) largest = size;
  }
  if (total.toString().length > 30) {
    throw new ImportControlError('IMPORT_SOURCE_TOO_LARGE', 409);
  }
  const destinationLimitIssues: ImportPlanLimitIssue[] = [];
  if (availableBytes !== null && availableBytes !== undefined && DECIMAL.test(availableBytes)) {
    const available = BigInt(availableBytes);
    if (total > available) {
      destinationLimitIssues.push({
        pathAlias: '计划总量',
        kind: 'OBJECT_TOO_LARGE',
        limit: availableBytes,
        actual: total.toString(),
      });
    }
  }
  return {
    sourceAuthState: 'AUTHORIZED',
    sourceRequiresPasscode,
    objectCount: objects.length,
    totalBytes: total.toString(),
    largestObjectBytes: largest.toString(),
    requiredSpoolBytes: largest.toString(),
    pathConflicts: conflictSummary(objects),
    destinationLimitIssues,
  };
}

function passcodeRequiredPlan(): PlannerResult {
  return {
    sourceAuthState: 'PASSCODE_REQUIRED',
    sourceRequiresPasscode: true,
    objectCount: 0,
    totalBytes: '0',
    largestObjectBytes: '0',
    requiredSpoolBytes: '0',
    pathConflicts: [],
    destinationLimitIssues: [],
  };
}

/** Read-only discovery used by `/api/imports/plan`; it never starts a transfer. */
export class BaiduImportPlanner implements ImportPlanner {
  constructor(private readonly options: BaiduImportPlannerOptions) {}

  async plan(input: ImportPlannerInput): Promise<PlannerResult> {
    const selection = selectionRecord(input.selection);
    try {
      if (input.sourceKind === 'BAIDU_SHARE') {
        if (typeof selection.sanitizedShareUrl !== 'string') {
          throw new ImportControlError('IMPORT_SELECTION_INVALID', 400);
        }
        const extractionCode =
          input.secretRef === null ? null : this.options.secrets.read(input.secretRef);
        const preview = await this.options.gateway.previewShare({
          sanitizedShareUrl: selection.sanitizedShareUrl,
          extractionCode,
        });
        const planned = planFromObjects(
          preview.objects,
          preview.sourceRequiresPasscode,
          input.destination.availableBytes,
        );
        if (preview.directories !== undefined) {
          planned.sourceManifest = buildSourceManifest(
            'BAIDU_SHARE',
            '/',
            createHash('sha256').update(selection.sanitizedShareUrl).digest('hex'),
            { objects: preview.objects, directories: preview.directories },
          );
        }
        if (input.sourceBinding != null && planned.sourceManifest === undefined) {
          throw new ImportControlError('IMPORT_SOURCE_MANIFEST_REQUIRED', 409);
        }
        return planned;
      }
      if (input.sourceKind === 'BAIDU_APP_DIR') {
        if (typeof selection.sourcePath !== 'string') {
          throw new ImportControlError('IMPORT_SELECTION_INVALID', 400);
        }
        if (selection.sourceScope === 'FILE') {
          const expected = ImportFileIdentitySchema.safeParse(selection.expectedFile);
          if (!expected.success) throw new ImportControlError('IMPORT_SELECTION_INVALID', 400);
          if (this.options.gateway.snapshotFile === undefined) {
            throw new ImportControlError('IMPORT_SOURCE_MANIFEST_REQUIRED', 409);
          }
          const object = await this.options.gateway.snapshotFile({
            sourcePath: selection.sourcePath,
            expectedFile: expected.data,
          });
          if (
            object.fsid !== expected.data.fsid ||
            object.size !== expected.data.size ||
            object.mtime !== expected.data.mtime
          ) {
            throw new ImportControlError('SOURCE_CHANGED', 409);
          }
          return {
            ...planFromObjects([object], false, input.destination.availableBytes),
            sourceManifest: buildFileSourceManifest(selection.sourcePath, object),
          };
        }
        const snapshot = await this.options.gateway.snapshotAppDirectory?.({
          sourcePath: selection.sourcePath,
        });
        const objects =
          snapshot?.objects ??
          (await this.options.gateway.listAppDirectory({
            sourcePath: selection.sourcePath,
          }));
        const planned = planFromObjects(objects, false, input.destination.availableBytes);
        if (snapshot !== undefined) {
          const root = snapshot.directories.find((entry) => entry.path === selection.sourcePath);
          if (root === undefined)
            throw new ImportControlError('IMPORT_SOURCE_MANIFEST_INVALID', 409);
          planned.sourceManifest = buildSourceManifest(
            'BAIDU_APP_DIR',
            selection.sourcePath,
            root.fsid,
            snapshot,
          );
        }
        if (input.sourceBinding != null && planned.sourceManifest === undefined) {
          throw new ImportControlError('IMPORT_SOURCE_MANIFEST_REQUIRED', 409);
        }
        return planned;
      }
      throw new ImportControlError('IMPORT_SOURCE_UNSUPPORTED', 409);
    } catch (error) {
      if (
        error instanceof BaiduApiError &&
        error.code === 'AUTH_SHARE_PASSCODE_REQUIRED' &&
        input.secretRef === null
      ) {
        return passcodeRequiredPlan();
      }
      if (error instanceof ImportControlError) throw error;
      if (error instanceof BaiduApiError) {
        if (error.code.startsWith('AUTH_')) {
          throw new ImportControlError(error.code, 409);
        }
        if (error.code === 'RATE_LIMITED' || error.code === 'API_QUOTA_EXCEEDED') {
          throw new ImportControlError(error.code, 429);
        }
        if (error.code === 'SOURCE_CHANGED') {
          throw new ImportControlError(error.code, 409);
        }
        throw new ImportControlError(error.code, 502);
      }
      throw error;
    }
  }
}
