import { z } from 'zod';

export const CloudProviderSchema = z.enum(['BAIDU', 'ONEDRIVE']);

export const CloudConnectionAuthStateSchema = z.enum([
  'CONNECTED',
  'REAUTH_REQUIRED',
  'DISABLED',
  'DISCONNECTED',
  'ERROR',
]);

export const CloudConnectionProvisionStateSchema = z.enum([
  'NOT_REQUESTED',
  'PROVISIONING',
  'READY',
  'PROVISION_FAILED',
]);

export const CloudConnectionCapabilitySchema = z.enum([
  'SOURCE_BROWSE',
  'SOURCE_DOWNLOAD',
  'SHARE_TRANSFER',
  'SOURCE_DELETE',
  'ARCHIVE_DESTINATION',
  'JELLYFIN_MOUNT',
  'RECOVERY_ELIGIBLE',
  'RECOVERY_ACTIVE',
]);

/**
 * Actions are explicit server authority, not UI inference from provider/state.
 * The deployment envelope advertises the globally wired subset and each
 * connection advertises the state-safe subset currently available to it.
 */
export const CloudConnectionActionSchema = z.enum([
  'START_OAUTH',
  'REAUTHORIZE',
  'TEST',
  'EDIT',
  'ENABLE',
  'DISABLE',
  'DISCONNECT',
  'BROWSE',
  'PROVISION',
  'TAKEOVER_LEGACY',
]);

export const CloudConnectionReferenceKindSchema = z.enum([
  'SOURCE_IMPORT_JOB',
  'DESTINATION_IMPORT_JOB',
  'ACTIVE_OFFLOAD_JOB',
  'MOUNT',
  'CLOUD_CATALOG',
  'RECOVERY_COPY',
  'CLOUD_REPLICA',
  'STORAGE_BINDING',
]);

export const CloudConnectionReferenceSchema = z
  .object({
    kind: CloudConnectionReferenceKindSchema,
    count: z.number().int().nonnegative(),
  })
  .strict();

export const CloudConnectionRateLimitCodeSchema = z.enum([
  'PROVIDER_RATE_LIMITED',
  'BAIDU_RATE_LIMITED',
  'ONEDRIVE_RATE_LIMITED',
]);

export const CloudConnectionRateLimitSchema = z
  .object({
    retryAt: z.number().int().nonnegative().nullable(),
    code: CloudConnectionRateLimitCodeSchema.nullable(),
    updatedAt: z.number().int().nonnegative().nullable(),
    revision: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    const present = [value.retryAt, value.code, value.updatedAt].map((part) => part !== null);
    if (present.some(Boolean) && !present.every(Boolean)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Rate-limit fields must be present or absent together',
      });
    }
  });

/**
 * The only cloud-connection projection allowed across the HTTP boundary.
 * Deliberately strict: encrypted references and provider credentials are not
 * merely omitted by convention; an attempted addition fails validation.
 */
export const CloudConnectionSchema = z
  .object({
    id: z.string().uuid(),
    provider: CloudProviderSchema,
    label: z.string().trim().min(1).max(64),
    principalMasked: z.string().min(1).max(120),
    authState: CloudConnectionAuthStateSchema,
    provisionState: CloudConnectionProvisionStateSchema,
    capabilities: z.array(CloudConnectionCapabilitySchema).max(32),
    supportedActions: z.array(CloudConnectionActionSchema).max(16),
    accessExpiresAt: z.number().int().nonnegative().nullable(),
    revision: z.number().int().nonnegative(),
    lastCheckedAt: z.number().int().nonnegative().nullable(),
    legacy: z.boolean(),
    readOnly: z.boolean(),
    clientProfile: z
      .object({
        id: z.string().min(1).max(128),
        appIdKnown: z.boolean(),
        downloadVerification: z.literal('NOT_PERFORMED_BY_LOGIN'),
      })
      .strict()
      .optional(),
    rateLimit: CloudConnectionRateLimitSchema,
    activeJobCount: z.number().int().nonnegative(),
    activeReferences: z.array(CloudConnectionReferenceSchema).max(32),
    storageAccountIds: z.array(z.string().min(1).max(128)).max(64),
    provisionFailureCode: z.string().min(1).max(64).nullable(),
  })
  .strict();

export const CloudConnectionCapabilitiesSchema = z
  .object({
    oauthEnabled: z.boolean(),
    baiduDeviceEnabled: z.boolean().optional(),
    providers: z.array(CloudProviderSchema).max(8),
    supportedActions: z.array(CloudConnectionActionSchema).max(16),
    disabledReason: z.enum(['NOT_CONFIGURED', 'FEATURE_DISABLED', 'SHADOW_MODE']).nullable(),
  })
  .strict();

export const CloudConnectionListResponseSchema = z
  .object({
    capabilities: CloudConnectionCapabilitiesSchema,
    connections: z.array(CloudConnectionSchema).max(64),
  })
  .strict();

