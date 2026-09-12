import {
  LoginRequestSchema,
  MfaRequestSchema,
  SessionSchema,
  type LoginRequest,
  type MfaRequest,
} from '@ptvault/contracts';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
  preHandlerAsyncHookHandler,
} from 'fastify';

import type { AuditInput, AuditRepository } from '../audit/repository.js';
import type { AppMode } from '../config/env.js';
import type { AppDatabase } from '../db/database.js';
import { SESSION_COOKIE_NAME } from './guards.js';
import {
  AuthError,
  type AuthErrorCode,
  type AuthService,
  type SessionPrincipal,
  type SessionToken,
} from './service.js';

const SESSION_COOKIE_OPTIONS = {
  path: '/',
  httpOnly: true,
  secure: true,
  sameSite: 'strict' as const,
};

type AuthRouteDependencies = {
  db: AppDatabase;
  auth: AuthService;
  audit: AuditRepository;
  requireSession: preHandlerAsyncHookHandler;
  /** Reported on the session so the UI can hide controls it must not offer. */
  mode: AppMode;
};

type LoginAuditInput = Omit<AuditInput, 'sourceIp' | 'correlationId' | 'action'>;

type MfaTransactionResult =
  | { ok: true; session: SessionToken; principal: SessionPrincipal }
  | { ok: false; error: AuthError };

const MFA_DENIAL_CODES = new Set<AuthErrorCode>([
  'MFA_CHALLENGE_INVALID',
  'MFA_CHALLENGE_EXPIRED',
  'MFA_CODE_INVALID',
  'MFA_CHALLENGE_LOCKED',
]);

function sourceUserAgent(request: FastifyRequest): string {
  const value = request.headers['user-agent'];
  return typeof value === 'string' ? value : 'unknown';
}

function auditRequest(
  audit: AuditRepository,
  request: FastifyRequest,
  input: Omit<AuditInput, 'sourceIp' | 'correlationId'>,
): void {
  audit.append({
    ...input,
    sourceIp: request.ip,
    correlationId: String(request.id),
  });
}

function loginSubject(request: FastifyRequest): string {
  const body = request.body as Partial<LoginRequest> | undefined;
  const username = body?.username;
  return typeof username === 'string' && username.length >= 1 && username.length <= 64
    ? username
    : 'authentication';
}

function mfaSubject(request: FastifyRequest): string {
  const body = request.body as Partial<MfaRequest> | undefined;
  const challengeId = body?.challengeId;
  return typeof challengeId === 'string' && challengeId.length <= 64
    ? challengeId
    : 'mfa-challenge';
}

function isMfaDenial(error: unknown): error is AuthError {
  return error instanceof AuthError && MFA_DENIAL_CODES.has(error.code);
}

function noStore(reply: FastifyReply): void {
  void reply.header('cache-control', 'no-store');
}

