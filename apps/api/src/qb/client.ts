import { isIP } from 'node:net';

import {
  InfoHashSchema,
  QbInstanceIdSchema,
  TorrentStateSchema,
  type QbInstanceId,
} from '@ptvault/contracts';
import { z } from 'zod';

import type { NormalizedTorrentState, QbControl, QbTorrent } from './types.js';

export const QB_REQUEST_TIMEOUT_MS = 10_000;

const RawQbTorrentSchema = z.object({
  hash: InfoHashSchema,
  name: z.string().min(1),
  progress: z.number().finite().min(0).max(1),
  state: z.string().min(1),
  size: z.number().finite().int().nonnegative(),
  amount_left: z.number().finite().int().nonnegative(),
  content_path: z.string().min(1),
  save_path: z.string().min(1),
  ratio: z.number().finite().nonnegative(),
  seeding_time: z.number().finite().int().nonnegative(),
  completion_on: z.number().finite().int().min(-1),
});

const RawQbTorrentListSchema = z.array(RawQbTorrentSchema);

type KnownQbState =
  | 'error'
  | 'missingfiles'
  | 'uploading'
  | 'seeding'
  | 'paused'
  | 'pausedup'
  | 'stoppedup'
  | 'queuedup'
  | 'stalledup'
  | 'checking'
  | 'checkingup'
  | 'forcedup'
  | 'allocating'
  | 'downloading'
  | 'metadl'
  | 'forcedmetadl'
  | 'pauseddl'
  | 'stoppeddl'
  | 'queueddl'
  | 'stalleddl'
  | 'checkingdl'
  | 'forceddl'
  | 'checkingresumedata'
  | 'moving'
  | 'stopped'
  | 'unknown';

const QB_STATE_MAP: Record<KnownQbState, NormalizedTorrentState> = {
  error: 'ERROR',
  missingfiles: 'MISSING_FILES',
  uploading: 'SEEDING',
  seeding: 'SEEDING',
  paused: 'PAUSED',
  pausedup: 'PAUSED',
  stoppedup: 'PAUSED',
  queuedup: 'SEEDING',
  stalledup: 'SEEDING',
  checking: 'CHECKING',
  checkingup: 'CHECKING',
  forcedup: 'SEEDING',
  allocating: 'DOWNLOADING',
  downloading: 'DOWNLOADING',
  metadl: 'DOWNLOADING',
  forcedmetadl: 'DOWNLOADING',
  pauseddl: 'PAUSED',
  stoppeddl: 'PAUSED',
  queueddl: 'DOWNLOADING',
  stalleddl: 'DOWNLOADING',
  checkingdl: 'CHECKING',
  forceddl: 'DOWNLOADING',
  checkingresumedata: 'CHECKING',
  moving: 'DOWNLOADING',
  stopped: 'PAUSED',
  unknown: 'UNKNOWN',
};

export type QbClientEnvironment = 'production' | 'development' | 'test';

export type QbClientOptions = {
  instanceId: string;
  baseUrl: string;
  username: string;
  password: string;
  fetch?: typeof fetch;
  environment?: QbClientEnvironment;
  requestTimeoutMs?: number;
};

export type QbClientErrorCode =
  | 'INVALID_INSTANCE_ID'
  | 'INVALID_BASE_URL'
  | 'BASE_URL_CREDENTIALS'
  | 'INVALID_TIMEOUT'
  | 'INVALID_HASH'
  | 'LOOPBACK_REQUIRED'
  | 'AUTH_FAILED'
  | 'AUTH_COOKIE_MISSING'
  | 'AUTH_RESPONSE_INVALID'
  | 'REQUEST_FAILED'
  | 'INVALID_RESPONSE';

const ERROR_MESSAGES: Record<QbClientErrorCode, string> = {
  INVALID_INSTANCE_ID: 'qB instance ID is invalid',
  INVALID_BASE_URL: 'qB base URL is invalid',
  BASE_URL_CREDENTIALS: 'qB base URL must not contain credentials',
  INVALID_TIMEOUT: 'qB request timeout is invalid',
  INVALID_HASH: 'qB torrent hash is invalid',
  LOOPBACK_REQUIRED: 'HTTP qB connections must target loopback in production',
  AUTH_FAILED: 'qB authentication failed',
  AUTH_COOKIE_MISSING: 'qB login did not return a SID cookie',
  AUTH_RESPONSE_INVALID: 'qB login response was invalid',
  REQUEST_FAILED: 'qB request failed',
  INVALID_RESPONSE: 'qB response was invalid',
};

