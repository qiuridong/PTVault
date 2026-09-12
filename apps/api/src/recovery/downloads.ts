import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { assertPassphraseEncryptedAge } from './escrow.js';
import type { RecoveryRepository } from './repository.js';

export type RecoveryFileKind = 'bundle' | 'escrow';
export class RecoveryDownloadError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
  ) {
    super('Recovery file unavailable');
  }
}
export type RecoveryDownload = {
  bytes: Buffer;
  filename: string;
  sha256: string;
  release: () => void;
};
const MAX_BYTES = 256 * 1024 * 1024;
type DownloadFileSystem = {
  lstat: (file: string, options: { bigint: true }) => Promise<BigIntStats>;
  open: typeof open;
  realpath: (file: string) => Promise<string>;
};
function failed(code: string, status = 409): never {
  throw new RecoveryDownloadError(code, status);
}
function abort(signal?: AbortSignal): void {
  if (signal?.aborted) failed('RECOVERY_DOWNLOAD_ABORTED', 499);
}

/** Read-only artifact access. A lease bounds memory until the response finishes or disconnects. */
export class RecoveryDownloadService {
  private active = false;
  private readonly directory: string;
  private readonly maxBytes: number;
  private readonly fileSystem: DownloadFileSystem;
  constructor(
    private readonly options: {
      repository: Pick<RecoveryRepository, 'getExport'>;
      directory: string;
      maxBytes?: number;
      fileSystem?: DownloadFileSystem;
    },
  ) {
    this.directory = path.resolve(options.directory);
    this.maxBytes = options.maxBytes ?? MAX_BYTES;
    this.fileSystem = options.fileSystem ?? { lstat, open, realpath };
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > MAX_BYTES)
      throw new Error('RECOVERY_DOWNLOAD_LIMIT_INVALID');
  }
  async acquire(
    version: number,
    kind: RecoveryFileKind,
    signal?: AbortSignal,
  ): Promise<RecoveryDownload> {
    if (!Number.isSafeInteger(version) || version < 1 || (kind !== 'bundle' && kind !== 'escrow'))
      failed('RECOVERY_FILE_REQUEST_INVALID', 400);
    abort(signal);
    if (this.active) failed('RECOVERY_DOWNLOAD_BUSY', 429);
    this.active = true;
    let released = false;
    const release = (): void => {
      if (!released) {
        released = true;
        this.active = false;
      }
    };
    try {
      const record = this.options.repository.getExport(version);
      if (!record) failed('RECOVERY_EXPORT_NOT_FOUND', 404);
      const expected = kind === 'bundle' ? record.bundleSha256 : record.escrowSha256;
      if (record.completedAt === null || expected === null) failed('RECOVERY_EXPORT_NOT_READY');
      const root = await this.fileSystem.lstat(this.directory, { bigint: true });
      if (!root.isDirectory() || root.isSymbolicLink()) failed('RECOVERY_FILE_UNSAFE');
      const canonicalRoot = await this.fileSystem.realpath(this.directory);
      const storedName = kind === 'bundle' ? `recovery-v${version}.tar.age` : 'escrow.age';
      const file = path.join(canonicalRoot, storedName);
      if (path.dirname(file) !== canonicalRoot) failed('RECOVERY_FILE_UNSAFE');
      const before = await this.fileSystem.lstat(file, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink()) failed('RECOVERY_FILE_UNSAFE');
      if (before.size > BigInt(this.maxBytes)) failed('RECOVERY_FILE_TOO_LARGE', 413);
      if (before.size <= 0n) failed('RECOVERY_FILE_NOT_ENCRYPTED');
      abort(signal);
      const handle = await this.fileSystem.open(
        file,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      let bytes: Buffer;
      try {
        const opened = await handle.stat({ bigint: true });
        if (
          !opened.isFile() ||
          opened.dev !== before.dev ||
          opened.ino !== before.ino ||
          opened.size !== before.size
        )
          failed('RECOVERY_FILE_CHANGED');
        bytes = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < bytes.length) {
          abort(signal);
          const result = await handle.read(
            bytes,
            offset,
            Math.min(1024 * 1024, bytes.length - offset),
            offset,
          );
          if (result.bytesRead === 0) failed('RECOVERY_FILE_CHANGED');
          offset += result.bytesRead;
        }
        if ((await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead !== 0)
          failed('RECOVERY_FILE_CHANGED');
        const after = await handle.stat({ bigint: true });
        const current = await this.fileSystem.lstat(file, { bigint: true });
        const currentRoot = await this.fileSystem.lstat(this.directory, { bigint: true });
        if (
          current.isSymbolicLink() ||
          !current.isFile() ||
          current.dev !== before.dev ||
          current.ino !== before.ino ||
          after.size !== before.size ||
          after.mtimeNs !== before.mtimeNs ||
          currentRoot.isSymbolicLink() ||
          !currentRoot.isDirectory() ||
          currentRoot.dev !== root.dev ||
          currentRoot.ino !== root.ino
        )
          failed('RECOVERY_FILE_CHANGED');
      } finally {
        await handle.close();
      }
      abort(signal);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (sha256 !== expected)
        failed(
          kind === 'escrow'
            ? 'RECOVERY_ESCROW_VERSION_UNAVAILABLE'
            : 'RECOVERY_FILE_CHECKSUM_MISMATCH',
        );
      if (kind === 'escrow') {
        try {
          assertPassphraseEncryptedAge(bytes);
        } catch {
          failed('RECOVERY_FILE_NOT_ENCRYPTED');
        }
      } else {
        const header = bytes.subarray(0, Math.min(bytes.length, 4096)).toString('ascii');
        if (
          !header.startsWith('age-encryption.org/v1\n') ||
          !header.includes('\n-> ') ||
          !header.includes('\n--- ') ||
          bytes.includes(Buffer.from('AGE-SECRET-KEY-'))
        )
          failed('RECOVERY_FILE_NOT_ENCRYPTED');
      }
      return {
        bytes,
        sha256,
        filename: kind === 'bundle' ? storedName : `escrow-v${version}.age`,
        release,
      };
    } catch (error) {
      release();
      if (error instanceof RecoveryDownloadError) throw error;
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
      if (code === 'ENOENT' || code === 'ENOTDIR') failed('RECOVERY_FILE_MISSING', 404);
      if (code === 'ELOOP') failed('RECOVERY_FILE_UNSAFE');
      failed('RECOVERY_DOWNLOAD_FAILED', 500);
    }
  }
}
