import type { AppDatabase } from '../../db/database.js';
import { ImportDataPlaneError } from './errors.js';

export type ImportSpoolCapacityLimits = {
  spoolMaxBytes: string;
  spoolReserveBytes: string;
};

export interface ImportSpoolCapacityWaitSink {
  waiting(jobId: string, position: number, availableBytes: string): void;
  acquired(jobId: string): void;
  released(jobId: string): void;
}

type Waiter = {
  jobId: string;
  bytes: bigint;
  signal: AbortSignal;
  resolve: () => void;
  reject: (error: Error) => void;
  abort: () => void;
};

type ReservationRow = { jobId: string; reservedBytes: string };

const NOOP_SINK: ImportSpoolCapacityWaitSink = {
  waiting: () => undefined,
  acquired: () => undefined,
  released: () => undefined,
};

/**
 * Durable logical capacity reservations for the import spool.
 *
 * A reservation is job-scoped because the current recovery gate retains every
 * ready object until that job's encrypted control-plane generation is verified.
 * Reserving the complete planned byte count is conservative, survives restart,
 * and avoids a multi-object job deadlocking against files it must retain for its
 * own recovery proof.
 */
export class ImportSpoolCapacityGate {
  private readonly queue: Waiter[] = [];

  constructor(
    private readonly db: AppDatabase,
    private readonly limits: () => ImportSpoolCapacityLimits,
    private readonly sink: ImportSpoolCapacityWaitSink = NOOP_SINK,
    private readonly now: () => number = () => Date.now(),
  ) {
    // A completed job proved every ready file was cleaned.  If the process died
    // between that commit and release(), reclaim the now-orphaned reservation.
    this.db
      .prepare(
        `DELETE FROM import_spool_reservations
         WHERE job_id IN (SELECT id FROM import_jobs WHERE state = 'COMPLETED')`,
      )
      .run();
  }

