import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { DatabaseNativeRcloneAuthority } from '../cloud-connections/native-rclone-authority.js';
import { EncryptedSecretRepository } from '../cloud-connections/secrets.js';
import { resolveMasterKeyCredential } from '../config/credentials.js';
import { SecretBox } from '../core/crypto.js';
import type { AppDatabase } from '../db/database.js';
import { migrations } from '../db/migrations.js';
import { ProcessRunner, type ProcessRunnerOptions } from './process-runner.js';
import { RcloneConfigError } from './rclone-config-files.js';

type RunnerOptions = Omit<ProcessRunnerOptions, 'nativeConfig'>;

export function createDatabaseRcloneRunner(input: {
  db: AppDatabase;
  masterKey: Uint8Array;
  configPath: string;
  runnerOptions?: RunnerOptions;
  pollMs?: number;
}): ProcessRunner {
  const secrets = new EncryptedSecretRepository({
    db: input.db,
    secretBox: new SecretBox(Buffer.from(input.masterKey)),
    wrappingKey: { id: 'ptvault-master', version: 1 },
  });
  return new ProcessRunner({
    ...input.runnerOptions,
    nativeConfig: {
      authority: new DatabaseNativeRcloneAuthority({
        db: input.db,
        secrets,
        canonicalPath: input.configPath,
      }),
      ...(input.pollMs === undefined ? {} : { pollMs: input.pollMs }),
    },
  });
}

export type ManagedRcloneRuntime = {
  runner: ProcessRunner;
  configPath: string;
  rcloneBin: string;
  close(): void;
};

/** A mount is not an API server: it must neither create nor migrate the app DB,
 * nor require unrelated qB/Jellyfin settings. Open only a pre-migrated local DB,
 * with the same master credential and canonical config as the API. */
export function openManagedRcloneRuntime(input: {
  env: NodeJS.ProcessEnv;
  expectedConfigPath: string;
  runnerOptions?: RunnerOptions;
  pollMs?: number;
}): ManagedRcloneRuntime {
  let db: AppDatabase | undefined;
  try {
    const stateDir = input.env.PTVAULT_STATE_DIR;
    const configured = input.env.PTVAULT_RCLONE_CONFIG;
    if (
      !stateDir ||
      !configured ||
      !path.isAbsolute(stateDir) ||
      !path.isAbsolute(configured) ||
      !path.isAbsolute(input.expectedConfigPath)
    ) {
      throw new RcloneConfigError('RCLONE_MANAGED_RUNTIME_CONFIG_REQUIRED');
    }
    const configPath = realpathSync(configured);
    if (configPath !== realpathSync(input.expectedConfigPath)) {
      throw new RcloneConfigError('RCLONE_MANAGED_RUNTIME_CONFIG_MISMATCH');
    }
    const masterKey = Buffer.from(
      resolveMasterKeyCredential(input.env).PTVAULT_MASTER_KEY ?? '',
      'base64',
    );
    if (masterKey.length !== 32) throw new RcloneConfigError('RCLONE_MANAGED_MASTER_KEY_REQUIRED');
    const filename = path.join(realpathSync(stateDir), 'ptvault.db');
    const info = lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new RcloneConfigError('RCLONE_MANAGED_DATABASE_INVALID');
    }
    db = new Database(filename, { fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    const versions = db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .pluck()
      .all();
    if (
      JSON.stringify(versions) !== JSON.stringify(migrations.map((migration) => migration.version))
    ) {
      throw new RcloneConfigError('RCLONE_MANAGED_DATABASE_UPGRADE_REQUIRED');
    }
    const runner = createDatabaseRcloneRunner({
      db,
      masterKey,
      configPath,
      ...(input.runnerOptions === undefined ? {} : { runnerOptions: input.runnerOptions }),
      ...(input.pollMs === undefined ? {} : { pollMs: input.pollMs }),
    });
    const ownedDb = db;
    return {
      runner,
      configPath,
      rcloneBin: input.env.PTVAULT_RCLONE_BIN?.trim() || 'rclone',
      close: () => ownedDb.close(),
    };
  } catch (error) {
    db?.close();
    throw error instanceof RcloneConfigError
      ? error
      : new RcloneConfigError('RCLONE_MANAGED_RUNTIME_UNAVAILABLE');
  }
}
