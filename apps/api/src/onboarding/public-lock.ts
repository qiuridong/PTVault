import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';

/** OS lifetime lock: no stale PID sentinels, token/config locks, or extra processes.
 * Linux abstract sockets are supported by our Node 24 runtime (since Node 20.8).
 * No PrivateNetwork namespace may be added to the public unit: peers must share it.
 */
export async function acquirePublicLock(
  stateDir: string,
  purpose: 'run' | 'metadata',
): Promise<() => Promise<void>> {
  const canonical = realpathSync.native(stateDir),
    stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('SETUP_PATH_INVALID');
  const identity = createHash('sha256').update(`${stat.dev}:${stat.ino}:${purpose}`).digest('hex');
  const socketPath =
    process.platform === 'linux'
      ? `\0ptvault-public-${identity}`
      : process.platform === 'win32'
        ? `\\\\.\\pipe\\ptvault-public-${identity}`
        : null;
  if (socketPath === null) throw new Error('SETUP_PLATFORM_UNSUPPORTED');
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', () => reject(new Error('SETUP_BUSY')));
    server.listen(socketPath, () => resolve());
  });
  server.unref();
  let closing: Promise<void> | undefined;
  return () =>
    (closing ??= new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(new Error('SETUP_LOCK_RELEASE_FAILED')) : resolve())),
    ));
}
