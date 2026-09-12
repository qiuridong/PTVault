import {
  OffloadCancelRequestSchema,
  OffloadCancelResultSchema,
  OffloadCleanupRequestSchema,
  OffloadCleanupResultSchema,
  OffloadControlIdempotencyKeySchema,
  OffloadPauseAllRequestSchema,
  OffloadPauseRequestSchema,
  OffloadPauseResultSchema,
  OffloadResumeAllRequestSchema,
  OffloadResumeRequestSchema,
  OffloadResumeResultSchema,
  OffloadSchedulerStatusSchema,
  OffloadRetryRequestSchema,
  OffloadTriggerRequestSchema,
  type JobState,
  type OffloadRejection,
  type OffloadSchedulerStatus,
  type OffloadSnapshot,
} from '@ptvault/contracts';
import type {
  FastifyInstance,
  FastifyReply,
  onRequestHookHandler,
  preHandlerAsyncHookHandler,
} from 'fastify';

import type { AuditRepository } from '../audit/repository.js';
import { AuthError, type AuthService } from '../auth/service.js';
import type { AppMode } from '../config/env.js';
import type { EventHub } from '../events/hub.js';
import type { RecoveryGate } from '../recovery/gate.js';
import { canonicalHash } from '../qb/repository.js';
import { PreflightError, type TorrentPreflightService } from '../qb/preflight.js';
import type { OffloadMachine } from './offload-machine.js';
import type { CleanupService } from './cleanup.js';

/**
 * Job states an operator may act on.
 *
 * `QUEUED` is deliberately absent: a worker can claim it between the check and
 * the click, and a cancel racing a claim is exactly the case where the operator
 * is told one thing and something else happens.
 */
const STOPPED_JOB_STATES = new Set<JobState>([
  'FAILED_SAFE',
  'BLOCKED',
  'RETRY_WAIT',
  'CANCELLED_SAFE',
]);

export type OffloadTriggerDependencies = {
  /**
   * The runtime mode. Redundant with the fact that the caller only registers
   * this route in ACTIVE — deliberately so. If a future edit ever registers it
   * unconditionally, the check below still fails closed rather than queueing
   * jobs no handler exists to run.
   */
  mode: AppMode;
  machine: Pick<
    OffloadMachine,
    | 'assertCreateAllowed'
    | 'create'
    | 'activeHolder'
    | 'cancel'
    | 'retry'
    | 'get'
    | 'requestOperatorPause'
    | 'resumeOperatorPause'
    | 'requestPauseAll'
    | 'resumeAll'
    | 'schedulerStatus'
    | 'replayControlRequest'
  >;
  worker: {
    readonly activeOffloadJobCount: number;
    readonly activeJobCount: number;
    requestOffloadPause(jobId: string): boolean;
    requestOffloadCancel(jobId: string): boolean;
    requestAllOffloadPauses(): number;
  };
  events: Pick<EventHub, 'publish'>;
  cleanup?: Pick<CleanupService, 'clean'>;
  recoveryGate?: Pick<RecoveryGate, 'issueDeletionPermit'>;
  preflight: Pick<TorrentPreflightService, 'check'>;
  auth: Pick<AuthService, 'verifyStepUp'>;
  audit: Pick<AuditRepository, 'append'>;
  requireSession: preHandlerAsyncHookHandler;
  protectCsrf: onRequestHookHandler;
};

