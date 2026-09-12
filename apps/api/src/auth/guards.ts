import type { preHandlerAsyncHookHandler } from 'fastify';

import type { AuthService } from './service.js';

export const SESSION_COOKIE_NAME = 'ptvault_session';

export type AuthenticatedAdmin = {
  adminId: string;
  username: string;
};

declare module 'fastify' {
  interface FastifyRequest {
    authenticatedAdmin: AuthenticatedAdmin | null;
  }
}

export function createSessionGuard(auth: AuthService): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    const raw = request.cookies[SESSION_COOKIE_NAME];
    const principal = raw ? auth.requireSession(raw) : null;

    if (!principal) {
      await reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    request.authenticatedAdmin = {
      adminId: principal.adminId,
      username: principal.username,
    };
  };
}

/**
 * Demands a fresh, single-use TOTP code alongside a valid session.
 *
 * Used on the recovery mutations, which decide whether local files may ever be
 * deleted. A live session is not enough for those: a stolen cookie would
 * otherwise be able to configure a recipient the attacker controls, or attest a
 * passphrase drill that never happened, and thereby unlock deletion.
 *
 * The code is spent via `verifyStepUp`, so replaying a captured one inside its
 * 30-second window fails. Runs after the session guard, which is what puts
 * `authenticatedAdmin` on the request.
 */
export function createRecentMfaGuard(
  auth: Pick<AuthService, 'verifyStepUp'>,
): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    const admin = request.authenticatedAdmin;
    if (!admin) {
      await reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const body = request.body;
    const code =
      typeof body === 'object' && body !== null && 'mfaCode' in body ? body.mfaCode : undefined;
    if (typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) {
      await reply.code(403).send({ error: 'Step-up verification required' });
      return;
    }

    try {
      auth.verifyStepUp(admin.adminId, code);
    } catch {
      // 403, not 401: the session is valid, the step-up is what failed. A 401
      // would make the browser client tear down a perfectly good session.
      await reply.code(403).send({ error: 'Step-up verification failed' });
    }
  };
}
