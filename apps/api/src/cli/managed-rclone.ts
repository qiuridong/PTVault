import path from 'node:path';
import { realpathSync } from 'node:fs';
import type { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { openManagedRcloneRuntime, type ManagedRcloneRuntime } from '../storage/managed-rclone.js';
import type { ProcessRunnerOptions } from '../storage/process-runner.js';
import { RcloneConfigError } from '../storage/rclone-config-files.js';

const booleanFlags = new Set([
  '--read-only',
  '--allow-other',
  '--rc',
  '--use-json-log',
  '--no-checksum',
  '--no-modtime',
]);
const valueFlags = new Set([
  '--config',
  '--umask',
  '--vfs-cache-mode',
  '--vfs-cache-max-size',
  '--vfs-cache-min-free-space',
  '--cache-dir',
  '--vfs-read-ahead',
  '--buffer-size',
  '--vfs-read-chunk-size',
  '--vfs-read-chunk-size-limit',
  '--dir-cache-time',
  '--poll-interval',
  '--rc-addr',
  '--rc-htpasswd',
  '--log-level',
]);

/** Only the reviewed foreground mount surface, not a pass-through CLI. In
 * particular no --daemon, --log-file/dump, remote overrides or credential argv.
 * rclone stays in this service's cgroup and sends READY itself after FUSE works. */
export function parseManagedRcloneArgs(argv: readonly string[]): {
  executable: string;
  args: string[];
  configPath: string;
} {
  const invalid = (): never => {
    throw new RcloneConfigError('RCLONE_MANAGED_ARGUMENT_INVALID');
  };
  if (
    argv[0] !== '--rclone-bin' ||
    !argv[1] ||
    argv[2] !== '--' ||
    argv.some((arg) => /[\0\r\n]/.test(arg))
  )
    invalid();
  const executable = argv[1]!;
  if (!path.isAbsolute(executable)) invalid();
  const args = argv.slice(3);
  if (
    args[0] !== 'mount' ||
    !/^[A-Za-z0-9_-]+:[^,\0\r\n]*$/.test(args[1] ?? '') ||
    !path.isAbsolute(args[2] ?? '')
  )
    invalid();
  const seen = new Set<string>();
  let configPath = '';
  for (let index = 3; index < args.length; index += 1) {
    const flag = args[index]!;
    if (seen.has(flag)) invalid();
    seen.add(flag);
    if (booleanFlags.has(flag)) continue;
    if (!valueFlags.has(flag)) invalid();
    const value = args[++index];
    if (!value || value.startsWith('--')) invalid();
    if (flag === '--config') configPath = value!;
    if (flag === '--log-level' && !['INFO', 'NOTICE', 'ERROR'].includes(value!)) invalid();
  }
  if (!path.isAbsolute(configPath) || !seen.has('--read-only')) invalid();
  return { executable, args, configPath };
}

export async function runManagedRclone(options: {
  argv: readonly string[];
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  stderr?: Pick<Writable, 'write'>;
  runnerOptions?: Omit<ProcessRunnerOptions, 'nativeConfig'>;
  pollMs?: number;
}): Promise<number> {
  const stderr = options.stderr ?? process.stderr;
  let runtime: ManagedRcloneRuntime | undefined;
  try {
    const parsed = parseManagedRcloneArgs(options.argv);
    const env = options.env ?? process.env;
    runtime = openManagedRcloneRuntime({
      env,
      expectedConfigPath: parsed.configPath,
      ...(options.runnerOptions === undefined ? {} : { runnerOptions: options.runnerOptions }),
      ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    });
    const result = await runtime.runner.run({
      executable: parsed.executable,
      args: parsed.args,
      env,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      // The coordinator has already removed arbitrary text and provider data.
      // Mount stdout is not public diagnostic output and is deliberately dropped.
      onStderrLine: (line) => {
        stderr.write(`${line}\n`);
      },
    });
    if (result.exitCode !== 0) stderr.write('RCLONE_MANAGED_PROCESS_FAILED\n');
    return result.exitCode === 0 ? 0 : 1;
  } catch (error) {
    // A simultaneous config fault wins over normal shutdown. Never label a
    // failed credential commit successful just because SIGTERM also arrived.
    if (
      options.signal?.aborted &&
      error === options.signal.reason &&
      !(error instanceof RcloneConfigError)
    )
      return 0;
    stderr.write(
      `${error instanceof RcloneConfigError ? error.code : 'RCLONE_MANAGED_PROCESS_FAILED'}\n`,
    );
    return 1;
  } finally {
    runtime?.close();
  }
}

export async function main(): Promise<void> {
  const stop = new AbortController();
  const onStop = (): void => stop.abort(new Error('RCLONE_MANAGED_STOP'));
  process.on('SIGTERM', onStop);
  process.on('SIGINT', onStop);
  try {
    process.exitCode = await runManagedRclone({ argv: process.argv.slice(2), signal: stop.signal });
  } finally {
    process.off('SIGTERM', onStop);
    process.off('SIGINT', onStop);
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(realpathSync.native(invokedPath)).href) void main();
