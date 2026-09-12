import { closeSync, fsyncSync, openSync } from 'node:fs';
import { open } from 'node:fs/promises';
import type { DownloadFailureDiagnostic } from '@ptvault/contracts';

import { parseRetryAfter } from './backoff.js';
import { dataPlaneInvariant, ImportDataPlaneError } from './errors.js';
import { networkFailureCode, networkFailureDiagnostic } from './network-retry.js';
import type { BytePacer } from './rate-pacer.js';
import { AsyncSemaphore } from '../../storage/resource-scheduler.js';
import { parallelDownload } from './parallel-download.js';

export type DownloadLease = {
  leaseId: string;
  url: string;
  expiresAt: string;
  expectedSize: string;
  requestHeaders?: Readonly<Record<string, string>>;
};

export type DurableDownloadCheckpoint = {
  leaseId: string;
  completedBytes: string;
  leaseExpiresAt: string;
  checkpointedAt: string;
};

export type RangeDownloadOptions = {
  lease: DownloadLease;
  partPath: string;
  completedBytes: string;
  signal?: AbortSignal;
  pacer?: BytePacer;
  checkpointEveryBytes?: number;
  onDurableCheckpoint?: (checkpoint: DurableDownloadCheckpoint) => void | Promise<void>;
  /** Opt-in per-file connections; legacy callers retain their existing path. */
  connections?: number | (() => number);
};

export type RangeDownloadResult = {
  completedBytes: string;
  responseBytes: string;
  rangeResumed: boolean;
};

export type RangeDownloaderOptions = {
  fetch?: typeof fetch;
  allowedHosts: readonly string[];
  maximumRedirects?: number;
  /** Maximum time to receive response headers for each request/redirect hop. */
  responseHeaderTimeoutMs?: number;
  /** Maximum silence between response-body chunks; this is not a total file deadline. */
  responseIdleTimeoutMs?: number;
  now?: () => Date;
  /** Bounded look-ahead buffer per parallel file; injection for native tests. */
  parallelChunkBytes?: number;
  /** Shared body-request budget. A reduction lets existing requests finish. */
  maximumParallelRequests?: () => number;
};

export class RangeDownloadError extends ImportDataPlaneError {
  constructor(
    code: string,
    message: string,
    readonly retryAfterMs: number | null = null,
    downloadDiagnostic?: DownloadFailureDiagnostic,
  ) {
    super(code, message, downloadDiagnostic);
    this.name = 'RangeDownloadError';
  }
}

type ParsedContentRange = { start: bigint; end: bigint; total: bigint };

type DownloadRequestTarget = { url: string; headers: Headers };
type BoundedRequester = (
  start: bigint,
  end: bigint,
  signal: AbortSignal,
) => Promise<ManagedDownloadResponse>;

type ManagedDownloadResponse = {
  response: Response;
  abort: (reason: Error) => void;
  release: () => void;
  target: DownloadRequestTarget;
};

function decimal(value: string, field: string): bigint {
  dataPlaneInvariant(/^(?:0|[1-9]\d*)$/.test(value), 'DOWNLOAD_DECIMAL_INVALID', field);
  return BigInt(value);
}

function parseContentRange(value: string | null): ParsedContentRange | null {
  if (value === null) return null;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(value.trim());
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return { start: BigInt(match[1]), end: BigInt(match[2]), total: BigInt(match[3]) };
}

