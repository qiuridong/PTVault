import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import type { Clock } from '../core/clock.js';
import { ImportControlError, importInvariant } from './errors.js';
import { assertSecretRef } from './security.js';

export type ImportSecret = { ref: string; expiresAt: number };

export interface ImportSecretStore {
  put(value: string, ttlMs: number): ImportSecret;
  read(ref: string): string;
  delete(ref: string): boolean;
}

type MemoryEntry = { value: string; expiresAt: number };

/**
 * Test/development implementation. Production wiring uses a worker-owned
 * credential provider; keeping this implementation explicit prevents the API
 * from silently falling back to process memory after a restart.
 */
export class MemoryImportSecretStore implements ImportSecretStore {
  private readonly entries = new Map<string, MemoryEntry>();

  constructor(private readonly now: Clock = () => new Date()) {}

  put(value: string, ttlMs: number): ImportSecret {
    importInvariant(value.length > 0 && value.length <= 64, 'IMPORT_PASSCODE_INVALID', 400);
    importInvariant(
      Number.isSafeInteger(ttlMs) && ttlMs >= 1_000 && ttlMs <= 86_400_000,
      'IMPORT_SECRET_TTL_INVALID',
      500,
    );
    const ref = `import-secret:${randomUUID()}`;
    const expiresAt = this.now().getTime() + ttlMs;
    this.entries.set(ref, { value, expiresAt });
    return { ref, expiresAt };
  }

  read(ref: string): string {
    assertSecretRef(ref);
    const entry = this.entries.get(ref);
    if (!entry) throw new ImportControlError('IMPORT_SECRET_NOT_FOUND', 409);
    if (entry.expiresAt <= this.now().getTime()) {
      this.entries.delete(ref);
      throw new ImportControlError('IMPORT_SECRET_EXPIRED', 409);
    }
    return entry.value;
  }

  delete(ref: string): boolean {
    assertSecretRef(ref);
    return this.entries.delete(ref);
  }

  activeCount(): number {
    return this.entries.size;
  }
}

type FileEnvelope = { version: 1; expiresAt: number; value: string };

function fsyncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, 'r');
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform !== 'win32' ||
      !['EINVAL', 'EPERM', 'EISDIR', 'EBADF'].includes(code ?? '')
    ) {
      throw error;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Atomic, TTL-bound filesystem ingress for production wiring. The directory is
 * expected to be a private bind shared with the importer worker. Only opaque
 * references enter SQLite; passcodes never enter the PT Vault database.
 */
export class FileImportSecretStore implements ImportSecretStore {
  readonly root: string;

  constructor(
    root: string,
    private readonly now: Clock = () => new Date(),
  ) {
    importInvariant(path.isAbsolute(root), 'IMPORT_SECRET_ROOT_INVALID', 500);
    this.root = path.resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    chmodSync(this.root, 0o700);
    const rootStat = lstatSync(this.root);
    importInvariant(
      rootStat.isDirectory() && !rootStat.isSymbolicLink(),
      'IMPORT_SECRET_ROOT_INVALID',
      500,
    );
  }

  put(value: string, ttlMs: number): ImportSecret {
    importInvariant(value.length > 0 && value.length <= 64, 'IMPORT_PASSCODE_INVALID', 400);
    importInvariant(
      Number.isSafeInteger(ttlMs) && ttlMs >= 1_000 && ttlMs <= 86_400_000,
      'IMPORT_SECRET_TTL_INVALID',
      500,
    );
    const id = randomUUID();
    const ref = `import-secret:${id}`;
    const finalPath = this.secretPath(ref);
    const temporaryPath = `${finalPath}.${randomUUID()}.tmp`;
    const expiresAt = this.now().getTime() + ttlMs;
    const envelope: FileEnvelope = { version: 1, expiresAt, value };
    let fd: number | undefined;
    try {
      fd = openSync(temporaryPath, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(envelope), 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, finalPath);
      fsyncDirectory(this.root);
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      rmSync(temporaryPath, { force: true });
      throw error;
    }
    return { ref, expiresAt };
  }

  read(ref: string): string {
    const secretPath = this.secretPath(ref);
    let envelope: FileEnvelope;
    try {
      const fileStat = lstatSync(secretPath);
      importInvariant(
        fileStat.isFile() && !fileStat.isSymbolicLink(),
        'IMPORT_SECRET_FILE_INVALID',
        409,
      );
      const fd = openSync(secretPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      try {
        envelope = JSON.parse(readFileSync(fd, 'utf8')) as FileEnvelope;
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if (error instanceof ImportControlError) throw error;
      throw new ImportControlError('IMPORT_SECRET_NOT_FOUND', 409);
    }
    importInvariant(
      envelope.version === 1 &&
        typeof envelope.expiresAt === 'number' &&
        typeof envelope.value === 'string',
      'IMPORT_SECRET_FILE_INVALID',
      409,
    );
    if (envelope.expiresAt <= this.now().getTime()) {
      this.delete(ref);
      throw new ImportControlError('IMPORT_SECRET_EXPIRED', 409);
    }
    return envelope.value;
  }

  delete(ref: string): boolean {
    const secretPath = this.secretPath(ref);
    if (!existsSync(secretPath)) return false;
    const fileStat = lstatSync(secretPath);
    importInvariant(
      fileStat.isFile() && !fileStat.isSymbolicLink(),
      'IMPORT_SECRET_FILE_INVALID',
      409,
    );
    rmSync(secretPath, { force: false });
    fsyncDirectory(this.root);
    return true;
  }

  private secretPath(ref: string): string {
    assertSecretRef(ref);
    const id = ref.slice('import-secret:'.length);
    const resolved = path.resolve(this.root, `${id}.secret`);
    importInvariant(
      resolved.startsWith(`${this.root}${path.sep}`),
      'IMPORT_SECRET_PATH_INVALID',
      500,
    );
    return resolved;
  }
}
