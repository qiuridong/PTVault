import {
  BaiduDeviceFlowSchema,
  BaiduDeviceInfoSchema,
  BaiduDeviceStartSchema,
  CloudConnectionEnableSchema,
  CloudConnectionIdParamsSchema,
  CloudConnectionListResponseSchema,
  CloudConnectionMutationResponseSchema,
  CloudConnectionPatchSchema,
  CloudConnectionReauthorizeSchema,
  CloudConnectionRevisionMutationSchema,
  CloudConnectionTestInputSchema,
  CloudIdempotencyKeySchema,
  CloudOAuthCallbackParamsSchema,
  CloudOAuthCallbackQuerySchema,
  CloudOAuthFlowIdParamsSchema,
  CloudOAuthStartInputSchema,
  CloudOAuthStartResponseSchema,
  BaiduConnectionBrowseQuerySchema,
  BaiduConnectionBrowseResponseSchema,
  BaiduConnectionSearchQuerySchema,
  BaiduConnectionSearchResponseSchema,
  OneDriveLegacyTakeoverInputSchema,
  OneDriveLegacyTakeoverResponseSchema,
  OneDriveProvisionInputSchema,
  OneDriveProvisionResponseSchema,
} from '@ptvault/contracts';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
  preHandlerAsyncHookHandler,
} from 'fastify';

import type { AuditInput, AuditRepository } from '../audit/repository.js';
import type { AuthService } from '../auth/service.js';
import { SESSION_COOKIE_NAME } from '../auth/guards.js';
import { DeviceFlowError } from './baidu-device.js';
import { BaiduDeviceError } from './baidu-device-transport.js';
import { digestToken } from '../core/crypto.js';
import {
  CloudConnectionOperationReceiptError,
  fingerprintCloudConnectionOperation,
  type CloudConnectionOperation,
  type CloudConnectionOperationHttpResponse,
  type CloudConnectionOperationScope,
} from './idempotency.js';
import { CloudConnectionError } from './oauth.js';
import { CloudConnectionReferencedError } from './repository.js';
import { OneDriveProvisionError } from './onedrive-provision.js';
import { BaiduApiError } from '../imports/baidu-official-gateway.js';
import type { CloudConnectionServices } from './services.js';

export type CloudConnectionRouteDependencies = {
  services: CloudConnectionServices;
  auth: Pick<AuthService, 'verifyStepUp'> & Partial<Pick<AuthService, 'requireSession'>>;
  audit: Pick<AuditRepository, 'append'>;
  requireSession: preHandlerAsyncHookHandler;
  protectCsrf: onRequestHookHandler;
};

const OAUTH_BINDING_COOKIE_NAME = 'ptvault_oauth_binding';
const OAUTH_BINDING_COOKIE_MAX_AGE_SECONDS = 300;
const OAUTH_CLOSE_PAGE =
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
  '<meta name="referrer" content="no-referrer"><title>授权已处理</title></head>' +
  '<body><p>授权结果已处理，可以关闭此窗口。</p><script>' +
  "history.replaceState(null,'','/api/storage/connections/oauth/callback/complete');" +
  "if(window.opener){window.opener.postMessage({type:'ptvault:oauth-callback'},location.origin);}" +
  'window.close();</script></body></html>';

