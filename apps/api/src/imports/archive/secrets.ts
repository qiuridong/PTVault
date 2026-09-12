import { createHmac, randomUUID } from 'node:crypto';
import {
  constants,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { ArchiveCandidatesSchema } from '@ptvault/contracts';
import type { SecretBox } from '../../core/crypto.js';
import { ArchiveError, archiveAssert } from './inspection.js';

const TTL = 7 * 24 * 60 * 60 * 1000;
type Options = {
  root: string;
  box: Pick<SecretBox, 'seal' | 'open'>;
  fingerprintKey?: Buffer;
  now?: () => number;
};
type Envelope = { version: 1; expiresAt: number; ciphertext: string };

function syncDirectory(root: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(root, 'r');
    fsyncSync(fd);
  } catch (error) {
    if (
      process.platform !== 'win32' ||
      !['EINVAL', 'EPERM', 'EISDIR', 'EBADF'].includes((error as NodeJS.ErrnoException).code ?? '')
    )
      throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** AES-GCM at rest, opaque references in SQLite; candidates never enter recovery JSON. */
export class ArchivePasswordStore {
  private readonly root: string;
  private readonly now: () => number;
  constructor(private readonly options: Options) {
    archiveAssert(path.isAbsolute(options.root), 'ARCHIVE_CREDENTIAL_INVALID');
    this.root = path.resolve(options.root);
    this.now = options.now ?? Date.now;
    if (existsSync(this.root))
      archiveAssert(
        lstatSync(this.root).isDirectory() && !lstatSync(this.root).isSymbolicLink(),
        'ARCHIVE_CREDENTIAL_INVALID',
      );
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    chmodSync(this.root, 0o700);
  }

  put(candidates: readonly string[]): string {
    this.pruneExpired();
    const parsed = ArchiveCandidatesSchema.min(1).safeParse(candidates);
    archiveAssert(parsed.success, 'ARCHIVE_CREDENTIAL_INVALID');
    const ref = `archive-secret:${randomUUID()}`,
      final = this.filename(ref);
    const temporary = `${final}.${randomUUID()}.tmp`;
    const expiresAt = this.now() + TTL;
    const ciphertext = this.options.box.seal(
      JSON.stringify({ ref, expiresAt, candidates: [...new Set(parsed.data)] }),
    );
    const envelope: Envelope = { version: 1, expiresAt, ciphertext };
    let fd: number | undefined;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(envelope), 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, final);
      syncDirectory(this.root);
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
    return ref;
  }

  read(ref: string): string[] {
    const filename = this.filename(ref);
    let fd: number | undefined;
    try {
      fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = fstatSync(fd);
      archiveAssert(
        info.isFile() &&
          info.nlink === 1 &&
          info.size <= 65536 &&
          (process.platform === 'win32' || (info.mode & 0o077) === 0),
        'ARCHIVE_CREDENTIAL_INVALID',
      );
      const raw: unknown = JSON.parse(readFileSync(fd, 'utf8'));
      archiveAssert(
        typeof raw === 'object' &&
          raw !== null &&
          'version' in raw &&
          raw.version === 1 &&
          'expiresAt' in raw &&
          typeof raw.expiresAt === 'number' &&
          Number.isSafeInteger(raw.expiresAt) &&
          'ciphertext' in raw &&
          typeof raw.ciphertext === 'string',
        'ARCHIVE_CREDENTIAL_INVALID',
      );
      const inner: unknown = JSON.parse(this.options.box.open(raw.ciphertext));
      archiveAssert(
        typeof inner === 'object' &&
          inner !== null &&
          'ref' in inner &&
          inner.ref === ref &&
          'expiresAt' in inner &&
          inner.expiresAt === raw.expiresAt &&
          'candidates' in inner,
        'ARCHIVE_CREDENTIAL_INVALID',
      );
      const parsed = ArchiveCandidatesSchema.min(1).safeParse(inner.candidates);
      archiveAssert(parsed.success, 'ARCHIVE_CREDENTIAL_INVALID');
      if (raw.expiresAt <= this.now()) {
        closeSync(fd);
        fd = undefined;
        this.delete(ref);
        throw new ArchiveError('ARCHIVE_CREDENTIAL_EXPIRED');
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof ArchiveError) throw error;
      throw new ArchiveError(
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'ARCHIVE_CREDENTIAL_MISSING'
          : 'ARCHIVE_CREDENTIAL_INVALID',
      );
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  delete(ref: string): boolean {
    const filename = this.filename(ref);
    if (!existsSync(filename)) return false;
    const info = lstatSync(filename);
    archiveAssert(info.isFile() && !info.isSymbolicLink(), 'ARCHIVE_CREDENTIAL_INVALID');
    unlinkSync(filename);
    syncDirectory(this.root);
    return true;
  }

  fingerprint(value: unknown): string {
    archiveAssert(this.options.fingerprintKey?.length === 32, 'ARCHIVE_RUNTIME_UNAVAILABLE');
    return createHmac('sha256', this.options.fingerprintKey)
      .update('ptvault-archive-credential-operation-v1\0')
      .update(JSON.stringify(value))
      .digest('hex');
  }

  pruneExpired(): void {
    for (const name of readdirSync(this.root)) {
      if (!/^[0-9a-f-]{36}\.sealed$/.test(name)) continue;
      try {
        this.read('archive-secret:' + name.slice(0, -7));
      } catch (error) {
        if (
          !(error instanceof ArchiveError) ||
          !['ARCHIVE_CREDENTIAL_EXPIRED', 'ARCHIVE_CREDENTIAL_MISSING'].includes(error.code)
        )
          throw error;
      }
    }
  }

  private filename(ref: string): string {
    archiveAssert(
      /^archive-secret:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        ref,
      ),
      'ARCHIVE_CREDENTIAL_INVALID',
    );
    return path.join(this.root, ref.slice('archive-secret:'.length) + '.sealed');
  }
}