export function registerAuthRoutes(
  app: FastifyInstance,
  dependencies: AuthRouteDependencies,
): void {
  const { db, auth, audit, requireSession, mode } = dependencies;
  const auditedLoginRequests = new WeakSet<FastifyRequest>();
  const auditLogin = (request: FastifyRequest, input: LoginAuditInput): void => {
    if (auditedLoginRequests.has(request)) return;

    auditedLoginRequests.add(request);
    auditRequest(audit, request, { ...input, action: 'AUTH_LOGIN' });
  };
  const finishMfa = db.transaction(
    (request: FastifyRequest, input: MfaRequest): MfaTransactionResult => {
      let session: SessionToken;
      try {
        session = auth.finishLogin(input.challengeId, input.code, {
          sourceIp: request.ip,
          userAgent: sourceUserAgent(request),
        });
      } catch (error) {
        if (!isMfaDenial(error)) throw error;

        auditRequest(audit, request, {
          actorAdminId: null,
          action: 'AUTH_MFA',
          subject: input.challengeId,
          outcome: 'DENIED',
          detail: { reason: error.code },
        });
        return { ok: false, error };
      }

      const principal = auth.requireSession(session.raw);
      if (!principal) throw new Error('Created session could not be loaded');
      auditRequest(audit, request, {
        actorAdminId: principal.adminId,
        action: 'AUTH_MFA',
        subject: principal.username,
        outcome: 'SUCCESS',
        detail: { sessionCreated: true },
      });
      return { ok: true, session, principal };
    },
  );
  const revokeSession = db.transaction((request: FastifyRequest, raw: string): boolean => {
    const admin = request.authenticatedAdmin;
    const revoked = auth.revokeSession(raw);
    auditRequest(audit, request, {
      actorAdminId: admin?.adminId ?? null,
      action: 'AUTH_LOGOUT',
      subject: admin?.username ?? 'session',
      outcome: revoked ? 'SUCCESS' : 'DENIED',
      detail: { sessionRevoked: revoked },
    });
    return revoked;
  });
  const protectCsrf: onRequestHookHandler = (request, reply, done) => {
    app.csrfProtection(request, reply, done);
  };
  const protectLoginCsrf: onRequestHookHandler = (request, reply, done) => {
    let accepted = false;
    app.csrfProtection(request, reply, () => {
      accepted = true;
      done();
    });
    if (!accepted && reply.sent) {
      auditLogin(request, {
        actorAdminId: null,
        subject: loginSubject(request),
        outcome: 'DENIED',
        detail: { reason: 'CSRF_REJECTED' },
      });
    }
  };

  app.get('/api/auth/csrf', async (_request, reply) => {
    noStore(reply);
    return { token: reply.generateCsrf() };
  });

  app.post(
    '/api/auth/login',
    {
      onRequest: protectLoginCsrf,
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
          hook: 'preHandler',
          onExceeded: (request) => {
            auditLogin(request, {
              actorAdminId: null,
              subject: loginSubject(request),
              outcome: 'DENIED',
              detail: { reason: 'RATE_LIMITED' },
            });
          },
        },
      },
      errorHandler: (error, request, reply) => {
        const statusCode = error.statusCode ?? 500;
        auditLogin(request, {
          actorAdminId: null,
          subject: loginSubject(request),
          outcome: statusCode >= 500 ? 'ERROR' : 'DENIED',
          detail: { reason: error.code || 'FRAMEWORK_ERROR' },
        });
        app.errorHandler(error, request, reply);
      },
    },
    async (request, reply) => {
      noStore(reply);
      const parsed = LoginRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        auditLogin(request, {
          actorAdminId: null,
          subject: loginSubject(request),
          outcome: 'DENIED',
          detail: { reason: 'INVALID_REQUEST' },
        });
        return reply.code(400).send({ error: 'Invalid request' });
      }

      try {
        const challenge = await auth.startLogin(parsed.data.username, parsed.data.password);
        auditLogin(request, {
          actorAdminId: null,
          subject: parsed.data.username,
          outcome: 'SUCCESS',
          detail: { mfaRequired: true },
        });
        return { challengeId: challenge.id, expiresAt: challenge.expiresAt };
      } catch (error) {
        if (!(error instanceof AuthError) || error.code !== 'INVALID_CREDENTIALS') throw error;

        auditLogin(request, {
          actorAdminId: null,
          subject: parsed.data.username,
          outcome: 'DENIED',
          detail: { reason: error.code },
        });
        return reply.code(401).send({ error: 'Invalid credentials' });
      }
    },
  );

  app.post(
    '/api/auth/mfa',
    {
      onRequest: protectCsrf,
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
          hook: 'preHandler',
          onExceeded: (request) => {
            auditRequest(audit, request, {
              actorAdminId: null,
              action: 'AUTH_MFA',
              subject: mfaSubject(request),
              outcome: 'DENIED',
              detail: { reason: 'RATE_LIMITED' },
            });
          },
        },
      },
    },
    async (request, reply) => {
      noStore(reply);
      const parsed = MfaRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        auditRequest(audit, request, {
          actorAdminId: null,
          action: 'AUTH_MFA',
          subject: 'mfa-challenge',
          outcome: 'DENIED',
          detail: { reason: 'INVALID_REQUEST' },
        });
        return reply.code(400).send({ error: 'Invalid request' });
      }

      const result = finishMfa(request, parsed.data);
      if (!result.ok) {
        return reply.code(401).send({ error: 'Invalid credentials' });
      }

      reply.setCookie(SESSION_COOKIE_NAME, result.session.raw, {
        ...SESSION_COOKIE_OPTIONS,
        expires: new Date(result.session.expiresAt),
      });
      return SessionSchema.parse({
        username: result.principal.username,
        expiresAt: result.principal.expiresAt,
        mode,
      });
    },
  );

  app.get('/api/auth/session', { preHandler: requireSession }, async (request, reply) => {
    noStore(reply);
    const raw = request.cookies[SESSION_COOKIE_NAME];
    const principal = raw ? auth.requireSession(raw) : null;
    if (!principal) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    return SessionSchema.parse({
      username: principal.username,
      expiresAt: principal.expiresAt,
      mode,
    });
  });

  app.post(
    '/api/auth/logout',
    { onRequest: protectCsrf, preHandler: requireSession },
    async (request, reply) => {
      noStore(reply);
      const raw = request.cookies[SESSION_COOKIE_NAME];
      const revoked = raw ? revokeSession(request, raw) : false;

      if (!revoked) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      reply.clearCookie(SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
      return reply.code(204).send();
    },
  );
}