export class QbClientError extends Error {
  constructor(
    readonly code: QbClientErrorCode,
    readonly status?: number,
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = 'QbClientError';
  }
}

function runtimeEnvironment(explicit: QbClientEnvironment | undefined): QbClientEnvironment {
  if (explicit) return explicit;
  if (process.env.NODE_ENV === 'production') return 'production';
  if (process.env.NODE_ENV === 'test') return 'test';
  return 'development';
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  if (isIP(normalized) !== 4) return false;
  return normalized.split('.')[0] === '127';
}

function parseBaseUrl(raw: string, environment: QbClientEnvironment): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new QbClientError('INVALID_BASE_URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new QbClientError('INVALID_BASE_URL');
  }
  if (url.username || url.password) throw new QbClientError('BASE_URL_CREDENTIALS');
  if (url.search || url.hash) throw new QbClientError('INVALID_BASE_URL');
  if (
    environment === 'production' &&
    url.protocol === 'http:' &&
    !isLoopbackHostname(url.hostname)
  ) {
    throw new QbClientError('LOOPBACK_REQUIRED');
  }

  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

function extractSid(headers: Headers): string {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const values = withGetSetCookie.getSetCookie?.() ?? [headers.get('set-cookie') ?? ''];
  for (const value of values) {
    // qB <5 names the session cookie `SID`; qB 5.2 names it `QBT_SID_<port>`
    // (port-suffixed so multiple instances don't clash). Capture the whole
    // `name=value` pair and replay it verbatim, so either scheme round-trips.
    const match = /(?:^|[,;]\s*)((?:QBT_)?SID(?:_\d+)?=[^;,\s]+)/i.exec(value);
    if (match?.[1]) return match[1];
  }
  throw new QbClientError('AUTH_COOKIE_MISSING');
}

function formRequest(values: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values).toString(),
  };
}

function isQbClientError(error: unknown): error is QbClientError {
  return error instanceof QbClientError;
}

function validatedInfoHash(hash: string): string {
  const parsed = InfoHashSchema.safeParse(hash);
  if (!parsed.success) throw new QbClientError('INVALID_HASH');
  return parsed.data;
}

export function normalizeTorrentState(rawState: string): NormalizedTorrentState {
  const normalizedContractState = TorrentStateSchema.safeParse(rawState);
  if (normalizedContractState.success) return normalizedContractState.data;
  return QB_STATE_MAP[rawState.toLowerCase() as KnownQbState] ?? 'UNKNOWN';
}

export const normalizeQbState = normalizeTorrentState;

type ResponseResult<T> = {
  response: Response;
  value: T;
};

type ResponseConsumer<T> = (response: Response) => Promise<T>;

type ReauthenticationResult = {
  generation: number;
  ownsInvalidation: boolean;
};

export class QbClient implements QbControl {
  readonly instanceId: QbInstanceId;
  readonly #baseUrl: URL;
  readonly #username: string;
  readonly #password: string;
  readonly #requestFetch: typeof fetch;
  readonly #requestTimeoutMs: number;
  #sid: string | undefined;
  #sessionGeneration = 0;
  #authentication: Promise<void> | undefined;

