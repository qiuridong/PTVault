import {
  RecoveryStatusSchema,
  RecoveryExportSchema,
  RecoveryCloudCopySchema,
  EscrowUploadResultSchema,
  RecoveryBundleResultSchema,
  Sha256Schema,
  type RecoveryStatus,
  type RecoveryExport,
  type RecoveryCloudCopy,
  type EscrowUploadResult,
  type RecoveryBundleResult,
} from '@ptvault/contracts';
import { z } from 'zod';

import { ApiError, apiGet, apiMutation, apiControlMutation } from '../../api/client.js';
import { isDemoSessionActive } from '../../demo/demoSession.js';

const StatusResponseSchema = z.object({
  status: RecoveryStatusSchema,
});
const PreparationResponseSchema = z.object({
  status: RecoveryStatusSchema,
  receipt: z.object({
    operationId: z.string().min(1),
    state: z.literal('SUCCEEDED'),
    result: z.object({
      version: z.number().int().positive().optional(),
      baselineRevision: z.number().int().nonnegative().optional(),
      materialRevision: z.number().int().nonnegative().optional(),
      escrowSha256: Sha256Schema.optional(),
    }),
  }),
});

const ExportsResponseSchema = z.object({
  exports: z.array(RecoveryExportSchema),
});

const CloudCopiesResponseSchema = z.object({
  cloudCopies: z.array(RecoveryCloudCopySchema),
});

export const recoveryStatusQueryKey = ['recovery', 'status'] as const;
export const recoveryExportsQueryKey = ['recovery', 'exports'] as const;

export type RecoveryFileKind = 'bundle' | 'escrow';
const DownloadErrorCode = z.enum([
  'RECOVERY_FILE_REQUEST_INVALID',
  'RECOVERY_EXPORT_NOT_FOUND',
  'RECOVERY_EXPORT_NOT_READY',
  'RECOVERY_FILE_MISSING',
  'RECOVERY_FILE_UNSAFE',
  'RECOVERY_FILE_TOO_LARGE',
  'RECOVERY_FILE_CHANGED',
  'RECOVERY_ESCROW_VERSION_UNAVAILABLE',
  'RECOVERY_FILE_CHECKSUM_MISMATCH',
  'RECOVERY_FILE_NOT_ENCRYPTED',
  'RECOVERY_DOWNLOAD_BUSY',
  'RECOVERY_DOWNLOAD_ABORTED',
  'RECOVERY_DOWNLOAD_FAILED',
]);

