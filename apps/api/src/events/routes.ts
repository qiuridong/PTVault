import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';

import { SESSION_COOKIE_NAME } from '../auth/guards.js';
import type { AuthService } from '../auth/service.js';
import type { EventHub } from './hub.js';

export type EventRouteDependencies = {
  auth: AuthService;
  events: EventHub;
  requireSession: preHandlerAsyncHookHandler;
};

export type DrainWaitOutcome = 'drain' | 'response-closed' | 'subscription-closed';

export type DrainWaitTarget = {
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
  once: (event: 'drain' | 'close', listener: () => void) => unknown;
  off: (event: 'drain' | 'close', listener: () => void) => unknown;
};

export function waitForDrainOrClose(
  response: DrainWaitTarget,
  subscriptionClosed: AbortSignal,
): Promise<DrainWaitOutcome> {
  if (response.destroyed || response.writableEnded) return Promise.resolve('response-closed');
  if (subscriptionClosed.aborted) return Promise.resolve('subscription-closed');

  return new Promise((resolve) => {
    const finish = (outcome: DrainWaitOutcome): void => {
      response.off('drain', onDrain);
      response.off('close', onClose);
      subscriptionClosed.removeEventListener('abort', onSubscriptionClose);
      resolve(outcome);
    };
    const onDrain = (): void => finish('drain');
    const onClose = (): void => finish('response-closed');
    const onSubscriptionClose = (): void => finish('subscription-closed');
    response.once('drain', onDrain);
    response.once('close', onClose);
    subscriptionClosed.addEventListener('abort', onSubscriptionClose, { once: true });
  });
}

export function registerEventRoutes(app: FastifyInstance, deps: EventRouteDependencies): void {
  app.get('/api/events', { preHandler: deps.requireSession }, async (request, reply) => {
    const rawSession = request.cookies[SESSION_COOKIE_NAME];
    if (!rawSession) return reply.code(401).send({ error: 'Unauthorized' });

    const subscription = deps.events.subscribe();
    const response = reply.raw;
    const close = (): void => subscription.close();
    response.once('close', close);
    request.raw.once('aborted', close);

    reply.hijack();
    response.writeHead(200, {
      'cache-control': 'no-cache, no-store, must-revalidate',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
    });
    response.flushHeaders();

    try {
      for await (const message of subscription) {
        if (response.destroyed || response.writableEnded) break;
        if (!deps.auth.requireSession(rawSession)) break;
        const frame =
          message.type === 'heartbeat'
            ? ': heartbeat\n\n'
            : `data: ${JSON.stringify(message.event)}\n\n`;
        if (!response.write(frame)) {
          const outcome = await waitForDrainOrClose(response, subscription.closedSignal);
          if (outcome !== 'drain') {
            if (outcome === 'subscription-closed' && !response.destroyed) response.destroy();
            break;
          }
        }
      }
    } finally {
      subscription.close();
      response.off('close', close);
      request.raw.off('aborted', close);
      if (!response.destroyed && !response.writableEnded) {
        // A hijacked SSE response can become an idle keep-alive connection after
        // the server's closeIdleConnections pass. Finish this one response, then
        // end only its socket gracefully; do not reset other active requests.
        const socket = response.socket;
        response.end(() => socket?.end());
      }
    }
  });
}
