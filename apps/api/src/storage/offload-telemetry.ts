import { createHash } from 'node:crypto';

import type { OffloadStep } from '@ptvault/contracts';

import type { OffloadTelemetryPatch } from './offload-machine.js';
import type { OffloadSnapshotPublication } from './offload-event-publisher.js';
import type { VerificationContext } from './verify.js';

type TelemetryWriter = {
  updateTelemetry(
    jobId: string,
    patch: OffloadTelemetryPatch,
    publication?: OffloadSnapshotPublication,
  ): unknown;
};

export type OffloadTelemetryReporterOptions = {
  jobId: string;
  writer: TelemetryWriter;
  wallNow?: () => number;
  monotonicNow?: () => number;
  sampleIntervalMs?: number;
  schedule?: TelemetrySchedule;
};

export type TelemetryTimer = { cancel(): void };
export type TelemetrySchedule = (callback: () => void, delayMs: number) => TelemetryTimer;

type DataStep = 'HASHING' | 'UPLOADING_STAGING' | 'VERIFYING' | 'FINALIZING_REMOTE';

const RATE_FIELD: Record<DataStep, 'hashRateBps' | 'uploadRateBps' | 'verifyRateBps'> = {
  HASHING: 'hashRateBps',
  UPLOADING_STAGING: 'uploadRateBps',
  VERIFYING: 'verifyRateBps',
  FINALIZING_REMOTE: 'verifyRateBps',
};

const scheduleTimer: TelemetrySchedule = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
};

export function maskedFileAlias(relativePath: string, zeroBasedIndex: number): string {
  const digest = createHash('sha256').update(relativePath).digest('hex').slice(0, 12);
  return `file-${String(zeroBasedIndex + 1).padStart(4, '0')}-${digest}`.slice(0, 300);
}

export class OffloadTelemetryReporter {
  private readonly jobId: string;
  private readonly writer: TelemetryWriter;
  private readonly wallNow: () => number;
  private readonly monotonicNow: () => number;
  private readonly sampleIntervalMs: number;
  private readonly schedule: TelemetrySchedule;
  private step: DataStep | undefined;
  private totalBytes = 0n;
  private completedBytes = 0n;
  private currentFileBytes = 0n;
  private filesDone = 0;
  private fileCount = 0;
  private currentFileAlias: string | undefined;
  private verifiedBytes = 0n;
  private sampleStartedAt = 0;
  private sampledBytes = 0n;
  private sampleTimer: TelemetryTimer | undefined;
  private timerGeneration = 0;
  private asyncFailure: unknown;

  constructor(options: OffloadTelemetryReporterOptions) {
    this.jobId = options.jobId;
    this.writer = options.writer;
    this.wallNow = options.wallNow ?? (() => Date.now());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.sampleIntervalMs = options.sampleIntervalMs ?? 1_000;
    this.schedule = options.schedule ?? scheduleTimer;
    if (!Number.isFinite(this.sampleIntervalMs) || this.sampleIntervalMs < 1) {
      throw new Error('INVALID_TELEMETRY_SAMPLE_INTERVAL');
    }
  }

  initializeManifest(totalBytes: bigint, fileCount: number, verifiedBytes = 0n): void {
    this.throwIfAsyncFailed();
    this.totalBytes = nonNegative(totalBytes);
    this.fileCount = nonNegativeInteger(fileCount);
    this.verifiedBytes = nonNegative(verifiedBytes);
    this.write({
      totalBytes: decimal(this.totalBytes),
      verifiedBytes: decimal(this.verifiedBytes),
      fileCount: this.fileCount,
    });
  }

  beginStage(input: {
    step: OffloadStep;
    totalBytes: bigint;
    fileCount: number;
    resumedBytes: bigint;
    resumedFiles: number;
  }): void {
    this.throwIfAsyncFailed();
    this.cancelSampleTimer();
    if (!(input.step in RATE_FIELD)) throw new Error('NOT_A_DATA_STEP');
    this.step = input.step as DataStep;
    this.totalBytes = nonNegative(input.totalBytes);
    this.completedBytes = nonNegative(input.resumedBytes);
    this.currentFileBytes = 0n;
    this.filesDone = nonNegativeInteger(input.resumedFiles);
    this.fileCount = nonNegativeInteger(input.fileCount);
    this.currentFileAlias = undefined;
    this.sampleStartedAt = this.monotonicNow();
    this.sampledBytes = 0n;
    this.write({
      stepBytesDone: decimal(this.completedBytes),
      stepBytesTotal: decimal(this.totalBytes),
      filesDone: this.filesDone,
      fileCount: this.fileCount,
      currentFileAlias: null,
      uploadRateBps: null,
      hashRateBps: null,
      verifyRateBps: null,
      etaSeconds: null,
      ratesSampledAt: null,
    });
  }

  startFile(relativePath: string, zeroBasedIndex: number): void {
    this.throwIfAsyncFailed();
    this.currentFileBytes = 0n;
    this.currentFileAlias = maskedFileAlias(relativePath, zeroBasedIndex);
  }

  addChunk(bytes: bigint): void {
    this.throwIfAsyncFailed();
    const increment = nonNegative(bytes);
    this.currentFileBytes += increment;
    this.sampledBytes += increment;
    this.flushOrScheduleSample();
  }

  setCurrentFileBytes(bytes: bigint): void {
    this.throwIfAsyncFailed();
    const next = nonNegative(bytes);
    if (next <= this.currentFileBytes) return;
    this.sampledBytes += next - this.currentFileBytes;
    this.currentFileBytes = next;
    this.flushOrScheduleSample();
  }