  async reserve(jobId: string, bytesValue: string, signal: AbortSignal): Promise<void> {
    const bytes = decimal(bytesValue);
    const existing = this.reservation(jobId);
    if (existing !== null) {
      if (existing !== bytes) throw new ImportDataPlaneError('IMPORT_SPOOL_RESERVATION_CONFLICT');
      this.sink.acquired(jobId);
      return;
    }
    this.assertFitsConfiguredCapacity(bytes);
    if (signal.aborted) throw abortError();

    // Preserve FIFO within this process: a small late job must not repeatedly
    // jump over the oldest capacity waiter.
    if (this.queue.length === 0 && this.tryReserve(jobId, bytes)) {
      this.sink.acquired(jobId);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        jobId,
        bytes,
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          this.sink.released(jobId);
          this.publishQueue();
          reject(abortError());
        },
      };
      this.queue.push(waiter);
      signal.addEventListener('abort', waiter.abort, { once: true });
      try {
        this.publishQueue();
      } catch (error) {
        signal.removeEventListener('abort', waiter.abort);
        this.queue.splice(this.queue.indexOf(waiter), 1);
        reject(error instanceof Error ? error : new Error('IMPORT_SPOOL_WAIT_SINK_FAILED'));
      }
    });
  }

  release(jobId: string): void {
    const changed = this.db
      .prepare('DELETE FROM import_spool_reservations WHERE job_id = ?')
      .run(jobId);
    if (changed.changes > 0) this.sink.released(jobId);
    this.drain();
  }

  notifyCapacityChanged(): void {
    // A decrease never aborts work that already owns durable capacity.  It only
    // stops new reservations until natural release brings usage below the line.
    this.drain();
  }

  reservedBytes(): string {
    const rows = this.db
      .prepare('SELECT reserved_bytes AS reservedBytes FROM import_spool_reservations')
      .all() as Array<{ reservedBytes: string }>;
    return rows.reduce((sum, row) => sum + BigInt(row.reservedBytes), 0n).toString();
  }

  pendingCount(): number {
    return this.queue.length;
  }

  /** Nonblocking group admission. Shrink only after the caller measured a stopped workspace. */
  tryResize(jobId: string, value: string): boolean {
    const bytes = decimal(value);
    const changed = this.db
      .transaction(() => {
        const previous = this.reservation(jobId) ?? 0n;
        if (bytes === previous) return true;
        if (bytes > previous) {
          const limits = parseLimits(this.limits());
          if (
            this.queue.length > 0 ||
            bytes > limits.max - limits.reserve ||
            bytes - previous > this.availableBytes()
          )
            return false;
        }
        if (bytes === 0n)
          this.db.prepare('DELETE FROM import_spool_reservations WHERE job_id=?').run(jobId);
        else
          this.db
            .prepare(
              `INSERT INTO import_spool_reservations(job_id,reserved_bytes,created_at,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(job_id) DO UPDATE SET reserved_bytes=excluded.reserved_bytes,updated_at=excluded.updated_at`,
            )
            .run(jobId, bytes.toString(), this.now(), this.now());
        return true;
      })
      .immediate();
    if (changed) this.drain();
    return changed;
  }

  reservationBytes(jobId: string): string {
    return (this.reservation(jobId) ?? 0n).toString();
  }

  private drain(): void {
    for (;;) {
      const waiter = this.queue[0];
      if (waiter === undefined) break;
      if (waiter.signal.aborted) {
        waiter.abort();
        continue;
      }
      try {
        this.assertFitsConfiguredCapacity(waiter.bytes);
      } catch (error) {
        this.queue.shift();
        waiter.signal.removeEventListener('abort', waiter.abort);
        this.sink.released(waiter.jobId);
        waiter.reject(error instanceof Error ? error : new Error('IMPORT_SPOOL_CAPACITY_INVALID'));
        continue;
      }
      if (!this.tryReserve(waiter.jobId, waiter.bytes)) break;
      this.queue.shift();
      waiter.signal.removeEventListener('abort', waiter.abort);
      try {
        this.sink.acquired(waiter.jobId);
        waiter.resolve();
      } catch (error) {
        waiter.reject(error instanceof Error ? error : new Error('IMPORT_SPOOL_WAIT_SINK_FAILED'));
      }
    }
    this.publishQueue();
  }

  private publishQueue(): void {
    const available = this.availableBytes().toString();
    this.queue.forEach((waiter, index) => {
      this.sink.waiting(waiter.jobId, index + 1, available);
    });
  }

  private tryReserve(jobId: string, bytes: bigint): boolean {
    return this.db
      .transaction(() => {
        const existing = this.reservation(jobId);
        if (existing !== null) {
          if (existing !== bytes) {
            throw new ImportDataPlaneError('IMPORT_SPOOL_RESERVATION_CONFLICT');
          }
          return true;
        }
        const available = this.availableBytes();
        if (bytes > available) return false;
        const timestamp = this.now();
        this.db
          .prepare(
            `INSERT INTO import_spool_reservations(
               job_id, reserved_bytes, created_at, updated_at
             ) VALUES (?, ?, ?, ?)`,
          )
          .run(jobId, bytes.toString(), timestamp, timestamp);
        return true;
      })
      .immediate();
  }

  private availableBytes(): bigint {
    const limits = parseLimits(this.limits());
    const reserved = BigInt(this.reservedBytes());
    const usable = limits.max - limits.reserve;
    return usable > reserved ? usable - reserved : 0n;
  }

  private assertFitsConfiguredCapacity(bytes: bigint): void {
    const limits = parseLimits(this.limits());
    if (bytes > limits.max - limits.reserve) {
      throw new ImportDataPlaneError('IMPORT_SPOOL_JOB_EXCEEDS_CAPACITY');
    }
  }

  private reservation(jobId: string): bigint | null {
    const row = this.db
      .prepare(
        `SELECT job_id AS jobId, reserved_bytes AS reservedBytes
         FROM import_spool_reservations WHERE job_id = ?`,
      )
      .get(jobId) as ReservationRow | undefined;
    return row === undefined ? null : BigInt(row.reservedBytes);
  }
}

function parseLimits(input: ImportSpoolCapacityLimits): { max: bigint; reserve: bigint } {
  const max = decimal(input.spoolMaxBytes);
  const reserve = decimal(input.spoolReserveBytes);
  if (max === 0n || reserve >= max) {
    throw new ImportDataPlaneError('IMPORT_SPOOL_CAPACITY_INVALID');
  }
  return { max, reserve };
}

function decimal(value: string): bigint {
  if (!/^(?:0|[1-9][0-9]{0,29})$/.test(value)) {
    throw new ImportDataPlaneError('IMPORT_SPOOL_CAPACITY_INVALID');
  }
  return BigInt(value);
}

function abortError(): Error {
  const error = new Error('IMPORT_SPOOL_WAIT_ABORTED');
  error.name = 'AbortError';
  return error;
}
