import {
  BaiduConnectionBrowseQuerySchema,
  BaiduConnectionBrowseResponseSchema,
  BaiduConnectionSearchQuerySchema,
  BaiduConnectionSearchResponseSchema,
  CloudConnectionErrorResponseSchema,
  CloudConnectionIdParamsSchema,
  CloudConnectionListResponseSchema,
  CloudConnectionMutationResponseSchema,
  CloudConnectionPatchSchema,
  CloudConnectionReauthorizeSchema,
  CloudConnectionRevisionMutationSchema,
  CloudConnectionTestInputSchema,
  CloudIdempotencyKeySchema,
  CloudOAuthFlowIdParamsSchema,
  CloudOAuthFlowSchema,
  CloudOAuthReturnToSchema,
  CloudOAuthStartInputSchema,
  CloudOAuthStartResponseSchema,
  OneDriveLegacyTakeoverInputSchema,
  OneDriveLegacyTakeoverResponseSchema,
  OneDriveProvisionInputSchema,
  OneDriveProvisionResponseSchema,
  type BaiduConnectionBrowseResponse,
  type BaiduConnectionSearchResponse,
  type CloudConnection,
  type CloudOAuthFlow,
  type CloudOAuthReturnTo,
  type CloudOAuthStartResponse,
  type CloudProvider,
  type OneDriveLegacyTakeoverResponse,
  type OneDriveProvisionResponse,
} from '@ptvault/contracts';
import type { z } from 'zod';

import { ApiError, ContractError, apiControlMutation, apiGet } from '../../api/client.js';

export const cloudConnectionsQueryKey = ['storage', 'connections'] as const;

export type CloudConnectionListResponse = z.infer<typeof CloudConnectionListResponseSchema>;

export type Unavailable =
  | { supported: false; reason: 'ROUTE_ABSENT' }
  | { supported: false; reason: 'NOT_ENABLED'; status: 501 | 503 };
export type Available<T> = { supported: true; data: T };
export type Answer<T> = Available<T> | Unavailable;

/**
 * Deployment availability is deliberately narrower than ordinary request
 * failure. A missing connection/flow is a real domain error, not proof that the
 * whole route family is absent; likewise a failed provider test must stay a
 * failed test rather than being relabelled as an unconfigured deployment.
 */
function unavailableFrom(error: unknown): Unavailable | null {
  if (!(error instanceof ApiError)) return null;
  const domainNotFound = new Set([
    'CONNECTION_NOT_FOUND',
    'FLOW_NOT_FOUND',
    'BAIDU_CONNECTION_NOT_FOUND',
    'ONEDRIVE_CONNECTION_NOT_FOUND',
    'ONEDRIVE_LEGACY_ACCOUNT_NOT_FOUND',
  ]);
  if (error.status === 404 && (error.code === undefined || !domainNotFound.has(error.code))) {
    return { supported: false, reason: 'ROUTE_ABSENT' };
  }
  if (error.status === 501) return { supported: false, reason: 'NOT_ENABLED', status: 501 };
  if (
    error.status === 503 &&
    error.code !== undefined &&
    [
      'NOT_PROVISIONED',
      'BAIDU_BROWSE_NOT_CONFIGURED',
      'BAIDU_SEARCH_NOT_CONFIGURED',
      'ONEDRIVE_PROVISION_DISABLED',
    ].includes(error.code)
  ) {
    return { supported: false, reason: 'NOT_ENABLED', status: 503 };
  }
  return null;
}

async function answer<T>(run: () => Promise<T>): Promise<Answer<T>> {
  try {
    return { supported: true, data: await run() };
  } catch (error) {
    const unavailable = unavailableFrom(error);
    if (unavailable !== null) return unavailable;
    throw error;
  }
}

export function isSafeReturnTo(value: string): value is CloudOAuthReturnTo {
  return CloudOAuthReturnToSchema.safeParse(value).success;
}

function connectionPath(id: string, suffix = ''): string {
  const parsed = CloudConnectionIdParamsSchema.parse({ id });
  return `/api/storage/connections/${encodeURIComponent(parsed.id)}${suffix}`;
}

