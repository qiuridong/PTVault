import { createHash } from 'node:crypto';
import {
  ConfigureRecoveryMaterialRecipientSchema,
  EncryptedEscrowUploadSchema,
  SelectRecoveryBaselineSchema,
} from '@ptvault/contracts';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
  preHandlerAsyncHookHandler,
} from 'fastify';
import { z } from 'zod';

import type { AuditRepository } from '../audit/repository.js';
import { assertPassphraseEncryptedAge } from './escrow.js';
import type { RecoveryPreparationContext } from './preparation-context.js';
import type { PreparationRequestIdentity } from './preparation-requests.js';

type Dependencies = {
  preparation: RecoveryPreparationContext;
  requireSession: preHandlerAsyncHookHandler;
  requireRecentMfa: preHandlerAsyncHookHandler;
  protectCsrf: onRequestHookHandler;
  audit: Pick<AuditRepository, 'append'>;
};
type Operation = PreparationRequestIdentity['operation'];
const UploadSchema = EncryptedEscrowUploadSchema.extend({
  expectedMaterialRevision: z.number().int().nonnegative().safe(),
});
const KeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/);

function parse(operation: Operation, body: unknown) {
  if (operation === 'BASELINE_SELECT') {
    const data = SelectRecoveryBaselineSchema.parse(body);
    const identity = {
      version: data.version,
      bundleSha256: data.bundleSha256,
      escrowSha256: data.escrowSha256,
      expectedBaselineRevision: data.expectedBaselineRevision,
      expectedMaterialRevision: data.expectedMaterialRevision,
    };
    return { operation, data: identity, fingerprint: digest(JSON.stringify(identity)) } as const;
  }
  if (operation === 'RECIPIENT_SET') {
    const data = ConfigureRecoveryMaterialRecipientSchema.parse(body);
    const identity = {
      publicRecipient: data.publicRecipient,
      expectedMaterialRevision: data.expectedMaterialRevision,
    };
    return { operation, data: identity, fingerprint: digest(JSON.stringify(identity)) } as const;
  }
  const data = UploadSchema.parse(body);
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      data.encryptedEscrowBase64,
    )
  )
    throw new Error('RECOVERY_REQUEST_INVALID');
  const bytes = Buffer.from(data.encryptedEscrowBase64, 'base64');
  if (bytes.toString('base64') !== data.encryptedEscrowBase64)
    throw new Error('RECOVERY_REQUEST_INVALID');
  assertPassphraseEncryptedAge(bytes);
  const identity = {
    escrowSha256: digest(bytes),
    expectedMaterialRevision: data.expectedMaterialRevision,
  };
  return {
    operation: 'ESCROW_REPLACE',
    data: identity,
    bytes,
    fingerprint: digest(JSON.stringify(identity)),
  } as const;
}

function digest(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}
function codeFor(error: unknown): string {
  return error instanceof Error && /^RECOVERY_[A-Z_]{1,100}$/.test(error.message)
    ? error.message
    : 'RECOVERY_MATERIAL_WRITE_FAILED';
}

