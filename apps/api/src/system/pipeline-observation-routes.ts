import { PipelineObservationQuerySchema } from '@ptvault/contracts';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type { PipelineObservationService } from './pipeline-observation-service.js';

export function registerPipelineObservationRoutes(
  app: FastifyInstance,
  deps: {
    service?: PipelineObservationService;
    requireSession: preHandlerAsyncHookHandler;
  },
): void {
  for (const exportFile of [false, true])
    app.get(
      `/api/import-pipelines/observations${exportFile ? '/export' : ''}`,
      { preHandler: deps.requireSession },
      (request, reply) => {
        if (!deps.service)
          return reply.code(503).send({
            error: 'Observation history is not configured',
            code: 'GROUP_OBSERVATION_UNAVAILABLE',
          });
        const query = PipelineObservationQuerySchema.safeParse(request.query);
        if (!query.success)
          return reply.code(400).send({
            error: 'Choose a time window of at most 30 days and at most 500 points',
            code: 'GROUP_OBSERVATION_QUERY_INVALID',
          });
        reply.header('Cache-Control', 'no-store');
        if (exportFile)
          reply.header(
            'Content-Disposition',
            'attachment; filename="ptvault-group-observations.json"',
          );
        return reply.send(deps.service.history(query.data));
      },
    );
}
