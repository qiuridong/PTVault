import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { ArchiveError, archiveAssert } from './inspection.js';

export function isVideoProbeResult(text: string): boolean {
  if (Buffer.byteLength(text) > 1024 * 1024) return false;
  try {
    const value: unknown = JSON.parse(text);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('streams' in value) ||
      !Array.isArray(value.streams)
    )
      return false;
    return value.streams.some((stream: unknown) => {
      if (typeof stream !== 'object' || stream === null) return false;
      const s = stream as Record<string, unknown>;
      const disposition = s['disposition'] as { attached_pic?: unknown } | undefined;
      return (
        s['codec_type'] === 'video' &&
        typeof s['codec_name'] === 'string' &&
        s['codec_name'] !== 'unknown' &&
        typeof s['width'] === 'number' &&
        s['width'] > 0 &&
        typeof s['height'] === 'number' &&
        s['height'] > 0 &&
        disposition?.attached_pic !== 1
      );
    });
  } catch {
    return false;
  }
}

/** One local file is readable; no sibling files, host libraries, sockets or writes. */
export class ArchiveVideoProbe {
  constructor(
    private readonly options: { runtimeRoot: string; sandboxHelper: string; pythonBinary?: string },
  ) {}
  async probe(filename: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const info = await lstat(filename);
    archiveAssert(
      info.isFile() && !info.isSymbolicLink() && info.nlink === 1,
      'ARCHIVE_VIDEO_INVALID',
    );
    const file = await realpath(filename),
      root = await realpath(this.options.runtimeRoot);
    archiveAssert(
      path.isAbsolute(this.options.sandboxHelper) && process.platform === 'linux',
      'ARCHIVE_SANDBOX_UNAVAILABLE',
    );
    return new Promise<boolean>((resolve, reject) => {
      let bytes = 0,
        diagnosticBytes = 0,
        failure: Error | null = null;
      const chunks: Buffer[] = [];
      const child = spawn(
        this.options.pythonBinary ?? '/usr/bin/python3',
        [
          '-I',
          this.options.sandboxHelper,
          '--binary',
          path.join(root, 'loader'),
          '--input',
          path.dirname(file),
          '--probe-runtime',
          root,
          '--probe-file',
          file,
        ],
        {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
          cwd: path.dirname(file),
        },
      );
      const stop = (error: Error) => {
        failure ??= error;
        child.kill('SIGKILL');
      };
      const abort = () => stop(new DOMException('Video probe aborted', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(() => stop(new ArchiveError('ARCHIVE_VIDEO_PROBE_TIMEOUT')), 60000);
      child.stdout.on('data', (data: Buffer) => {
        bytes += data.length;
        if (bytes > 1024 * 1024) stop(new ArchiveError('ARCHIVE_VIDEO_PROBE_LIMIT'));
        else chunks.push(data);
      });
      child.stderr.on('data', (data: Buffer) => {
        diagnosticBytes += data.length;
        if (data.includes('ARCHIVE_SANDBOX_UNAVAILABLE'))
          stop(new ArchiveError('ARCHIVE_SANDBOX_UNAVAILABLE'));
        if (diagnosticBytes > 128 * 1024) stop(new ArchiveError('ARCHIVE_VIDEO_PROBE_LIMIT'));
      });
      child.on('error', () => {
        failure ??= new ArchiveError('ARCHIVE_TOOL_UNAVAILABLE');
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (failure !== null) reject(failure);
        else resolve(code === 0 && isVideoProbeResult(Buffer.concat(chunks).toString('utf8')));
      });
    });
  }
}