export function registerCloudConnectionRoutes(
  app: FastifyInstance,
  deps: CloudConnectionRouteDependencies,
): void {
  const readGuard = { preHandler: deps.requireSession };
  const mutationGuard = { onRequest: deps.protectCsrf, preHandler: deps.requireSession };

  app.get('/api/storage/connections/baidu-device/info', readGuard, (_request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!deps.services.baiduDevice) return sendCloudError(reply, new CloudConnectionError('NOT_PROVISIONED', 503));
    return reply.send(BaiduDeviceInfoSchema.parse(deps.services.baiduDevice.info()));
  });
  app.post('/api/storage/connections/baidu-device/start', mutationGuard, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const admin = request.authenticatedAdmin;
    const raw = request.cookies[SESSION_COOKIE_NAME];
    if (!admin || !raw) return reply.code(401).send({ error: 'Unauthorized' });
    const key = idempotencyKey(request); if (!key) return sendIdempotencyRequired(reply);
    const body = BaiduDeviceStartSchema.safeParse(request.body); if (!body.success) return sendInvalidRequest(reply);
    try {
      if (!deps.services.baiduDevice) throw new CloudConnectionError('NOT_PROVISIONED', 503);
      const flow = await deps.services.baiduDevice.start({ adminId: admin.adminId, sessionHash: digestToken(raw), key, instanceId: body.data.instanceId, target: body.data.target }, () => verifyMfa(deps.auth, admin.adminId, body.data.mfaCode));
      audit(deps.audit, request, 'CLOUD_OAUTH_START', flow.flowId, 'SUCCESS', { provider: 'BAIDU', flowId: flow.flowId, status: flow.status });
      return reply.send(BaiduDeviceFlowSchema.parse(flow));
    } catch (error) { return sendCloudError(reply, error); }
  });
  for (const action of ['poll', 'cancel'] as const) app.post(`/api/storage/connections/baidu-device/flows/:flowId/${action}`, mutationGuard, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const admin = request.authenticatedAdmin;
    const raw = request.cookies[SESSION_COOKIE_NAME];
    if (!admin || !raw) return reply.code(401).send({ error: 'Unauthorized' });
    const params = CloudOAuthFlowIdParamsSchema.safeParse(request.params); if (!params.success) return sendInvalidRequest(reply);
    try {
      if (!deps.services.baiduDevice) throw new CloudConnectionError('NOT_PROVISIONED', 503);
      const actor = { adminId: admin.adminId, sessionHash: digestToken(raw) };
      const flow = action === 'cancel' ? deps.services.baiduDevice.cancel(params.data.flowId, actor) : await deps.services.baiduDevice.poll(params.data.flowId, actor, () => deps.auth.requireSession?.(raw)?.adminId === admin.adminId, connectionId => audit(deps.audit, request, 'CLOUD_OAUTH_CALLBACK', params.data.flowId, 'SUCCESS', { provider: 'BAIDU', flowId: params.data.flowId, connectionId, status: 'COMPLETED' }));
      return reply.send(BaiduDeviceFlowSchema.parse(flow));
    } catch (error) { return sendCloudError(reply, error); }
  });

  app.get('/api/storage/connections', readGuard, (_request, reply) => {
    const deploymentActions = new Set(deps.services.capabilities.supportedActions);
    const connections = deps.services.management.list().map((connection) => ({
      ...connection,
      supportedActions: connection.supportedActions.filter(
        (action) =>
          deploymentActions.has(action) &&
          deps.services.supportsConnectionAction(connection.provider, action),
      ),
    }));
    return reply.send(
      CloudConnectionListResponseSchema.parse({
        capabilities: deps.services.capabilities,
        connections,
      }),
    );
  });

  app.get('/api/storage/connections/:id/browse', readGuard, async (request, reply) => {
    const params = CloudConnectionIdParamsSchema.safeParse(request.params);
    const query = BaiduConnectionBrowseQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return sendInvalidRequest(reply);
    try {
      const browser = deps.services.baiduBrowse;
      if (browser === undefined) throw new BaiduApiError('BAIDU_BROWSE_NOT_CONFIGURED', null);
      const result = await browser.browse({
        connectionId: params.data.id,
        ...query.data,
        signal: request.signal,
      });
      return reply.send(BaiduConnectionBrowseResponseSchema.parse(result));
    } catch (error) {
      return sendBaiduBrowseError(reply, error);
    }
  });

  app.get('/api/storage/connections/:id/search', readGuard, async (request, reply) => {
    const params = CloudConnectionIdParamsSchema.safeParse(request.params);
    const query = BaiduConnectionSearchQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return sendInvalidRequest(reply);
    try {
      const browser = deps.services.baiduBrowse;
      if (browser?.search === undefined)
        throw new BaiduApiError('BAIDU_SEARCH_NOT_CONFIGURED', null);
      const result = await browser.search({
        connectionId: params.data.id,
        ...query.data,
        signal: request.signal,
      });
      return reply.send(BaiduConnectionSearchResponseSchema.parse(result));
    } catch (error) {
      return sendBaiduBrowseError(reply, error);
    }
  });

  app.post('/api/storage/connections/oauth/start', mutationGuard, (request, reply) => {
    const admin = request.authenticatedAdmin;
    if (!admin) return reply.code(401).send({ error: 'Unauthorized' });
    const key = idempotencyKey(request);
    if (key === null) return sendIdempotencyRequired(reply);
    const body = CloudOAuthStartInputSchema.safeParse(request.body);
    if (!body.success) return sendInvalidRequest(reply);
    const scope = operationScope(
      admin.adminId,
      'START_OAUTH',
      `provider:${body.data.provider}`,
      key,
      body.data,
    );
    const binding = oauthBinding(request, deps.services.oauthBindingToken(scope));
    try {
      const execution = deps.services.receipts.executeSync(scope, () => {
        verifyMfa(deps.auth, admin.adminId, body.data.mfaCode);
        return captureOperation(() => {
          const result = deps.services.oauth.start({
            provider: body.data.provider,
            returnTo: body.data.returnTo,
            adminId: admin.adminId,
            sessionFingerprint: binding.fingerprint,
          });
          audit(deps.audit, request, 'CLOUD_OAUTH_START', result.flowId, 'SUCCESS', {
            provider: result.provider,
            flowId: result.flowId,
          });
          return {
            statusCode: 200,
            body: CloudOAuthStartResponseSchema.parse(result),
          };
        });
      });
      if (execution.response.statusCode === 200) setOAuthBindingCookie(reply, binding.raw);
      return sendExecution(reply, execution.response);
    } catch (error) {
      return sendCloudError(reply, error);
    }
  });

  app.get('/api/storage/connections/oauth/callback/:provider', async (request, reply) => {
    const params = CloudOAuthCallbackParamsSchema.safeParse(request.params);
    const query = CloudOAuthCallbackQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return sendOAuthClosePage(reply, 400);
    }
    let actorAdminId: string | undefined;
    try {
      const binding = callbackBinding(request);
      actorAdminId = deps.services.oauth.callbackAdminId(query.data.state, binding.fingerprint);
      const result = await deps.services.oauth.callback({
        provider: params.data.provider,
        state: query.data.state,
        ...(query.data.code === undefined ? {} : { code: query.data.code }),
        ...(query.data.error === undefined ? {} : { error: query.data.error }),
        adminId: actorAdminId,
        sessionFingerprint: binding.fingerprint,
        redirectUri: deps.services.oauth.redirectUri(params.data.provider),
      });
      audit(
        deps.audit,
        request,
        'CLOUD_OAUTH_CALLBACK',
        result.flowId,
        result.status === 'COMPLETED' ? 'SUCCESS' : 'ERROR',
        {
          provider: result.provider,
          flowId: result.flowId,
          status: result.status,
          connectionId: result.completedConnectionId,
        },
        actorAdminId,
      );
      return sendOAuthClosePage(reply, 200);
    } catch (error) {
      audit(
        deps.audit,
        request,
        'CLOUD_OAUTH_CALLBACK',
        'cloud-oauth',
        'ERROR',
        { reason: safeReason(error) },
        actorAdminId,
      );
      return sendOAuthClosePage(reply, cloudErrorResponse(error).statusCode);
    }
  });

  app.get('/api/storage/connections/oauth/flows/:flowId', readGuard, (request, reply) => {
    const admin = request.authenticatedAdmin;
    if (!admin) return reply.code(401).send({ error: 'Unauthorized' });
    const params = CloudOAuthFlowIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendInvalidRequest(reply);
    try {
      return reply.send(deps.services.oauth.poll(params.data.flowId, admin.adminId));
    } catch (error) {
      return sendCloudError(reply, error);
    }
  });

  app.post('/api/storage/connections/:id/reauthorize', mutationGuard, (request, reply) => {
    const admin = request.authenticatedAdmin;
    if (!admin) return reply.code(401).send({ error: 'Unauthorized' });
    const key = idempotencyKey(request);
    if (key === null) return sendIdempotencyRequired(reply);
    const params = CloudConnectionIdParamsSchema.safeParse(request.params);
    const body = CloudConnectionReauthorizeSchema.safeParse(request.body);
    if (!params.success || !body.success) return sendInvalidRequest(reply);
    const scope = operationScope(admin.adminId, 'REAUTHORIZE', params.data.id, key, body.data);
    const binding = oauthBinding(request, deps.services.oauthBindingToken(scope));
    try {
      const execution = deps.services.receipts.executeSync(scope, () => {
        verifyMfa(deps.auth, admin.adminId, body.data.mfaCode);
        return captureOperation(() => {
          const result = deps.services.oauth.startReauthorization({
            connectionId: params.data.id,
            expectedRevision: body.data.revision,
            returnTo: body.data.returnTo,
            adminId: admin.adminId,
            sessionFingerprint: binding.fingerprint,
          });
          audit(deps.audit, request, 'CLOUD_CONNECTION_REAUTHORIZE', params.data.id, 'SUCCESS', {
            provider: result.provider,
            flowId: result.flowId,
            revision: body.data.revision,
          });
          return {
            statusCode: 200,
            body: CloudOAuthStartResponseSchema.parse(result),
          };
        });
      });
      if (execution.response.statusCode === 200) setOAuthBindingCookie(reply, binding.raw);
      return sendExecution(reply, execution.response);
    } catch (error) {
      return sendCloudError(reply, error);
    }
  });

  app.post('/api/storage/connections/:id/test', mutationGuard, async (request, reply) => {
    const admin = request.authenticatedAdmin;
    if (!admin) return reply.code(401).send({ error: 'Unauthorized' });
    const key = idempotencyKey(request);
    if (key === null) return sendIdempotencyRequired(reply);
    const params = CloudConnectionIdParamsSchema.safeParse(request.params);
    const body = CloudConnectionTestInputSchema.safeParse(request.body);
    if (!params.success || !body.success) return sendInvalidRequest(reply);
    try {
      const execution = await deps.services.receipts.executeAsync(
        operationScope(admin.adminId, 'TEST', params.data.id, key, body.data),
        async () => {
          try {
            const proof = await deps.services.management.probeConnection({
              id: params.data.id,
              revision: body.data.revision,
            });
            return { kind: 'PROBED' as const, proof };
          } catch (error) {
            return { kind: 'ERROR' as const, response: cloudErrorResponse(error) };
          }
        },
        (outcome) => {
          if (outcome.kind === 'ERROR') return outcome.response;
          return captureOperation(() => {
            const connection = deps.services.management.recordSuccessfulProbe(outcome.proof);
            audit(deps.audit, request, 'CLOUD_CONNECTION_TEST', params.data.id, 'SUCCESS', {
              provider: connection.provider,
              revision: connection.revision,
            });
            return {
              statusCode: 200,
              body: CloudConnectionMutationResponseSchema.parse({ connection }),
            };
          });
        },
        () => verifyMfa(deps.auth, admin.adminId, body.data.mfaCode),
      );
      return sendExecution(reply, execution.response);
    } catch (error) {
      return sendCloudError(reply, error);
    }
  });

  app.post('/api/storage/connections/:id/provision', mutationGuard, async (request, reply) => {
    const admin = request.authenticatedAdmin;
    if (!admin) return reply.code(401).send({ error: 'Unauthorized' });
    const key = idempotencyKey(request);
    if (key === null) return sendIdempotencyRequired(reply);
    const params = CloudConnectionIdParamsSchema.safeParse(request.params);
    const body = OneDriveProvisionInputSchema.safeParse(request.body);
    if (!params.success || !body.success) return sendInvalidRequest(reply);
    try {
      const execution = await deps.services.receipts.executeAsync(
        operationScope(admin.adminId, 'PROVISION', params.data.id, key, body.data),
        async () => {
          try {
            const provisioner = deps.services.oneDriveProvision;
            if (provisioner === undefined) {
              throw new OneDriveProvisionError('ONEDRIVE_PROVISION_DISABLED');
            }
            const result = await provisioner.provision({
              connectionId: params.data.id,
              expectedRevision: body.data.revision,
              signal: request.signal,
            });
            return { kind: 'PROVISIONED' as const, result };
          } catch (error) {
            return { kind: 'ERROR' as const, response: cloudErrorResponse(error) };
          }
        },
        (outcome) => {
          if (outcome.kind === 'ERROR') return outcome.response;
          audit(deps.audit, request, 'CLOUD_CONNECTION_PROVISION', params.data.id, 'SUCCESS', {
            accountId: outcome.result.accountId,
            profileId: outcome.result.profileId,
            revision: outcome.result.connectionRevision,
          });
          return {
            statusCode: 200,
            body: OneDriveProvisionResponseSchema.parse(outcome.result),
          };
        },
        () => verifyMfa(deps.auth, admin.adminId, body.data.mfaCode),
      );
      return sendExecution(reply, execution.response);
    } catch (error) {
      return sendCloudError(reply, error);
    }
  });

  app.post(
    '/api/storage/connections/:id/takeover-legacy',
    mutationGuard,
    async (request, reply) => {
      const admin = request.authenticatedAdmin;
      if (!admin) return reply.code(401).send({ error: 'Unauthorized' });
      const key = idempotencyKey(request);
      if (key === null) return sendIdempotencyRequired(reply);
      const params = CloudConnectionIdParamsSchema.safeParse(request.params);
      const body = OneDriveLegacyTakeoverInputSchema.safeParse(request.body);
      if (!params.success || !body.success) return sendInvalidRequest(reply);
      try {
        const execution = await deps.services.receipts.executeAsync(
          operationScope(admin.adminId, 'TAKEOVER_LEGACY', params.data.id, key, body.data),
          async () => {
            try {
              const provisioner = deps.services.oneDriveProvision;
              if (provisioner === undefined) {
                throw new OneDriveProvisionError('ONEDRIVE_PROVISION_DISABLED');
              }
              const result = await provisioner.takeOverLegacy({
                connectionId: params.data.id,
                expectedConnectionRevision: body.data.revision,
                accountId: body.data.accountId,
                expectedAccountRevision: body.data.accountRevision,
                expectedRawRemote: body.data.rawRemote,
                expectedCryptRemote: body.data.cryptRemote,
                signal: request.signal,
              });
              return { kind: 'TAKEN_OVER' as const, result };
            } catch (error) {
              return { kind: 'ERROR' as const, response: cloudErrorResponse(error) };
            }
          },
          (outcome) => {
            if (outcome.kind === 'ERROR') return outcome.response;
            audit(deps.audit, request, 'CLOUD_CONNECTION_TAKEOVER', params.data.id, 'SUCCESS', {
              accountId: outcome.result.accountId,
              accountRevision: outcome.result.accountRevision,
              revision: outcome.result.connectionRevision,
            });
            return {
              statusCode: 200,
              body: OneDriveLegacyTakeoverResponseSchema.parse(outcome.result),
            };
          },
          () => verifyMfa(deps.auth, admin.adminId, body.data.mfaCode),
        );
        return sendExecution(reply, execution.response);
      } catch (error) {
        return sendCloudError(reply, error);
      }
    },
  );

  app.patch('/api/storage/connections/:id', mutationGuard, (request, reply) => {
    const admin = request.authenticatedAdmin;
    if (!admin) return reply.code(401).send({ error: 'Unauthorized' });
    const key = idempotencyKey(request);
    if (key === null) return sendIdempotencyRequired(reply);
    const params = CloudConnectionIdParamsSchema.safeParse(request.params);
    const body = CloudConnectionPatchSchema.safeParse(request.body);
    if (!params.success || !body.success) return sendInvalidRequest(reply);
    return executeConnectionMutation({
      deps,
      request,
      reply,
      adminId: admin.adminId,
      operation: 'EDIT',
      resourceId: params.data.id,
      key,
      body: body.data,
      auditAction: 'CLOUD_CONNECTION_LABEL_UPDATE',
      action: () =>
        deps.services.management.patchLabel({
          id: params.data.id,
          revision: body.data.revision,
          label: body.data.label,
        }),
    });
  });

  for (const operation of ['enable', 'disable', 'disconnect'] as const) {
    app.post(`/api/storage/connections/:id/${operation}`, mutationGuard, (request, reply) => {
      const admin = request.authenticatedAdmin;
      if (!admin) return reply.code(401).send({ error: 'Unauthorized' });
      const key = idempotencyKey(request);
      if (key === null) return sendIdempotencyRequired(reply);
      const params = CloudConnectionIdParamsSchema.safeParse(request.params);
      const schema =
        operation === 'enable'
          ? CloudConnectionEnableSchema
          : CloudConnectionRevisionMutationSchema;
      const body = schema.safeParse(request.body);
      if (!params.success || !body.success) return sendInvalidRequest(reply);
      return executeConnectionMutation({
        deps,
        request,
        reply,
        adminId: admin.adminId,
        operation: operation.toUpperCase() as 'ENABLE' | 'DISABLE' | 'DISCONNECT',
        resourceId: params.data.id,
        key,
        body: body.data,
        auditAction:
          operation === 'enable'
            ? 'CLOUD_CONNECTION_ENABLE'
            : operation === 'disable'
              ? 'CLOUD_CONNECTION_DISABLE'
              : 'CLOUD_CONNECTION_DISCONNECT',
        action: () =>
          deps.services.management[operation]({
            id: params.data.id,
            revision: body.data.revision,
          }),
      });
    });
  }
}

