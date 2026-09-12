import { z } from 'zod';

import { MfaCodeSchema } from './recovery.js';

export const TransferSettingsIdempotencyKeySchema = z.string().min(8).max(200);

export const TransferRuntimeProvisionReasonSchema = z.enum([
  'READY',
  'MODE_NOT_ACTIVE',
  'RUNTIME_NOT_CONFIGURED',
  'PARALLEL_RUNTIME_DISABLED',
]);

const OffloadTransferLimitsObjectSchema = z
  .object({
    creationEnabled: z.boolean(),
    maxInFlight: z.number().int().min(2).max(32),
    preflightConcurrency: z.number().int().min(1).max(32),
    pauseSnapshotConcurrency: z.number().int().min(1).max(8),
    maxPausedPipelines: z.number().int().min(1).max(31),
    hashConcurrency: z.number().int().min(1).max(8),
    uploadConcurrency: z.number().int().min(1).max(4),
    readbackConcurrency: z.number().int().min(1).max(2),
  })
  .strict();

function isValidOffloadProfile(value: z.infer<typeof OffloadTransferLimitsObjectSchema>): boolean {
  return (
    value.maxPausedPipelines < value.maxInFlight &&
    value.preflightConcurrency <= value.maxInFlight &&
    value.pauseSnapshotConcurrency <= value.maxPausedPipelines &&
    value.hashConcurrency <= value.maxInFlight &&
    value.uploadConcurrency <= value.maxInFlight &&
    value.readbackConcurrency <= value.maxInFlight
  );
}

export const OffloadTransferLimitsSchema = OffloadTransferLimitsObjectSchema.superRefine(
  (value, context) => {
    if (!isValidOffloadProfile(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid offload concurrency profile',
      });
    }
  },
);

export const NetdiskTransferLimitsSchema = z
  .object({
    creationEnabled: z.boolean(),
    maxInFlight: z.number().int().min(1).max(4),
  })
  .strict();

export const TransferResourceStatsSchema = z
  .object({
    active: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    capacity: z.number().int().positive(),
    /** Actual data-plane bodies running after every required permit was acquired. */
    executing: z.number().int().nonnegative().optional(),
  })
  .strict();

export const TransferSettingsStatusSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    offload: z
      .object({
        provisioned: z.boolean(),
        provisionReason: TransferRuntimeProvisionReasonSchema,
        configured: OffloadTransferLimitsSchema,
        effective: OffloadTransferLimitsSchema,
        activity: z
          .object({
            activeHandlers: z.number().int().nonnegative(),
            resources: z
              .object({
                preflight: TransferResourceStatsSchema,
                pauseSnapshot: TransferResourceStatsSchema,
                hash: TransferResourceStatsSchema,
                upload: TransferResourceStatsSchema,
                readback: TransferResourceStatsSchema,
                /** Shared upload/readback ceiling; absent on older API builds. */
                remoteHeavy: TransferResourceStatsSchema.optional(),
              })
              .strict(),
          })
          .strict(),
      })
      .strict(),
    netdisk: z
      .object({
        provisioned: z.boolean(),
        provisionReason: TransferRuntimeProvisionReasonSchema,
        configured: NetdiskTransferLimitsSchema,
        effective: NetdiskTransferLimitsSchema,
        activity: z
          .object({
            activeJobs: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const TransferSettingsPatchSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    mfaCode: MfaCodeSchema,
    offload: OffloadTransferLimitsObjectSchema.partial().strict().optional(),
    netdisk: NetdiskTransferLimitsSchema.partial().strict().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.offload === undefined || Object.keys(value.offload).length === 0) &&
      (value.netdisk === undefined || Object.keys(value.netdisk).length === 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one transfer setting must be changed',
      });
    }
  });

export type OffloadTransferLimits = z.infer<typeof OffloadTransferLimitsSchema>;
export type NetdiskTransferLimits = z.infer<typeof NetdiskTransferLimitsSchema>;
export type TransferResourceStats = z.infer<typeof TransferResourceStatsSchema>;
export type TransferSettingsStatus = z.infer<typeof TransferSettingsStatusSchema>;
export type TransferSettingsPatch = z.infer<typeof TransferSettingsPatchSchema>;
