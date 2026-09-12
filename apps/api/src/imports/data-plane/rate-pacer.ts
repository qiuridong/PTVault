import { dataPlaneInvariant } from './errors.js';

export interface BytePacer {
  consume(bytes: number): Promise<void>;
}

export type ByteRatePacerOptions = {
  bytesPerSecond: number;
  nowMs?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Sequential average-rate pacer; it never bypasses provider membership limits. */
export class ByteRatePacer implements BytePacer {
  private readonly bytesPerSecond: number;
  private readonly nowMs: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly startedAt: number;
  private consumedBytes = 0;

  constructor(options: ByteRatePacerOptions) {
    dataPlaneInvariant(
      Number.isFinite(options.bytesPerSecond) && options.bytesPerSecond > 0,
      'RATE_LIMIT_INVALID',
    );
    this.bytesPerSecond = options.bytesPerSecond;
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.startedAt = this.nowMs();
  }

  async consume(bytes: number): Promise<void> {
    dataPlaneInvariant(Number.isSafeInteger(bytes) && bytes >= 0, 'RATE_BYTES_INVALID');
    this.consumedBytes += bytes;
    const targetElapsed = (this.consumedBytes / this.bytesPerSecond) * 1_000;
    const delay = Math.ceil(targetElapsed - (this.nowMs() - this.startedAt));
    if (delay > 0) await this.sleep(delay);
  }
}