export function registerPreparationRoutes(app: FastifyInstance, dependencies: Dependencies): void {
  const { preparation: context } = dependencies;
  const routes = [
    ['/api/recovery/preparation-baseline', 'BASELINE_SELECT'],
    ['/api/recovery/recipient', 'RECIPIENT_SET'],
    ['/api/recovery/escrow', 'ESCROW_REPLACE'],
  ] as const;
  for (const [url, operation] of routes) {
    app.post(
      url,
      {
        onRequest: dependencies.protectCsrf,
        preHandler: dependencies.requireSession,
        ...(operation === 'ESCROW_REPLACE' ? { bodyLimit: 6_100_000 } : {}),
      },
      async (request, reply) => {
        void reply.header('cache-control', 'no-store');
        if (context.readOnly)
          return reply.code(409).send({ code: 'RECOVERY_COMPATIBILITY_READ_ONLY' });
        const adminId = request.authenticatedAdmin?.adminId;
        if (!adminId) return reply.code(401).send({ code: 'RECOVERY_SESSION_REQUIRED' });
        let parsed: ReturnType<typeof parse>;
        let identity: PreparationRequestIdentity;
        try {
          parsed = parse(operation, request.body);
          identity = {
            adminId,
            key: KeySchema.parse(request.headers['idempotency-key']),
            operation,
            fingerprint: parsed.fingerprint,
          };
        } catch {
          return reply.code(400).send({
            code: 'RECOVERY_REQUEST_INVALID',
            error: 'Refresh recovery settings and provide the current revision and request key.',
          });
        }
        let release: (() => void) | undefined;
        let operationId: string | undefined;
        try {
          const previous = context.requests.find(identity);
          if (previous) {
            if (previous.state !== 'SUCCEEDED')
              return reply.code(409).send({
                code: 'RECOVERY_REQUEST_PENDING_OR_FAILED',
                receipt: previous,
                status: await context.readiness.currentStatus(),
              });
            return { receipt: previous, status: await context.readiness.currentStatus() };
          }
          release = context.coordinator.acquireWrite();
          const state = context.store.get();
          if (
            state.materialRevision !== parsed.data.expectedMaterialRevision ||
            (parsed.operation === 'BASELINE_SELECT' &&
              state.baselineRevision !== parsed.data.expectedBaselineRevision)
          )
            throw new Error('RECOVERY_PREPARATION_STALE');
          if (state.escrowState === 'UPDATING' || state.escrowState === 'UNRESOLVED')
            throw new Error('RECOVERY_MATERIAL_UPDATE_PENDING');
          await dependencies.requireRecentMfa.call(app, request, reply);
          if (reply.sent) return;
          if (parsed.operation === 'ESCROW_REPLACE') {
            operationId = context.requests.begin(identity).operationId;
            const abort = new AbortController();
            const disconnected = () => abort.abort();
            request.raw.once('aborted', disconnected);
            try {
              await context.writer.replaceLeased({
                bytes: parsed.bytes,
                expectedMaterialRevision: parsed.data.expectedMaterialRevision,
                operationId,
                signal: abort.signal,
              });
              if (context.requests.operation(operationId)?.state !== 'SUCCEEDED')
                throw new Error('RECOVERY_REQUEST_NOT_SETTLED');
            } finally {
              request.raw.off('aborted', disconnected);
            }
          } else {
            context.requests.atomic(() => {
              operationId = context.requests.begin(identity).operationId;
              if (parsed.operation === 'BASELINE_SELECT') {
                const selected = context.store.select({ ...parsed.data, adminId });
                context.requests.succeed(operationId, {
                  version: parsed.data.version,
                  baselineRevision: selected.baselineRevision,
                  materialRevision: selected.materialRevision,
                });
              } else if (parsed.operation === 'RECIPIENT_SET') {
                if (context.repository.getPublicRecipient() !== parsed.data.publicRecipient) {
                  context.repository.configurePublicRecipient(parsed.data.publicRecipient);
                  context.store.advanceMaterialRevision(parsed.data.expectedMaterialRevision);
                }
                context.requests.succeed(operationId, {
                  materialRevision: context.store.get().materialRevision,
                });
              }
            });
          }
          release();
          release = undefined;
          audit(request, operation, dependencies);
          return {
            receipt: context.requests.find(identity),
            status: await context.readiness.currentStatus(),
          };
        } catch (error) {
          const code = codeFor(error);
          if (operationId) {
            const receipt = context.requests.find(identity);
            if (receipt && receipt.state !== 'SUCCEEDED') {
              const pending = context.store.get().pendingOperationId === operationId;
              context.requests.fail(operationId, pending ? 'UNRESOLVED' : 'FAILED', code);
            }
          }
          return sendError(reply, code);
        } finally {
          release?.();
        }
      },
    );
  }
}

function sendError(reply: FastifyReply, code: string) {
  return reply.code(code === 'RECOVERY_MATERIAL_WRITE_FAILED' ? 500 : 409).send({ code });
}
function audit(request: FastifyRequest, operation: Operation, dependencies: Dependencies): void {
  dependencies.audit.append({
    actorAdminId: request.authenticatedAdmin?.adminId ?? null,
    sourceIp: request.ip,
    action:
      operation === 'BASELINE_SELECT'
        ? 'RECOVERY_BASELINE_SELECTED'
        : operation === 'RECIPIENT_SET'
          ? 'RECOVERY_RECIPIENT_SET'
          : 'RECOVERY_ESCROW_UPLOADED',
    subject: 'recovery-preparation',
    outcome: 'SUCCESS',
    correlationId: String(request.id),
    detail: { operation },
  });
}
