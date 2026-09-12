import {
  ArchiveCredentialsRequestSchema,
  CreateImportRequestSchema,
  CreateImportResponseSchema,
  ImportCredentialsRequestSchema,
  ImportDestinationsResponseSchema,
  ImportDetailResponseSchema,
  ImportPlanRequestSchema,
  ImportPlanResponseSchema,
  ImportSourceCleanupExecuteRequestSchema,
  ImportSourceCleanupPreviewRequestSchema,
  ImportSourceCleanupPreviewResponseSchema,
  ImportSourceCleanupResponseSchema,
  ImportsResponseSchema,
  LegacyImportSourceBindingSchema,
  LegacyImportSourceBindRequestSchema,
  MediaPublicationRequestSchema,
  MediaPublicationResponseSchema,
  MediaUnpublishResponseSchema,
  type CreateImportRequest,
  type ImportDestinationsResponse,
  type ImportDetail,
  type ImportJobSummary,
  type ImportPlan,
  type ImportPlanRequest,
  type ImportPublication,
  type ImportShareCredential,
  type ImportSourceCleanup,
  type ImportSourceCleanupExecuteRequest,
  type ImportSourceCleanupPreview,
  type ImportSourceCleanupPreviewRequest,
  type LegacyImportSourceBinding,
} from '@ptvault/contracts';
import { z } from 'zod';

import {
  ApiError,
  ContractError,
  apiControlMutation,
  apiGet,
  apiMutation,
} from '../../api/client.js';
import { probeGet, type Probe } from '../../api/probe.js';
import { verifyArchivePlanIdentity } from './archivePlanIdentity.js';
import { verifyGroupPlanIdentity } from './groupPlanIdentity.js';

/**
 * The browser's side of the netdisk-import API.
 *
 * Three properties this module exists to hold:
 *
 * 1. **Every response goes through the shared contract.** No second Zod mirror
 *    lives here. A mirror is a copy that drifts, and the drift shows up as a
 *    field that silently stops rendering.
 * 2. **A missing route is not an empty result.** `Probe` keeps 404 separate from
 *    "the list is empty", because those lead to different next moves and the page
 *    has to say which one it is.
 * 3. **A passcode passes through and is not retained.** It is accepted as an
 *    argument, validated, put in one request body, and forgotten. Nothing here
 *    caches it, logs it, or puts it in a path — and `importErrorMessage` never
 *    echoes a server string that might quote the request back.
 */

/**
 * Root key for the job list. Detail keys nest under it on purpose: the event
 * stream cannot know which panel is open, so it invalidates this prefix and the
 * open panel has to be reached by it.
 */
export const importsQueryKey = ['imports'] as const;

export function importDetailQueryKey(jobId: string) {
  return ['imports', jobId] as const;
}

export function sourceCleanupQueryKey(jobId: string) {
  return ['imports', jobId, 'source-cleanup'] as const;
}

export function legacyImportSourceQueryKey(jobId: string) {
  return ['imports', jobId, 'legacy-source'] as const;
}

/**
 * Capabilities sit outside the `imports` prefix.
 *
 * A job moving does not change what this deployment can do. Nesting them would
 * refetch the destination list and the library allowlist on every checkpoint of
 * a multi-hour transfer.
 */
export const importDestinationsQueryKey = ['import-destinations'] as const;

const JobIdSchema = z.string().uuid();