function safePosition(value: bigint): number {
  const result = Number(value);
  dataPlaneInvariant(Number.isSafeInteger(result), 'DOWNLOAD_POSITION_INVALID');
  return result;
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

export class RangeDownloader {
  private readonly fetcher: typeof fetch;
  private readonly allowedHosts: readonly string[];
  private readonly maximumRedirects: number;
  private readonly responseHeaderTimeoutMs: number;
  private readonly responseIdleTimeoutMs: number;
  private readonly now: () => Date;
  private readonly parallelChunkBytes: number;
  private readonly maximumParallelRequests: () => number;
  private readonly parallelRequests = new AsyncSemaphore(16);

  constructor(options: RangeDownloaderOptions) {
    dataPlaneInvariant(options.allowedHosts.length > 0, 'DOWNLOAD_HOSTS_EMPTY');
    this.fetcher = options.fetch ?? fetch;
    this.allowedHosts = options.allowedHosts.map((host) => host.toLowerCase());
    this.maximumRedirects = options.maximumRedirects ?? 5;
    this.responseHeaderTimeoutMs = options.responseHeaderTimeoutMs ?? 30_000;
    this.responseIdleTimeoutMs = options.responseIdleTimeoutMs ?? 120_000;
    dataPlaneInvariant(
      Number.isSafeInteger(this.maximumRedirects) && this.maximumRedirects >= 0,
      'DOWNLOAD_REDIRECT_CONFIG_INVALID',
    );
    dataPlaneInvariant(
      Number.isSafeInteger(this.responseHeaderTimeoutMs) && this.responseHeaderTimeoutMs >= 1,
      'DOWNLOAD_HEADER_TIMEOUT_CONFIG_INVALID',
    );
    dataPlaneInvariant(
      Number.isSafeInteger(this.responseIdleTimeoutMs) && this.responseIdleTimeoutMs >= 1,
      'DOWNLOAD_IDLE_TIMEOUT_CONFIG_INVALID',
    );
    this.now = options.now ?? (() => new Date());
    this.parallelChunkBytes = options.parallelChunkBytes ?? 32 * 1024 * 1024;
    this.maximumParallelRequests = options.maximumParallelRequests ?? (() => 16);
    dataPlaneInvariant(
      Number.isSafeInteger(this.parallelChunkBytes) &&
        this.parallelChunkBytes >= 1 &&
        this.parallelChunkBytes <= 64 * 1024 * 1024,
      'DOWNLOAD_CHUNK_CONFIG_INVALID',
    );
  }

  async download(options: RangeDownloadOptions): Promise<RangeDownloadResult> {
    const connections = () => {
      const count =
        typeof options.connections === 'function'
          ? options.connections()
          : (options.connections ?? 1);
      dataPlaneInvariant(
        Number.isSafeInteger(count) && count >= 1 && count <= 16,
        'DOWNLOAD_CONNECTIONS_INVALID',
      );
      return count;
    };
    const initialConnections = connections();
    const expectedSize = decimal(options.lease.expectedSize, 'expectedSize');
    const completed = decimal(options.completedBytes, 'completedBytes');
    dataPlaneInvariant(completed <= expectedSize, 'DOWNLOAD_OFFSET_INVALID');
    dataPlaneInvariant(Date.parse(options.lease.expiresAt) > this.now().getTime(), 'DLINK_EXPIRED');
    const checkpointEveryBytes = options.checkpointEveryBytes ?? 8 * 1024 * 1024;
    dataPlaneInvariant(
      Number.isSafeInteger(checkpointEveryBytes) && checkpointEveryBytes >= 1,
      'DOWNLOAD_CHECKPOINT_CONFIG_INVALID',
    );

    if (
      (initialConnections > 1 || typeof options.connections === 'function') &&
      options.pacer === undefined &&
      expectedSize - completed > BigInt(this.parallelChunkBytes)
    ) {
      // A single valid lease/file owns this route. Resolve its first range once;
      // later ranges retain the validated redirect's already-stripped headers.
      const request = this.parallelRequester(options.lease);
      const result = await parallelDownload({
        partPath: options.partPath,
        completed,
        expected: expectedSize,
        chunkBytes: this.parallelChunkBytes,
        connections,
        checkpointEveryBytes,
        ...(options.signal ? { signal: options.signal } : {}),
        read: (start, end, signal, consume) => {
          const maximum = this.maximumParallelRequests();
          dataPlaneInvariant(
            Number.isSafeInteger(maximum) && maximum >= 1 && maximum <= 128,
            'DOWNLOAD_REQUEST_BUDGET_INVALID',
          );
          this.parallelRequests.resize(maximum);
          return this.parallelRequests.run(signal, () =>
            this.readBounded(options.lease, start, end, signal, consume, request),
          );
        },
        checkpoint: (cursor) => this.checkpoint(options, cursor),
      });
      if (result.fallback) {
        const fallback = await this.download({
          ...options,
          connections: 1,
          completedBytes: result.completed.toString(),
        });
        return {
          ...fallback,
          responseBytes: (result.received + BigInt(fallback.responseBytes)).toString(),
          rangeResumed: completed > 0n,
        };
      }
      return {
        completedBytes: result.completed.toString(),
        responseBytes: result.received.toString(),
        rangeResumed: completed > 0n,
      };
    }

    let file;
    try {
      file = await open(options.partPath, completed === 0n ? 'w+' : 'r+');
    } catch {
      throw new RangeDownloadError('DOWNLOAD_PART_MISSING', 'Partial file is missing');
    }
    let responseBytes = 0n;
    try {
      const stat = await file.stat({ bigint: true });
      dataPlaneInvariant(stat.isFile(), 'DOWNLOAD_PART_TYPE_INVALID');
      dataPlaneInvariant(stat.size >= completed, 'DOWNLOAD_CHECKPOINT_MISMATCH');
      if (stat.size > completed) {
        await file.truncate(safePosition(completed));
        await file.sync();
      }
      if (completed === expectedSize) {
        await file.sync();
        await this.checkpoint(options, completed);
        return {
          completedBytes: completed.toString(),
          responseBytes: '0',
          rangeResumed: completed > 0n,
        };
      }

      const managed = await this.request(options.lease, completed, options.signal);
      const { response } = managed;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        this.validateResponse(response, completed, expectedSize);
        reader = response.body?.getReader();
        if (!reader)
          throw new RangeDownloadError('NETWORK_RESET', 'Response body is missing', null, {
            version: 1,
            phase: 'RESPONSE_BODY',
            kind: 'BODY_MISSING',
          });
        let durableAt = completed;
        let cursor = completed;
        for (;;) {
          const chunk = await this.readChunk(reader, managed, options.signal);
          if (chunk.done) break;
          if (options.signal?.aborted) throw options.signal.reason ?? new Error('aborted');
          const value = chunk.value;
          if (value.byteLength === 0)
            throw new RangeDownloadError('NETWORK_RESET', 'Empty response body chunk', null, {
              version: 1,
              phase: 'RESPONSE_BODY',
              kind: 'BODY_EMPTY_CHUNK',
            });
          const next = cursor + BigInt(value.byteLength);
          if (next > expectedSize) {
            throw new RangeDownloadError('SOURCE_CHANGED', 'Response exceeded source size');
          }
          await file.write(value, 0, value.byteLength, safePosition(cursor));
          cursor = next;
          responseBytes += BigInt(value.byteLength);
          await options.pacer?.consume(value.byteLength);
          if (cursor - durableAt >= BigInt(checkpointEveryBytes)) {
            await file.sync();
            await this.checkpoint(options, cursor);
            durableAt = cursor;
          }
        }
        if (cursor !== expectedSize) {
          throw new RangeDownloadError('NETWORK_RESET', 'Response ended before source size', null, {
            version: 1,
            phase: 'RESPONSE_BODY',
            kind: 'BODY_INCOMPLETE',
          });
        }
        await file.sync();
        if (cursor !== durableAt) await this.checkpoint(options, cursor);
        return {
          completedBytes: cursor.toString(),
          responseBytes: responseBytes.toString(),
          rangeResumed: completed > 0n,
        };
      } catch (error) {
        if (
          error instanceof RangeDownloadError &&
          error.downloadDiagnostic?.phase === 'RESPONSE_BODY'
        ) {
          throw new RangeDownloadError(error.code, error.message, error.retryAfterMs, {
            ...error.downloadDiagnostic,
            receivedBytes: responseBytes.toString(),
            expectedBytes: (expectedSize - completed).toString(),
          });
        }
        throw error;
      } finally {
        if (reader === undefined) {
          await response.body?.cancel().catch(() => undefined);
        } else {
          await reader.cancel().catch(() => undefined);
        }
        managed.release();
      }
    } finally {
      await file.close();
    }
  }

  /** A bounded live read, not a promise that a merely issued URL is retrievable. */
  async probe(
    lease: DownloadLease,
    signal?: AbortSignal,
  ): Promise<{ readBytes: string; checkedAt: number }> {
    const size = decimal(lease.expectedSize, 'expectedSize');
    dataPlaneInvariant(Date.parse(lease.expiresAt) > this.now().getTime(), 'DLINK_EXPIRED');
    if (size === 0n) return { readBytes: '0', checkedAt: this.now().getTime() };
    const managed = await this.request(lease, 0n, signal, 0n);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = managed.response;
      this.validateResponse(response, 0n, size);
      const range = parseContentRange(response.headers.get('content-range'));
      dataPlaneInvariant(
        response.status === 206 && range?.start === 0n && range.end === 0n,
        'RANGE_NOT_HONORED',
      );
      reader = response.body?.getReader();
      dataPlaneInvariant(reader !== undefined, 'NETWORK_RESET');
      const chunk = await this.readChunk(reader, managed, signal);
      dataPlaneInvariant(!chunk.done && chunk.value.length === 1, 'SOURCE_RESPONSE_INVALID');
      return { readBytes: '1', checkedAt: this.now().getTime() };
    } finally {
      if (reader) await reader.cancel().catch(() => undefined);
      else await managed.response.body?.cancel().catch(() => undefined);
      managed.release();
    }
  }

  private parallelRequester(lease: DownloadLease): BoundedRequester {
    let target: Promise<DownloadRequestTarget> | undefined;
    return async (start, end, signal) => {
      if (target !== undefined) {
        const resolved = await target;
        signal.throwIfAborted();
        dataPlaneInvariant(Date.parse(lease.expiresAt) > this.now().getTime(), 'DLINK_EXPIRED');
        return this.request(lease, start, signal, end, resolved);
      }
      let accept!: (value: DownloadRequestTarget) => void;
      let reject!: (error: unknown) => void;
      target = new Promise<DownloadRequestTarget>((resolve, fail) => {
        accept = resolve;
        reject = fail;
      });
      // A sibling might be aborted while waiting for its global request permit.
      // Keep this shared rejection handled even if it never starts its read.
      void target.catch(() => undefined);
      let managed: ManagedDownloadResponse | undefined;
      try {
        managed = await this.request(lease, start, signal, end);
        this.validateBoundedResponse(managed.response, start, end, lease);
        accept(managed.target);
        return managed;
      } catch (error) {
        reject(error);
        if (managed !== undefined) {
          await managed.response.body?.cancel().catch(() => undefined);
          managed.release();
        }
        throw error;
      }
    };
  }

  private validateBoundedResponse(
    response: Response,
    start: bigint,
    end: bigint,
    lease: DownloadLease,
  ): void {
    this.validateResponse(response, start, decimal(lease.expectedSize, 'expectedSize'));
    const range = parseContentRange(response.headers.get('content-range'));
    dataPlaneInvariant(
      response.status === 206 && range?.start === start && range.end === end,
      'RANGE_NOT_HONORED',
    );
  }

  private async readBounded(
    lease: DownloadLease,
    start: bigint,
    end: bigint,
    signal: AbortSignal,
    consume: (bytes: Uint8Array) => Promise<void>,
    request: BoundedRequester,
  ): Promise<void> {
    signal.throwIfAborted();
    dataPlaneInvariant(Date.parse(lease.expiresAt) > this.now().getTime(), 'DLINK_EXPIRED');
    const managed = await request(start, end, signal);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
      received = 0n;
    const expected = end - start + 1n;
    try {
      const response = managed.response;
      this.validateBoundedResponse(response, start, end, lease);
      reader = response.body?.getReader();
      if (!reader)
        throw new RangeDownloadError('NETWORK_RESET', 'Download body missing', null, {
          version: 1,
          phase: 'RESPONSE_BODY',
          kind: 'BODY_MISSING',
        });
      for (;;) {
        const chunk = await this.readChunk(reader, managed, signal);
        if (chunk.done) break;
        signal.throwIfAborted();
        if (chunk.value.length === 0)
          throw new RangeDownloadError('NETWORK_RESET', 'Empty range chunk', null, {
            version: 1,
            phase: 'RESPONSE_BODY',
            kind: 'BODY_EMPTY_CHUNK',
          });
        received += BigInt(chunk.value.length);
        dataPlaneInvariant(received <= expected, 'SOURCE_CHANGED');
        await consume(chunk.value);
      }
      if (received !== expected)
        throw new RangeDownloadError('NETWORK_RESET', 'Range response ended early', null, {
          version: 1,
          phase: 'RESPONSE_BODY',
          kind: 'BODY_INCOMPLETE',
        });
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (
        error instanceof RangeDownloadError &&
        error.downloadDiagnostic?.phase === 'RESPONSE_BODY'
      )
        throw new RangeDownloadError(error.code, error.message, error.retryAfterMs, {
          ...error.downloadDiagnostic,
          receivedBytes: received.toString(),
          expectedBytes: expected.toString(),
        });
      throw error;
    } finally {
      if (reader) await reader.cancel().catch(() => undefined);
      else await managed.response.body?.cancel().catch(() => undefined);
      managed.release();
    }
  }

  private async request(
    lease: DownloadLease,
    start: bigint,
    signal: AbortSignal | undefined,
    end?: bigint,
    target?: DownloadRequestTarget,
  ): Promise<ManagedDownloadResponse> {
    let url = new URL(target?.url ?? lease.url);
    this.validateUrl(url);
    let headers = new Headers(target?.headers ?? lease.requestHeaders);
    headers.set('range', `bytes=${start}-${end === undefined ? '' : end.toString()}`);
    headers.set('accept-encoding', 'identity');

    for (let redirects = 0; ; redirects += 1) {
      const managed = await this.requestOnce(url, headers, signal);
      const { response } = managed;
      if (!isRedirect(response.status)) return managed;
      try {
        if (redirects >= this.maximumRedirects) {
          throw new RangeDownloadError('REDIRECT_LIMIT', 'Download redirect limit exceeded');
        }
        const location = response.headers.get('location');
        if (!location) throw new RangeDownloadError('REDIRECT_INVALID', 'Redirect is missing');
        const next = new URL(location, url);
        this.validateUrl(next);
        if (next.origin !== url.origin) {
          headers = new Headers(headers);
          headers.delete('authorization');
          headers.delete('cookie');
        }
        url = next;
      } finally {
        await response.body?.cancel().catch(() => undefined);
        managed.release();
      }
    }
  }

  private async requestOnce(
    url: URL,
    headers: Headers,
    upstream: AbortSignal | undefined,
  ): Promise<ManagedDownloadResponse> {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(upstream?.reason);
    if (upstream?.aborted) {
      forwardAbort();
    } else {
      upstream?.addEventListener('abort', forwardAbort, { once: true });
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      upstream?.removeEventListener('abort', forwardAbort);
    };
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('download response headers timed out'));
    }, this.responseHeaderTimeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      release();
      if (upstream?.aborted) throw upstream.reason ?? error;
      if (timedOut) {
        throw new RangeDownloadError(
          'NETWORK_HEADERS_TIMEOUT',
          'Download response headers timed out',
          null,
          { version: 1, phase: 'RESPONSE_HEADERS', kind: 'HEADERS_TIMEOUT' },
        );
      }
      throw new RangeDownloadError(
        networkFailureCode(error),
        'Download request failed',
        null,
        networkFailureDiagnostic(error, 'REQUEST'),
      );
    }
    clearTimeout(timeout);
    if (timedOut) {
      await response.body?.cancel().catch(() => undefined);
      release();
      throw new RangeDownloadError(
        'NETWORK_HEADERS_TIMEOUT',
        'Download response headers timed out',
        null,
        { version: 1, phase: 'RESPONSE_HEADERS', kind: 'HEADERS_TIMEOUT' },
      );
    }
    return {
      response,
      abort: (reason) => controller.abort(reason),
      release,
      target: { url: url.toString(), headers: new Headers(headers) },
    };
  }

  private async readChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    response: ManagedDownloadResponse,
    upstream: AbortSignal | undefined,
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        const error = new Error('download response body stalled');
        response.abort(error);
        reject(error);
      }, this.responseIdleTimeoutMs);
    });
    try {
      return await Promise.race([reader.read(), deadline]);
    } catch (error) {
      if (upstream?.aborted) throw upstream.reason ?? error;
      if (timedOut) {
        throw new RangeDownloadError(
          'NETWORK_BODY_TIMEOUT',
          'Download response body stalled',
          null,
          { version: 1, phase: 'RESPONSE_BODY', kind: 'BODY_TIMEOUT' },
        );
      }
      const diagnostic = networkFailureDiagnostic(error, 'RESPONSE_BODY');
      throw new RangeDownloadError(
        diagnostic.kind === 'BODY_TIMEOUT' ? 'NETWORK_BODY_TIMEOUT' : 'NETWORK_RESET',
        'Download response body failed',
        null,
        diagnostic,
      );
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private validateResponse(response: Response, start: bigint, expectedSize: bigint): void {
    if (response.status === 401 || response.status === 403) {
      throw new RangeDownloadError('DLINK_EXPIRED', 'Download lease was rejected', null, {
        version: 1,
        phase: 'RESPONSE_HEADERS',
        kind: 'LEASE_REJECTED',
        httpStatus: response.status,
      });
    }
    if (response.status === 429) {
      throw new RangeDownloadError(
        'RATE_LIMITED',
        'Source rate limit reached',
        parseRetryAfter(response.headers.get('retry-after'), this.now()),
        {
          version: 1,
          phase: 'RESPONSE_HEADERS',
          kind: 'HTTP_RATE_LIMITED',
          httpStatus: response.status,
        },
      );
    }
    if (response.status >= 500) {
      throw new RangeDownloadError(
        'NETWORK_RESET',
        'Source temporarily unavailable',
        parseRetryAfter(response.headers.get('retry-after'), this.now()),
        {
          version: 1,
          phase: 'RESPONSE_HEADERS',
          kind: 'HTTP_SERVER_ERROR',
          httpStatus: response.status,
        },
      );
    }
    if (start > 0n && response.status !== 206) {
      throw new RangeDownloadError('RANGE_NOT_HONORED', 'Resume range was ignored');
    }
    if (start === 0n && response.status !== 200 && response.status !== 206) {
      throw new RangeDownloadError('SOURCE_RESPONSE_INVALID', 'Unexpected source status', null, {
        version: 1,
        phase: 'RESPONSE_HEADERS',
        kind: 'HTTP_UNEXPECTED_STATUS',
        httpStatus: response.status,
      });
    }
    const encoding = response.headers.get('content-encoding');
    if (encoding !== null && encoding.toLowerCase() !== 'identity') {
      throw new RangeDownloadError('SOURCE_ENCODING_UNSAFE', 'Range response was encoded');
    }
    if (response.status === 206) {
      const range = parseContentRange(response.headers.get('content-range'));
      if (!range || range.start !== start || range.end < range.start) {
        throw new RangeDownloadError('RANGE_NOT_HONORED', 'Invalid content range');
      }
      if (range.total !== expectedSize || range.end >= expectedSize) {
        throw new RangeDownloadError('SOURCE_CHANGED', 'Source size changed');
      }
      const length = response.headers.get('content-length');
      if (length !== null && decimal(length, 'contentLength') !== range.end - range.start + 1n) {
        throw new RangeDownloadError('SOURCE_RESPONSE_INVALID', 'Range length mismatch');
      }
      return;
    }
    const length = response.headers.get('content-length');
    if (length !== null && decimal(length, 'contentLength') !== expectedSize) {
      throw new RangeDownloadError('SOURCE_CHANGED', 'Source size changed');
    }
  }

  private validateUrl(url: URL): void {
    dataPlaneInvariant(url.protocol === 'https:', 'DOWNLOAD_URL_SCHEME_REJECTED');
    dataPlaneInvariant(!url.username && !url.password, 'DOWNLOAD_URL_USERINFO_REJECTED');
    const hostname = url.hostname.toLowerCase();
    const allowed = this.allowedHosts.some((entry) =>
      entry.startsWith('.')
        ? hostname.endsWith(entry) && hostname.length > entry.length
        : hostname === entry,
    );
    dataPlaneInvariant(allowed, 'DOWNLOAD_HOST_REJECTED');
  }

  private async checkpoint(options: RangeDownloadOptions, completedBytes: bigint): Promise<void> {
    await options.onDurableCheckpoint?.({
      leaseId: options.lease.leaseId,
      completedBytes: completedBytes.toString(),
      leaseExpiresAt: options.lease.expiresAt,
      checkpointedAt: this.now().toISOString(),
    });
  }
}

export function fsyncProbe(filePath: string): void {
  const descriptor = openSync(filePath, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
