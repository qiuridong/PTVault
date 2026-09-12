import { z } from 'zod';

const bytes = z.string().regex(/^(?:0|[1-9][0-9]{0,29})$/);
export const ArchiveCandidatesSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(256)
      .refine((value) => !/[\r\n\0]/.test(value)),
  )
  .max(32);
export const ArchiveProcessingOptionsSchema = z
  .object({
    mode: z.literal('RECURSIVE_VIDEO'),
    maxDepth: z.number().int().min(1).max(16),
    maxFiles: z.number().int().min(1).max(100000),
    maxExpandedBytes: bytes.refine((value) => BigInt(value) > 0n && BigInt(value) <= 1024n ** 4n),
  })
  .strict();
export const ArchivePlanRequestSchema = z
  .object({
    mode: z.literal('RECURSIVE_VIDEO'),
    /** Request-only secret ingress. Never echoed, put in a URL, or cached. */
    candidates: ArchiveCandidatesSchema,
    maxDepth: z.number().int().min(1).max(16).default(8),
    maxExpandedBytes: bytes
      .refine((value) => BigInt(value) > 0n && BigInt(value) <= 1024n ** 4n)
      .default('274877906944'),
  })
  .strict();
export const ArchiveVolumeGroupSchema = z.object({
  entry: z.string().min(1).max(4096),
  members: z.array(z.string().min(1).max(4096)).min(1).max(10000),
  kind: z.enum(['SINGLE', 'NUMERIC', 'RAR_PART', 'RAR_LEGACY', 'ZIP_SPLIT']),
});
export const ArchivePlanSummarySchema = ArchiveProcessingOptionsSchema.extend({
  candidateCount: z.number().int().min(0).max(32),
  inputCount: z.number().int().min(1),
  inputBytes: bytes,
  requiredSpoolBytes: bytes,
  groups: z.array(ArchiveVolumeGroupSchema).max(500),
  groupsTruncated: z.boolean(),
});
/** A metadata estimate, not a promise about files that the worker has not rechecked. */
export const ArchiveRetryImpactSchema = z.object({
  mode: z.enum(['UNKNOWN', 'REUSE_OUTPUTS', 'RESUME_INPUTS', 'REUSE_INPUTS', 'REDOWNLOAD_INPUTS']),
  basis: z.literal('CHECKPOINT_ESTIMATE'),
  sampledAt: z.number().int().nonnegative(),
  downloadBytes: bytes.nullable(),
  retainedInputBytes: bytes.nullable(),
  reextract: z.boolean().nullable(),
});
export type ArchiveRetryImpact = z.infer<typeof ArchiveRetryImpactSchema>;
export const ArchiveJobStatusSchema = z.object({
  mode: z.literal('RECURSIVE_VIDEO'),
  phase: z.enum([
    'PENDING',
    'DOWNLOADING_INPUTS',
    'EXTRACTING',
    'WAITING_PASSWORD',
    'PREPARING_VIDEOS',
    'READY',
    'CLEANED',
  ]),
  inputCount: z.number().int().nonnegative(),
  inputBytes: bytes,
  inputBytesDone: bytes,
  videoCount: z.number().int().nonnegative(),
  videoBytes: bytes,
  depth: z.number().int().nonnegative(),
  archiveCount: z.number().int().nonnegative(),
  expandedBytes: bytes,
  candidateIndex: z.number().int().nonnegative().nullable(),
  candidateCount: z.number().int().nonnegative(),
  maxDepth: z.number().int().min(1).max(16),
  maxExpandedBytes: bytes,
  lastErrorCode: z
    .string()
    .regex(/^[A-Z0-9_]+$/)
    .nullable(),
  retryImpact: ArchiveRetryImpactSchema.optional(),
});
export const ArchiveCredentialsRequestSchema = z
  .object({
    candidates: ArchiveCandidatesSchema.min(1),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
export type ArchiveProcessingOptions = z.infer<typeof ArchiveProcessingOptionsSchema>;
export type ArchivePlanRequest = z.infer<typeof ArchivePlanRequestSchema>;
export type ArchivePlanSummary = z.infer<typeof ArchivePlanSummarySchema>;
export type ArchiveJobStatus = z.infer<typeof ArchiveJobStatusSchema>;
export type ArchiveCredentialsRequest = z.infer<typeof ArchiveCredentialsRequestSchema>;
