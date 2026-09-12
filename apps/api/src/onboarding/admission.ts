import type { FastifyInstance } from 'fastify';

/** Counts business handler lifetime, not just the lifetime of its browser socket. */
export class ManagedMutationAdmission {
  private readonly requests = new Map<string, 'RECEIVING' | 'EXECUTING'>();
  constructor(private readonly closed: () => boolean) {}
  get activeCount(): number { return this.requests.size; }

  register(app: FastifyInstance): void {
    const requests = this.requests;
    const closed = this.closed;
    const receivingDone = (id: string) => { if (requests.get(id) === 'RECEIVING') requests.delete(id); };
    app.addHook('onRequest', async (request, reply) => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
      if (this.closed()) return reply.code(503).header('retry-after', '2').send({ code: 'SETUP_APPLYING', error: '正在应用配置，请稍后再试。现有任务和凭据不会被重置。' });
      requests.set(request.id, 'RECEIVING');
    });
    app.addHook('onRequestAbort', async (request) => { receivingDone(request.id); });
    app.addHook('onResponse', async (request) => { receivingDone(request.id); });
    app.addHook('onSend', async (request, _reply, payload) => { receivingDone(request.id); return payload; });
    // Must run before routes are registered. No Fastify private contexts are modified.
    app.addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      if (methods.every((method) => ['GET', 'HEAD', 'OPTIONS'].includes(method))) return;
      const original = route.handler;
      route.handler = function (request, reply) {
        if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return original.call(this, request, reply);
        if (closed()) { receivingDone(request.id); return reply.code(503).header('retry-after', '2').send({ code: 'SETUP_APPLYING', error: '正在应用配置，请稍后再试。' }); }
        requests.set(request.id, 'EXECUTING');
        const done = () => { requests.delete(request.id); };
        try {
          const result = original.call(this, request, reply);
          // A synchronous reply is a Fastify thenable, not unfinished business work.
          if (result !== reply && result !== null && typeof result === 'object' && 'then' in result && typeof result.then === 'function') {
            return Promise.resolve(result).finally(done);
          }
          done(); return result;
        } catch (error) { done(); throw error; }
      };
    });
  }
}