function executeConnectionMutation(input: {
  deps: CloudConnectionRouteDependencies;
  request: FastifyRequest;
  reply: FastifyReply;
  adminId: string;
  operation: 'EDIT' | 'ENABLE' | 'DISABLE' | 'DISCONNECT';
  resourceId: string;
  key: string;
  body: { revision: number; mfaCode: string };
  auditAction: AuditInput['action'];
  action: () => ReturnType<CloudConnectionServices['management']['patchLabel']>;
}) {
  try {
    const execution = input.deps.services.receipts.executeSync(
      operationScope(input.adminId, input.operation, input.resourceId, input.key, input.body),
      () => {
        verifyMfa(input.deps.auth, input.adminId, input.body.mfaCode);
        return captureOperation(() => {
          const connection = input.action();
          audit(input.deps.audit, input.request, input.auditAction, input.resourceId, 'SUCCESS', {
            provider: connection.provider,
            revision: connection.revision,
          });
          return {
            statusCode: 200,
            body: CloudConnectionMutationResponseSchema.parse({ connection }),
          };
        });
      },
    );
    return sendExecution(input.reply, execution.response);
  } catch (error) {
    return sendCloudError(input.reply, error);
  }
}

function operationScope(
  adminId: string,
  operation: CloudConnectionOperation,
  resourceId: string,
  key: string,
  body: unknown,
): CloudConnectionOperationScope {
  return {
    adminId,
    operation,
    resourceId,
    idempotencyKey: key,
    requestFingerprint: fingerprintCloudConnectionOperation(body),
  };
}

