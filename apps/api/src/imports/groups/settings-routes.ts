import { GroupSettingsPatchSchema, NetdiskSettingsIdempotencyKeySchema } from '@ptvault/contracts';
import type { FastifyInstance, onRequestHookHandler, preHandlerAsyncHookHandler } from 'fastify';
import type { AuthService } from '../../auth/service.js';
import type { AuditRepository } from '../../audit/repository.js';
import { ImportControlError } from '../errors.js';
import type { GroupSettingsService } from './settings.js';

export function registerGroupSettingsRoutes(
  app: FastifyInstance,
  deps: {
    service: GroupSettingsService;
    auth: Pick<AuthService, 'verifyStepUp'>;
    audit: Pick<AuditRepository, 'append'>;
    requireSession: preHandlerAsyncHookHandler;
    protectCsrf: onRequestHookHandler;
  },
): void {
  const path = '/api/import-pipelines/settings';
  app.get(path, { preHandler: deps.requireSession }, (_request, reply) =>
    reply.send(deps.service.status()),
  );
  app.patch(
    path,
    { onRequest: deps.protectCsrf, preHandler: deps.requireSession },
    (request, reply) => {
      const admin = request.authenticatedAdmin;
      if (!admin) return reply.code(401).send({ error: 'Unauthorized' });
      const key = NetdiskSettingsIdempotencyKeySchema.safeParse(request.headers['idempotency-key']);
      const body = GroupSettingsPatchSchema.safeParse(request.body);
      if (!key.success || !body.success)
        return reply
          .code(400)
          .send({ error: 'Invalid group settings request', code: 'GROUP_SETTINGS_INVALID' });
      const audit = (
        outcome: 'SUCCESS' | 'DENIED',
        detail: Record<string, string | number | boolean | null>,
      ) =>
        deps.audit.append({
          actorAdminId: admin.adminId,
          sourceIp: request.ip,
          action: 'IMPORT_PIPELINE_SETTINGS_UPDATED',
          subject: 'group-runtime',
          outcome,
          correlationId: request.id,
          detail,
        });
      try {
        // Replay precedes one-time MFA: a lost response must not cost a second code.
        const replayed = deps.service.replay(admin.adminId, key.data, body.data);
        if (replayed) {
          audit('SUCCESS', { revision: replayed.revision, replayed: true });
          return reply.send(replayed);
        }
        try {
          deps.auth.verifyStepUp(admin.adminId, body.data.mfaCode);
        } catch {
          audit('DENIED', { reason: 'MFA_FAILED' });
          return reply.code(403).send({ error: 'Step-up verification failed', code: 'MFA_FAILED' });
        }
        const response = deps.service.update(admin.adminId, key.data, body.data);
        audit('SUCCESS', { revision: response.revision });
        return reply.send(response);
      } catch (error) {
        if (!(error instanceof ImportControlError)) throw error;
        audit('DENIED', { reason: error.code });
        return reply
          .code(error.statusCode)
          .send({ error: 'Group settings request failed', code: error.code });
      }
    },
  );
}
