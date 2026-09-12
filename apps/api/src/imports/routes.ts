import type { FastifyInstance, onRequestHookHandler, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import {
  ArchiveCredentialsRequestSchema,
  LegacyImportSourceBindRequestSchema,
  LegacyImportSourceBindingSchema,
  ImportPipelineSummarySchema,
  ImportPipelineDetailSchema,
} from '@ptvault/contracts';

import type { AuditInput, AuditRepository } from '../audit/repository.js';
import { AuthError, type AuthService } from '../auth/service.js';
import { ImportControlError } from './errors.js';
import { ArchiveError } from './archive/inspection.js';
import {
  CreateImportRequestSchema,
  ImportCredentialsRequestSchema,
  ImportPlanRequestSchema,
  ImportSourceCleanupExecuteRequestSchema,
  ImportSourceCleanupPreviewRequestSchema,
  MediaPublicationRequestSchema,
} from './schemas.js';
import type { ImportControlService } from './service.js';

export type ImportRouteDependencies = {
  service: ImportControlService;
  audit: Pick<AuditRepository, 'append'>;
  auth: Pick<AuthService, 'verifyStepUp'>;
  requireSession: preHandlerAsyncHookHandler;
  protectCsrf: onRequestHookHandler;
};

function idempotencyHeader(headers: Record<string, unknown>): string | null {
  const raw = headers['idempotency-key'];
  const values: unknown[] | null = Array.isArray(raw) ? (raw as unknown[]) : null;
  const value: unknown = values === null ? raw : values[0];
  return typeof value === 'string' && value.length >= 8 && value.length <= 200 ? value : null;
}

function sendError(
  reply: Parameters<Parameters<FastifyInstance['setErrorHandler']>[0]>[2],
  error: unknown,
) {
  if (error instanceof ArchiveError)
    return reply.code(409).send({ error: 'Archive operation failed', code: error.code });
  if (error instanceof ImportControlError) {
    return reply
      .code(error.statusCode)
      .send({ error: 'Import operation failed', code: error.code });
  }
  throw error;
}

export function registerImportRoutes(app: FastifyInstance, deps: ImportRouteDependencies): void {
  app.get('/api/import-pipelines', { preHandler: deps.requireSession }, (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return {
      pipelines: deps.service
        .pipelineList()
        .map((value) => ImportPipelineSummarySchema.parse(value)),
    };
  });
  app.get(
    '/api/import-pipelines/:pipelineId',
    { preHandler: deps.requireSession },
    (request, reply) => {
      const params = z.object({ pipelineId: z.string().uuid() }).safeParse(request.params);
      const query = z
        .object({
          offset: z.coerce.number().int().min(0).max(10000).default(0),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        })
        .safeParse(request.query);
      if (!params.success || !query.success)
        return reply.code(400).send({ error: 'Invalid pipeline page' });
      try {
        reply.header('cache-control', 'no-store');
        return {
          pipeline: ImportPipelineDetailSchema.parse(
            deps.service.pipelineDetail(
              params.data.pipelineId,
              query.data.offset,
              query.data.limit,
            ),
          ),
        };
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post(
    '/api/import-pipelines',
    { onRequest: deps.protectCsrf, preHandler: deps.requireSession },
    async (request, reply) => {
      const body = CreateImportRequestSchema.safeParse(request.body),
        admin = request.authenticatedAdmin;
      if (!admin) return reply.code(401).send({ error: 'Unauthorized' });
      if (!body.success) return reply.code(400).send({ error: 'Invalid pipeline request' });
      try {
        const pipeline = ImportPipelineSummarySchema.parse(
          await deps.service.createPipelineWithSourceRevalidation(body.data),
        );
        appendAudit(deps.audit, request, {
          actorAdminId: admin.adminId,
          action: 'IMPORT_PIPELINE_CREATED',
          subject: pipeline.pipelineId,
          outcome: 'SUCCESS',
          detail: { groupCount: pipeline.counts.total, sourcePolicy: 'KEEP' },
        });
        return reply.code(201).send({ pipeline });
      } catch (error) {
        appendAudit(deps.audit, request, {
          actorAdminId: admin.adminId,
          action: 'IMPORT_PIPELINE_CREATED',
          subject: body.data.planId,
          outcome: error instanceof ImportControlError ? 'DENIED' : 'ERROR',
          detail: { reason: error instanceof ImportControlError ? error.code : 'IMPORT_INTERNAL' },
        });
        return sendError(reply, error);
      }
    },
  );
  for (const [name, action, auditAction] of [
    ['pause', 'PAUSE', 'IMPORT_PIPELINE_PAUSED'],
    ['resume', 'RESUME', 'IMPORT_PIPELINE_RESUMED'],
    ['cancel', 'CANCEL', 'IMPORT_PIPELINE_CANCELLED'],
    ['retry', 'RETRY', 'IMPORT_PIPELINE_RETRIED'],
  ] as const) {
    app.post(
      `/api/import-pipelines/:pipelineId/${name}`,
      { onRequest: deps.protectCsrf, preHandler: deps.requireSession },
      (request, reply) => {
        const params = z.object({ pipelineId: z.string().uuid() }).safeParse(request.params),
          key = idempotencyHeader(request.headers),
          admin = request.authenticatedAdmin;
        if (!admin) return reply.code(401).send({ error: 'Unauthorized' });
        if (!params.success || key === null)
          return reply.code(400).send({ error: 'Invalid pipeline action' });
        try {
          const pipeline = ImportPipelineSummarySchema.parse(
            deps.service.pipelineAction(params.data.pipelineId, action, key),
          );
          appendAudit(deps.audit, request, {
            actorAdminId: admin.adminId,
            action: auditAction,
            subject: pipeline.pipelineId,
            outcome: 'SUCCESS',
            detail: { sourcePolicy: 'KEEP' },
          });
          return { pipeline };
        } catch (error) {
          appendAudit(deps.audit, request, {
            actorAdminId: admin.adminId,
            action: auditAction,
            subject: params.data.pipelineId,
            outcome: error instanceof ImportControlError ? 'DENIED' : 'ERROR',
            detail: {
              reason: error instanceof ImportControlError ? error.code : 'IMPORT_INTERNAL',
            },
          });
          return sendError(reply, error);
        }
      },
    );
  }
  app.post(
    '/api/imports/:jobId/archive-credentials',
    { onRequest: deps.protectCsrf, preHandler: deps.requireSession },
    (request, reply) => {
      const params = z.object({ jobId: z.string().uuid() }).safeParse(request.params),
        body = ArchiveCredentialsRequestSchema.safeParse(request.body);
      const admin = request.authenticatedAdmin,
        key = idempotencyHeader(request.headers);
      if (!admin) return reply.code(401).send({ error: 'Unauthorized' });
      if (!params.success || !body.success || key === null)
        return reply.code(400).send({ error: 'Invalid archive credentials request' });
      try {
        const job = deps.service.provideArchiveCredentials({
          ...body.data,
          jobId: params.data.jobId,
          adminId: admin.adminId,
          idempotencyKey: key,
        });
        appendAudit(deps.audit, request, {
          actorAdminId: admin.adminId,
          action: 'IMPORT_CREDENTIALS_PROVIDED',
          subject: params.data.jobId,
          outcome: 'SUCCESS',
          detail: { kind: 'ARCHIVE', candidateCount: job.archive?.candidateCount ?? 0 },
        });
        return { job };
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.get(
    '/api/imports/:jobId/legacy-source',
    { preHandler: deps.requireSession },
    (request, reply) => {
      const params = z.object({ jobId: z.string().uuid() }).safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'Invalid import id' });
      try {
        return {
          binding: LegacyImportSourceBindingSchema.parse(
            deps.service.legacySourceStatus(params.data.jobId),
          ),
        };
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post(
    '/api/imports/:jobId/legacy-source',
    { onRequest: deps.protectCsrf, preHandler: deps.requireSession },
    async (request, reply) => {
      const params = z.object({ jobId: z.string().uuid() }).safeParse(request.params);
      const body = LegacyImportSourceBindRequestSchema.safeParse(request.body);
      const admin = request.authenticatedAdmin;
      if (!admin) return reply.code(401).send({ error: 'Unauthorized' });
      if (!params.success || !body.success)
        return reply.code(400).send({ error: 'Invalid legacy source binding' });
      const key = idempotencyHeader(request.headers);
      if (key === null)
        return reply
          .code(400)
          .send({ error: 'Idempotency-Key is required', code: 'IDEMPOTENCY_KEY_REQUIRED' });
      const input = {
        jobId: params.data.jobId,
        sourceConnectionId: body.data.sourceConnectionId,
        expectedRevision: body.data.expectedRevision,
        confirmSameSourceIdentity: body.data.confirmSameSourceIdentity,
        operation: { adminId: admin.adminId, idempotencyKey: key },
      };
      try {
        const replayed = deps.service.replayLegacySourceBinding(input);
        if (replayed !== null) return { binding: LegacyImportSourceBindingSchema.parse(replayed) };
        deps.auth.verifyStepUp(admin.adminId, body.data.stepUpCode);
        const binding = await deps.service.bindLegacySource(input);
        appendAudit(deps.audit, request, {
          actorAdminId: admin.adminId,
          action: 'IMPORT_LEGACY_SOURCE_BOUND',
          subject: params.data.jobId,
          outcome: 'SUCCESS',
          detail: { sourceConnectionId: binding.sourceConnectionId, state: binding.state },
        });
        return { binding: LegacyImportSourceBindingSchema.parse(binding) };
      } catch (error) {
        appendAudit(deps.audit, request, {
          actorAdminId: admin.adminId,
          action: 'IMPORT_LEGACY_SOURCE_BOUND',
          subject: params.data.jobId,
          outcome:
            error instanceof AuthError || error instanceof ImportControlError ? 'DENIED' : 'ERROR',
          detail: {
            reason:
              error instanceof AuthError
                ? 'MFA_STEP_UP_FAILED'
                : error instanceof ImportControlError
                  ? error.code
                  : 'IMPORT_INTERNAL',
          },
        });
        if (error instanceof AuthError)
          return reply.code(403).send({ error: 'Step-up failed', code: 'MFA_STEP_UP_FAILED' });
        return sendError(reply, error);
      }
    },
  );
  app.get(
    '/api/import-destinations',
    { preHandler: deps.requireSession },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      await deps.service.refreshLibraries(
        (request.query as { refreshLibraries?: string }).refreshLibraries === 'true',
      );
      return deps.service.capabilities();
    },
  );
  app.get('/api/imports', { preHandler: deps.requireSession }, () => ({
    jobs: deps.service.list(),
  }));
  app.get('/api/imports/:jobId', { preHandler: deps.requireSession }, (request, reply) => {
    try {
      const { jobId } = request.params as { jobId?: string };
      if (!jobId) return reply.code(400).send({ error: 'Invalid import id' });
      return { job: deps.service.detail(jobId) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post(
    '/api/imports/plan',
    { onRequest: deps.protectCsrf, preHandler: deps.requireSession },
    async (request, reply) => {
      const parsed = ImportPlanRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid import plan request' });
      const admin = request.authenticatedAdmin;
      if (!admin) return reply.code(401).send({ error: 'Unauthorized' });
      try {
        const plan = await deps.service.plan(parsed.data);
        appendAudit(deps.audit, request, {
          actorAdminId: admin.adminId,
          action: 'IMPORT_PLAN_CREATED',
          subject: plan.planId,
          outcome: 'SUCCESS',
          detail: { destinationId: plan.destinationId, objectCount: plan.objectCount },
        });
        return reply.code(200).send({ plan });
      } catch (error) {
        appendAudit(deps.audit, request, {
          actorAdminId: admin.adminId,
          action: 'IMPORT_PLAN_CREATED',
          subject: 'new-plan',
          outcome: error instanceof ImportControlError ? 'DENIED' : 'ERROR',
          detail: { reason: error instanceof ImportControlError ? error.code : 'IMPORT_INTERNAL' },
        });
        return sendError(reply, error);
      }
    },
  );

  app.post(
    '/api/imports',
    { onRequest: deps.protectCsrf, preHandler: deps.requireSession },
    async (request, reply) => {
      const parsed = CreateImportRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid import request' });
      const admin = request.authenticatedAdmin;
      if (!admin) return reply.code(401).send({ error: 'Unauthorized' });
      try {
        const job = await deps.service.createWithSourceRevalidation(parsed.data);
        appendAudit(deps.audit, request, {
          actorAdminId: admin.adminId,
          action: 'IMPORT_CREATED',
          subject: job.jobId,
          outcome: 'SUCCESS',
          detail: {
            destinationId: job.destination.destinationId,
            publicationPolicy: job.progress.publicationPolicy,
          },
        });
        return reply.code(201).send({ job });
      } catch (error) {
        appendAudit(deps.audit, request, {
          actorAdminId: admin.adminId,
          action: 'IMPORT_CREATED',
          subject: parsed.data.planId,
          outcome: error instanceof ImportControlError ? 'DENIED' : 'ERROR',
          detail: { reason: error instanceof ImportControlError ? error.code : 'IMPORT_INTERNAL' },
        });
        return sendError(reply, error);
      }
    },
  );

  const actions = [
    ['pause', 'PAUSE', 'IMPORT_PAUSED'],
    ['resume', 'RESUME', 'IMPORT_RESUMED'],
    ['cancel', 'CANCEL', 'IMPORT_CANCELLED'],
    ['retry', 'RETRY', 'IMPORT_RETRIED'],
  ] as const;
  for (const [pathAction, serviceAction, auditAction] of actions) {
    app.post(
      `/api/imports/:jobId/${pathAction}`,
      { onRequest: deps.protectCsrf, preHandler: deps.requireSession },
      (request, reply) => {
        const admin = request.authenticatedAdmin;
        if (!admin) return reply.code(401).send({ error: 'Unauthorized' });
        const { jobId } = request.params as { jobId?: string };
        if (!jobId) return reply.code(400).send({ error: 'Import id is required' });
        try {
          const idempotencyKey =
            idempotencyHeader(request.headers) ??
            `implicit:${serviceAction}:${jobId}:${deps.service.detail(jobId).progress.revision}`;
          const job = deps.service.action(jobId, serviceAction, idempotencyKey);
          appendAudit(deps.audit, request, {
            actorAdminId: admin.adminId,
            action: auditAction,
            subject: jobId,
            outcome: 'SUCCESS',
            detail: { state: job.progress.state },
          });
          return { job: deps.service.detail(job.jobId) };
        } catch (error) {
          appendAudit(deps.audit, request, {
            actorAdminId: admin.adminId,
            action: auditAction,
            subject: jobId,
            outcome: error instanceof ImportControlError ? 'DENIED' : 'ERROR',
            detail: {
              reason: error instanceof ImportControlError ? error.code : 'IMPORT_INTERNAL',
            },
          });
          return sendError(reply, error);
        }
      },
    );
  }

  app.post(
    '/api/imports/:jobId/credentials',
    { onRequest: deps.protectCsrf, preHandler: deps.requireSession },
    (request, reply) => {
      const admin = request.authenticatedAdmin;
      if (!admin) return reply.code(401).send({ error: 'Unauthorized' });
      const { jobId } = request.params as { jobId?: string };
      const parsed = ImportCredentialsRequestSchema.safeParse(request.body);
      if (!jobId || !parsed.success) {
        return reply.code(400).send({ error: 'Invalid credentials request' });
      }
      try {
        const idempotencyKey =
          idempotencyHeader(request.headers) ??
          `implicit:CREDENTIALS:${jobId}:${deps.service.detail(jobId).progress.revision}`;
        const job = deps.service.provideCredentials(jobId, parsed.data.credential, idempotencyKey);
        appendAudit(deps.audit, request, {
          actorAdminId: admin.adminId,
          action: 'IMPORT_CREDENTIALS_PROVIDED',
          subject: jobId,
          outcome: 'SUCCESS',
          detail: { requeued: job.progress.state === 'QUEUED' },
        });
        return { job: deps.service.detail(job.jobId) };
      } catch (error) {
        appendAudit(deps.audit, request, {
          actorAdminId: admin.adminId,
          action: 'IMPORT_CREDENTIALS_PROVIDED',
          subject: jobId,
          outcome: error instanceof ImportControlError ? 'DENIED' : 'ERROR',
          detail: { reason: error instanceof ImportControlError ? error.code : 'IMPORT_INTERNAL' },
        });
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/api/imports/:jobId/source-cleanup',
    { preHandler: deps.requireSession },
    (request, reply) => {
      const parsed = z.object({ jobId: z.string().uuid() }).safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid import id' });
      try {
        const cleanup = deps.service.sourceCleanupStatus(parsed.data.jobId);
        if (cleanup === null) {
          return reply
            .code(404)
            .send({ error: 'Import operation failed', code: 'SOURCE_CLEANUP_NOT_FOUND' });
        }
        return { cleanup };
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post(
    '/api/imports/:jobId/source-cleanup/preview',
    { onRequest: deps.protectCsrf, preHandler: deps.requireSession },
    async (request, reply) => {
      const params = z.object({ jobId: z.string().uuid() }).safeParse(request.params);
      const body = ImportSourceCleanupPreviewRequestSchema.safeParse(request.body);
      const admin = request.authenticatedAdmin;
      if (admin === null) return reply.code(401).send({ error: 'Unauthorized' });
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: 'Invalid source cleanup preview request' });
      }
      const key = idempotencyHeader(request.headers);
      if (key === null) {
        return reply
          .code(400)
          .send({ error: 'Idempotency-Key is required', code: 'IDEMPOTENCY_KEY_REQUIRED' });
      }
      try {
        const preview = await deps.service.sourceCleanupPreview({
          adminId: admin.adminId,
          jobId: params.data.jobId,
          policy: body.data.policy,
          expectedJobRevision: body.data.expectedJobRevision,
          idempotencyKey: key,
        });
        appendAudit(deps.audit, request, {
          actorAdminId: admin.adminId,
          action: 'IMPORT_SOURCE_CLEANUP_PREVIEWED',
          subject: params.data.jobId,
          outcome: preview.eligible ? 'SUCCESS' : 'DENIED',
          detail: {
            policy: preview.policy,
            eligible: preview.eligible,
            objectCount: preview.objectCount,
          },
        });
        return { preview };
      } catch (error) {
        appendAudit(deps.audit, request, {
          actorAdminId: admin.adminId,
          action: 'IMPORT_SOURCE_CLEANUP_PREVIEWED',
          subject: params.data.jobId,
          outcome: error instanceof ImportControlError ? 'DENIED' : 'ERROR',
          detail: { reason: error instanceof ImportControlError ? error.code : 'IMPORT_INTERNAL' },
        });
        return sendError(reply, error);
      }
    },
  );

  app.post(
    '/api/imports/:jobId/source-cleanup',
    { onRequest: deps.protectCsrf, preHandler: deps.requireSession },
    async (request, reply) => {
      const params = z.object({ jobId: z.string().uuid() }).safeParse(request.params);
      const body = ImportSourceCleanupExecuteRequestSchema.safeParse(request.body);
      const admin = request.authenticatedAdmin;
      if (admin === null) return reply.code(401).send({ error: 'Unauthorized' });
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: 'Invalid source cleanup execute request' });
      }
      const key = idempotencyHeader(request.headers);
      if (key === null) {
        return reply
          .code(400)
          .send({ error: 'Idempotency-Key is required', code: 'IDEMPOTENCY_KEY_REQUIRED' });
      }
      const executeInput = {
        adminId: admin.adminId,
        jobId: params.data.jobId,
        previewId: body.data.previewId,
        previewRevision: body.data.previewRevision,
        previewFingerprint: body.data.previewFingerprint,
        expectedJobRevision: body.data.expectedJobRevision,
        idempotencyKey: key,
      };
      try {
        const replayed = deps.service.replaySourceCleanupExecute(executeInput);
        if (replayed !== null) return { cleanup: replayed };
      } catch (error) {
        return sendError(reply, error);
      }

      try {
        deps.auth.verifyStepUp(admin.adminId, body.data.mfaCode);
      } catch (error) {
        appendAudit(deps.audit, request, {
          actorAdminId: admin.adminId,
          action: 'IMPORT_SOURCE_CLEANUP_EXECUTED',
          subject: params.data.jobId,
          outcome: 'DENIED',
          detail: { reason: error instanceof AuthError ? error.code : 'MFA_FAILED' },
        });
        return reply.code(403).send({ error: 'Step-up verification failed' });
      }

      try {
        const cleanup = await deps.service.executeSourceCleanup(executeInput);
        appendAudit(deps.audit, request, {
          actorAdminId: admin.adminId,
          action: 'IMPORT_SOURCE_CLEANUP_EXECUTED',
          subject: params.data.jobId,
          outcome: cleanup.status === 'COMPLETED' ? 'SUCCESS' : 'ERROR',
          detail: {
            status: cleanup.status,
            policy: cleanup.policy,
            completedObjectCount: cleanup.completedObjectCount,
            failedObjectCount: cleanup.failedObjectCount,
            physicalErasureClaimed: false,
          },
        });
        return { cleanup };
      } catch (error) {
        appendAudit(deps.audit, request, {
          actorAdminId: admin.adminId,
          action: 'IMPORT_SOURCE_CLEANUP_EXECUTED',
          subject: params.data.jobId,
          outcome: error instanceof ImportControlError ? 'DENIED' : 'ERROR',
          detail: { reason: error instanceof ImportControlError ? error.code : 'IMPORT_INTERNAL' },
        });
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/api/media-publications/:publicationId',
    { preHandler: deps.requireSession },
    (request, reply) => {
      const parsed = z.object({ publicationId: z.string().uuid() }).safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid publication id' });
      try {
        return { publication: deps.service.publication(parsed.data.publicationId) };
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post(
    '/api/media-publications',
    { onRequest: deps.protectCsrf, preHandler: deps.requireSession },
    async (request, reply) => {
      const parsed = MediaPublicationRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid publication request' });
      const admin = request.authenticatedAdmin;
      if (!admin) return reply.code(401).send({ error: 'Unauthorized' });
      try {
        deps.service.assertPublicationMutationReady();
        const key = idempotencyHeader(request.headers);
        if (key === null) {
          return reply
            .code(400)
            .send({ error: 'Idempotency-Key is required', code: 'IDEMPOTENCY_KEY_REQUIRED' });
        }
        const publication = await deps.service.requestPublication(parsed.data, key);
        appendAudit(deps.audit, request, {
          actorAdminId: admin.adminId,
          action: 'MEDIA_PUBLICATION_REQUESTED',
          subject: publication.publicationId,
          outcome: 'SUCCESS',
          detail: { jobId: parsed.data.jobId, libraryId: publication.libraryId },
        });
        return reply.code(202).send({ publication });
      } catch (error) {
        appendAudit(deps.audit, request, {
          actorAdminId: admin.adminId,
          action: 'MEDIA_PUBLICATION_REQUESTED',
          subject: parsed.data.jobId,
          outcome: error instanceof ImportControlError ? 'DENIED' : 'ERROR',
          detail: { reason: error instanceof ImportControlError ? error.code : 'IMPORT_INTERNAL' },
        });
        return sendError(reply, error);
      }
    },
  );

  for (const [pathAction, auditAction] of [
    ['retry', 'MEDIA_PUBLICATION_RETRIED'],
    ['unpublish', 'MEDIA_PUBLICATION_UNPUBLISHED'],
  ] as const) {
    app.post(
      `/api/media-publications/:publicationId/${pathAction}`,
      { onRequest: deps.protectCsrf, preHandler: deps.requireSession },
      async (request, reply) => {
        const parsed = z.object({ publicationId: z.string().uuid() }).safeParse(request.params);
        if (!parsed.success) return reply.code(400).send({ error: 'Invalid publication id' });
        const admin = request.authenticatedAdmin;
        if (!admin) return reply.code(401).send({ error: 'Unauthorized' });
        try {
          deps.service.assertPublicationMutationReady();
          const key = idempotencyHeader(request.headers);
          if (key === null) {
            return reply
              .code(400)
              .send({ error: 'Idempotency-Key is required', code: 'IDEMPOTENCY_KEY_REQUIRED' });
          }
          const result =
            pathAction === 'retry'
              ? {
                  publication: await deps.service.retryPublication(parsed.data.publicationId, key),
                }
              : await deps.service.unpublishPublication(parsed.data.publicationId, key);
          appendAudit(deps.audit, request, {
            actorAdminId: admin.adminId,
            action: auditAction,
            subject: parsed.data.publicationId,
            outcome: 'SUCCESS',
            detail: { action: pathAction },
          });
          return result;
        } catch (error) {
          appendAudit(deps.audit, request, {
            actorAdminId: admin.adminId,
            action: auditAction,
            subject: parsed.data.publicationId,
            outcome: error instanceof ImportControlError ? 'DENIED' : 'ERROR',
            detail: {
              reason: error instanceof ImportControlError ? error.code : 'IMPORT_INTERNAL',
            },
          });
          return sendError(reply, error);
        }
      },
    );
  }
}

function appendAudit(
  audit: Pick<AuditRepository, 'append'>,
  request: { ip: string; id: string },
  input: Pick<AuditInput, 'actorAdminId' | 'action' | 'subject' | 'outcome' | 'detail'>,
): void {
  audit.append({
    ...input,
    sourceIp: request.ip,
    correlationId: request.id,
  });
}
