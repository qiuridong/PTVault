import { createReadStream, lstatSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff' };
const SPA_ROUTES = new Set(['/', '/setup', '/login', '/login/mfa', '/login/recovery', '/settings', '/settings/setup', '/settings/netdisk', '/imports', '/transfers', '/torrents', '/storage-accounts', '/recovery', '/media', '/audit']);

/** Only a release's public build tree is registered; there is no filesystem URL resolver. */
export function registerStaticApp(app: FastifyInstance, directory: string): void {
  const root = realpathSync(directory);
  const files = new Map<string, { filename: string; type: string }>();
  function visit(relative: string, depth: number) {
    if (depth > 8) throw new Error('SETUP_WEB_BUILD_INVALID');
    for (const entry of readdirSync(path.join(root, relative))) {
      const filename = path.join(root, relative, entry);
      const stats = lstatSync(filename);
      if (stats.isSymbolicLink()) throw new Error('SETUP_WEB_BUILD_INVALID');
      if (entry.startsWith('.')) continue;
      if (stats.isDirectory()) { visit(path.join(relative, entry), depth + 1); continue; }
      const type = TYPES[path.extname(entry)];
      if (!type) continue;
      if (!stats.isFile() || stats.nlink !== 1 || stats.size > 32 * 1024 * 1024 || files.size >= 4096) throw new Error('SETUP_WEB_BUILD_INVALID');
      files.set(`/${[...relative.split(path.sep).filter(Boolean), entry].join('/')}`, { filename, type });
    }
  }
  visit('', 0);
  if (!files.has('/index.html')) throw new Error('SETUP_WEB_BUILD_MISSING');
  app.get('/*', (request, reply) => {
    const requested = request.url.split('?')[0] ?? '';
    const file = files.get(requested) ?? (SPA_ROUTES.has(requested) ? files.get('/index.html') : undefined);
    if (!file || requested.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
    void reply.type(file.type).header('cache-control', file.type.startsWith('text/html') ? 'no-store' : requested.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    return reply.send(createReadStream(file.filename));
  });
}
