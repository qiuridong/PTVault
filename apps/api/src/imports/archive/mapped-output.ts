import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import {
  archiveAssert,
  mapArchiveMemberName,
  normalizeArchiveMember,
  type ArchiveMember,
} from './inspection.js';

/** Only the parent creates local names. The sandboxed decoder has read-only
 * input and stdout, never permission to write an overlong archive path.
 * A single extraction stream avoids re-decoding a solid block once per file.
 * Listing order, exact byte boundaries and every listed CRC must all agree. */
export async function writeMappedArchiveStream(input: {
  root: string;
  members: readonly ArchiveMember[];
  stream: AsyncIterable<Uint8Array>;
  maxBytes: string;
  signal?: AbortSignal;
}): Promise<void> {
  const info = await lstat(input.root);
  archiveAssert(
    path.isAbsolute(input.root) && info.isDirectory() && !info.isSymbolicLink(),
    'ARCHIVE_ROOT_INVALID',
  );
  const root = await realpath(input.root);
  const files = input.members.filter((member) => !member.directory);
  let total = 0n;
  for (const member of input.members) {
    normalizeArchiveMember(member.path);
    if (member.sourcePath !== undefined)
      archiveAssert(
        mapArchiveMemberName(member.sourcePath) === member.path,
        'ARCHIVE_MEMBER_UNSAFE',
      );
    archiveAssert(/^(?:0|[1-9]\d{0,29})$/.test(member.size), 'ARCHIVE_LIST_INVALID');
    if (!member.directory) {
      archiveAssert(
        (member.size === '0' && member.crc32 === undefined) ||
          (member.crc32 !== undefined && /^[a-f0-9]{8}$/.test(member.crc32)),
        'ARCHIVE_STREAM_PROOF_REQUIRED',
      );
      total += BigInt(member.size);
    }
  }
  archiveAssert(
    /^(?:0|[1-9]\d{0,29})$/.test(input.maxBytes) && total <= BigInt(input.maxBytes),
    'ARCHIVE_EXPANSION_LIMIT',
  );
  const parents = async (relative: string): Promise<void> => {
    let current = root;
    for (const part of relative.split('/').slice(0, -1)) {
      current = path.join(current, part);
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const info = await lstat(current);
      archiveAssert(
        info.isDirectory() && !info.isSymbolicLink() && (await realpath(current)) === current,
        'ARCHIVE_MEMBER_UNSAFE',
      );
    }
  };
  let index = 0,
    written = 0n,
    crc = 0,
    handle: FileHandle | undefined;
  const begin = async (): Promise<void> => {
    const member = files[index]!;
    await parents(member.path);
    handle = await open(
      path.join(root, member.path),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  };
  const finish = async (): Promise<void> => {
    archiveAssert(
      crc.toString(16).padStart(8, '0') === (files[index]!.crc32 ?? '00000000'),
      'ARCHIVE_OUTPUT_MISMATCH',
    );
    await handle!.sync();
    await handle!.close();
    handle = undefined;
    index++;
    written = 0n;
    crc = 0;
  };
  const emptyFiles = async (): Promise<void> => {
    while (index < files.length && files[index]!.size === '0') {
      input.signal?.throwIfAborted();
      await begin();
      await finish();
    }
  };
  try {
    await emptyFiles();
    for await (const chunk of input.stream) {
      input.signal?.throwIfAborted();
      let offset = 0;
      while (offset < chunk.byteLength) {
        archiveAssert(index < files.length, 'ARCHIVE_OUTPUT_MISMATCH');
        if (handle === undefined) await begin();
        const remaining = BigInt(files[index]!.size) - written;
        const count = Number(
          remaining < BigInt(chunk.byteLength - offset)
            ? remaining
            : BigInt(chunk.byteLength - offset),
        );
        const data = chunk.subarray(offset, offset + count);
        let saved = 0;
        while (saved < count) {
          input.signal?.throwIfAborted();
          const result = await handle!.write(data, saved, count - saved);
          archiveAssert(result.bytesWritten > 0, 'ARCHIVE_OUTPUT_MISMATCH');
          saved += result.bytesWritten;
        }
        crc = crc32(data, crc);
        written += BigInt(count);
        offset += count;
        if (written === BigInt(files[index]!.size)) {
          await finish();
          await emptyFiles();
        }
      }
    }
    archiveAssert(index === files.length && handle === undefined, 'ARCHIVE_OUTPUT_MISMATCH');
  } finally {
    await handle?.close();
  }
}