function flowPath(flowId: string): string {
  const parsed = CloudOAuthFlowIdParamsSchema.parse({ flowId });
  return `/api/storage/connections/oauth/flows/${encodeURIComponent(parsed.flowId)}`;
}

function key(value: string): string {
  return CloudIdempotencyKeySchema.parse(value);
}

async function mutateConnection(
  path: string,
  body: unknown,
  idempotencyKey: string,
  method: 'POST' | 'PATCH' = 'POST',
): Promise<CloudConnection> {
  const response = await apiControlMutation(path, body, CloudConnectionMutationResponseSchema, {
    idempotencyKey: key(idempotencyKey),
    method,
    errorSchema: CloudConnectionErrorResponseSchema,
  });
  return response.connection;
}

/** GET is the only list operation: no CSRF, recent MFA or idempotency header. */
export function getCloudConnections(): Promise<Answer<CloudConnectionListResponse>> {
  return answer(() => apiGet('/api/storage/connections', CloudConnectionListResponseSchema));
}

/** Starts a new one-shot OAuth flow. The caller owns key reuse per user intent. */
export function startOAuth(input: {
  provider: CloudProvider;
  returnTo: CloudOAuthReturnTo;
  mfaCode: string;
  idempotencyKey: string;
}): Promise<Answer<CloudOAuthStartResponse>> {
  const body = CloudOAuthStartInputSchema.parse({
    provider: input.provider,
    returnTo: input.returnTo,
    mfaCode: input.mfaCode,
  });
  return answer(() =>
    apiControlMutation(
      '/api/storage/connections/oauth/start',
      body,
      CloudOAuthStartResponseSchema,
      {
        idempotencyKey: key(input.idempotencyKey),
        errorSchema: CloudConnectionErrorResponseSchema,
      },
    ),
  );
}

/** Polling may expire a flow; 410 remains an error so USED and EXPIRED stay distinct. */
export function pollOAuthFlow(flowId: string): Promise<Answer<CloudOAuthFlow>> {
  return answer(() => apiGet(flowPath(flowId), CloudOAuthFlowSchema));
}

export function testConnection(input: {
  id: string;
  revision: number;
  mfaCode: string;
  idempotencyKey: string;
}): Promise<Answer<CloudConnection>> {
  const body = CloudConnectionTestInputSchema.parse({
    revision: input.revision,
    mfaCode: input.mfaCode,
  });
  return answer(() =>
    mutateConnection(connectionPath(input.id, '/test'), body, input.idempotencyKey),
  );
}

export function updateConnection(input: {
  id: string;
  revision: number;
  label: string;
  mfaCode: string;
  idempotencyKey: string;
}): Promise<Answer<CloudConnection>> {
  const body = CloudConnectionPatchSchema.parse({
    revision: input.revision,
    label: input.label,
    mfaCode: input.mfaCode,
  });
  return answer(() =>
    mutateConnection(connectionPath(input.id), body, input.idempotencyKey, 'PATCH'),
  );
}

export function reauthorizeConnection(input: {
  id: string;
  revision: number;
  returnTo: CloudOAuthReturnTo;
  mfaCode: string;
  idempotencyKey: string;
}): Promise<Answer<CloudOAuthStartResponse>> {
  const body = CloudConnectionReauthorizeSchema.parse({
    revision: input.revision,
    returnTo: input.returnTo,
    mfaCode: input.mfaCode,
  });
  return answer(() =>
    apiControlMutation(
      connectionPath(input.id, '/reauthorize'),
      body,
      CloudOAuthStartResponseSchema,
      {
        idempotencyKey: key(input.idempotencyKey),
        errorSchema: CloudConnectionErrorResponseSchema,
      },
    ),
  );
}

async function revisionMutation(
  input: { id: string; revision: number; mfaCode: string; idempotencyKey: string },
  suffix: '/enable' | '/disable' | '/disconnect',
): Promise<Answer<CloudConnection>> {
  const body = CloudConnectionRevisionMutationSchema.parse({
    revision: input.revision,
    mfaCode: input.mfaCode,
  });
  return answer(() =>
    mutateConnection(connectionPath(input.id, suffix), body, input.idempotencyKey),
  );
}