function idempotencyKey(request: FastifyRequest): string | null {
  const raw = request.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = CloudIdempotencyKeySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function verifyMfa(auth: Pick<AuthService, 'verifyStepUp'>, adminId: string, code: string): void {
  try {
    auth.verifyStepUp(adminId, code);
  } catch {
    throw new CloudConnectionError('MFA_STEP_UP_FAILED', 403);
  }
}

function oauthBinding(
  request: FastifyRequest,
  deterministicFallback: string,
): { raw: string; fingerprint: string } {
  const existing = request.cookies[OAUTH_BINDING_COOKIE_NAME];
  const raw = existing && /^[A-Za-z0-9_-]{43}$/.test(existing) ? existing : deterministicFallback;
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) throw new Error('INVALID_OAUTH_BINDING_TOKEN');
  return { raw, fingerprint: digestToken(raw) };
}

function callbackBinding(request: FastifyRequest): { raw: string; fingerprint: string } {
  const raw = request.cookies[OAUTH_BINDING_COOKIE_NAME];
  if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) {
    throw new CloudConnectionError('SESSION_MISMATCH', 403);
  }
  return { raw, fingerprint: digestToken(raw) };
}

function setOAuthBindingCookie(reply: FastifyReply, raw: string): void {
  reply.setCookie(OAUTH_BINDING_COOKIE_NAME, raw, {
    path: '/api/storage/connections',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: OAUTH_BINDING_COOKIE_MAX_AGE_SECONDS,
  });
}