/** Keys a passcode is known to hide in. Mirrors `splitSharePasscode`. */
const PASSCODE_PARAMS = /[?&#](?:pwd|passwd|password)=/i;

/**
 * Refuse a share URL that still carries its passcode.
 *
 * The form strips it at the entry point; this is the backstop for every other
 * caller. Throwing is right rather than stripping silently here: a caller that
 * still holds a passcode-bearing URL probably holds it somewhere else too, and a
 * quiet fix would hide that.
 */
function assertSanitizedShareUrl(shareUrl: string | undefined): void {
  if (shareUrl !== undefined && PASSCODE_PARAMS.test(shareUrl)) {
    throw new Error('share url still carries a pwd parameter; move it into the credential block');
  }
}

/** Read-only: what this deployment can do, and where imports may land. */
export async function getImportDestinations(): Promise<Probe<ImportDestinationsResponse>> {
  return probeGet('/api/import-destinations', ImportDestinationsResponseSchema);
}

export async function refreshImportLibraries(): Promise<Probe<ImportDestinationsResponse>> {
  return probeGet(
    '/api/import-destinations?refreshLibraries=true',
    ImportDestinationsResponseSchema,
  );
}

/** Read-only: every import job this session may see. */
export async function getImports(): Promise<Probe<ImportJobSummary[]>> {
  const probe = await probeGet('/api/imports', ImportsResponseSchema);
  return probe.supported ? { supported: true, data: probe.data.jobs } : probe;
}

/** Read-only: one job with its receipts, timeline and permitted actions. */
export async function getImportDetail(jobId: string): Promise<Probe<ImportDetail>> {
  const safeJobId = JobIdSchema.parse(jobId);
  const probe = await probeGet(
    `/api/imports/${encodeURIComponent(safeJobId)}`,
    ImportDetailResponseSchema,
  );
  return probe.supported ? { supported: true, data: probe.data.job } : probe;
}

// Only the HTTP envelope lives here; both payloads use the frozen shared schemas.
const LegacySourceResponseSchema = z.object({ binding: LegacyImportSourceBindingSchema }).strict();
export type LegacyImportSourceBindRequest = z.input<typeof LegacyImportSourceBindRequestSchema>;

async function legacySourceAnswer(
  jobId: string,
  run: (path: string) => Promise<z.infer<typeof LegacySourceResponseSchema>>,
): Promise<Probe<LegacyImportSourceBinding>> {
  const path = `/api/imports/${encodeURIComponent(JobIdSchema.parse(jobId))}/legacy-source`;
  try {
    const response = await run(path);
    if (response.binding.jobId !== jobId) throw new ContractError(path, 'binding.jobId:mismatch');
    return { supported: true, data: response.binding };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && error.code !== 'IMPORT_NOT_FOUND') {
      return { supported: false };
    }
    throw error;
  }
}

export function getLegacyImportSourceBinding(
  jobId: string,
): Promise<Probe<LegacyImportSourceBinding>> {
  return legacySourceAnswer(jobId, (path) => apiGet(path, LegacySourceResponseSchema));
}

/** Confirmation changes only the binding. Retry/resume remain separate explicit actions. */
export function bindLegacyImportSource(
  jobId: string,
  request: LegacyImportSourceBindRequest,
  idempotencyKey: string,
): Promise<Probe<LegacyImportSourceBinding>> {
  const body = LegacyImportSourceBindRequestSchema.parse(request);
  const key = z.string().min(8).max(200).parse(idempotencyKey);
  return legacySourceAnswer(jobId, (path) =>
    apiControlMutation(path, body, LegacySourceResponseSchema, { idempotencyKey: key }),
  );
}

/**
 * A mutation that reports a missing route instead of throwing on it.
 *
 * Same reasoning as `probeGet`, applied to POST: on a deployment without the
 * import routes the page has to say "this API version has no such endpoint"
 * rather than show a generic failure that reads like the request went wrong.
 */
