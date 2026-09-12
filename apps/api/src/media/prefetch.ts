import { z } from 'zod';

/**
 * Bytes read from each end before streaming the middle.
 *
 * Container metadata lives at both ends: MP4/MOV keep `moov` at the head or the
 * tail, and MKV keeps cues near the end. Jellyfin cannot identify or seek a title
 * until it has read those, so pulling them first is what makes a cold cloud title
 * playable in seconds instead of after a full sequential fetch.
 */
export const EDGE_WINDOW_BYTES = 8 * 1024 * 1024;

export const PrefetchPayloadSchema = z.object({
  instanceId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  torrentHash: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  logicalPath: z.string().min(1),
  /** Total size, so ranges can be planned without a remote round trip. */
  totalBytes: z.number().int().nonnegative(),
});

export type PrefetchPayload = z.infer<typeof PrefetchPayloadSchema>;

export function prefetchIdempotencyKey(logicalPath: string): string {
  return `prefetch:${logicalPath}`;
}

export type ByteRange = { start: number; end: number };

/**
 * Plans the read order for warming one title.
 *
 * Head and tail first, then the middle sequentially. A single sequential pass
 * would leave the tail — and therefore seeking — cold until the very end, which is
 * the difference between "seekable in a few seconds" and "seekable in an hour".
 *
 * `end` is inclusive, matching HTTP range semantics, so a caller can hand these
 * straight to a range request without off-by-one arithmetic.
 */
export function planPrefetchRanges(
  totalBytes: number,
  edgeWindowBytes: number = EDGE_WINDOW_BYTES,
): ByteRange[] {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) {
    throw new Error('PREFETCH_TOTAL_INVALID');
  }
  if (!Number.isSafeInteger(edgeWindowBytes) || edgeWindowBytes <= 0) {
    throw new Error('PREFETCH_WINDOW_INVALID');
  }
  if (totalBytes === 0) return [];

  // Small enough that the two windows would overlap: one read is both cheaper and
  // avoids fetching the same bytes twice.
  if (totalBytes <= edgeWindowBytes * 2) return [{ start: 0, end: totalBytes - 1 }];

  // Past the collapse check above, `totalBytes > edgeWindowBytes * 2`, so the
  // middle always holds at least one byte — no empty-range case to guard.
  const head: ByteRange = { start: 0, end: edgeWindowBytes - 1 };
  const tail: ByteRange = { start: totalBytes - edgeWindowBytes, end: totalBytes - 1 };
  const middle: ByteRange = { start: head.end + 1, end: tail.start - 1 };
  return [head, tail, middle];
}

export type PrefetchProgress = {
  /** Bytes fetched so far, persisted so a cancelled job can resume. */
  bytesRead: number;
  /** Index into the planned range list where the next attempt should resume. */
  rangeIndex: number;
};

export type PrefetchReader = {
  /** Reads a range through the mount, returning how many bytes it fetched. */
  readRange(logicalPath: string, range: ByteRange, signal: AbortSignal): Promise<number>;
};

export type PrefetchAdmission = {
  /** Whether the mount is currently serving reads. */
  mountHealthy(): boolean;
  /** Non-reserved cache headroom, in bytes. */
  availableCacheBytes(): number;
};

export type PrefetchHandlerOptions = {
  reader: PrefetchReader;
  admission: PrefetchAdmission;
  /** Persists progress so a cancellation has a checkpoint to resume from. */
  saveProgress?: (logicalPath: string, progress: PrefetchProgress) => void;
  loadProgress?: (logicalPath: string) => PrefetchProgress | null;
};

/**
 * Warms the VFS cache for one title.
 *
 * Purely an availability optimisation. A failed prefetch changes what plays
 * quickly; it must never change replica verification, the catalog, or anything the
 * deletion gate reads. The bytes it fetches are a copy of an already-verified
 * remote object, so failing halfway leaves nothing inconsistent behind.
 */
export class PrefetchHandler {
  constructor(private readonly options: PrefetchHandlerOptions) {}

  async run(payload: unknown, signal: AbortSignal): Promise<PrefetchProgress> {
    const parsed = PrefetchPayloadSchema.safeParse(payload);
    if (!parsed.success) throw new Error('PREFETCH_PAYLOAD_INVALID');
    const { logicalPath, totalBytes } = parsed.data;

    // Refused rather than attempted: reading through a mount that is not serving
    // produces a queue of failures, and each one looks like a media problem in the
    // diagnostics the operator reads.
    if (!this.options.admission.mountHealthy()) throw new Error('PREFETCH_MOUNT_UNHEALTHY');

    const ranges = planPrefetchRanges(totalBytes);
    const resumed = this.options.loadProgress?.(logicalPath) ?? null;
    let progress: PrefetchProgress = resumed ?? { bytesRead: 0, rangeIndex: 0 };

    for (let index = progress.rangeIndex; index < ranges.length; index += 1) {
      // Checked before each range rather than once at the start: a cancellation
      // during a long middle read should stop at the next boundary, and the
      // checkpoint means the work already done is not repeated.
      if (signal.aborted) return progress;

      const range = ranges[index];
      if (!range) break;
      const rangeBytes = range.end - range.start + 1;
      // Re-checked per range because eviction runs concurrently: headroom that
      // existed when the job was queued may be gone by the time it runs.
      if (this.options.admission.availableCacheBytes() < rangeBytes) {
        throw new Error('PREFETCH_INSUFFICIENT_CACHE');
      }

      const read = await this.options.reader.readRange(logicalPath, range, signal);
      progress = { bytesRead: progress.bytesRead + read, rangeIndex: index + 1 };
      this.options.saveProgress?.(logicalPath, progress);
    }

    return progress;
  }
}