function clearOAuthBindingCookie(reply: FastifyReply): void {
  reply.clearCookie(OAUTH_BINDING_COOKIE_NAME, {
    path: '/api/storage/connections',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
  });
}

function sendOAuthClosePage(reply: FastifyReply, statusCode: number) {
  clearOAuthBindingCookie(reply);
  return reply
    .code(statusCode)
    .header('cache-control', 'no-store')
    .header(
      'content-security-policy',
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    )
    .type('text/html; charset=utf-8')
    .send(OAUTH_CLOSE_PAGE);
}

function captureOperation(
  operation: () => CloudConnectionOperationHttpResponse,
): CloudConnectionOperationHttpResponse {
  try {
    return operation();
  } catch (error) {
    return cloudErrorResponse(error);
  }
}

function cloudErrorResponse(error: unknown): CloudConnectionOperationHttpResponse {
  if (error instanceof DeviceFlowError) return { statusCode: error.code === 'DEVICE_FLOW_RESTARTED' ? 410 : 409, body: { code: error.code, error: error.code } };
  if (error instanceof BaiduDeviceError) return { statusCode: 502, body: { code: error.code, error: error.code } };
  if (error instanceof CloudConnectionReferencedError) {
    return {
      statusCode: 409,
      body: { error: error.code, code: error.code, references: error.references },
    };
  }
  if (error instanceof CloudConnectionOperationReceiptError) {
    return {
      statusCode: error.code === 'IDEMPOTENCY_RECEIPT_CORRUPT' ? 500 : 409,
      body: { error: error.code, code: error.code },
    };
  }
  if (error instanceof OneDriveProvisionError) {
    return {
      statusCode: oneDriveProvisionErrorStatus(error.code),
      body: { error: error.code, code: error.code },
    };
  }
  if (error instanceof CloudConnectionError) {
    return { statusCode: error.statusCode, body: { error: error.code, code: error.code } };
  }
  return {
    statusCode: 500,
    body: { error: 'Internal Server Error', code: 'CONNECTION_AUTH_STATE_INVALID' },
  };
}