function idempotencyKey(headers: Record<string, unknown>): string | null {
  const raw = headers['idempotency-key'];
  const value: unknown = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
  const parsed = OffloadControlIdempotencyKeySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function publishSchedulerUpdateBestEffort(
  events: Pick<EventHub, 'publish'>,
  status: OffloadSchedulerStatus,
): void {
  try {
    events.publish({
      type: 'scheduler.updated',
      component: 'offload-scheduler',
      schedulerState: status.schedulerState,
      revision: status.revision,
    });
  } catch {
    // The scheduler transition is durable; SSE is an invalidation hint only.
  }
}

/**
 * Registers `POST /api/offloads` — the only route in this process that can start
 * a job which pauses a torrent, uploads its bytes, and eventually deletes the
 * local copy.
 *
 * The caller decides whether to call this at all: `buildApp` registers it only
 * when the offload executor exists, which only happens in ACTIVE mode. That
 * pairing is deliberate. In SHADOW there is no trigger *and* no handler, so
 * arming the pipeline takes a mode flip plus a restart, never a single stray
 * request. Registering the trigger without an executor would be the worst of
 * both: jobs would queue up and park in BLOCKED with nothing to run them.
 *
 * Five checks stand in front of `machine.create`, in this order:
 *   1. CSRF, so a cross-site form cannot post it;
 *   2. a live session;
 *   3. ACTIVE mode, re-checked here rather than assumed from registration;
 *   4. a fresh single-use TOTP code, because a stolen cookie must not suffice;
 *   5. a preflight that currently says eligible.
 *
 * The preflight is re-run here rather than trusted from the UI's earlier GET:
 * the file could have been moved, hardlinked, or reopened for writing in the
 * seconds since the operator looked at it, and the check is cheap next to the
 * upload it guards.
 *
 * One code authorizes the whole submitted batch (capped at `OFFLOAD_BATCH_LIMIT`),
 * and the code is spent once, before any target is examined — so a batch that is
 * entirely ineligible still burns the code rather than letting a caller probe
 * eligibility repeatedly on one code.
 *
 * Per-target failures do not fail the request. A batch of twenty where one file
 * vanished should migrate nineteen and report the one, which is the same
 * partial-success shape the fleet inventory sync already returns; collapsing that
 * into a single 4xx would make the operator re-select and re-authorize the
 * nineteen that were fine.
 */
export function registerOffloadTriggerRoutes(
  app: FastifyInstance,
  deps: OffloadTriggerDependencies,
): void {
  app.post(
    '/api/offloads',
    { onRequest: deps.protectCsrf, preHandler: deps.requireSession },
    async (request, reply) => {
      void reply.header('cache-control', 'no-store');
      if (deps.mode !== 'ACTIVE') {
        return reply.code(409).send({ error: 'Offloads are disabled', code: 'MODE_NOT_ACTIVE' });
      }

      const admin = request.authenticatedAdmin;
      if (!admin) return reply.code(401).send({ error: 'Unauthorized' });

      const parsed = OffloadTriggerRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid offload request' });
      }
      const { mfaCode, targets, importance } = parsed.data;
      const batchSubject = `batch:${targets.length}`;

      try {
        // Fast rejection protects the single-use MFA code and avoids filesystem/qB
        // preflight. OffloadMachine.create repeats this check transactionally.
        deps.machine.assertCreateAllowed();
      } catch (error) {
        if (error instanceof Error && error.message === 'OFFLOAD_CREATION_DISABLED') {
          deps.audit.append({
            actorAdminId: admin.adminId,
            sourceIp: request.ip,
            action: 'OFFLOAD_TRIGGER',
            subject: batchSubject,
            outcome: 'DENIED',
            correlationId: request.id,
            detail: { reason: 'OFFLOAD_CREATION_DISABLED' },
          });
          return reply.code(409).send({
            error: 'Creating new offloads is disabled',
            code: 'OFFLOAD_CREATION_DISABLED',
          });
        }
        if (error instanceof Error && error.message === 'OFFLOAD_SCHEDULER_NOT_RUNNING') {
          deps.audit.append({
            actorAdminId: admin.adminId,
            sourceIp: request.ip,
            action: 'OFFLOAD_TRIGGER',
            subject: batchSubject,
            outcome: 'DENIED',
            correlationId: request.id,
            detail: { reason: 'OFFLOAD_SCHEDULER_NOT_RUNNING' },
          });
          return reply.code(409).send({
            error: 'Offload scheduler is not running',
            code: 'OFFLOAD_SCHEDULER_NOT_RUNNING',
          });
        }
        throw error;
      }

      try {
        deps.auth.verifyStepUp(admin.adminId, mfaCode);
      } catch (error) {
        deps.audit.append({
          actorAdminId: admin.adminId,
          sourceIp: request.ip,
          action: 'OFFLOAD_TRIGGER',
          subject: batchSubject,
          outcome: 'DENIED',
          correlationId: request.id,
          detail: { reason: error instanceof AuthError ? error.code : 'MFA_FAILED' },
        });
        // 403, not 401: the session is valid, the step-up is what failed. A 401
        // would make the browser client tear down a perfectly good session.
        return reply.code(403).send({ error: 'Step-up verification failed' });
      }

      const created: OffloadSnapshot[] = [];
      const rejected: OffloadRejection[] = [];
      const seen = new Set<string>();
      let creationGateClosed = false;
      let creationDisabled = false;

      for (const target of targets) {
        const hash = canonicalHash(target.torrentHash);
        const subject = `${target.instanceId}:${hash}`;
        const reject = (code: OffloadRejection['code'], issues: string[] = []): void => {
          deps.audit.append({
            actorAdminId: admin.adminId,
            sourceIp: request.ip,
            action: 'OFFLOAD_TRIGGER',
            subject,
            outcome: code === 'CREATE_FAILED' ? 'ERROR' : 'DENIED',
            correlationId: request.id,
            detail: { reason: code },
          });
          rejected.push({ ...target, code, issues, conflict: null });
        };

        /**
         * Rejects with the job that is holding this torrent attached.
         *
         * `resolvable` marks a holder that has stopped and only needs clearing —
         * that is the difference between "wait for it" and "you can act on it",
         * and without it the operator cannot tell which situation they are in.
         */
        const rejectWithConflict = (): void => {
          const holder = deps.machine.activeHolder(target.instanceId, hash);
          deps.audit.append({
            actorAdminId: admin.adminId,
            sourceIp: request.ip,
            action: 'OFFLOAD_TRIGGER',
            subject,
            outcome: 'DENIED',
            correlationId: request.id,
            detail: { reason: 'OFFLOAD_ALREADY_ACTIVE', holderJobId: holder?.jobId ?? null },
          });
          rejected.push({
            ...target,
            code: 'OFFLOAD_ALREADY_ACTIVE',
            issues: [],
            conflict: holder
              ? {
                  jobId: holder.jobId,
                  currentStep: holder.currentStep,
                  // Stopped states only. A QUEUED or RUNNING holder may be
                  // claimed or driven by a worker at any moment, so offering an
                  // action on it would race that worker.
                  resolvable: STOPPED_JOB_STATES.has(holder.jobState),
                }
              : null,
          });
        };

        // Same torrent twice in one batch: the first wins, the second would
        // otherwise come back as OFFLOAD_ALREADY_ACTIVE and read like a
        // pre-existing job rather than the operator's own duplicate selection.
        if (seen.has(subject)) {
          reject('DUPLICATE_TARGET');
          continue;
        }
        seen.add(subject);

        if (creationDisabled) {
          reject('OFFLOAD_CREATION_DISABLED');
          continue;
        }
        if (creationGateClosed) {
          reject('OFFLOAD_SCHEDULER_NOT_RUNNING');
          continue;
        }

        let preflight;
        try {
          preflight = await deps.preflight.check({ instanceId: target.instanceId, hash });
        } catch (error) {
          if (error instanceof PreflightError) {
            reject(
              error.code === 'TORRENT_NOT_FOUND' ? 'TORRENT_NOT_FOUND' : 'INVALID_TORRENT_IDENTITY',
            );
            continue;
          }
          throw error;
        }

        if (!preflight.eligible) {
          // The blocking reasons ride along so the operator can see *why* without
          // a second round trip per torrent.
          reject(
            'PREFLIGHT_INELIGIBLE',
            preflight.issues.filter((issue) => issue.blocking).map((issue) => issue.code),
          );
          continue;
        }

        try {
          const snapshot = deps.machine.create({
            instanceId: target.instanceId,
            torrentHash: hash,
            importance,
          });
          created.push(snapshot);
          deps.audit.append({
            actorAdminId: admin.adminId,
            sourceIp: request.ip,
            action: 'OFFLOAD_TRIGGER',
            subject,
            outcome: 'SUCCESS',
            correlationId: request.id,
            detail: { jobId: snapshot.jobId, importance: snapshot.importance },
          });
        } catch (error) {
          if (error instanceof Error && error.message === 'OFFLOAD_ALREADY_ACTIVE') {
            rejectWithConflict();
            continue;
          }
          if (error instanceof Error && error.message === 'OFFLOAD_CREATION_DISABLED') {
            creationDisabled = true;
            reject('OFFLOAD_CREATION_DISABLED');
            continue;
          }
          if (error instanceof Error && error.message === 'OFFLOAD_SCHEDULER_NOT_RUNNING') {
            creationGateClosed = true;
            reject('OFFLOAD_SCHEDULER_NOT_RUNNING');
            continue;
          }
          // A create that failed for any other reason is this server's fault, not
          // the operator's. Recording it per target keeps the rest of the batch
          // intact instead of discarding work already queued.
          reject('CREATE_FAILED');
        }
      }

      // 201 whenever anything was queued; 409 when the whole batch was refused,
      // so a caller that queued nothing does not read success from the status.
      return reply
        .code(created.length > 0 ? 201 : 409)
        .send({ offloads: created, rejected, requested: targets.length });
    },
  );

  const controlError = (reply: FastifyReply, error: unknown) => {
    const code = error instanceof Error ? error.message : 'OFFLOAD_CONTROL_FAILED';
    if (code === 'OFFLOAD_NOT_FOUND') {
      return reply.code(404).send({ error: 'Transfer not found', code });
    }
    if (
      code === 'OFFLOAD_NOT_PAUSABLE' ||
      code === 'OFFLOAD_NOT_RESUMABLE' ||
      code === 'OFFLOAD_NOT_OPERATOR_PAUSED' ||
      code === 'OFFLOAD_SCHEDULER_PAUSED' ||
      code === 'OFFLOAD_SCHEDULER_NOT_DRAINED' ||
      code === 'OFFLOAD_ALREADY_CLOUD_COMMITTED' ||
      code === 'OFFLOAD_CANCEL_CONFLICT' ||
      code === 'IDEMPOTENCY_KEY_CONFLICT'
    ) {
      return reply.code(409).send({ error: 'Offload control state conflict', code });
    }
    return reply.code(500).send({ error: 'Offload control failed', code });
  };

  app.post(
    '/api/offloads/pause',
    { onRequest: deps.protectCsrf, preHandler: deps.requireSession },
    (request, reply) => {
      void reply.header('cache-control', 'no-store');
      if (deps.mode !== 'ACTIVE') {
        return reply.code(409).send({ error: 'Offloads are disabled', code: 'MODE_NOT_ACTIVE' });
      }
      const admin = request.authenticatedAdmin;
      if (!admin) return reply.code(401).send({ error: 'Unauthorized' });
      const parsed = OffloadPauseRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid pause request' });
      const key = idempotencyKey(request.headers);
      if (!key) {
        return reply
          .code(400)
          .send({ error: 'Idempotency-Key is required', code: 'IDEMPOTENCY_KEY_REQUIRED' });
      }
      try {
        const result = OffloadPauseResultSchema.parse(
          deps.machine.requestOperatorPause(parsed.data.jobId, key),
        );
        if (result.pauseRequested) deps.worker.requestOffloadPause(parsed.data.jobId);
        deps.audit.append({
          actorAdminId: admin.adminId,
          sourceIp: request.ip,
          action: 'OFFLOAD_PAUSE',
          subject: parsed.data.jobId,
          outcome: 'SUCCESS',
          correlationId: request.id,
          detail: {
            acknowledged: result.operatorPaused,
            eventCode: result.operatorPaused ? 'OFFLOAD_PAUSED' : 'OFFLOAD_PAUSE_REQUESTED',
          },
        });
        return reply.code(result.pauseRequested ? 202 : 200).send(result);
      } catch (error) {
        const code = error instanceof Error ? error.message : 'OFFLOAD_CONTROL_FAILED';
        deps.audit.append({
          actorAdminId: admin.adminId,
          sourceIp: request.ip,
          action: 'OFFLOAD_PAUSE',
          subject: parsed.data.jobId,
          outcome: 'DENIED',
          correlationId: request.id,
          detail: { reason: code },
        });
        return controlError(reply, error);
      }
    },
  );

  app.post(
    '/api/offloads/resume',
    { onRequest: deps.protectCsrf, preHandler: deps.requireSession },
    (request, reply) => {
      void reply.header('cache-control', 'no-store');
      if (deps.mode !== 'ACTIVE') {
        return reply.code(409).send({ error: 'Offloads are disabled', code: 'MODE_NOT_ACTIVE' });
      }
      const admin = request.authenticatedAdmin;
      if (!admin) return reply.code(401).send({ error: 'Unauthorized' });
      const parsed = OffloadResumeRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid resume request' });
      const key = idempotencyKey(request.headers);
      if (!key) {
        return reply
          .code(400)
          .send({ error: 'Idempotency-Key is required', code: 'IDEMPOTENCY_KEY_REQUIRED' });
      }
      try {
        const replay = deps.machine.replayControlRequest(key, 'RESUME', parsed.data.jobId);
        if (replay) {
          const result = OffloadResumeResultSchema.parse(replay);
          deps.audit.append({
            actorAdminId: admin.adminId,
            sourceIp: request.ip,
            action: 'OFFLOAD_RESUME',
            subject: parsed.data.jobId,
            outcome: 'SUCCESS',
            correlationId: request.id,
            detail: { eventCode: 'OFFLOAD_RESUMED', replay: true },
          });
          return reply.code(200).send(result);
        }
        try {
          deps.auth.verifyStepUp(admin.adminId, parsed.data.mfaCode);
        } catch (error) {
          const reason = error instanceof AuthError ? error.code : 'MFA_FAILED';
          deps.audit.append({
            actorAdminId: admin.adminId,
            sourceIp: request.ip,
            action: 'OFFLOAD_RESUME',
            subject: parsed.data.jobId,
            outcome: 'DENIED',
            correlationId: request.id,
            detail: { reason },
          });
          return reply.code(403).send({ error: 'Step-up verification failed' });
        }
        const result = OffloadResumeResultSchema.parse(
          deps.machine.resumeOperatorPause(parsed.data.jobId, key),
        );
        deps.audit.append({
          actorAdminId: admin.adminId,
          sourceIp: request.ip,
          action: 'OFFLOAD_RESUME',
          subject: parsed.data.jobId,
          outcome: 'SUCCESS',
          correlationId: request.id,
          detail: { eventCode: 'OFFLOAD_RESUMED', resumingFrom: result.resumingFrom },
        });
        return reply.code(200).send(result);
      } catch (error) {
        const code = error instanceof Error ? error.message : 'OFFLOAD_CONTROL_FAILED';
        deps.audit.append({
          actorAdminId: admin.adminId,
          sourceIp: request.ip,
          action: 'OFFLOAD_RESUME',
          subject: parsed.data.jobId,
          outcome: 'DENIED',
          correlationId: request.id,
          detail: { reason: code },
        });
        return controlError(reply, error);
      }
    },
  );

  app.post(
    '/api/offloads/pause-all',
    { onRequest: deps.protectCsrf, preHandler: deps.requireSession },
    (request, reply) => {
      void reply.header('cache-control', 'no-store');
      if (deps.mode !== 'ACTIVE') {
        return reply.code(409).send({ error: 'Offloads are disabled', code: 'MODE_NOT_ACTIVE' });
      }
      const admin = request.authenticatedAdmin;
      if (!admin) return reply.code(401).send({ error: 'Unauthorized' });
      if (!OffloadPauseAllRequestSchema.safeParse(request.body ?? {}).success) {
        return reply.code(400).send({ error: 'Invalid pause-all request' });
      }
      const key = idempotencyKey(request.headers);
      if (!key) {
        return reply
          .code(400)
          .send({ error: 'Idempotency-Key is required', code: 'IDEMPOTENCY_KEY_REQUIRED' });
      }
      try {
        // The database gate is persisted by requestPauseAll before any controller
        // is aborted, so a released worker slot cannot claim another OFFLOAD.
        const status = OffloadSchedulerStatusSchema.parse(
          deps.machine.requestPauseAll(
            key,
            deps.worker.activeOffloadJobCount,
            deps.worker.activeJobCount,
          ),
        );
        publishSchedulerUpdateBestEffort(deps.events, status);
        deps.worker.requestAllOffloadPauses();
        deps.audit.append({
          actorAdminId: admin.adminId,
          sourceIp: request.ip,
          action: 'OFFLOAD_PAUSE_ALL',
          subject: 'OFFLOAD_SCHEDULER',
          outcome: 'SUCCESS',
          correlationId: request.id,
          detail: {
            schedulerState: status.schedulerState,
            requestedCount: status.requestedCount,
            pausedCount: status.pausedCount,
          },
        });
        return reply.code(status.offloadDrained ? 200 : 202).send(status);
      } catch (error) {
        const code = error instanceof Error ? error.message : 'OFFLOAD_CONTROL_FAILED';
        deps.audit.append({
          actorAdminId: admin.adminId,
          sourceIp: request.ip,
          action: 'OFFLOAD_PAUSE_ALL',
          subject: 'OFFLOAD_SCHEDULER',
          outcome: 'DENIED',
          correlationId: request.id,
          detail: { reason: code },
        });
        return controlError(reply, error);
      }
    },
  );

  app.post(
    '/api/offloads/resume-all',
    { onRequest: deps.protectCsrf, preHandler: deps.requireSession },
    (request, reply) => {
      void reply.header('cache-control', 'no-store');
      if (deps.mode !== 'ACTIVE') {
        return reply.code(409).send({ error: 'Offloads are disabled', code: 'MODE_NOT_ACTIVE' });
      }
      const admin = request.authenticatedAdmin;
      if (!admin) return reply.code(401).send({ error: 'Unauthorized' });
      const parsed = OffloadResumeAllRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid resume-all request' });
      const key = idempotencyKey(request.headers);
      if (!key) {
        return reply
          .code(400)
          .send({ error: 'Idempotency-Key is required', code: 'IDEMPOTENCY_KEY_REQUIRED' });
      }
      try {
        const replay = deps.machine.replayControlRequest(key, 'RESUME_ALL');
        if (replay) {
          const status = OffloadSchedulerStatusSchema.parse(replay);
          deps.audit.append({
            actorAdminId: admin.adminId,
            sourceIp: request.ip,
            action: 'OFFLOAD_RESUME_ALL',
            subject: 'OFFLOAD_SCHEDULER',
            outcome: 'SUCCESS',
            correlationId: request.id,
            detail: { schedulerState: status.schedulerState, replay: true },
          });
          return reply.code(200).send(status);
        }
        try {
          deps.auth.verifyStepUp(admin.adminId, parsed.data.mfaCode);
        } catch (error) {
          const reason = error instanceof AuthError ? error.code : 'MFA_FAILED';
          deps.audit.append({
            actorAdminId: admin.adminId,
            sourceIp: request.ip,
            action: 'OFFLOAD_RESUME_ALL',
            subject: 'OFFLOAD_SCHEDULER',
            outcome: 'DENIED',
            correlationId: request.id,
            detail: { reason },
          });
          return reply.code(403).send({ error: 'Step-up verification failed' });
        }
        const status = OffloadSchedulerStatusSchema.parse(
          deps.machine.resumeAll(
            key,
            deps.worker.activeOffloadJobCount,
            deps.worker.activeJobCount,
          ),
        );
        publishSchedulerUpdateBestEffort(deps.events, status);
        deps.audit.append({
          actorAdminId: admin.adminId,
          sourceIp: request.ip,
          action: 'OFFLOAD_RESUME_ALL',
          subject: 'OFFLOAD_SCHEDULER',
          outcome: 'SUCCESS',
          correlationId: request.id,
          detail: { schedulerState: status.schedulerState, queuedCount: status.queuedCount },
        });
        return reply.code(200).send(status);
      } catch (error) {
        const code = error instanceof Error ? error.message : 'OFFLOAD_CONTROL_FAILED';
        deps.audit.append({
          actorAdminId: admin.adminId,
          sourceIp: request.ip,
          action: 'OFFLOAD_RESUME_ALL',
          subject: 'OFFLOAD_SCHEDULER',
          outcome: 'DENIED',
          correlationId: request.id,
          detail: { reason: code },
        });
        return controlError(reply, error);
      }
    },
  );

  app.get('/api/offloads/scheduler', { preHandler: deps.requireSession }, (request, reply) => {
    void request;
    void reply.header('cache-control', 'no-store');
    return OffloadSchedulerStatusSchema.parse(
      deps.machine.schedulerStatus(deps.worker.activeOffloadJobCount, deps.worker.activeJobCount),
    );
  });

  app.post(
    '/api/offloads/cancel',
    { onRequest: deps.protectCsrf, preHandler: deps.requireSession },
    (request, reply) => {
      void reply.header('cache-control', 'no-store');
      if (deps.mode !== 'ACTIVE') {
        return reply.code(409).send({ error: 'Offloads are disabled', code: 'MODE_NOT_ACTIVE' });
      }
      const admin = request.authenticatedAdmin;
      if (!admin) return reply.code(401).send({ error: 'Unauthorized' });
      const parsed = OffloadCancelRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid cancel request' });

      const audit = (
        outcome: 'SUCCESS' | 'DENIED' | 'ERROR',
        detail: Record<string, string | number | boolean | null>,
      ) => {
        deps.audit.append({
          actorAdminId: admin.adminId,
          sourceIp: request.ip,
          action: 'OFFLOAD_CANCELLED',
          subject: parsed.data.jobId,
          outcome,
          correlationId: request.id,
          detail,
        });
      };

      const key = idempotencyKey(request.headers);
      if (!key) {
        audit('DENIED', { reason: 'IDEMPOTENCY_KEY_REQUIRED' });
        return reply
          .code(400)
          .send({ error: 'Idempotency-Key is required', code: 'IDEMPOTENCY_KEY_REQUIRED' });
      }

      try {
        const replay = deps.machine.replayControlRequest(key, 'CANCEL', parsed.data.jobId);
        if (replay) {
          const result = OffloadCancelResultSchema.parse(replay);
          audit('SUCCESS', { localPreserved: true, replay: true });
          return reply.code(200).send(result);
        }

        try {
          deps.auth.verifyStepUp(admin.adminId, parsed.data.mfaCode);
        } catch (error) {
          const reason = error instanceof AuthError ? error.code : 'MFA_FAILED';
          audit('DENIED', { reason });
          return reply.code(403).send({ error: 'Step-up verification failed' });
        }

        const result = OffloadCancelResultSchema.parse(deps.machine.cancel(parsed.data.jobId, key));
        // A paused job has no active handler; a pause-request race may still own a
        // child/stream, so target only that controller after cancellation is durable.
        deps.worker.requestOffloadCancel(parsed.data.jobId);
        audit('SUCCESS', { localPreserved: true, replay: false });
        return reply.code(200).send(result);
      } catch (error) {
        const code = error instanceof Error ? error.message : 'OFFLOAD_CONTROL_FAILED';
        audit('DENIED', { reason: code });
        return controlError(reply, error);
      }
    },
  );

  /**
   * Shared shape for recovery actions without durable control receipts.
   *
   * Retry takes a fresh single-use TOTP code, for the same reason the trigger does:
   * abandoning or restarting a transfer decides what happens to real bytes, and a
   * stolen cookie must not be enough authority for that.
   *
   * Cancel is registered separately because it has a bounded durable receipt and
   * must replay that receipt before another single-use TOTP code is consumed.
   */
  const recoveryAction = <T>(
    path: string,
    action: 'OFFLOAD_CANCELLED' | 'OFFLOAD_RETRIED',
    parse: (body: unknown) => { jobId: string; mfaCode: string } | null,
    run: (jobId: string) => T,
  ): void => {
    app.post(
      path,
      { onRequest: deps.protectCsrf, preHandler: deps.requireSession },
      (request, reply) => {
        void reply.header('cache-control', 'no-store');
        if (deps.mode !== 'ACTIVE') {
          return reply.code(409).send({ error: 'Offloads are disabled', code: 'MODE_NOT_ACTIVE' });
        }
        const admin = request.authenticatedAdmin;
        if (!admin) return reply.code(401).send({ error: 'Unauthorized' });

        const parsed = parse(request.body);
        if (!parsed) return reply.code(400).send({ error: 'Invalid request' });

        const audit = (outcome: 'SUCCESS' | 'DENIED' | 'ERROR', detail: Record<string, string>) => {
          deps.audit.append({
            actorAdminId: admin.adminId,
            sourceIp: request.ip,
            action,
            subject: parsed.jobId,
            outcome,
            correlationId: request.id,
            detail,
          });
        };

        try {
          deps.auth.verifyStepUp(admin.adminId, parsed.mfaCode);
        } catch (error) {
          audit('DENIED', { reason: error instanceof AuthError ? error.code : 'MFA_FAILED' });
          // 403 rather than 401: the session is fine, the step-up is what failed.
          return reply.code(403).send({ error: 'Step-up verification failed' });
        }

        try {
          const result = run(parsed.jobId);
          audit('SUCCESS', {});
          return reply.code(200).send(result);
        } catch (error) {
          const code = error instanceof Error ? error.message : 'UNKNOWN';
          audit('DENIED', { reason: code });
          if (code === 'OFFLOAD_NOT_FOUND') {
            return reply.code(404).send({ error: 'Transfer not found', code });
          }
          // Everything else is a state conflict: already committed, already
          // cancelled, or held by a worker. All mean "not in a state you can act on",
          // and the code says which.
          if (
            code === 'OFFLOAD_ALREADY_CLOUD_COMMITTED' ||
            code === 'OFFLOAD_CANCEL_CONFLICT' ||
            code === 'OFFLOAD_NOT_RETRYABLE' ||
            code === 'OFFLOAD_CANCELLED' ||
            code === 'OFFLOAD_OPERATOR_PAUSED'
          ) {
            return reply.code(409).send({ error: 'Transfer cannot be changed now', code });
          }
          return reply.code(500).send({ error: 'Transfer action failed' });
        }
      },
    );
  };

  recoveryAction(
    '/api/offloads/retry',
    'OFFLOAD_RETRIED',
    (body) => {
      const parsed = OffloadRetryRequestSchema.safeParse(body);
      return parsed.success ? parsed.data : null;
    },
    (jobId) => ({ ...deps.machine.retry(jobId), requeued: true as const }),
  );

  if (deps.cleanup && deps.recoveryGate) {
    const cleanup = deps.cleanup;
    const recoveryGate = deps.recoveryGate;
    app.post(
      '/api/offloads/cleanup',
      { onRequest: deps.protectCsrf, preHandler: deps.requireSession },
      async (request, reply) => {
        void reply.header('cache-control', 'no-store');
        if (deps.mode !== 'ACTIVE') {
          return reply.code(409).send({ error: 'Offloads are disabled', code: 'MODE_NOT_ACTIVE' });
        }
        const admin = request.authenticatedAdmin;
        if (!admin) return reply.code(401).send({ error: 'Unauthorized' });
        const parsed = OffloadCleanupRequestSchema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: 'Invalid cleanup request' });

        try {
          deps.auth.verifyStepUp(admin.adminId, parsed.data.mfaCode);
        } catch (error) {
          deps.audit.append({
            actorAdminId: admin.adminId,
            sourceIp: request.ip,
            action: 'OFFLOAD_CLEANUP',
            subject: parsed.data.jobId,
            outcome: 'DENIED',
            correlationId: request.id,
            detail: { reason: error instanceof AuthError ? error.code : 'MFA_FAILED' },
          });
          return reply.code(403).send({ error: 'Step-up verification failed' });
        }

        const controller = new AbortController();
        const abortOnDisconnect = (): void => {
          if (!reply.raw.writableEnded) {
            controller.abort(new Error('CLEANUP_CLIENT_DISCONNECTED'));
          }
        };
        request.raw.once('aborted', abortOnDisconnect);
        reply.raw.once('close', abortOnDisconnect);
        try {
          const permit = await recoveryGate.issueDeletionPermit(parsed.data.jobId);
          const result = await cleanup.clean(parsed.data.jobId, permit, controller.signal);
          const response = OffloadCleanupResultSchema.parse({
            jobId: parsed.data.jobId,
            ...result,
          });
          deps.audit.append({
            actorAdminId: admin.adminId,
            sourceIp: request.ip,
            action: 'OFFLOAD_CLEANUP',
            subject: parsed.data.jobId,
            outcome: result.followUpPending ? 'ERROR' : 'SUCCESS',
            correlationId: request.id,
            detail: { deleted: result.deleted, followUpPending: result.followUpPending },
          });
          return reply
            .code(result.followUpPending || !result.localDeleted ? 202 : 200)
            .send(response);
        } catch (error) {
          const code = error instanceof Error ? error.message : 'CLEANUP_FAILED';
          let cleanupAlreadyStarted = false;
          try {
            cleanupAlreadyStarted =
              deps.machine.get(parsed.data.jobId)?.currentStep === 'LOCAL_CLEANUP';
          } catch {
            // If state inspection itself is unavailable, fail conservatively:
            // cleanup may have crossed the durable LOCAL_CLEANUP boundary before
            // the original error, so never answer with an intact-source 409.
            cleanupAlreadyStarted = true;
          }
          deps.audit.append({
            actorAdminId: admin.adminId,
            sourceIp: request.ip,
            action: 'OFFLOAD_CLEANUP',
            subject: parsed.data.jobId,
            outcome: cleanupAlreadyStarted ? 'ERROR' : 'DENIED',
            correlationId: request.id,
            detail: { reason: code, cleanupAlreadyStarted },
          });
          if (cleanupAlreadyStarted) {
            return reply.code(202).send(
              OffloadCleanupResultSchema.parse({
                jobId: parsed.data.jobId,
                localDeletionStarted: true,
                localDeleted: false,
                completed: false,
                deleted: 0,
                followUpPending: true,
                warningCode: 'CLEANUP_PARTIAL_LOCAL_DELETION',
              }),
            );
          }
          if (code === 'OFFLOAD_NOT_FOUND') {
            return reply.code(404).send({ error: 'Transfer not found', code });
          }
          if (code === 'PLAYBACK_PROBE_UNAVAILABLE' || code.startsWith('JELLYFIN_')) {
            return reply.code(503).send({ error: 'Playback observer unavailable', code });
          }
          return reply.code(409).send({ error: 'Cleanup cannot run now', code });
        } finally {
          request.raw.off('aborted', abortOnDisconnect);
          reply.raw.off('close', abortOnDisconnect);
        }
      },
    );
  }
}
