import {
  TransferSettingsIdempotencyKeySchema,
  TransferSettingsPatchSchema,
} from '@ptvault/contracts';
import type { FastifyInstance, onRequestHookHandler, preHandlerAsyncHookHandler } from 'fastify';

import type { AuditRepository } from '../audit/repository.js';
import { AuthError, type AuthService } from '../auth/service.js';
import { TransferSettingsError, type TransferSettingsService } from './transfer-settings.js';

export type TransferSettingsRouteDependencies = {
  service: TransferSettingsService;
  auth: Pick<AuthService, 'verifyStepUp'>;
  audit: Pick<AuditRepository, 'append'>;
  requireSession: preHandlerAsyncHookHandler;
  protectCsrf: onRequestHookHandler;
};

function idempotencyKey(headers: Record<string, unknown>): string | null {
  const raw = headers['idempotency-key'];
  const value: unknown = Array.isArray(raw) ? raw[0] : raw;
  const parsed = TransferSettingsIdempotencyKeySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function registerTransferSettingsRoutes(
  app: FastifyInstance,
  deps: TransferSettingsRouteDependencies,
): void {
  app.get('/api/settings/transfers', { preHandler: deps.requireSession }, (_request, reply) =>
    reply.send(deps.service.status()),
  );

  app.patch(
    '/api/settings/transfers',
    { onRequest: deps.protectCsrf, preHandler: deps.requireSession },
    (request, reply) => {
      const admin = request.authenticatedAdmin;
      if (!admin) return reply.code(401).send({ error: 'Unauthorized' });
      const key = idempotencyKey(request.headers);
      if (key === null) {
        return reply
          .code(400)
          .send({ error: 'Idempotency-Key is required', code: 'IDEMPOTENCY_KEY_REQUIRED' });
      }
      const parsed = TransferSettingsPatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Invalid transfer settings',
          code: 'TRANSFER_SETTINGS_INVALID_PROFILE',
        });
      }
      if (parsed.data.netdisk !== undefined) {
        deps.audit.append({
          actorAdminId: admin.adminId,
          sourceIp: request.ip,
          action: 'TRANSFER_SETTINGS_UPDATE',
          subject: 'transfer-runtime',
          outcome: 'DENIED',
          correlationId: request.id,
          detail: { reason: 'NETDISK_SETTINGS_MOVED' },
        });
        return reply.code(409).send({
          error: 'NETDISK_SETTINGS_MOVED',
          code: 'NETDISK_SETTINGS_MOVED',
          settingsUrl: '/api/netdisk/settings',
        });
      }

      try {
        const replayed = deps.service.replay(key, parsed.data);
        if (replayed !== null) {
          deps.audit.append({
            actorAdminId: admin.adminId,
            sourceIp: request.ip,
            action: 'TRANSFER_SETTINGS_UPDATE',
            subject: 'transfer-runtime',
            outcome: 'SUCCESS',
            correlationId: request.id,
            detail: { revision: replayed.revision, replayed: true },
          });
          return reply.send(replayed);
        }
      } catch (error) {
        if (
          error instanceof TransferSettingsError &&
          error.code === 'TRANSFER_SETTINGS_IDEMPOTENCY_CONFLICT'
        ) {
          deps.audit.append({
            actorAdminId: admin.adminId,
            sourceIp: request.ip,
            action: 'TRANSFER_SETTINGS_UPDATE',
            subject: 'transfer-runtime',
            outcome: 'DENIED',
            correlationId: request.id,
            detail: { reason: error.code },
          });
          return reply.code(409).send({ error: error.code, code: error.code });
        }
        throw error;
      }

      try {
        deps.auth.verifyStepUp(admin.adminId, parsed.data.mfaCode);
      } catch (error) {
        deps.audit.append({
          actorAdminId: admin.adminId,
          sourceIp: request.ip,
          action: 'TRANSFER_SETTINGS_UPDATE',
          subject: 'transfer-runtime',
          outcome: 'DENIED',
          correlationId: request.id,
          detail: { reason: error instanceof AuthError ? error.code : 'MFA_FAILED' },
        });
        return reply.code(403).send({ error: 'Step-up verification failed' });
      }

      try {
        const response = deps.service.update({
          idempotencyKey: key,
          patch: parsed.data,
          adminId: admin.adminId,
        });
        deps.audit.append({
          actorAdminId: admin.adminId,
          sourceIp: request.ip,
          action: 'TRANSFER_SETTINGS_UPDATE',
          subject: 'transfer-runtime',
          outcome: 'SUCCESS',
          correlationId: request.id,
          detail: {
            revision: response.revision,
            offloadCreationEnabled: response.offload.configured.creationEnabled,
            offloadMaxInFlight: response.offload.configured.maxInFlight,
            offloadPreflightConcurrency: response.offload.configured.preflightConcurrency,
            offloadPauseSnapshotConcurrency: response.offload.configured.pauseSnapshotConcurrency,
            offloadMaxPausedPipelines: response.offload.configured.maxPausedPipelines,
            offloadHashConcurrency: response.offload.configured.hashConcurrency,
            offloadUploadConcurrency: response.offload.configured.uploadConcurrency,
            offloadReadbackConcurrency: response.offload.configured.readbackConcurrency,
            netdiskCreationEnabled: response.netdisk.configured.creationEnabled,
            netdiskMaxInFlight: response.netdisk.configured.maxInFlight,
          },
        });
        return reply.send(response);
      } catch (error) {
        if (error instanceof TransferSettingsError) {
          const status = error.code === 'TRANSFER_SETTINGS_INVALID_PROFILE' ? 400 : 409;
          deps.audit.append({
            actorAdminId: admin.adminId,
            sourceIp: request.ip,
            action: 'TRANSFER_SETTINGS_UPDATE',
            subject: 'transfer-runtime',
            outcome: 'DENIED',
            correlationId: request.id,
            detail: { reason: error.code },
          });
          return reply.code(status).send({ error: error.code, code: error.code });
        }
        throw error;
      }
    },
  );
}