function oneDriveProvisionErrorStatus(code: string): number {
  if (code === 'ONEDRIVE_CONNECTION_NOT_FOUND' || code === 'ONEDRIVE_LEGACY_ACCOUNT_NOT_FOUND') {
    return 404;
  }
  if (code === 'ONEDRIVE_PROVISION_DISABLED') return 503;
  if (
    code === 'ONEDRIVE_ESCROW_VERIFY_FAILED' ||
    code === 'ONEDRIVE_CRYPT_ROUNDTRIP_FAILED' ||
    code === 'ONEDRIVE_PROVISION_FAILED'
  ) {
    return 502;
  }
  return 409;
}

function sendExecution(reply: FastifyReply, response: CloudConnectionOperationHttpResponse) {
  return reply.code(response.statusCode).send(response.body);
}

function sendInvalidRequest(reply: FastifyReply) {
  return reply.code(400).send({ error: 'Invalid request', code: 'INVALID_REQUEST' });
}

function sendIdempotencyRequired(reply: FastifyReply) {
  return reply
    .code(400)
    .send({ error: 'Idempotency-Key is required', code: 'IDEMPOTENCY_KEY_REQUIRED' });
}

function sendCloudError(reply: FastifyReply, error: unknown) {
  return sendExecution(reply, cloudErrorResponse(error));
}

