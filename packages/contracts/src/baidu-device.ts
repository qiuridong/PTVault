import { z } from 'zod';
export const BaiduDeviceInfoSchema = z
  .object({
    instanceId: z.string().uuid(),
    clientLabel: z.string().min(1).max(120),
    profileId: z.string().max(128).nullable(),
  })
  .strict();
export const BaiduDeviceStartSchema = z
  .object({
    instanceId: z.string().uuid(),
    mfaCode: z.string().regex(/^\d{6}$/),
    target: z
      .object({ id: z.string().uuid(), revision: z.number().int().nonnegative() })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
export const BaiduDeviceFlowSchema = z
  .object({
    flowId: z.string().uuid(),
    status: z.enum(['PENDING', 'COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED']),
    userCode: z.string().min(1).max(64).nullable(),
    verificationUrl: z.literal('https://openapi.baidu.com/device').nullable(),
    expiresAt: z.number().int().nonnegative(),
    nextPollAt: z.number().int().nonnegative(),
    completedConnectionId: z.string().uuid().nullable(),
    failureCode: z
      .enum([
        'NETWORK_RETRYABLE',
        'SAVE_RETRYABLE',
        'AUTHORIZATION_DENIED',
        'PROVIDER_REJECTED',
        'IDENTITY_MISMATCH',
        'SESSION_EXPIRED',
        'DEVICE_FLOW_RESTARTED',
      ])
      .nullable(),
  })
  .strict();
export type BaiduDeviceInfo = z.infer<typeof BaiduDeviceInfoSchema>;
export type BaiduDeviceStart = z.infer<typeof BaiduDeviceStartSchema>;
export type BaiduDeviceFlow = z.infer<typeof BaiduDeviceFlowSchema>;
