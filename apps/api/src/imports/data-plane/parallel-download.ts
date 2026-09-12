import { open } from 'node:fs/promises';
import { dataPlaneInvariant, ImportDataPlaneError } from './errors.js';

type Options = {
  partPath: string;
  completed: bigint;
  expected: bigint;
  chunkBytes: number;
  connections: () => number;
  checkpointEveryBytes: number;
  signal?: AbortSignal;
  read: (
    start: bigint,
    end: bigint,
    signal: AbortSignal,
    consume: (bytes: Uint8Array) => Promise<void>,
  ) => Promise<void>;
  checkpoint: (completed: bigint) => Promise<void>;
};
export type ParallelDownloadResult = { completed: bigint; received: bigint; fallback: boolean };

/**
 * Bounded disjoint requests, one ordered writer. The leading range streams to disk;
 * each following range buffers at most one chunk. No sparse holes or
 * chunk bitmap are introduced into the existing durable-prefix protocol.
 */
export async function parallelDownload(options: Options): Promise<ParallelDownloadResult> {
  const controller = new AbortController();
  const forward = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) forward();
  else options.signal?.addEventListener('abort', forward, { once: true });
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let cursor = options.completed,
    durable = cursor,
    received = 0n;
  const check = () => controller.signal.throwIfAborted();
  const position = (value: bigint) => {
    const n = Number(value);
    dataPlaneInvariant(Number.isSafeInteger(n), 'DOWNLOAD_POSITION_INVALID');
    return n;
  };
  try {
    check();
    try {
      file = await open(options.partPath, options.completed === 0n ? 'w+' : 'r+', 0o600);
    } catch {
      throw new ImportDataPlaneError('DOWNLOAD_PART_MISSING');
    }
    const stat = await file.stat({ bigint: true });
    dataPlaneInvariant(stat.isFile(), 'DOWNLOAD_PART_TYPE_INVALID');
    dataPlaneInvariant(stat.size >= options.completed, 'DOWNLOAD_CHECKPOINT_MISMATCH');
    if (stat.size > options.completed) {
      await file.truncate(position(options.completed));
      await file.sync();
    }
    const flush = async (force = false) => {
      check();
      if (cursor === durable || (!force && cursor - durable < BigInt(options.checkpointEveryBytes)))
        return;
      await file!.sync();
      check();
      await options.checkpoint(cursor);
      durable = cursor;
    };
    const write = async (data: Uint8Array) => {
      check();
      dataPlaneInvariant(cursor + BigInt(data.length) <= options.expected, 'SOURCE_CHANGED');
      let offset = 0;
      while (offset < data.length) {
        check();
        const { bytesWritten } = await file!.write(
          data,
          offset,
          data.length - offset,
          position(cursor),
        );
        dataPlaneInvariant(bytesWritten > 0, 'DOWNLOAD_WRITE_FAILED');
        cursor += BigInt(bytesWritten);
        offset += bytesWritten;
      }
      await flush();
    };
    while (cursor < options.expected) {
      check();
      // Re-read only between batches. Live edits never abort in-flight requests.
      const count = options.connections();
      const ranges = Array.from({ length: count }, (_, i) => ({
        start: cursor + BigInt(i * options.chunkBytes),
        end: minimum(cursor + BigInt((i + 1) * options.chunkBytes), options.expected),
        buffered: [] as Buffer[],
        bufferedBytes: 0,
      })).filter((range) => range.start < options.expected);
      const leading = ranges[0]!;
      let failure: Error | undefined;
      const guarded = async (run: () => Promise<void>) => {
        try {
          await run();
        } catch (error) {
          failure ??=
            error instanceof Error ? error : new ImportDataPlaneError('DOWNLOAD_PARALLEL_FAILED');
          controller.abort(failure);
          throw failure;
        }
      };
      const first = guarded(async () => {
        await options.read(leading.start, leading.end - 1n, controller.signal, async (data) => {
          received += BigInt(data.length);
          await write(data);
        });
        await flush(true);
      });
      const followers = ranges.slice(1).map((range) =>
        guarded(() =>
          options.read(range.start, range.end - 1n, controller.signal, (data) => {
            check();
            range.bufferedBytes += data.length;
            dataPlaneInvariant(
              BigInt(range.bufferedBytes) <= range.end - range.start,
              'SOURCE_RESPONSE_INVALID',
            );
            received += BigInt(data.length);
            range.buffered.push(Buffer.from(data));
            return Promise.resolve();
          }),
        ),
      );
      // Await every reader, including abort/cancellation, before touching fallback
      // or returning the file to the caller that may pause/retry this owner.
      await Promise.allSettled([first, ...followers]);
      try {
        options.signal?.throwIfAborted();
        if (failure !== undefined) {
          if (failure instanceof ImportDataPlaneError && failure.code === 'RANGE_NOT_HONORED')
            return { completed: durable, received, fallback: true };
          throw failure;
        }
        check();
        dataPlaneInvariant(cursor === leading.end, 'DOWNLOAD_RANGE_GAP');
        for (const range of ranges.slice(1)) {
          dataPlaneInvariant(
            cursor === range.start && BigInt(range.bufferedBytes) === range.end - range.start,
            'DOWNLOAD_RANGE_GAP',
          );
          for (const data of range.buffered) await write(data);
          await flush(true);
        }
      } finally {
        for (const range of ranges) for (const data of range.buffered) data.fill(0);
      }
    }
    return { completed: cursor, received, fallback: false };
  } finally {
    options.signal?.removeEventListener('abort', forward);
    await file?.close();
  }
}
const minimum = (a: bigint, b: bigint) => (a < b ? a : b);
