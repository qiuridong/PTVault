import {
  RecoveryComputerConfirmationSchema,
  RecoveryDrillAttestationSchema,
  RecoveryStatusSchema,
} from '@ptvault/contracts';
import type {
  FastifyInstance,
  FastifyRequest,
  onRequestHookHandler,
  preHandlerAsyncHookHandler,
} from 'fastify';

import type { AuditRepository } from '../audit/repository.js';
import type { RecoveryRepository } from './repository.js';
import type { RecoveryReadiness } from './preparation-readiness.js';
import type { RecoveryPreparationContext } from './preparation-context.js';
import { registerPreparationRoutes } from './preparation-routes.js';

type RecoveryBundleGenerationResult = {
  version: number;
  bundlePath: string;
  bundleSha256: string;
  escrowSha256: string;
  accountIds: string[];
};

export type RecoveryWorkflow = {
  uploadEncryptedEscrow(bytes: Uint8Array, signal: AbortSignal): Promise<{ escrowSha256: string }>;
  generate(input: {
    destinationAccountIds: readonly string[];
    signal: AbortSignal;
  }): Promise<RecoveryBundleGenerationResult>;
};

export type RecoveryRouteDependencies = {
  preparation: RecoveryPreparationContext;
  repository: RecoveryRepository;
  readiness: RecoveryReadiness;
  workflow?: RecoveryWorkflow | undefined;
  requireSession: preHandlerAsyncHookHandler;
  requireRecentMfa: preHandlerAsyncHookHandler;
  protectCsrf: onRequestHookHandler;
  audit: Pick<AuditRepository, 'append'>;
  now?: () => number;
};

function signalFor(request: FastifyRequest): { signal: AbortSignal; close: () => void } {
  const controller = new AbortController();
  const close = (): void => controller.abort();
  request.raw.once('close', close);
  return { signal: controller.signal, close: () => request.raw.off('close', close) };
}

function audit(
  dependencies: RecoveryRouteDependencies,
  request: FastifyRequest,
  action: Parameters<AuditRepository['append']>[0]['action'],
  outcome: 'SUCCESS' | 'DENIED' | 'ERROR',
  detail: Record<string, string | number | boolean | null> = {},
): void {
  dependencies.audit.append({
    actorAdminId: request.authenticatedAdmin?.adminId ?? null,
    sourceIp: request.ip,
    action,
    subject: request.authenticatedAdmin?.username ?? 'recovery',
    outcome,
    correlationId: String(request.id),
    detail,
  });
}

export function registerRecoveryRoutes(
  app: FastifyInstance,
  dependencies: RecoveryRouteDependencies,
): void {
  const { repository, workflow, requireSession, requireRecentMfa, protectCsrf } = dependencies;
  const mutationOptions = {
    onRequest: protectCsrf,
    preHandler: [requireSession, requireRecentMfa],
  };
  registerPreparationRoutes(app, dependencies);

  app.get('/api/recovery', { preHandler: requireSession }, async (_request, reply) => {
    void reply.header('cache-control', 'no-store');
    return RecoveryStatusSchema.parse(await dependencies.readiness.currentStatus());
  });

  if (!workflow) return;

  app.post('/api/recovery/generate', mutationOptions, async (request, reply) => {
    void reply.header('cache-control', 'no-store');
    const body = request.body as { destinationAccountIds?: unknown } | undefined;
    const ids = Array.isArray(body?.destinationAccountIds) ? body.destinationAccountIds : [];
    if (
      ids.length < 2 ||
      ids.some((id) => typeof id !== 'string') ||
      new Set(ids).size !== ids.length
    ) {
      audit(dependencies, request, 'RECOVERY_BUNDLE_GENERATED', 'DENIED', {
        reason: 'INVALID_DESTINATIONS',
      });
      return reply.code(400).send({ error: 'At least two distinct destinations are required' });
    }
    const { signal, close } = signalFor(request);
    try {
      const result = await workflow.generate({
        destinationAccountIds: ids as string[],
        signal,
      });
      audit(dependencies, request, 'RECOVERY_BUNDLE_GENERATED', 'SUCCESS', {
        version: result.version,
        destinationCount: result.accountIds.length,
      });
      return {
        version: result.version,
        bundleSha256: result.bundleSha256,
        escrowSha256: result.escrowSha256,
        accountIds: result.accountIds,
      };
    } catch {
      audit(dependencies, request, 'RECOVERY_BUNDLE_GENERATED', 'ERROR');
      return reply.code(500).send({ error: 'Recovery bundle generation failed' });
    } finally {
      close();
    }
  });

  app.post('/api/recovery/computer-confirmation', mutationOptions, async (request, reply) => {
    void reply.header('cache-control', 'no-store');
    const parsed = RecoveryComputerConfirmationSchema.safeParse(request.body);
    if (!parsed.success) {
      audit(dependencies, request, 'RECOVERY_COMPUTER_CONFIRMED', 'DENIED', {
        reason: 'INVALID_REQUEST',
      });
      return reply.code(400).send({ error: 'Invalid computer confirmation' });
    }
    try {
      repository.confirmComputerDownload({
        ...parsed.data,
        confirmedAt: dependencies.now?.() ?? Date.now(),
      });
      audit(dependencies, request, 'RECOVERY_COMPUTER_CONFIRMED', 'SUCCESS', {
        version: parsed.data.version,
      });
      return dependencies.readiness.currentStatus();
    } catch {
      audit(dependencies, request, 'RECOVERY_COMPUTER_CONFIRMED', 'DENIED', {
        reason: 'CHECKSUM_MISMATCH',
      });
      return reply.code(409).send({ error: 'Recovery bundle checksum does not match' });
    }
  });

  app.post('/api/recovery/drill', mutationOptions, async (request, reply) => {
    void reply.header('cache-control', 'no-store');
    const parsed = RecoveryDrillAttestationSchema.safeParse(request.body);
    if (!parsed.success) {
      audit(dependencies, request, 'RECOVERY_DRILL_ATTESTED', 'DENIED', {
        reason: 'INVALID_REQUEST',
      });
      return reply.code(400).send({ error: 'Invalid recovery drill attestation' });
    }
    try {
      repository.attestPassphraseVerification({
        ...parsed.data,
        verifiedAt: dependencies.now?.() ?? Date.now(),
      });
      audit(dependencies, request, 'RECOVERY_DRILL_ATTESTED', 'SUCCESS', {
        version: parsed.data.version,
      });
      return dependencies.readiness.currentStatus();
    } catch {
      audit(dependencies, request, 'RECOVERY_DRILL_ATTESTED', 'DENIED', {
        reason: 'CHECKSUM_MISMATCH',
      });
      return reply.code(409).send({ error: 'Recovery escrow checksum does not match' });
    }
  });
}
