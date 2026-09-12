import { z } from 'zod';

import { PublicationPolicySchema } from './imports.js';
import { MfaCodeSchema } from './recovery.js';
import { TransferResourceStatsSchema } from './transfer-settings.js';

const DecimalCapacitySchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,29})$/)
  .refine((value) => BigInt(value) > 0n, 'Capacity must be positive');

export const NetdiskSettingsIdempotencyKeySchema = z.string().min(8).max(200);

export const NetdiskSettingsValuesSchema = z
  .object({
    creationEnabled: z.boolean(),
    maxInFlight: z.number().int().min(1).max(8),
    localPreparationConcurrency: z.number().int().min(1).max(4),
    uploadConcurrency: z.number().int().min(1).max(4),
    spoolMaxBytes: DecimalCapacitySchema,
    spoolReserveBytes: z.string().regex(/^(?:0|[1-9][0-9]{0,29})$/),
    defaultSourceConnectionId: z.string().uuid().nullable(),
    defaultDestinationAccountId: z.string().min(1).max(256).nullable(),
    defaultPublicationPolicy: PublicationPolicySchema,
    sourceStagingCleanupEnabled: z.boolean(),
    sourceDeleteEnabled: z.boolean(),
    sourceDeleteGraceSeconds: z
      .number()
      .int()
      .min(0)
      .max(30 * 24 * 60 * 60),
  })
  .strict()
  .superRefine((value, context) => {
    if (BigInt(value.spoolReserveBytes) >= BigInt(value.spoolMaxBytes)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['spoolReserveBytes'],
        message: 'Spool reserve must be smaller than spool maximum',
      });
    }
  });

export const NetdiskSettingsProvisionReasonSchema = z.enum([
  'READY',
  'MODE_NOT_ACTIVE',
  'RUNTIME_NOT_CONFIGURED',
]);

export const NetdiskSettingsClampSchema = z
  .object({
    field: z.enum(['creationEnabled', 'sourceStagingCleanupEnabled', 'sourceDeleteEnabled']),
    reason: z.enum(['MODE_NOT_ACTIVE', 'RUNTIME_UNPROVISIONED', 'EXECUTOR_UNSUPPORTED']),
  })
  .strict();

export const NetdiskResourceWaitKindSchema = z.enum([
  'MAX_IN_FLIGHT',
  'LOCAL_PREPARATION',
  'UPLOAD',
  'SPOOL_CAPACITY',
]);

export const NetdiskSettingsStatusSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    provisioned: z.boolean(),
    provisionReason: NetdiskSettingsProvisionReasonSchema,
    /** Startup assembly diagnostics only; never secret values or execution permission. */
    runtimeMissing: z
      .array(
        z.enum([
          'ACTIVE_MODE',
          'SECRET_ROOT',
          'SPOOL_ROOT',
          'BAIDU_PROVIDER',
          'RCLONE_CONFIG',
          'RECOVERY_ACCOUNTS',
          'RECOVERY_RUNTIME',
        ]),
      )
      .optional(),
    configured: NetdiskSettingsValuesSchema,
    effective: NetdiskSettingsValuesSchema,
    clamps: z.array(NetdiskSettingsClampSchema).max(16),
    activity: z
      .object({
        activeJobs: z.number().int().nonnegative(),
        waitingJobs: z.number().int().nonnegative(),
        resources: z
          .object({
            maxInFlight: TransferResourceStatsSchema,
            localPreparation: TransferResourceStatsSchema,
            upload: TransferResourceStatsSchema,
          })
          .strict(),
        spool: z
          .object({
            reservedBytes: z.string().regex(/^(?:0|[1-9][0-9]{0,29})$/),
            maxBytes: DecimalCapacitySchema,
            reserveBytes: z.string().regex(/^(?:0|[1-9][0-9]{0,29})$/),
            availableBytes: z.string().regex(/^(?:0|[1-9][0-9]{0,29})$/),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

const NetdiskSettingsPatchValuesSchema = NetdiskSettingsValuesSchema.innerType().partial().strict();

export const NetdiskSettingsPatchSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    mfaCode: MfaCodeSchema,
    settings: NetdiskSettingsPatchValuesSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value.settings).length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one setting is required',
      });
    }
  });

export type NetdiskSettingsValues = z.infer<typeof NetdiskSettingsValuesSchema>;
export type NetdiskSettingsPatch = z.infer<typeof NetdiskSettingsPatchSchema>;
export type NetdiskSettingsStatus = z.infer<typeof NetdiskSettingsStatusSchema>;
export type NetdiskResourceWaitKind = z.infer<typeof NetdiskResourceWaitKindSchema>;
