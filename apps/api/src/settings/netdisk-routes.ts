import {
  NetdiskSettingsIdempotencyKeySchema,
  NetdiskSettingsPatchSchema,
} from '@ptvault/contracts';
import type { FastifyInstance, onRequestHookHandler, preHandlerAsyncHookHandler } from 'fastify';

import type { AuditRepository } from '../audit/repository.js';
import { AuthError, type AuthService } from '../auth/service.js';
import { NetdiskSettingsError, type NetdiskSettingsService } from './netdisk-settings.js';

export type NetdiskSettingsRouteDependencies = {
  service: NetdiskSettingsService;
  auth: Pick<AuthService, 'verifyStepUp'>;
  audit: Pick<AuditRepository, 'append'>;
  requireSession: preHandlerAsyncHookHandler;
  protectCsrf: onRequestHookHandler;
};

function idempotencyKey(headers: Record<string, unknown>): string | null {
  const raw = headers['idempotency-key'];
  const value: unknown = Array.isArray(raw) ? raw[0] : raw;
  const parsed = NetdiskSettingsIdempotencyKeySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function registerNetdiskSettingsRoutes(
  app: FastifyInstance,
  deps: NetdiskSettingsRouteDependencies,
): void {
  app.get('/api/netdisk/settings', { preHandler: deps.requireSession }, (_request, reply) =>
    reply.send(deps.service.status()),
  );

  app.patch(
    '/api/netdisk/settings',
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
      const parsed = NetdiskSettingsPatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Invalid netdisk settings',
          code: 'NETDISK_SETTINGS_INVALID_PROFILE',
        });
      }

      // A durable completed response wins before step-up.  This makes a retry
      // after a dropped HTTP response neither spend a second TOTP nor write a
      // second revision.
      try {
        const replayed = deps.service.replay(admin.adminId, key, parsed.data);
        if (replayed !== null) {
          deps.audit.append({
            actorAdminId: admin.adminId,
            sourceIp: request.ip,
            action: 'NETDISK_SETTINGS_UPDATE',
            subject: 'netdisk-runtime',
            outcome: 'SUCCESS',
            correlationId: request.id,
            detail: { revision: replayed.revision, replayed: true },
          });
          return reply.send(replayed);
        }
      } catch (error) {
        if (
          error instanceof NetdiskSettingsError &&
          error.code === 'NETDISK_SETTINGS_IDEMPOTENCY_CONFLICT'
        ) {
          deps.audit.append({
            actorAdminId: admin.adminId,
            sourceIp: request.ip,
            action: 'NETDISK_SETTINGS_UPDATE',
            subject: 'netdisk-runtime',
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
          action: 'NETDISK_SETTINGS_UPDATE',
          subject: 'netdisk-runtime',
          outcome: 'DENIED',
          correlationId: request.id,
          detail: { reason: error instanceof AuthError ? error.code : 'MFA_FAILED' },
        });
        return reply.code(403).send({ error: 'Step-up verification failed' });
      }

      try {
        const response = deps.service.update({
          adminId: admin.adminId,
          idempotencyKey: key,
          patch: parsed.data,
        });
        deps.audit.append({
          actorAdminId: admin.adminId,
          sourceIp: request.ip,
          action: 'NETDISK_SETTINGS_UPDATE',
          subject: 'netdisk-runtime',
          outcome: 'SUCCESS',
          correlationId: request.id,
          detail: {
            revision: response.revision,
            creationEnabled: response.configured.creationEnabled,
            maxInFlight: response.configured.maxInFlight,
            localPreparationConcurrency: response.configured.localPreparationConcurrency,
            uploadConcurrency: response.configured.uploadConcurrency,
          },
        });
        return reply.send(response);
      } catch (error) {
        if (error instanceof NetdiskSettingsError) {
          const status =
            error.code === 'NETDISK_SETTINGS_INVALID_PROFILE' ||
            error.code === 'NETDISK_DEFAULT_SOURCE_INVALID' ||
            error.code === 'NETDISK_DEFAULT_DESTINATION_INVALID'
              ? 400
              : 409;
          deps.audit.append({
            actorAdminId: admin.adminId,
            sourceIp: request.ip,
            action: 'NETDISK_SETTINGS_UPDATE',
            subject: 'netdisk-runtime',
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
