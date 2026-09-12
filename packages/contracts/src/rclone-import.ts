import { z } from 'zod';

export const RcloneImportPreviewRequestSchema = z
  .object({ path: z.string().min(1).max(4096) })
  .strict();
export const RcloneImportPreviewSchema = z
  .object({
    previewId: z.string().uuid(),
    expiresAt: z.number().int().positive(),
    pairs: z
      .array(
        z
          .object({
            id: z.string().max(128),
            rawName: z.string().max(128),
            cryptName: z.string().max(128),
            driveType: z.enum(['personal', 'business', 'documentLibrary']),
            driveHint: z.string().max(80),
          })
          .strict(),
      )
      .max(128),
    skippedCount: z.number().int().nonnegative(),
  })
  .strict();
export const RcloneImportRequestSchema = z
  .object({
    previewId: z.string().uuid(),
    pairIds: z.array(z.string().min(1).max(128)).min(1).max(2),
    mfaCode: z
      .string()
      .regex(/^[0-9]{6}$/)
      .optional(),
  })
  .strict();
export const RcloneImportResultSchema = z
  .object({
    accountIds: z.array(z.string().uuid()).min(1).max(2),
    status: z.literal('IMPORTED'),
  })
  .strict();
export type RcloneImportPreview = z.infer<typeof RcloneImportPreviewSchema>;
export type RcloneImportRequest = z.infer<typeof RcloneImportRequestSchema>;
export type RcloneImportResult = z.infer<typeof RcloneImportResultSchema>;
export const RcloneImportPendingSchema = z
  .array(
    z
      .object({
        idempotencyKey: z.string().min(8).max(128),
        previewId: z.string().uuid(),
        pairIds: z.array(z.string().min(1).max(128)).min(1).max(2),
        stage: z.enum(['CHECKING', 'READY_TO_SAVE']),
      })
      .strict(),
  )
  .max(32);
export type RcloneImportPending = z.infer<typeof RcloneImportPendingSchema>;
