import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveMasterKeyCredential } from '../config/credentials.js';
import { parseConfig } from '../config/env.js';
import { openDatabase } from '../db/database.js';
import { StorageAccountRepository, UnknownRemoteError } from '../storage/accounts.js';
import { createDatabaseRcloneRunner } from '../storage/managed-rclone.js';
import { RcloneClient } from '../storage/rclone.js';

/**
 * Registers a cloud destination and probes its capacity.
 *
 * Exists because account registration previously lived only inside
 * `pilot-offload.ts`, inline with a full one-shot migration — so there was no way
 * to populate `storage_accounts` without also moving a torrent. A recovery bundle
 * needs two HEALTHY destinations before any upload may start, which made this the
 * one missing piece between a deployed build and a usable recovery gate.
 *
 * Deliberately read-only against the cloud: `rclone about` reports quota and
 * nothing else. It creates no remote directory, uploads nothing, deletes nothing.
 */
export type RegisterAccountArgs = {
  label: string;
  rawRemote: string;
  cryptRemote: string;
  reserveBytes: number;
};

export class UsageError extends Error {}

const USAGE = `Usage:
  register-account --label <name> --raw-remote <alias:> --crypt-remote <alias:>
                   [--reserve-bytes <n>]

  --label          Human-readable name shown in the UI.
  --raw-remote     Backing rclone remote, e.g. ptvault-backend:
  --crypt-remote   Crypt remote wrapping it, e.g. ptvault-crypt:
  --reserve-bytes  Headroom kept free on the account (default 0).

Both remotes must already exist in the rclone config named by
PTVAULT_RCLONE_CONFIG; unknown aliases are rejected rather than created.`;

export function parseRegisterAccountArgs(argv: readonly string[]): RegisterAccountArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (!token.startsWith('--')) throw new UsageError(`Unexpected argument: ${token}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new UsageError(`Missing value for ${token}`);
    }
    values.set(token.slice(2), next);
    index += 1;
  }

  const label = values.get('label')?.trim();
  const rawRemote = values.get('raw-remote')?.trim();
  const cryptRemote = values.get('crypt-remote')?.trim();
  // `?? '0'` alone would let `--reserve-bytes ''` through as 0, since `''` is not
  // nullish and `Number('')` is 0. An empty value almost always means an
  // unexpanded shell variable, so it fails rather than silently reserving nothing.
  const reserveProvided = values.get('reserve-bytes');
  const reserveRaw = reserveProvided === undefined ? '0' : reserveProvided.trim();
  if (reserveRaw === '') throw new UsageError('--reserve-bytes must not be empty');
  if (!label) throw new UsageError('--label is required');
  if (!rawRemote) throw new UsageError('--raw-remote is required');
  if (!cryptRemote) throw new UsageError('--crypt-remote is required');
  if (rawRemote === cryptRemote) {
    throw new UsageError('--raw-remote and --crypt-remote must differ');
  }
  const reserveBytes = Number(reserveRaw);
  if (!Number.isInteger(reserveBytes) || reserveBytes < 0) {
    throw new UsageError('--reserve-bytes must be a non-negative integer');
  }

  return { label, rawRemote, cryptRemote, reserveBytes };
}

export async function main(): Promise<void> {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    const args = parseRegisterAccountArgs(process.argv.slice(2));
    const config = parseConfig(resolveMasterKeyCredential(process.env));
    if (config.rcloneConfigPath === null) {
      process.stdout.write('PTVAULT_RCLONE_CONFIG is required.\n');
      process.exitCode = 1;
      return;
    }

    db = openDatabase(path.join(config.stateDir, 'ptvault.db'));
    const accounts = new StorageAccountRepository(db);
    const rclone = new RcloneClient({
      runner: createDatabaseRcloneRunner({
        db,
        masterKey: config.masterKey,
        configPath: config.rcloneConfigPath,
      }),
      executable: config.rcloneBin,
      configPath: config.rcloneConfigPath,
    });

    // Registration is rejected outright for an alias the config does not define,
    // so a typo cannot create an account that points at nothing.
    const account = accounts.register(args, await rclone.listRemotes());

    // Probed *after* the row exists, so a probe failure leaves a visible
    // AUTH_REQUIRED account to retry rather than nothing at all.
    const capacity = await rclone.about(args.rawRemote);
    accounts.recordHealth(account.id, {
      health: 'HEALTHY',
      totalBytes: capacity.total,
      freeBytes: capacity.free,
      checkedAt: Date.now(),
    });

    process.stdout.write(
      `${JSON.stringify(
        {
          id: account.id,
          label: account.label,
          rawRemote: account.rawRemote,
          cryptRemote: account.cryptRemote,
          health: 'HEALTHY',
          totalBytes: capacity.total,
          freeBytes: capacity.free,
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 0;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stdout.write(`${error.message}\n\n${USAGE}\n`);
    } else if (error instanceof UnknownRemoteError) {
      process.stdout.write(
        `${error.message}\nThe alias is not defined in the rclone config; check 'rclone listremotes'.\n`,
      );
    } else {
      // Never the raw error: rclone messages carry config paths and can echo
      // response bodies from the provider.
      process.stdout.write('Account registration failed.\n');
    }
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  void main();
}
