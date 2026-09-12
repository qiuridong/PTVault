import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

import type { ProcessResult } from './process-runner.js';

/**
 * The minimal crypt-remote surface the verifier depends on. Both methods speak
 * plaintext through the crypt remote: `stat` reports the decrypted object size
 * and `cat` streams the decrypted bytes. Depending on this interface (not the
 * concrete {@link RcloneClient}) lets tests substitute a local fake with no
 * network access.
 */
export type VerifierRclone = {
  stat(remotePath: string, signal?: AbortSignal): Promise<{ size: number; name: string } | null>;
  cat(
    remotePath: string,
    signal: AbortSignal,
  ): { stream: Readable; completed: Promise<ProcessResult> };
};

/**
 * One manifest entry to verify: its logical path, plaintext size, and digest.
 *
 * `relativePath` stays the *source*-relative path: it identifies the file to
 * callers and feeds {@link manifestDigest}, so receipts remain comparable across
 * releases. `remoteRelativePath` carries where the object actually lives under
 * the target prefix, which since the 2026-08-02 move to content-addressed naming
 * is `<sha256[:2]>/<sha256>` rather than the source path. Omit it and the source
 * path is used, which is what the legacy mirrored layout did.
 */
export type VerifiableFile = {
  relativePath: string;
  remoteRelativePath?: string;
  size: number;
  sha256: string;
};

export type VerifyTarget = {
  cryptRemote: string;
  stagingPrefix: string;
  files: readonly VerifiableFile[];
};

/** Immutable evidence recorded only after every byte has been read back. */
export type VerificationReceipt = {
  files: number;
  bytes: number;
  verifiedAt: number;
  manifestSha256: string;
};

export type StrictRemoteVerifierOptions = {
  rclone: VerifierRclone;
  now?: () => number;
};

export type VerificationContext = 'STAGING' | 'COMMITTED';
export type VerificationProgressCallbacks = {
  context: VerificationContext;
  /**
   * Owns the expensive remote-read permit for exactly one manifest file.
   *
   * The verifier still owns all validation and the aggregate receipt: callers
   * may only wrap the supplied operation (for example with a FIFO semaphore).
   * Releasing at this boundary prevents a large manifest from monopolising one
   * readback slot while preserving the same per-file SHA-256 evidence.
   */
  withFile?: (event: {
    context: VerificationContext;
    file: VerifiableFile;
    verify: () => Promise<void>;
  }) => void | Promise<void>;
  onFileStart?: (event: {
    context: VerificationContext;
    file: VerifiableFile;
  }) => void | Promise<void>;
  onChunk?: (event: {
    context: VerificationContext;
    file: VerifiableFile;
    bytes: bigint;
  }) => void | Promise<void>;
  onFileCompleted?: (event: {
    context: VerificationContext;
    file: VerifiableFile;
  }) => void | Promise<void>;
};

/**
 * Streams every manifest object back through the crypt remote and hashes the
 * decrypted bytes, refusing to trust a replica unless the decrypted size and
 * SHA-256 both match the manifest. Corruption, truncation, a wrong crypt
 * password (nonzero `cat` exit), or a missing object each throw before any
 * caller can advance the offload to CLOUD_COMMITTED — so the local source is
 * always still present when verification fails.
 */
export class StrictRemoteVerifier {
  private readonly rclone: VerifierRclone;
  private readonly now: () => number;

  constructor(options: StrictRemoteVerifierOptions) {
    this.rclone = options.rclone;
    this.now = options.now ?? (() => Date.now());
  }

  async verify(
    target: VerifyTarget,
    signal: AbortSignal,
    callbacks?: VerificationProgressCallbacks,
  ): Promise<VerificationReceipt> {
    throwIfAborted(signal);
    let totalBytes = 0;
    for (const file of target.files) {
      throwIfAborted(signal);
      let started = false;
      let completed = false;
      const verifyFile = async (): Promise<void> => {
        if (started) throw new Error('VERIFY_FILE_ALREADY_RUN');
        started = true;
        const remoteRelativePath = file.remoteRelativePath ?? file.relativePath;
        const remotePath = `${target.cryptRemote}${target.stagingPrefix}/${remoteRelativePath}`;
        if (callbacks) await callbacks.onFileStart?.({ context: callbacks.context, file });

        const stat = await this.rclone.stat(remotePath, signal);
        if (!stat) throw new Error('REPLICA_OBJECT_MISSING');
        if (stat.size !== file.size) throw new Error('REPLICA_SIZE_MISMATCH');

        const { digest, bytes } = await this.readback(remotePath, file, signal, callbacks);
        throwIfAborted(signal);
        if (bytes !== file.size) throw new Error('REPLICA_SIZE_MISMATCH');
        if (digest !== file.sha256) throw new Error('REPLICA_DIGEST_MISMATCH');
        if (callbacks) await callbacks.onFileCompleted?.({ context: callbacks.context, file });
        totalBytes += bytes;
        completed = true;
      };

      if (callbacks?.withFile) {
        await callbacks.withFile({ context: callbacks.context, file, verify: verifyFile });
        if (!completed) throw new Error('VERIFY_FILE_NOT_RUN');
      } else {
        await verifyFile();
      }
    }

    return {
      files: target.files.length,
      bytes: totalBytes,
      verifiedAt: this.now(),
      manifestSha256: manifestDigest(target.files),
    };
  }

  private async readback(
    remotePath: string,
    file: VerifiableFile,
    signal: AbortSignal,
    callbacks?: VerificationProgressCallbacks,
  ): Promise<{ digest: string; bytes: number }> {
    const { stream, completed } = this.rclone.cat(remotePath, signal);
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of stream) {
        const buffer = chunk as Buffer;
        bytes += buffer.length;
        hash.update(buffer);
        if (callbacks) {
          await callbacks.onChunk?.({
            context: callbacks.context,
            file,
            bytes: BigInt(buffer.length),
          });
        }
        throwIfAborted(signal);
      }
    } catch (error: unknown) {
      await completed.catch(() => undefined);
      throw abortOr(signal, error, 'REPLICA_READBACK_FAILED');
    }

    let result: ProcessResult;
    try {
      result = await completed;
    } catch (error: unknown) {
      throw abortOr(signal, error, 'REPLICA_READBACK_FAILED');
    }
    if (result.exitCode !== 0) throw new Error('REPLICA_READBACK_FAILED');
    throwIfAborted(signal);

    return { digest: hash.digest('hex'), bytes };
  }
}

/**
 * A deterministic digest over the ordered manifest (path, size, per-file
 * digest) so the receipt carries a single value that changes if any file's
 * identity changes.
 */
function manifestDigest(files: readonly VerifiableFile[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    hash.update(`${file.relativePath}\0${file.size}\0${file.sha256}\n`);
  }
  return hash.digest('hex');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted');
}

function abortOr(signal: AbortSignal, error: unknown, code: string): Error {
  if (signal.aborted) return abortReason(signal);
  return new Error(code, { cause: error });
}