export function enableConnection(input: {
  id: string;
  revision: number;
  mfaCode: string;
  idempotencyKey: string;
}): Promise<Answer<CloudConnection>> {
  return revisionMutation(input, '/enable');
}

export function disableConnection(input: {
  id: string;
  revision: number;
  mfaCode: string;
  idempotencyKey: string;
}): Promise<Answer<CloudConnection>> {
  return revisionMutation(input, '/disable');
}

export function disconnectConnection(input: {
  id: string;
  revision: number;
  mfaCode: string;
  idempotencyKey: string;
}): Promise<Answer<CloudConnection>> {
  return revisionMutation(input, '/disconnect');
}

/**
 * Materialize one connected OneDrive identity into managed raw/crypt remotes.
 *
 * The response intentionally exposes aliases and ids only. Crypt material,
 * OAuth credentials and the escrow payload never cross this boundary.
 */
export function provisionOneDriveConnection(input: {
  id: string;
  revision: number;
  mfaCode: string;
  idempotencyKey: string;
}): Promise<Answer<OneDriveProvisionResponse>> {
  const body = OneDriveProvisionInputSchema.parse({
    revision: input.revision,
    mfaCode: input.mfaCode,
  });
  return answer(() =>
    apiControlMutation(
      connectionPath(input.id, '/provision'),
      body,
      OneDriveProvisionResponseSchema,
      { idempotencyKey: key(input.idempotencyKey) },
    ),
  );
}

/** Explicitly adopt one immutable legacy rclone binding after exact alias review. */
export function takeOverLegacyOneDriveAccount(input: {
  id: string;
  revision: number;
  mfaCode: string;
  accountId: string;
  accountRevision: number;
  rawRemote: string;
  cryptRemote: string;
  confirmTakeover: true;
  idempotencyKey: string;
}): Promise<Answer<OneDriveLegacyTakeoverResponse>> {
  const body = OneDriveLegacyTakeoverInputSchema.parse({
    revision: input.revision,
    mfaCode: input.mfaCode,
    accountId: input.accountId,
    accountRevision: input.accountRevision,
    rawRemote: input.rawRemote,
    cryptRemote: input.cryptRemote,
    confirmTakeover: input.confirmTakeover,
  });
  return answer(() =>
    apiControlMutation(
      connectionPath(input.id, '/takeover-legacy'),
      body,
      OneDriveLegacyTakeoverResponseSchema,
      { idempotencyKey: key(input.idempotencyKey) },
    ),
  );
}

/** Read one bounded page under the exact Baidu connection's selected directory. */
export function browseConnection(input: {
  id: string;
  path?: string;
  start?: number;
  limit?: number;
}): Promise<Answer<BaiduConnectionBrowseResponse>> {
  const query = BaiduConnectionBrowseQuerySchema.parse({
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.start === undefined ? {} : { start: input.start }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  const search = new URLSearchParams({
    path: query.path,
    start: String(query.start),
    limit: String(query.limit),
  });
  return answer(() =>
    apiGet(
      `${connectionPath(input.id, '/browse')}?${search.toString()}`,
      BaiduConnectionBrowseResponseSchema,
    ),
  );
}

/** Search the provider's name index, not the currently loaded browse page. */
export function searchConnection(input: {
  id: string;
  path: string;
  query: string;
  page?: number;
  limit?: number;
  signal?: AbortSignal;
}): Promise<Answer<BaiduConnectionSearchResponse>> {
  const query = BaiduConnectionSearchQuerySchema.parse({
    path: input.path,
    query: input.query,
    ...(input.page === undefined ? {} : { page: input.page }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  const params = new URLSearchParams({
    path: query.path,
    query: query.query,
    page: String(query.page),
    limit: String(query.limit),
  });
  const path = `${connectionPath(input.id, '/search')}?${params.toString()}`;
  return answer(async () => {
    const result = await apiGet(
      path,
      BaiduConnectionSearchResponseSchema,
      input.signal === undefined ? {} : { signal: input.signal },
    );
    if (
      result.connectionId !== input.id ||
      result.path !== query.path ||
      result.query !== query.query ||
      result.page !== query.page ||
      result.limit !== query.limit
    )
      throw new ContractError(path, 'search binding mismatch');
    return result;
  });
}