export const CloudOAuthReturnToSchema = z.enum([
  '/storage-accounts',
  '/imports',
  '/settings/netdisk',
]);

export const CloudOAuthFlowStatusSchema = z.enum([
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'EXPIRED',
]);

export const CloudOAuthFailureCodeSchema = z.enum([
  'STATE_INVALID',
  'FLOW_EXPIRED',
  'FLOW_ALREADY_USED',
  'PROVIDER_MISMATCH',
  'SESSION_MISMATCH',
  'REDIRECT_URI_MISMATCH',
  'TOKEN_EXCHANGE_FAILED',
  'IDENTITY_MISMATCH',
  'USER_CANCELLED',
  'NOT_PROVISIONED',
]);

export const CloudOAuthStartInputSchema = z
  .object({
    provider: CloudProviderSchema,
    returnTo: CloudOAuthReturnToSchema,
    mfaCode: z.string().regex(/^[0-9]{6}$/),
  })
  .strict();

export const CloudOAuthStartResponseSchema = z
  .object({
    provider: CloudProviderSchema,
    flowId: z.string().uuid(),
    authorizationUrl: z.string().url(),
    expiresAt: z.number().int().nonnegative(),
    status: z.literal('PENDING'),
    returnTo: CloudOAuthReturnToSchema,
  })
  .strict();

export const CloudOAuthFlowSchema = z
  .object({
    provider: CloudProviderSchema,
    flowId: z.string().uuid(),
    expiresAt: z.number().int().nonnegative(),
    status: CloudOAuthFlowStatusSchema,
    returnTo: CloudOAuthReturnToSchema,
    completedConnectionId: z.string().uuid().nullable(),
    failure: CloudOAuthFailureCodeSchema.nullable(),
  })
  .strict();

export const CloudOAuthCallbackResultSchema = CloudOAuthFlowSchema;

export const CloudOAuthCallbackParamsSchema = z.object({ provider: CloudProviderSchema }).strict();

export const CloudOAuthCallbackQuerySchema = z
  .object({
    state: z.string().min(32).max(1024),
    code: z.string().min(1).max(4096).optional(),
    error: z.enum(['access_denied']).optional(),
  })
  .strict()
  .refine((value) => (value.code === undefined) !== (value.error === undefined), {
    message: 'Exactly one callback result is required',
  });

export const CloudConnectionIdParamsSchema = z.object({ id: z.string().uuid() }).strict();

export const CloudOAuthFlowIdParamsSchema = z.object({ flowId: z.string().uuid() }).strict();

export const CloudConnectionRevisionMutationSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    mfaCode: z.string().regex(/^[0-9]{6}$/),
  })
  .strict();

export const CloudConnectionPatchSchema = CloudConnectionRevisionMutationSchema.extend({
  label: z.string().trim().min(1).max(64),
}).strict();

export const CloudConnectionReauthorizeSchema = CloudConnectionRevisionMutationSchema.extend({
  returnTo: CloudOAuthReturnToSchema,
}).strict();

export const CloudConnectionTestInputSchema = CloudConnectionRevisionMutationSchema;
export const CloudConnectionEnableSchema = CloudConnectionRevisionMutationSchema;

export const CloudIdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);

export const CloudConnectionMutationResponseSchema = z
  .object({ connection: CloudConnectionSchema })
  .strict();

export const CloudConnectionReferenceSummarySchema = z
  .object({
    activeImportJobs: z.number().int().nonnegative(),
    destinationImportJobs: z.number().int().nonnegative(),
    activeOffloadJobs: z.number().int().nonnegative(),
    mounts: z.number().int().nonnegative(),
    storageBindings: z.number().int().nonnegative(),
    activeCatalogEntries: z.number().int().nonnegative(),
    recoveryCopies: z.number().int().nonnegative(),
    activeCloudReplicas: z.number().int().nonnegative(),
  })
  .strict();

export const CloudConnectionErrorCodeSchema = z.enum([
  'NOT_PROVISIONED',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_KEY_CONFLICT',
  'IDEMPOTENCY_OPERATION_IN_PROGRESS',
  'IDEMPOTENCY_RECEIPT_CORRUPT',
  'MFA_STEP_UP_FAILED',
  'INVALID_REQUEST',
  'CONNECTION_NOT_FOUND',
  'CONNECTION_REVISION_CONFLICT',
  'CONNECTION_READ_ONLY',
  'CONNECTION_REFERENCED',
  'CONNECTION_AUTH_STATE_INVALID',
  'CONNECTION_TEST_FAILED',
  'FLOW_NOT_FOUND',
  'STATE_INVALID',
  'FLOW_EXPIRED',
  'FLOW_ALREADY_USED',
  'PROVIDER_MISMATCH',
  'SESSION_MISMATCH',
  'REDIRECT_URI_MISMATCH',
  'TOKEN_EXCHANGE_FAILED',
  'IDENTITY_MISMATCH',
  'USER_CANCELLED',
]);