async function probeMutation<T>(
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
): Promise<Probe<T>> {
  try {
    return { supported: true, data: await apiMutation(path, body, schema) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { supported: false };
    throw error;
  }
}

async function probeControlMutation<T>(
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
  idempotencyKey: string,
  allowedStatus: readonly number[] = [],
): Promise<Probe<T>> {
  const key = z.string().min(8).max(200).parse(idempotencyKey);
  try {
    return {
      supported: true,
      data: await apiControlMutation(path, body, schema, {
        idempotencyKey: key,
        allowedStatus,
      }),
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { supported: false };
    throw error;
  }
}

/**
 * Ask what an import would do. Moves no bytes.
 *
 * The request is validated against the shared schema before it goes out, so a
 * malformed credential union or an unsanitised URL fails here rather than being
 * discovered by the server after the secret is already on the wire.
 */
export async function planImport(request: ImportPlanRequest): Promise<Probe<ImportPlan>> {
  assertSanitizedShareUrl(request.shareUrl);
  const body = ImportPlanRequestSchema.parse(request);
  const probe = await probeMutation('/api/imports/plan', body, ImportPlanResponseSchema);
  if (probe.supported) {
    verifyGroupPlanIdentity(body.grouped, body.archive, probe.data.plan);
    if (!body.grouped) verifyArchivePlanIdentity(body.archive, probe.data.plan);
  }
  return probe.supported ? { supported: true, data: probe.data.plan } : probe;
}

/**
 * Create the job.
 *
 * Parsed locally first because the policy/publication pairing is a correctness
 * rule, not a formatting one: an archive-only submission carrying a leftover
 * publication block is how a title gets published that nobody chose to publish,
 * and catching it here means it never reaches a server that might be lenient.
 */
export async function createImport(request: CreateImportRequest): Promise<Probe<ImportJobSummary>> {
  const body = CreateImportRequestSchema.parse(request);
  const probe = await probeMutation('/api/imports', body, CreateImportResponseSchema);
  return probe.supported ? { supported: true, data: probe.data.job } : probe;
}

export async function provideArchiveCredentials(
  jobId: string,
  candidates: string[],
  expectedRevision: number,
  idempotencyKey: string,
): Promise<Probe<ImportJobSummary>> {
  const body = ArchiveCredentialsRequestSchema.parse({ candidates, expectedRevision });
  const probe = await probeControlMutation(
    `/api/imports/${encodeURIComponent(JobIdSchema.parse(jobId))}/archive-credentials`,
    body,
    CreateImportResponseSchema,
    idempotencyKey,
  );
  return probe.supported ? { supported: true, data: probe.data.job } : probe;
}

/** One of the four lifecycle actions the server said it would accept. */
export type ImportLifecycleAction = 'pause' | 'resume' | 'cancel' | 'retry';

export async function actOnImport(
  jobId: string,
  action: ImportLifecycleAction,
): Promise<Probe<ImportDetail>> {
  const safeJobId = JobIdSchema.parse(jobId);
  const probe = await probeMutation(
    `/api/imports/${encodeURIComponent(safeJobId)}/${action}`,
    {},
    ImportDetailResponseSchema,
  );
  return probe.supported ? { supported: true, data: probe.data.job } : probe;
}

/**
 * Hand a parked job a fresh passcode.
 *
 * Takes the credential as an argument and keeps nothing: the value's only
 * lifetime is this call. Callers must clear their own copy once it settles.
 */
export async function provideImportCredentials(
  jobId: string,
  credential: ImportShareCredential,
): Promise<Probe<ImportDetail>> {
  const safeJobId = JobIdSchema.parse(jobId);
  const body = ImportCredentialsRequestSchema.parse({ credential });
  const probe = await probeMutation(
    `/api/imports/${encodeURIComponent(safeJobId)}/credentials`,
    body,
    ImportDetailResponseSchema,
  );
  return probe.supported ? { supported: true, data: probe.data.job } : probe;
}

/** Publish, or re-publish, an already verified import into a Jellyfin library. */
export async function publishImport(
  request: z.input<typeof MediaPublicationRequestSchema>,
  idempotencyKey: string,
): Promise<Probe<ImportPublication>> {
  const body = MediaPublicationRequestSchema.parse(request);
  const probe = await probeControlMutation(
    '/api/media-publications',
    body,
    MediaPublicationResponseSchema,
    idempotencyKey,
    [202],
  );
  return probe.supported ? { supported: true, data: probe.data.publication } : probe;
}

export async function retryPublication(
  publicationId: string,
  idempotencyKey: string,
): Promise<Probe<ImportPublication>> {
  const safeId = z.string().uuid().parse(publicationId);
  const probe = await probeControlMutation(
    `/api/media-publications/${encodeURIComponent(safeId)}/retry`,
    {},
    MediaPublicationResponseSchema,
    idempotencyKey,
  );
  return probe.supported ? { supported: true, data: probe.data.publication } : probe;
}

/**
 * Remove the projection. Deletes no cloud bytes — the response says so, and the
 * contract will not let it say otherwise.
 */
export async function unpublishPublication(
  publicationId: string,
  idempotencyKey: string,
): Promise<Probe<z.infer<typeof MediaUnpublishResponseSchema>>> {
  const safeId = z.string().uuid().parse(publicationId);
  return probeControlMutation(
    `/api/media-publications/${encodeURIComponent(safeId)}/unpublish`,
    {},
    MediaUnpublishResponseSchema,
    idempotencyKey,
  );
}

/** Read-only: the raw publication record, for a detail panel that has only an id. */
export async function getPublication(publicationId: string): Promise<Probe<ImportPublication>> {
  const safeId = z.string().uuid().parse(publicationId);
  const probe = await probeGet(
    `/api/media-publications/${encodeURIComponent(safeId)}`,
    MediaPublicationResponseSchema,
  );
  return probe.supported ? { supported: true, data: probe.data.publication } : probe;
}

export async function getImportSourceCleanup(
  jobId: string,
): Promise<Probe<ImportSourceCleanup | null>> {
  const safeJobId = JobIdSchema.parse(jobId);
  const path = `/api/imports/${encodeURIComponent(safeJobId)}/source-cleanup`;
  try {
    const response = await apiGet(path, ImportSourceCleanupResponseSchema);
    return { supported: true, data: response.cleanup };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return error.code === 'SOURCE_CLEANUP_NOT_FOUND'
        ? { supported: true, data: null }
        : { supported: false };
    }
    throw error;
  }
}

export async function previewImportSourceCleanup(
  jobId: string,
  request: ImportSourceCleanupPreviewRequest,
  idempotencyKey: string,
): Promise<Probe<ImportSourceCleanupPreview>> {
  const safeJobId = JobIdSchema.parse(jobId);
  const body = ImportSourceCleanupPreviewRequestSchema.parse(request);
  const result = await probeControlMutation(
    `/api/imports/${encodeURIComponent(safeJobId)}/source-cleanup/preview`,
    body,
    ImportSourceCleanupPreviewResponseSchema,
    idempotencyKey,
  );
  return result.supported ? { supported: true, data: result.data.preview } : result;
}

export async function executeImportSourceCleanup(
  jobId: string,
  request: ImportSourceCleanupExecuteRequest,
  idempotencyKey: string,
): Promise<Probe<ImportSourceCleanup>> {
  const safeJobId = JobIdSchema.parse(jobId);
  const body = ImportSourceCleanupExecuteRequestSchema.parse(request);
  const result = await probeControlMutation(
    `/api/imports/${encodeURIComponent(safeJobId)}/source-cleanup`,
    body,
    ImportSourceCleanupResponseSchema,
    idempotencyKey,
  );
  return result.supported ? { supported: true, data: result.data.cleanup } : result;
}

/**
 * A failure as a sentence the operator can act on.
 *
 * Deliberately never `error.message` for a mapped status. A server error body is
 * not a trusted display string — it can quote the request that produced it, and
 * the request that produced it may have carried a passcode. Only these fixed
 * sentences reach the screen; the diagnostic detail stays in the thrown object.
 */
/** This validation runs before createJob and cannot have committed a job. */
export function isDefiniteImportCreateRejection(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 400 &&
    error.code === 'IMPORT_LOGICAL_PATH_REJECTED'
  );
}