  constructor(options: QbClientOptions) {
    const instanceId = QbInstanceIdSchema.safeParse(options.instanceId);
    if (!instanceId.success) throw new QbClientError('INVALID_INSTANCE_ID');

    this.instanceId = instanceId.data;
    this.#baseUrl = parseBaseUrl(options.baseUrl, runtimeEnvironment(options.environment));
    this.#username = options.username;
    this.#password = options.password;
    this.#requestFetch = options.fetch ?? fetch;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? QB_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(this.#requestTimeoutMs) || this.#requestTimeoutMs <= 0) {
      throw new QbClientError('INVALID_TIMEOUT');
    }
  }

  async version(): Promise<string> {
    const version = (
      await this.requestBody(this.endpoint('/api/v2/app/version'), { method: 'GET' }, (response) =>
        this.readTextBody(response),
      )
    ).trim();
    if (!version) throw new QbClientError('INVALID_RESPONSE');
    return version;
  }

  async list(): Promise<QbTorrent[]> {
    let payload: unknown;
    try {
      payload = await this.requestBody(
        this.endpoint('/api/v2/torrents/info'),
        { method: 'GET' },
        (response) => this.readJsonBody(response),
      );
    } catch (error) {
      if (isQbClientError(error)) throw error;
      throw new QbClientError('INVALID_RESPONSE');
    }

    const torrents = RawQbTorrentListSchema.safeParse(payload);
    if (!torrents.success) throw new QbClientError('INVALID_RESPONSE');
    return torrents.data.map((torrent) => ({
      ...torrent,
      state: normalizeTorrentState(torrent.state),
    }));
  }

  async pause(hash: string): Promise<void> {
    const validHash = validatedInfoHash(hash);
    const stop = await this.request(
      this.endpoint('/api/v2/torrents/stop'),
      formRequest({ hashes: validHash }),
      [404],
    );
    if (stop.status === 404) {
      await this.request(
        this.endpoint('/api/v2/torrents/pause'),
        formRequest({ hashes: validHash }),
      );
    }
  }

  async exportTorrent(hash: string): Promise<Uint8Array> {
    const endpoint = this.endpoint('/api/v2/torrents/export');
    endpoint.searchParams.set('hash', validatedInfoHash(hash));
    const buffer = await this.requestBody(endpoint, { method: 'GET' }, (response) =>
      this.readArrayBufferBody(response),
    );
    return new Uint8Array(buffer);
  }

  async forceRecheck(hash: string): Promise<void> {
    await this.postHash('/api/v2/torrents/recheck', hash);
  }

  async resume(hash: string): Promise<void> {
    // qB 5.x renamed `resume` to `start`, exactly as it renamed `pause` to `stop`.
    // `pause` already probed both; this one did not, so it returned 404 against the
    // real 5.2 instance — meaning a torrent paused for a migration could never be
    // put back to seeding by this code. Try the new name first, fall back to the
    // old one, and treat only 404 as "wrong name" so a real failure still throws.
    const validHash = validatedInfoHash(hash);
    const start = await this.request(
      this.endpoint('/api/v2/torrents/start'),
      formRequest({ hashes: validHash }),
      [404],
    );
    if (start.status === 404) {
      await this.request(
        this.endpoint('/api/v2/torrents/resume'),
        formRequest({ hashes: validHash }),
      );
    }
  }

  async addTag(hash: string, tag: string): Promise<void> {
    await this.request(
      this.endpoint('/api/v2/torrents/addTags'),
      formRequest({ hashes: validatedInfoHash(hash), tags: tag }),
    );
  }

  private endpoint(pathname: string): URL {
    const endpoint = new URL(this.#baseUrl);
    const basePath = endpoint.pathname.replace(/\/+$/, '');
    const apiPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
    endpoint.pathname = `${basePath}${apiPath}`;
    return endpoint;
  }

  private async postHash(pathname: string, hash: string): Promise<void> {
    await this.request(this.endpoint(pathname), formRequest({ hashes: validatedInfoHash(hash) }));
  }

  private ensureAuthenticated(): Promise<void> {
    if (this.#sid) return Promise.resolve();
    if (this.#authentication) return this.#authentication;

    const authentication = this.performAuthentication();
    this.#authentication = authentication;
    void authentication
      .finally(() => {
        if (this.#authentication === authentication) this.#authentication = undefined;
      })
      .catch(() => undefined);
    return authentication;
  }

  private async performAuthentication(): Promise<void> {
    const result = await this.fetchAndConsume(
      this.endpoint('/api/v2/auth/login'),
      formRequest({ username: this.#username, password: this.#password }),
      async (response) => {
        if (!response.ok) {
          await this.discardBody(response);
          return '';
        }
        return this.readTextBody(response);
      },
    );
    if (!result.response.ok) throw new QbClientError('AUTH_FAILED', result.response.status);
    // qB <5 answers a successful login with `200 Ok.`; qB 5.2 answers with
    // `204 No Content` and an empty body. Accept either, but still reject any
    // other 2xx body (e.g. a stray `Fails.`) as malformed. The SID cookie below
    // remains the real gate — an empty body without a cookie still fails.
    const body = result.value.trim();
    const emptyNoContent = result.response.status === 204 && body === '';
    if (!emptyNoContent && body !== 'Ok.') {
      throw new QbClientError('AUTH_RESPONSE_INVALID', result.response.status);
    }

    this.#sid = extractSid(result.response.headers);
    this.#sessionGeneration += 1;
  }

  private async reauthenticate(staleGeneration: number): Promise<ReauthenticationResult> {
    const ownsInvalidation = this.invalidateSession(staleGeneration);
    await this.ensureAuthenticated();
    return {
      generation: this.#sessionGeneration,
      ownsInvalidation,
    };
  }

  private invalidateSession(generation: number): boolean {
    if (this.#sessionGeneration !== generation || !this.#sid) return false;
    this.#sid = undefined;
    this.#sessionGeneration += 1;
    return true;
  }

  private async request(
    endpoint: URL,
    init: RequestInit,
    allowedStatuses: readonly number[] = [],
  ): Promise<Response> {
    await this.ensureAuthenticated();

    const staleGeneration = this.#sessionGeneration;
    let result = await this.fetchAuthenticated(endpoint, init);
    if (result.response.status === 403) {
      const refresh = await this.reauthenticate(staleGeneration);
      result = await this.fetchAuthenticated(endpoint, init);
      if (result.response.status === 403) {
        if (refresh.ownsInvalidation) this.invalidateSession(refresh.generation);
        throw new QbClientError('AUTH_FAILED', 403);
      }
    }

    if (!result.response.ok && !allowedStatuses.includes(result.response.status)) {
      throw new QbClientError('REQUEST_FAILED', result.response.status);
    }
    return result.response;
  }

  private async requestBody<T>(
    endpoint: URL,
    init: RequestInit,
    consume: ResponseConsumer<T>,
  ): Promise<T> {
    await this.ensureAuthenticated();

    const staleGeneration = this.#sessionGeneration;
    let result = await this.fetchAuthenticatedBody(endpoint, init, consume);
    if (result.response.status === 403) {
      const refresh = await this.reauthenticate(staleGeneration);
      result = await this.fetchAuthenticatedBody(endpoint, init, consume);
      if (result.response.status === 403) {
        if (refresh.ownsInvalidation) this.invalidateSession(refresh.generation);
        throw new QbClientError('AUTH_FAILED', 403);
      }
    }

    if (!result.response.ok) throw new QbClientError('REQUEST_FAILED', result.response.status);
    return result.value;
  }

  private async fetchAuthenticated(
    endpoint: URL,
    init: RequestInit,
  ): Promise<ResponseResult<void>> {
    const sid = this.#sid;
    if (!sid) throw new QbClientError('AUTH_FAILED');
    const headers = new Headers(init.headers);
    headers.set('Cookie', sid);
    return this.fetchAndConsume(endpoint, { ...init, headers }, (response) =>
      this.discardBody(response),
    );
  }

  private async fetchAuthenticatedBody<T>(
    endpoint: URL,
    init: RequestInit,
    consume: ResponseConsumer<T>,
  ): Promise<ResponseResult<T>> {
    const sid = this.#sid;
    if (!sid) throw new QbClientError('AUTH_FAILED');
    const headers = new Headers(init.headers);
    headers.set('Cookie', sid);
    return this.fetchAndConsume(endpoint, { ...init, headers }, async (response) => {
      if (!response.ok) {
        await this.discardBody(response);
        return undefined as T;
      }
      return consume(response);
    });
  }
  private async fetchAndConsume<T>(
    endpoint: URL,
    init: RequestInit,
    consume: ResponseConsumer<T>,
  ): Promise<ResponseResult<T>> {
    const controller = new AbortController();
    let rejectTimeout: ((reason: QbClientError) => void) | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });
    const timeout = setTimeout(() => {
      controller.abort();
      rejectTimeout?.(new QbClientError('REQUEST_FAILED'));
    }, this.#requestTimeoutMs);

    try {
      const operation = (async () => {
        const response = await this.#requestFetch(endpoint.toString(), {
          ...init,
          redirect: 'error',
          signal: controller.signal,
        });
        const value = await consume(response);
        return { response, value };
      })();
      return await Promise.race([operation, timeoutPromise]);
    } catch (error) {
      if (isQbClientError(error)) throw error;
      throw new QbClientError('REQUEST_FAILED');
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }

  private async discardBody(response: Response): Promise<void> {
    try {
      await response.arrayBuffer();
    } catch {
      throw new QbClientError('INVALID_RESPONSE', response.status);
    }
  }

  private async readTextBody(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      throw new QbClientError('INVALID_RESPONSE', response.status);
    }
  }

  private async readJsonBody(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new QbClientError('INVALID_RESPONSE', response.status);
    }
  }

  private async readArrayBufferBody(response: Response): Promise<ArrayBuffer> {
    try {
      return await response.arrayBuffer();
    } catch {
      throw new QbClientError('INVALID_RESPONSE', response.status);
    }
  }
}