export const CloudConnectionErrorResponseSchema = z
  .object({
    error: z.string().min(1).max(128),
    code: CloudConnectionErrorCodeSchema,
    references: CloudConnectionReferenceSummarySchema.optional(),
  })
  .strict();

/**
 * Compile-time and test-time source of truth for the HTTP control protocol.
 * Callback is deliberately absent: it is a provider-facing GET that returns a
 * minimal close page, not a browser application JSON operation.
 */
export const CLOUD_CONNECTION_HTTP_CONTRACT = {
  list: {
    method: 'GET',
    path: '/api/storage/connections',
    csrf: false,
    recentMfa: false,
    revision: false,
    idempotencyKey: false,
  },
  start: {
    method: 'POST',
    path: '/api/storage/connections/oauth/start',
    csrf: true,
    recentMfa: true,
    revision: false,
    idempotencyKey: true,
  },
  poll: {
    method: 'GET',
    path: '/api/storage/connections/oauth/flows/:flowId',
    csrf: false,
    recentMfa: false,
    revision: false,
    idempotencyKey: false,
  },
  test: {
    method: 'POST',
    path: '/api/storage/connections/:id/test',
    csrf: true,
    recentMfa: true,
    revision: true,
    idempotencyKey: true,
  },
  patch: {
    method: 'PATCH',
    path: '/api/storage/connections/:id',
    csrf: true,
    recentMfa: true,
    revision: true,
    idempotencyKey: true,
  },
  reauthorize: {
    method: 'POST',
    path: '/api/storage/connections/:id/reauthorize',
    csrf: true,
    recentMfa: true,
    revision: true,
    idempotencyKey: true,
  },
  enable: {
    method: 'POST',
    path: '/api/storage/connections/:id/enable',
    csrf: true,
    recentMfa: true,
    revision: true,
    idempotencyKey: true,
  },
  disable: {
    method: 'POST',
    path: '/api/storage/connections/:id/disable',
    csrf: true,
    recentMfa: true,
    revision: true,
    idempotencyKey: true,
  },
  disconnect: {
    method: 'POST',
    path: '/api/storage/connections/:id/disconnect',
    csrf: true,
    recentMfa: true,
    revision: true,
    idempotencyKey: true,
  },
  browse: {
    method: 'GET',
    path: '/api/storage/connections/:id/browse',
    csrf: false,
    recentMfa: false,
    revision: false,
    idempotencyKey: false,
  },
  search: {
    method: 'GET',
    path: '/api/storage/connections/:id/search',
    csrf: false,
    recentMfa: false,
    revision: false,
    idempotencyKey: false,
  },
  provision: {
    method: 'POST',
    path: '/api/storage/connections/:id/provision',
    csrf: true,
    recentMfa: true,
    revision: true,
    idempotencyKey: true,
  },
  takeOverLegacy: {
    method: 'POST',
    path: '/api/storage/connections/:id/takeover-legacy',
    csrf: true,
    recentMfa: true,
    revision: true,
    idempotencyKey: true,
  },
} as const;

export type CloudProvider = z.infer<typeof CloudProviderSchema>;
export type CloudConnectionAuthState = z.infer<typeof CloudConnectionAuthStateSchema>;
export type CloudConnectionProvisionState = z.infer<typeof CloudConnectionProvisionStateSchema>;
export type CloudConnectionCapability = z.infer<typeof CloudConnectionCapabilitySchema>;
export type CloudConnectionAction = z.infer<typeof CloudConnectionActionSchema>;
export type CloudConnectionReferenceKind = z.infer<typeof CloudConnectionReferenceKindSchema>;
export type CloudConnectionReference = z.infer<typeof CloudConnectionReferenceSchema>;
export type CloudConnectionRateLimitCode = z.infer<typeof CloudConnectionRateLimitCodeSchema>;
export type CloudConnectionRateLimit = z.infer<typeof CloudConnectionRateLimitSchema>;
export type CloudConnection = z.infer<typeof CloudConnectionSchema>;
export type CloudConnectionCapabilities = z.infer<typeof CloudConnectionCapabilitiesSchema>;
export type CloudOAuthReturnTo = z.infer<typeof CloudOAuthReturnToSchema>;
export type CloudOAuthFlowStatus = z.infer<typeof CloudOAuthFlowStatusSchema>;
export type CloudOAuthFailureCode = z.infer<typeof CloudOAuthFailureCodeSchema>;
export type CloudOAuthStartInput = z.infer<typeof CloudOAuthStartInputSchema>;
export type CloudOAuthStartResponse = z.infer<typeof CloudOAuthStartResponseSchema>;
export type CloudOAuthFlow = z.infer<typeof CloudOAuthFlowSchema>;
export type CloudConnectionReferenceSummary = z.infer<typeof CloudConnectionReferenceSummarySchema>;
