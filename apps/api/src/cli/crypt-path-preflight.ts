import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import type { OffloadImportance } from '@ptvault/contracts';

import {
  CryptPathPreflight,
  type CryptPathPreflightInput,
} from '../storage/crypt-path-preflight.js';
import { snapshotSourceFiles } from '../storage/manifest.js';
import { openManagedRcloneRuntime, type ManagedRcloneRuntime } from '../storage/managed-rclone.js';
import type { CommandRunner } from '../storage/process-runner.js';
import { RcloneClient } from '../storage/rclone.js';

export type CryptPathPreflightCliArgs = {
  sourcePath: string;
  configPath: string;
  cryptRemote: string;
  providerPrefix: string;
  torrentHash: string;
  importance: OffloadImportance;
  jobId?: string;
};

export type RunCryptPathPreflightOptions = {
  argv: readonly string[];
  runner?: CommandRunner;
  rcloneExecutable?: string;
  createJobId?: () => string;
  stdout?: Pick<Writable, 'write'>;
  stderr?: Pick<Writable, 'write'>;
};

export function parseCryptPathPreflightArgs(argv: readonly string[]): CryptPathPreflightCliArgs {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      source: { type: 'string' },
      config: { type: 'string' },
      remote: { type: 'string' },
      'provider-prefix': { type: 'string' },
      'torrent-hash': { type: 'string' },
      importance: { type: 'string' },
      'job-id': { type: 'string' },
    },
  });

  const sourcePath = requireString(values.source, 'source');
  const configPath = requireString(values.config, 'config');
  const cryptRemote = requireString(values.remote, 'remote');
  const providerPrefix = requireString(values['provider-prefix'], 'provider-prefix', true);
  const torrentHash = requireString(values['torrent-hash'], 'torrent-hash');
  const importance = requireString(values.importance, 'importance');
  if (!path.isAbsolute(sourcePath) || !path.isAbsolute(configPath)) {
    throw new Error('ABSOLUTE_PATH_REQUIRED');
  }
  if (importance !== 'STANDARD' && importance !== 'IMPORTANT') {
    throw new Error('INVALID_IMPORTANCE');
  }

  const jobId = values['job-id'];
  return {
    sourcePath: path.resolve(sourcePath),
    configPath: path.resolve(configPath),
    cryptRemote,
    providerPrefix,
    torrentHash,
    importance,
    ...(typeof jobId === 'string' ? { jobId } : {}),
  };
}

export async function runCryptPathPreflight(
  options: RunCryptPathPreflightOptions,
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  let runtime: ManagedRcloneRuntime | undefined;

  try {
    const parsed = parseCryptPathPreflightArgs(options.argv);
    const snapshots = await snapshotSourceFiles(parsed.sourcePath);
    if (snapshots.length === 0) throw new Error('SOURCE_EMPTY');

    if (options.runner === undefined)
      runtime = openManagedRcloneRuntime({
        env: process.env,
        expectedConfigPath: parsed.configPath,
      });
    const configuredExecutable = process.env.PTVAULT_RCLONE_BIN?.trim();
    const rclone = new RcloneClient({
      runner: options.runner ?? runtime!.runner,
      executable: options.rcloneExecutable ?? configuredExecutable ?? 'rclone',
      configPath: parsed.configPath,
    });
    const preflight = new CryptPathPreflight({ encoder: rclone });
    const request: CryptPathPreflightInput = {
      cryptRemote: parsed.cryptRemote,
      providerPrefix: parsed.providerPrefix,
      torrentHash: parsed.torrentHash,
      jobId: parsed.jobId ?? (options.createJobId ?? randomUUID)(),
      importance: parsed.importance,
      relativePaths: snapshots.map((snapshot) => snapshot.relativePath),
    };
    const report = await preflight.check(request);
    stdout.write(`${JSON.stringify(report)}\n`);
    return report.eligible ? 0 : 2;
  } catch {
    stderr.write('Crypt path preflight failed.\n');
    return 1;
  } finally {
    runtime?.close();
  }
}

function requireString(value: string | undefined, name: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`MISSING_${name.toUpperCase().replaceAll('-', '_')}`);
  }
  return value;
}

export async function main(): Promise<void> {
  process.exitCode = await runCryptPathPreflight({ argv: process.argv.slice(2) });
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  void main();
}