function sendBaiduBrowseError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof BaiduApiError)) return sendCloudError(reply, error);
  if (error.code === 'RATE_LIMITED') {
    if (error.retryAfterMs !== null) {
      reply.header('retry-after', String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))));
    }
    return reply.code(429).send({ error: error.code, code: error.code });
  }
  if (error.code === 'BAIDU_CONNECTION_NOT_FOUND') {
    return reply.code(404).send({ error: error.code, code: error.code });
  }
  if (
    error.code === 'BAIDU_APP_PATH_INVALID' ||
    error.code === 'BAIDU_BROWSE_PAGE_INVALID' ||
    error.code === 'BAIDU_SEARCH_QUERY_INVALID'
  ) {
    return reply.code(400).send({ error: error.code, code: error.code });
  }
  if (
    error.code === 'BAIDU_CONNECTION_NOT_BROWSABLE' ||
    error.code === 'AUTH_IDENTITY_DRIFT' ||
    error.code === 'AUTH_EXPIRED' ||
    error.code === 'AUTH_SCOPE_INSUFFICIENT'
  ) {
    return reply.code(409).send({ error: error.code, code: error.code });
  }
  return reply.code(503).send({ error: error.code, code: error.code });
}

function audit(
  repository: Pick<AuditRepository, 'append'>,
  request: FastifyRequest,
  action: AuditInput['action'],
  subject: string,
  outcome: AuditInput['outcome'],
  detail: AuditInput['detail'],
  actorAdminId?: string,
): void {
  repository.append({
    actorAdminId: actorAdminId ?? request.authenticatedAdmin?.adminId ?? null,
    sourceIp: request.ip,
    action,
    subject,
    outcome,
    correlationId: request.id,
    detail,
  });
}

function safeReason(error: unknown): string {
  if (error instanceof CloudConnectionError) return error.code;
  if (error instanceof CloudConnectionReferencedError) return error.code;
  if (error instanceof CloudConnectionOperationReceiptError) return error.code;
  return 'INTERNAL_ERROR';
}
