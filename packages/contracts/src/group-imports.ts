import { z } from 'zod';
import {
  ArchiveProcessingOptionsSchema,
  ArchiveVolumeGroupSchema,
  ArchiveRetryImpactSchema,
} from './archive-imports.js';
import { DownloadFailureDiagnosticSchema } from './download-diagnostics.js';

const bytes = z.string().regex(/^(?:0|[1-9]\d{0,29})$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const code = z.string().regex(/^[A-Z0-9_]{1,100}$/);
export const ImportPipelineOptionsSchema = z
  .object({
    version: z.literal(1),
    processing: ArchiveProcessingOptionsSchema,
    residentMaxBytes: bytes.refine((x) => BigInt(x) > 0n),
    waitingCacheMaxBytes: bytes,
  })
  .strict()
  .refine((x) => BigInt(x.waitingCacheMaxBytes) <= BigInt(x.residentMaxBytes));
export const ImportPipelinePlanGroupSchema = ArchiveVolumeGroupSchema.extend({
  key: digest,
  inputBytes: bytes,
  requiredSpoolBytes: bytes,
  issue: z.enum(['ARCHIVE_VOLUME_SET_INVALID', 'GROUP_EXCEEDS_RESIDENT_BUDGET']).nullable(),
});
export const ImportPipelinePlanSchema = z.object({
  candidateCount: z.number().int().min(0).max(32),
  options: ImportPipelineOptionsSchema,
  groupCount: z.number().int().positive(),
  executableCount: z.number().int().nonnegative(),
  attentionCount: z.number().int().nonnegative(),
  largestGroupBytes: bytes,
  groups: z.array(ImportPipelinePlanGroupSchema).max(500),
  groupsTruncated: z.boolean(),
});
export const ImportPipelineStageSchema = z.enum([
  'QUEUED',
  'ADMISSION_WAIT',
  'DOWNLOAD_WAIT',
  'DOWNLOADING',
  'EXTRACTION_WAIT',
  'EXTRACTING',
  'UPLOAD_WAIT',
  'UPLOADING',
  'VERIFYING',
  'RECOVERY',
  'CLEANUP',
  'WAITING_PASSWORD',
  'RETRY_WAIT',
  'NEEDS_ATTENTION',
  'COMPLETED',
  'CANCELLED',
]);
export const ImportPipelineGroupSchema = z.object({
  key: digest,
  ordinal: z.number().int().nonnegative(),
  entry: z.string().min(1).max(4096),
  jobId: z.string().uuid().nullable(),
  inputCount: z.number().int().positive(),
  inputBytes: bytes,
  requiredSpoolBytes: bytes,
  residentBytes: bytes,
  residentSampledAt: z.number().int().nonnegative().nullable(),
  stage: ImportPipelineStageSchema,
  // Optional so a Web-only release can still consume the previous API.
  paused: z.boolean().optional(),
  retryInPlace: z.boolean().optional(),
  fairnessWait: z.boolean().optional(),
  waitKind: z
    .enum(['CAPACITY', 'DISK', 'PRESSURE', 'DOWNLOAD', 'EXTRACTION', 'UPLOAD'])
    .nullable()
    .optional(),
  lastFailure: z
    .object({
      at: z.number().int().nonnegative(),
      code,
      step: code.nullable(),
      downloadDiagnostic: DownloadFailureDiagnosticSchema.optional(),
    })
    .optional(),
  errorCode: code.nullable(),
  retryAt: z.number().int().nonnegative().nullable(),
  attempt: z.number().int().nonnegative(),
  needsRedownload: z.boolean(),
  retryImpact: ArchiveRetryImpactSchema.optional(),
  verifiedBytes: bytes,
  cacheState: z.enum(['NONE', 'HELD', 'EVICTING', 'RELEASED']),
  publicationState: z.enum([
    'NOT_REQUESTED',
    'PENDING',
    'RUNNING',
    'PUBLISHED',
    'FAILED_SAFE',
    'UNPUBLISHED',
  ]),
  availableActions: z.array(
    z.enum(['PAUSE', 'RESUME', 'CANCEL', 'RETRY', 'PROVIDE_CREDENTIALS', 'REPUBLISH', 'UNPUBLISH']),
  ),
});
export const ImportPipelineSummarySchema = z.object({
  pipelineId: z.string().uuid(),
  version: z.literal(1),
  sourceAlias: z.string(),
  sourcePolicy: z.literal('KEEP'),
  state: z.enum(['QUEUED', 'RUNNING', 'WAITING', 'PARTIAL', 'COMPLETED', 'CANCELLED']),
  paused: z.boolean(),
  revision: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  availableActions: z.array(z.enum(['PAUSE', 'RESUME', 'CANCEL', 'RETRY'])),
  counts: z.object({
    total: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    waitingPassword: z.number().int().nonnegative(),
    retryWait: z.number().int().nonnegative(),
    needsAttention: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  }),
  inputBytes: bytes,
  verifiedBytes: bytes,
  residentBytes: bytes,
  reservedBytes: bytes,
});
export const ImportPipelineDetailSchema = ImportPipelineSummarySchema.extend({
  options: ImportPipelineOptionsSchema,
  groups: z.array(ImportPipelineGroupSchema).max(500),
  nextOffset: z.number().int().nonnegative().nullable(),
});
export type ImportPipelineOptions = z.infer<typeof ImportPipelineOptionsSchema>;
export type ImportPipelineGroup = z.infer<typeof ImportPipelineGroupSchema>;
export type ImportPipelineSummary = z.infer<typeof ImportPipelineSummarySchema>;
export type ImportPipelineDetail = z.infer<typeof ImportPipelineDetailSchema>;
export type ImportPipelinePlan = z.infer<typeof ImportPipelinePlanSchema>;
