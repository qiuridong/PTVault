import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import {
  RecoveryDownloadError,
  type RecoveryDownload,
  type RecoveryDownloadService,
} from './downloads.js';

export function registerRecoveryDownloadRoutes(
  app: FastifyInstance,
  dependencies: {
    downloads: RecoveryDownloadService;
    requireSession: preHandlerAsyncHookHandler;
  },
): void {
  app.get(
    '/api/recovery/exports/:version/files/:kind',
    { preHandler: dependencies.requireSession },
    async (request, reply) => {
      void reply
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff');
      const params = request.params as { version: string; kind: string };
      const version = Number(params.version);
      if (
        !/^[1-9][0-9]*$/.test(params.version) ||
        !Number.isSafeInteger(version) ||
        (params.kind !== 'bundle' && params.kind !== 'escrow')
      )
        return reply
          .code(400)
          .send({ error: 'Invalid recovery file request', code: 'RECOVERY_FILE_REQUEST_INVALID' });
      const controller = new AbortController();
      let download: RecoveryDownload | undefined;
      const finish = (): void => {
        download?.release();
        request.raw.off('aborted', disconnect);
        reply.raw.off('close', disconnect);
        reply.raw.off('finish', finish);
      };
      const disconnect = (): void => {
        controller.abort();
        finish();
      };
      request.raw.once('aborted', disconnect);
      reply.raw.once('close', disconnect);
      reply.raw.once('finish', finish);
      try {
        download = await dependencies.downloads.acquire(version, params.kind, controller.signal);
        if (controller.signal.aborted || reply.raw.destroyed) {
          finish();
          return reply;
        }
        return reply
          .type('application/octet-stream')
          .header('content-disposition', `attachment; filename="${download.filename}"`)
          .header('content-length', String(download.bytes.length))
          .header('x-content-sha256', download.sha256)
          .header('x-recovery-version', String(version))
          .header('x-recovery-file-kind', params.kind)
          .send(download.bytes);
      } catch (error) {
        finish();
        if (reply.raw.destroyed) return reply;
        const known =
          error instanceof RecoveryDownloadError
            ? error
            : new RecoveryDownloadError('RECOVERY_DOWNLOAD_FAILED', 500);
        if (known.statusCode === 429) void reply.header('retry-after', '1');
        return reply
          .code(known.statusCode)
          .send({ error: 'Recovery file unavailable', code: known.code });
      }
    },
  );
}
