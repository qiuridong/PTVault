import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { SetupConfigStore } from './config-store.js';
import { MAX_RCLONE_CONFIG_BYTES } from '../storage/rclone-config-files.js';
import { ensurePrivateDirectory, readPrivateJson, readPrivateText, writePrivateJson, writePrivateText } from './private-files.js';

const MarkerSchema = z.object({ version: z.literal(1), kind: z.literal('PTVAULT_PUBLIC'), port: z.number().int().min(1024).max(65535), keyId: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const GrantSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expiresAt: z.number().int().positive() }).strict();
type Options = { stateDir: string; masterKey: Buffer };
const keyId = (key: Buffer) => { if (key.length !== 32) throw new Error('SETUP_MASTER_KEY_INVALID'); return createHash('sha256').update(key).digest('hex'); };

export function readManagedInstallation(options: Options) {
  ensurePrivateDirectory(options.stateDir);
  const marker = MarkerSchema.parse(readPrivateJson(path.join(options.stateDir, 'installation.json')));
  if (marker.keyId !== keyId(options.masterKey)) throw new Error('SETUP_MASTER_KEY_MISMATCH');
  return marker;
}

export function initializeManagedInstallation(options: Options & { port: number }): void {
  if (!path.isAbsolute(options.stateDir)) throw new Error('SETUP_PATH_INVALID');
  ensurePrivateDirectory(options.stateDir);
  const markerFile = path.join(options.stateDir, 'installation.json');
  if (existsSync(markerFile)) {
    const existing = readManagedInstallation(options);
    if (existing.port !== options.port) throw new Error('SETUP_PORT_MISMATCH');
  } else {
    if (readdirSync(options.stateDir).length > 0) throw new Error('SETUP_EXISTING_INSTALLATION');
    writePrivateJson(markerFile, MarkerSchema.parse({ version: 1, kind: 'PTVAULT_PUBLIC', port: options.port, keyId: keyId(options.masterKey) }));
  }
  if (existsSync(path.join(options.stateDir, 'ptvault.db')) &&
      (!existsSync(path.join(options.stateDir, 'setup', 'configuration.json')) || !existsSync(path.join(options.stateDir, 'rclone', 'rclone.conf')))) {
    throw new Error('SETUP_CONFIG_MISSING');
  }
  const configFile = path.join(options.stateDir, 'rclone', 'rclone.conf');
  if (existsSync(configFile)) readPrivateText(configFile, MAX_RCLONE_CONFIG_BYTES);
  else {
    if (existsSync(path.join(options.stateDir, 'ptvault.db'))) throw new Error('SETUP_CONFIG_MISSING');
    writePrivateText(configFile, '# PTVault-owned configuration. External configuration is imported, never shared.\n');
  }
  new SetupConfigStore(options).initialize();
  ensurePrivateDirectory(path.join(options.stateDir, 'spool'));
  const grantFile = path.join(options.stateDir, 'setup', 'bootstrap.json');
  if (!existsSync(grantFile)) rotateSetupLink(options);
}

export function readBootstrapCredential(stateDir: string) {
  return GrantSchema.parse(readPrivateJson(path.join(stateDir, 'setup', 'bootstrap.json')));
}

export function rotateSetupLink(options: Options): string {
  const marker = readManagedInstallation(options);
  const dbPath = path.join(options.stateDir, 'ptvault.db');
  if (existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='admins'").get() && db.prepare('SELECT 1 FROM admins LIMIT 1').get()) throw new Error('SETUP_CLOSED');
    } finally { db.close(); }
  }
  const credential = { token: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 30 * 60_000 };
  writePrivateJson(path.join(options.stateDir, 'setup', 'bootstrap.json'), credential);
  return `http://localhost:${marker.port}/setup#setup=${credential.token}`;
}
