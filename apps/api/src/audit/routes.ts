import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';

import { AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT } from '@ptvault/contracts';

import type { AuditRepository } from './repository.js';

/**
 * Reads `?limit=`, falling back rather than failing.
 *
 * Only a plain positive integer is honoured. `?limit=abc` would otherwise reach
 * `Math.trunc(NaN)` in the repository and end up as `LIMIT NaN`, and a page that
 * errors because someone hand-edited a URL is worse than one that shows the
 * default hundred. Out-of-range values clamp instead of erroring for the same
 * reason — the ceiling is a resource limit, not an assertion about the caller.
 */
function parseLimit(raw: unknown): number {
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw)) return AUDIT_DEFAULT_LIMIT;
  return Math.min(AUDIT_MAX_LIMIT, Number(raw));
}

export function registerAuditRoutes(
  app: FastifyInstance,
  input: { audit: AuditRepository; requireSession: preHandlerAsyncHookHandler },
): void {
  app.get('/api/audit', { preHandler: input.requireSession }, async (request, reply) => {
    void reply.header('cache-control', 'no-store');
    const limit = parseLimit((request.query as Record<string, unknown> | undefined)?.limit);
    return { events: input.audit.listRecent(limit) };
  });
}