export function importErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message === 'ARCHIVE_PLAN_IDENTITY_UNVERIFIED')
    return '服务端未确认递归解压计划；已停止创建，不会将原压缩包当作视频迁移。请更新 API 后重新规划。';
  if (error instanceof ApiError) {
    const messages: Record<string, string> = {
      ARCHIVE_SELECT_VOLUME_DIRECTORY:
        '分卷文件须选择包含整组分卷的目录，不会自动扩大所选单文件范围。',
      ARCHIVE_VOLUME_SET_INVALID: '分卷编号缺失或不连续，请先补齐完整分卷组。',
      ARCHIVE_SPOOL_LIMIT:
        '完整分卷与解压上限超过 VPS 暂存配额，请调整本次解压上限或网盘暂存设置。',
      ARCHIVE_RUNTIME_UNAVAILABLE: '递归解压运行环境未就绪；普通原样备份不受影响。',
      ARCHIVE_SOURCE_KEEP_REQUIRED: '递归解压模式固定保留百度原压缩分卷。',
      ARCHIVE_CREDENTIAL_EXPIRED: '本计划的候选密码已过期，请重新提供并生成计划。',
    };
    if (error.code !== undefined && messages[error.code] !== undefined)
      return messages[error.code]!;
  }
  if (isDefiniteImportCreateRejection(error)) {
    return '逻辑路径已被服务端拒绝，未创建任务。请开始新批次，填写媒体库内的相对目录后重新规划。';
  }
  if (error instanceof ContractError) {
    return '这台机器上的 API 和当前网页包对不上：接口在，但两边说的字段形状不一样。';
  }
  if (error instanceof ApiError) {
    switch (error.status) {
      case 401:
        return '会话已过期，请重新登录后再查看网盘迁移。';
      case 403:
        return '当前会话没有权限执行这个操作；演示账户下所有写操作都是只读的。';
      case 404:
        return '这台机器上的 API 版本还没有网盘迁移接口。';
      case 409:
        return '任务状态已变化，刷新后再看它现在停在哪一步。';
      case 429:
        return '来源侧正在限速，稍后会自动重试。';
      case 503:
        return '这个能力暂时不可用，操作结果尚未确认；请刷新核对后再继续。';
      default:
        return '请求没有完成，操作结果尚未确认；请刷新核对，或沿用同一操作标识重试。';
    }
  }
  return '网盘迁移请求未完成，操作结果尚未确认；请刷新核对。';
}

export type { Probe } from '../../api/probe.js';
