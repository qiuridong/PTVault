import { chmodSync, lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import path from 'node:path';
import type { MaintenanceLease, ManagedMaintenance } from './maintenance.js';

/** Filesystem permissions, not a web route, authorize this Linux-only local control. */
export async function startControlSocket(stateDir: string, maintenance: ManagedMaintenance) {
  if (process.platform !== 'linux') throw Error('CONTROL_PLATFORM');
  const uid = process.getuid!(), directory = lstatSync(stateDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || realpathSync(stateDir) !== stateDir || directory.uid !== uid || (directory.mode & 0o077) !== 0) throw Error('CONTROL_PATH_UNSAFE');
  const filename = path.join(stateDir, 'control.sock');
  try {
    const existing = lstatSync(filename);
    // The caller MUST already hold this installation's exclusive kernel run lock.
    if (!existing.isSocket() || existing.uid !== uid) throw Error('CONTROL_PATH_UNSAFE');
    unlinkSync(filename);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    if (sockets.size >= 4) { socket.destroy(); return; }
    sockets.add(socket);
    let pending = Buffer.alloc(0), lease: MaintenanceLease | undefined;
    const release = () => { lease?.release(); lease = undefined; };
    const fail = (code: string) => { release(); socket.end(`${JSON.stringify({ ok: false, code })}\n`); };
    socket.setTimeout(15_000, () => { release(); socket.destroy(); });
    socket.on('error', () => { release(); socket.destroy(); });
    socket.on('close', () => { release(); sockets.delete(socket); });
    socket.on('data', chunk => {
      if (socket.writableEnded) return;
      if (pending.length + chunk.length > 1024) { fail('CONTROL_PROTOCOL'); return; }
      pending = Buffer.concat([pending, chunk]);
      const end = pending.indexOf(10);
      if (end < 0) return;
      // One request at a time, no bundled commands or unbounded streams.
      if (end !== pending.length - 1) { fail('CONTROL_PROTOCOL'); return; }
      let op: string;
      try {
        const input: unknown = JSON.parse(pending.subarray(0, end).toString('utf8'));
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !('op' in input) || typeof input.op !== 'string' || !['prepare', 'probe', 'abort'].includes(input.op)) throw Error('FORMAT');
        op = String(input.op);
      } catch { fail('CONTROL_PROTOCOL'); return; }
      pending = Buffer.alloc(0);
      try {
        if (op === 'abort') { release(); socket.end('{"ok":true,"released":true}\n'); return; }
        if (op === 'prepare') {
          if (lease) throw Error('SETUP_BUSY');
          lease = maintenance.prepare();
        }
        if (!lease) throw Error('SETUP_BUSY');
        const status = lease.probe();
        socket.setTimeout(600_000);
        socket.write(`${JSON.stringify({ ok: true, pid: process.pid, ...status })}\n`);
      } catch { fail('SETUP_BUSY'); }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(filename, () => { server.off('error', reject); resolve(); });
    });
    chmodSync(filename, 0o600);
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    throw error;
  }
  server.on('error', () => { for (const socket of sockets) socket.destroy(); });
  server.unref();
  let stopping: Promise<void> | undefined;
  return { stop: () => (stopping ??= new Promise<void>((resolve, reject) => {
    for (const socket of sockets) socket.destroy();
    server.close(error => error ? reject(error) : resolve());
  })) };
}