/** Downloads are GET reads, never generation or a computer-save/drill attestation. */
export async function downloadRecoveryFile(input: {
  version: number;
  kind: RecoveryFileKind;
  expectedSha256: string;
  signal?: AbortSignal;
}): Promise<{ blob: Blob; filename: string; sha256: string }> {
  const version = z.number().int().positive().safe().parse(input.version);
  const kind = z.enum(['bundle', 'escrow']).parse(input.kind);
  const expected = Sha256Schema.parse(input.expectedSha256);
  if (isDemoSessionActive()) throw new ApiError(403, '演示环境不提供真实恢复文件。');
  const filename = kind === 'bundle' ? `recovery-v${version}.tar.age` : `escrow-v${version}.age`;
  const response = await fetch(`/api/recovery/exports/${version}/files/${kind}`, {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    redirect: 'error',
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!response.ok) {
    let code: string | undefined;
    try {
      const body: unknown = await response.json();
      const parsed = z.object({ code: DownloadErrorCode.optional() }).safeParse(body);
      if (parsed.success) code = parsed.data.code;
    } catch {
      /* Never turn an error body into a file. */
    }
    throw new ApiError(response.status, '恢复文件下载失败。', code);
  }
  const length = response.headers.get('content-length');
  const size = length === null ? Number.NaN : Number(length);
  if (
    response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/octet-stream' ||
    response.headers.get('content-disposition') !== `attachment; filename="${filename}"` ||
    response.headers.get('x-recovery-version') !== String(version) ||
    response.headers.get('x-recovery-file-kind') !== kind ||
    response.headers.get('x-content-sha256') !== expected ||
    length === null ||
    !/^[0-9]+$/.test(length) ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > 256 * 1024 * 1024
  ) {
    await response.body?.cancel();
    throw new ApiError(
      502,
      '恢复下载响应与所选文件不一致。',
      'RECOVERY_DOWNLOAD_CONTRACT_MISMATCH',
    );
  }
  const blob = await response.blob();
  if (blob.size !== size)
    throw new ApiError(502, '恢复文件未完整接收。', 'RECOVERY_DOWNLOAD_INCOMPLETE');
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const sha256 = Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
  if (sha256 !== expected)
    throw new ApiError(502, '恢复文件摘要不一致，未保存。', 'RECOVERY_DOWNLOAD_CHECKSUM_MISMATCH');
  return { blob, filename, sha256 };
}

export function recoveryCloudCopiesQueryKey(version: number) {
  return ['recovery', 'exports', version, 'cloud-copies'] as const;
}

export async function getRecoveryStatus(): Promise<RecoveryStatus> {
  const response = await apiGet('/api/recovery/status', StatusResponseSchema);
  return response.status;
}

export async function getRecoveryExports(): Promise<RecoveryExport[]> {
  const response = await apiGet('/api/recovery/exports', ExportsResponseSchema);
  return response.exports;
}

export async function getRecoveryCloudCopies(version: number): Promise<RecoveryCloudCopy[]> {
  const safeVersion = z.number().int().positive().parse(version);
  const response = await apiGet(
    `/api/recovery/exports/${encodeURIComponent(safeVersion)}/cloud-copies`,
    CloudCopiesResponseSchema,
  );
  return response.cloudCopies;
}

export async function configureRecoveryRecipient(input: {
  publicRecipient: string;
  mfaCode: string;
  expectedMaterialRevision: number;
  idempotencyKey: string;
}): Promise<RecoveryStatus> {
  const { idempotencyKey, ...body } = input;
  const response = await apiControlMutation(
    '/api/recovery/recipient',
    body,
    PreparationResponseSchema,
    { idempotencyKey },
  );
  return response.status;
}

export async function selectRecoveryBaseline(input: {
  version: number;
  bundleSha256: string;
  escrowSha256: string;
  expectedBaselineRevision: number;
  expectedMaterialRevision: number;
  mfaCode: string;
  idempotencyKey: string;
}): Promise<RecoveryStatus> {
  const { idempotencyKey, ...body } = input;
  const response = await apiControlMutation(
    '/api/recovery/preparation-baseline',
    body,
    PreparationResponseSchema,
    { idempotencyKey },
  );
  return response.status;
}

/**
 * Encodes the operator's `escrow.age` for transport.
 *
 * Chunked rather than `String.fromCharCode(...bytes)`: spreading a whole file
 * into an argument list blows the stack once it gets large, and this runs on a
 * file the operator picked, not on a size we control.
 */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

export async function uploadEncryptedEscrow(input: {
  bytes: Uint8Array;
  mfaCode: string;
  expectedMaterialRevision: number;
  idempotencyKey: string;
}): Promise<EscrowUploadResult> {
  const response = await apiControlMutation(
    '/api/recovery/escrow',
    {
      encryptedEscrowBase64: toBase64(input.bytes),
      mfaCode: input.mfaCode,
      expectedMaterialRevision: input.expectedMaterialRevision,
    },
    PreparationResponseSchema,
    { idempotencyKey: input.idempotencyKey },
  );
  return EscrowUploadResultSchema.parse(response.receipt.result);
}

export async function generateRecoveryBundle(input: {
  destinationAccountIds: readonly string[];
  mfaCode: string;
}): Promise<RecoveryBundleResult> {
  return apiMutation(
    '/api/recovery/generate',
    { destinationAccountIds: [...input.destinationAccountIds], mfaCode: input.mfaCode },
    RecoveryBundleResultSchema,
  );
}

export async function confirmComputerDownload(input: {
  version: number;
  bundleSha256: string;
  mfaCode: string;
}): Promise<RecoveryStatus> {
  return apiMutation('/api/recovery/computer-confirmation', input, RecoveryStatusSchema);
}

export async function attestRecoveryDrill(input: {
  version: number;
  escrowSha256: string;
  mfaCode: string;
}): Promise<RecoveryStatus> {
  return apiMutation('/api/recovery/drill', input, RecoveryStatusSchema);
}