  completeFile(fileSize: bigint): void {
    this.throwIfAsyncFailed();
    this.completedBytes += nonNegative(fileSize);
    this.currentFileBytes = 0n;
    this.filesDone += 1;
    this.currentFileAlias = undefined;
    this.write(this.progressPatch({ currentFileAlias: null }));
  }

  completeStage(): void {
    this.throwIfAsyncFailed();
    this.cancelSampleTimer();
    this.completedBytes = this.totalBytes;
    this.currentFileBytes = 0n;
    this.filesDone = this.fileCount;
    this.currentFileAlias = undefined;
    this.write(
      this.progressPatch({
        currentFileAlias: null,
        uploadRateBps: null,
        hashRateBps: null,
        verifyRateBps: null,
        etaSeconds: null,
        ratesSampledAt: null,
      }),
    );
  }

  completeReadbackFile(context: VerificationContext, fileSize: bigint): void {
    this.throwIfAsyncFailed();
    if (context === 'COMMITTED') this.verifiedBytes += nonNegative(fileSize);
    this.write({ verifiedBytes: decimal(this.verifiedBytes) });
  }

  setVerifiedBytes(value: bigint): void {
    this.throwIfAsyncFailed();
    this.verifiedBytes = nonNegative(value);
    this.write({ verifiedBytes: decimal(this.verifiedBytes) });
  }

  clearActive(): void {
    this.cancelSampleTimer();
    this.asyncFailure = undefined;
    this.step = undefined;
    this.currentFileAlias = undefined;
    this.sampledBytes = 0n;
    this.write({
      currentFileAlias: null,
      uploadRateBps: null,
      hashRateBps: null,
      verifyRateBps: null,
      etaSeconds: null,
      ratesSampledAt: null,
    });
  }

  private flushOrScheduleSample(): void {
    if (!this.step) return;
    const now = this.monotonicNow();
    const elapsed = now - this.sampleStartedAt;
    if (elapsed < this.sampleIntervalMs) {
      this.scheduleSample(this.sampleIntervalMs - Math.max(0, elapsed));
      return;
    }
    this.flushSample(now);
  }

  private flushSample(now: number): void {
    if (!this.step) return;
    this.cancelSampleTimer();
    const elapsed = now - this.sampleStartedAt;
    const elapsedMilliseconds = BigInt(Math.max(1, Math.floor(elapsed)));
    const rate = (this.sampledBytes * 1_000n) / elapsedMilliseconds;
    const remaining =
      this.totalBytes > this.currentDone() ? this.totalBytes - this.currentDone() : 0n;
    const eta = rate > 0n ? ceilDivide(remaining, rate) : undefined;
    const rateField = RATE_FIELD[this.step];
    this.write(
      {
        ...this.progressPatch(),
        [rateField]: decimal(rate),
        etaSeconds:
          eta !== undefined && eta <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(eta) : null,
        ratesSampledAt: this.wallNow(),
      },
      'COALESCED',
    );
    this.sampleStartedAt = now;
    this.sampledBytes = 0n;
    if (rate > 0n) this.scheduleSample(this.sampleIntervalMs);
  }

  private scheduleSample(delayMs: number): void {
    if (this.sampleTimer) return;
    const generation = ++this.timerGeneration;
    this.sampleTimer = this.schedule(
      () => {
        if (generation !== this.timerGeneration) return;
        this.sampleTimer = undefined;
        try {
          const now = this.monotonicNow();
          const elapsed = now - this.sampleStartedAt;
          if (elapsed < this.sampleIntervalMs) {
            this.scheduleSample(this.sampleIntervalMs - Math.max(0, elapsed));
            return;
          }
          this.flushSample(now);
        } catch (error) {
          this.asyncFailure = error;
          this.cancelSampleTimer();
        }
      },
      Math.max(1, Math.ceil(delayMs)),
    );
  }

  private cancelSampleTimer(): void {
    this.timerGeneration += 1;
    this.sampleTimer?.cancel();
    this.sampleTimer = undefined;
  }

  private throwIfAsyncFailed(): void {
    if (this.asyncFailure === undefined) return;
    throw this.asyncFailure instanceof Error
      ? this.asyncFailure
      : new Error('TELEMETRY_ASYNC_WRITE_FAILED', { cause: this.asyncFailure });
  }

  private progressPatch(extra: OffloadTelemetryPatch = {}): OffloadTelemetryPatch {
    return {
      stepBytesDone: decimal(this.currentDone()),
      stepBytesTotal: decimal(this.totalBytes),
      filesDone: this.filesDone,
      fileCount: this.fileCount,
      ...(this.currentFileAlias ? { currentFileAlias: this.currentFileAlias } : {}),
      ...extra,
    };
  }

  private currentDone(): bigint {
    const value = this.completedBytes + this.currentFileBytes;
    return value > this.totalBytes ? this.totalBytes : value;
  }

  private write(
    patch: OffloadTelemetryPatch,
    publication: OffloadSnapshotPublication = 'IMMEDIATE',
  ): void {
    this.writer.updateTelemetry(this.jobId, patch, publication);
  }
}

function decimal(value: bigint): string {
  const result = value.toString();
  if (!/^(?:0|[1-9][0-9]{0,29})$/.test(result)) throw new Error('TELEMETRY_VALUE_OUT_OF_RANGE');
  return result;
}

function nonNegative(value: bigint): bigint {
  if (value < 0n) throw new Error('NEGATIVE_TELEMETRY_VALUE');
  return value;
}

function nonNegativeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('INVALID_TELEMETRY_COUNT');
  return value;
}

function ceilDivide(dividend: bigint, divisor: bigint): bigint {
  return dividend === 0n ? 0n : (dividend + divisor - 1n) / divisor;
}
