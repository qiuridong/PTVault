import { z } from 'zod';

import { LoginRequestSchema } from './auth.js';

export const BootstrapStatusSchema = z
  .object({ required: z.boolean(), available: z.boolean() })
  .strict();

const SetupTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const BootstrapBeginSchema = z
  .object({ setupToken: SetupTokenSchema, username: LoginRequestSchema.shape.username })
  .strict();

export const BootstrapEnrollmentSchema = z
  .object({
    enrollmentId: z.string().uuid(),
    otpauthUrl: z.string().max(2048).startsWith('otpauth://totp/'),
    expiresAt: z.number().int().positive(),
  })
  .strict();

export const BootstrapCompleteSchema = z
  .object({
    setupToken: SetupTokenSchema,
    enrollmentId: z.string().uuid(),
    password: LoginRequestSchema.shape.password,
    code: z.string().regex(/^[0-9]{6}$/),
  })
  .strict();

export const BootstrapCompleteResultSchema = z
  .object({ username: LoginRequestSchema.shape.username })
  .strict();

export type BootstrapEnrollment = z.infer<typeof BootstrapEnrollmentSchema>;

export const SetupUseCaseSchema = z.enum(['NETDISK', 'PT_OFFLOAD', 'JELLYFIN']);
const PathText = z.string().trim().min(1).max(4096).refine((value) => !/[\0\r\n]/.test(value));
const OptionalText = z.string().trim().min(1).max(512).nullable();

export const SetupValuesSchema = z
  .object({
    useCases: z.array(SetupUseCaseSchema).max(3).refine((values) => new Set(values).size === values.length),
    spoolRoot: PathText,
    sourceRoots: z.array(PathText).max(16),
    mediaHotRoot: PathText.nullable(),
    jellyfinUrl: z.string().url().max(2048).nullable(),
    jellyfinPathMaps: z.array(PathText).max(16),
    recoveryAccountIds: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)).max(8),
    baiduClient: z.enum(['DEFAULT', 'CUSTOM', 'NONE']),
    baiduClientId: OptionalText,
    baiduAppId: OptionalText,
    oneDriveClientId: OptionalText,
    oneDriveTenant: z.string().regex(/^[A-Za-z0-9.-]{1,128}$/),
    oauthCallbackOrigin: z.string().url().max(2048).nullable(),
  })
  .strict();

export const SetupSecretPatchSchema = z
  .object({
    jellyfinToken: z.string().trim().min(1).max(4096).nullable().optional(),
    baiduClientSecret: z.string().trim().min(1).max(512).nullable().optional(),
    oneDriveClientSecret: z.string().trim().min(1).max(512).nullable().optional(),
  })
  .strict();

export const SetupConfigPatchSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    values: SetupValuesSchema.partial(),
    secrets: SetupSecretPatchSchema.optional(),
    mfaCode: z.string().regex(/^[0-9]{6}$/),
    apply: z.boolean().default(false),
  })
  .strict();

export const SetupConfigViewSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    appliedRevision: z.number().int().nonnegative(),
    values: SetupValuesSchema,
    credentials: z.object({ jellyfinToken: z.boolean(), baiduClientSecret: z.boolean(), oneDriveClientSecret: z.boolean() }).strict(),
    pendingChanges: z.boolean(),
    lastError: z.enum(['APPLY_FAILED']).nullable(),
  })
  .strict();

export type SetupUseCase = z.infer<typeof SetupUseCaseSchema>;
export type SetupValues = z.infer<typeof SetupValuesSchema>;
export type SetupSecretPatch = z.infer<typeof SetupSecretPatchSchema>;
export type SetupConfigPatch = z.infer<typeof SetupConfigPatchSchema>;
export type SetupConfigView = z.infer<typeof SetupConfigViewSchema>;

export const SetupPathCheckRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('SOURCE'), path: PathText, pathMaps: z.array(PathText).max(16).default([]), expectedBytes: z.string().regex(/^(0|[1-9][0-9]{0,29})$/).optional() }).strict(),
  z.object({ kind: z.literal('SPOOL') }).strict(),
]);

export const SetupPathCheckResultSchema = z.object({
  kind: z.enum(['SOURCE', 'SPOOL']),
  outcome: z.enum(['READABLE', 'WRITABLE', 'NOT_CONFIGURED', 'NOT_FOUND', 'PERMISSION_DENIED', 'OUTSIDE_ALLOWED_ROOT', 'SYMLINK_ESCAPE', 'NOT_FILE', 'NOT_DIRECTORY', 'SIZE_CHANGED', 'PATH_CHANGED', 'IO_ERROR', 'PATH_OVERLAP']),
  reportedPath: PathText.nullable(),
  hostPath: PathText.nullable(),
  serviceUser: z.string().max(256),
  serviceUid: z.number().int().nonnegative().nullable(),
  bytesRead: z.number().int().min(0).max(1),
  sizeBytes: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
  availableBytes: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
  suggestedBudget: z.object({ maxBytes: z.string(), reserveBytes: z.string() }).strict().nullable(),
}).strict();

export type SetupPathCheckResult = z.infer<typeof SetupPathCheckResultSchema>;

export const SetupCheckSchema = z.object({
  id: z.enum(['NETDISK_RUNTIME', 'BAIDU_SOURCE', 'DESTINATION', 'RECOVERY_ACCOUNTS', 'RECOVERY_MATERIAL', 'SPOOL', 'QB_CONNECTION', 'QB_PATHS', 'JELLYFIN', 'CREATION']),
  label: z.string().max(100),
  state: z.enum(['READY', 'NEEDS_SETUP', 'NOT_SELECTED']),
  detail: z.string().max(500),
  href: z.string().regex(/^\/(?!\/)[A-Za-z0-9/?=&._#%-]*$/),
}).strict();

export const SetupOverviewSchema = z.object({
  configurationSource: z.enum(['MANAGED_INSTALLER', 'SERVER_ENVIRONMENT']),
  configuration: SetupConfigViewSchema.nullable(),
  useCases: z.array(SetupUseCaseSchema).max(3),
  applying: z.boolean(),
  checks: z.array(SetupCheckSchema).max(16),
  runtime: z.object({ mode: z.enum(['SHADOW', 'ACTIVE']), netdiskConfigured: z.boolean(), netdiskCreationEnabled: z.boolean(), offloadConfigured: z.boolean(), publicationEnabled: z.boolean() }).strict(),
}).strict();

export const SetupSaveResultSchema = z.object({
  configuration: SetupConfigViewSchema,
  activation: z.enum(['SAVED', 'APPLYING', 'WAITING_FOR_IDLE', 'ALREADY_APPLIED']),
}).strict();

export type SetupOverview = z.infer<typeof SetupOverviewSchema>;
export type SetupCheck = z.infer<typeof SetupCheckSchema>;
export type SetupSaveResult = z.infer<typeof SetupSaveResultSchema>;

export const SetupApplyRequestSchema = z.object({ revision: z.number().int().nonnegative(), mfaCode: z.string().regex(/^[0-9]{6}$/) }).strict();
