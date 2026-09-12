import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { assertPassphraseEncryptedAge } from './escrow.js';

export type MaterialSnapshot = { bytes: Buffer; sha256: string };

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('RECOVERY_MATERIAL_ABORTED');
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Observes only the fixed staged escrow. No registration, migration or other writes. */
export class RecoveryMaterialObserver {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = path.resolve(directory);
  }

  async read(signal?: AbortSignal): Promise<MaterialSnapshot> {
    aborted(signal);
    try {
      const root = await lstat(this.directory, { bigint: true });
      if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('RECOVERY_ESCROW_UNSAFE');
      const canonical = await realpath(this.directory);
      const file = path.join(canonical, 'escrow.age');
      const before = await lstat(file, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink()) throw new Error('RECOVERY_ESCROW_UNSAFE');
      if (before.size > 4n * 1024n * 1024n) throw new Error('RECOVERY_ESCROW_TOO_LARGE');
      if (before.size < 1n) throw new Error('RECOVERY_ESCROW_INVALID');
      aborted(signal);
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let bytes: Buffer;
      try {
        const opened = await handle.stat({ bigint: true });
        if (
          !opened.isFile() ||
          !sameIdentity(before, opened) ||
          before.size !== opened.size ||
          before.mtimeNs !== opened.mtimeNs
        )
          throw new Error('RECOVERY_ESCROW_CHANGED');
        bytes = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < bytes.length) {
          aborted(signal);
          const result = await handle.read(
            bytes,
            offset,
            Math.min(65536, bytes.length - offset),
            offset,
          );
          if (result.bytesRead === 0) throw new Error('RECOVERY_ESCROW_CHANGED');
          offset += result.bytesRead;
        }
        if ((await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead !== 0)
          throw new Error('RECOVERY_ESCROW_CHANGED');
        const after = await handle.stat({ bigint: true });
        const current = await lstat(file, { bigint: true });
        const rootAfter = await lstat(this.directory, { bigint: true });
        if (
          !current.isFile() ||
          current.isSymbolicLink() ||
          !sameIdentity(before, current) ||
          after.size !== before.size ||
          current.size !== before.size ||
          after.mtimeNs !== before.mtimeNs ||
          current.mtimeNs !== before.mtimeNs ||
          !rootAfter.isDirectory() ||
          rootAfter.isSymbolicLink() ||
          !sameIdentity(root, rootAfter)
        )
          throw new Error('RECOVERY_ESCROW_CHANGED');
      } finally {
        await handle.close();
      }
      aborted(signal);
      try {
        assertPassphraseEncryptedAge(bytes);
      } catch {
        throw new Error('RECOVERY_ESCROW_INVALID');
      }
      return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
    } catch (error) {
      if (error instanceof Error && /^RECOVERY_(ESCROW_|MATERIAL_ABORTED)/.test(error.message))
        throw error;
      throw new Error('RECOVERY_ESCROW_UNAVAILABLE');
    }
  }
}
