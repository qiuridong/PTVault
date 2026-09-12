import type { CloudProvider } from '@ptvault/contracts';

import type { OAuthProviderAdapter, OAuthTokenExchangeResult } from './oauth.js';
import { CloudProviderRateLimitError } from './rate-limit.js';
import type {
  CloudConnectionProviderSession,
  CloudTokenRefreshProvider,
  CloudTokenRefreshResult,
} from './refresh-coordinator.js';
import type { CloudConnectionProbeAdapter } from './services.js';

const DEFAULT_SCOPES = ['basic', 'netdisk'] as const;
const MAX_RESPONSE_BYTES = 1024 * 1024;

type TokenEnvelope = {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: number;
  scopes: string[];
};

type BaiduIdentity = { id: string; principal: string };

export type BaiduCloudProviderAdapterOptions = {
  clientId: string;
  clientSecret: string;
  appId: string | null;
  scopes?: readonly string[];
  oauthOrigin?: string;
  panOrigin?: string;
  fetch?: typeof fetch;
  now?: () => number;
  requestTimeoutMs?: number;
};

/** Official Baidu OAuth/xpan identity adapter. It never advertises delete authority. */
export class BaiduCloudProviderAdapter
  implements OAuthProviderAdapter, CloudTokenRefreshProvider, CloudConnectionProbeAdapter
{
  readonly provider: CloudProvider = 'BAIDU';
  readonly clientId: string;
  readonly usesPkce = false;
  readonly appId: string | null;
  private readonly clientSecret: string;
  private readonly scopes: readonly string[];
  private readonly oauthOrigin: string;
  private readonly panOrigin: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;

  constructor(options: BaiduCloudProviderAdapterOptions) {
    this.clientId = bounded(options.clientId, 1, 512, 'BAIDU_CLIENT_ID_INVALID');
    this.clientSecret = bounded(options.clientSecret, 1, 512, 'BAIDU_CLIENT_SECRET_INVALID');
    this.appId =
      options.appId === null ? null : bounded(options.appId, 1, 128, 'BAIDU_APP_ID_INVALID');
    this.scopes = normalizeScopes(options.scopes ?? DEFAULT_SCOPES);
    this.oauthOrigin = exactHttpsOrigin(
      options.oauthOrigin ?? 'https://openapi.baidu.com',
      'BAIDU_OAUTH_ORIGIN_INVALID',
    );
    this.panOrigin = exactHttpsOrigin(
      options.panOrigin ?? 'https://pan.baidu.com',
      'BAIDU_PAN_ORIGIN_INVALID',
    );
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1) {
      throw new Error('BAIDU_REQUEST_TIMEOUT_INVALID');
    }
  }

  createAuthorizationUrl(input: {
    state: string;
    redirectUri: string;
    codeChallenge: string | null;
  }): string {
    const url = new URL('/oauth/2.0/authorize', this.oauthOrigin);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('scope', this.scopes.join(','));
    url.searchParams.set('state', input.state);
    url.searchParams.set('display', 'page');
    url.searchParams.set('force_login', '1');
    return url.toString();
  }

  async exchangeCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string | null;
  }): Promise<OAuthTokenExchangeResult> {
    const token = await this.tokenRequest({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
    });
    if (token.refreshToken === null) throw new Error('BAIDU_REFRESH_TOKEN_REQUIRED');
    const identity = await this.identity(token.accessToken);
    return {
      provider: 'BAIDU',
      clientId: this.clientId,
      externalAccountId: identity.id,
      principalMasked: identity.principal,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      accessExpiresAt: token.accessExpiresAt,
      scopes: token.scopes,
      capabilities:
        this.appId === null
          ? ['SOURCE_BROWSE', 'SOURCE_DOWNLOAD']
          : ['SOURCE_BROWSE', 'SOURCE_DOWNLOAD', 'SHARE_TRANSFER', 'SOURCE_DELETE'],
      provisionState: 'NOT_REQUESTED',
    };
  }

  async refresh(input: {
    connectionId: string;
    refreshToken: string;
    externalAccountId: string;
    signal?: AbortSignal;
  }): Promise<CloudTokenRefreshResult> {
    const token = await this.tokenRequest(
      { grant_type: 'refresh_token', refresh_token: input.refreshToken },
      input.signal,
    );
    const identity = await this.identity(token.accessToken, input.signal);
    if (identity.id !== input.externalAccountId) throw new Error('BAIDU_IDENTITY_MISMATCH');
    return {
      provider: 'BAIDU',
      clientId: this.clientId,
      externalAccountId: identity.id,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      accessExpiresAt: token.accessExpiresAt,
    };
  }

  async testSession(session: CloudConnectionProviderSession): Promise<{ healthy: boolean }> {
    if (session.provider !== 'BAIDU') return { healthy: false };
    const identity = await this.identity(session.accessToken);
    return { healthy: identity.id === session.externalAccountId };
  }

  async inspectLegacyToken(token: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }): Promise<OAuthTokenExchangeResult> {
    if (token.expiresAt <= this.now()) throw new Error('AUTH_LEGACY_TOKEN_EXPIRED');
    const identity = await this.identity(token.accessToken);
    if (this.appId === null) {
      const url = new URL('/rest/2.0/xpan/file', this.panOrigin);
      url.searchParams.set('method', 'list');
      url.searchParams.set('dir', '/');
      url.searchParams.set('start', '0');
      url.searchParams.set('limit', '1');
      url.searchParams.set('access_token', token.accessToken);
      const listing = objectRecord(
        await this.requestJson(url, { method: 'GET', headers: { accept: 'application/json' } }),
        'BAIDU_BROWSE_RESPONSE_INVALID',
      );
      if (numericField(listing, 'errno') !== 0 || !Array.isArray(listing.list))
        throw new Error('BAIDU_BROWSE_CAPABILITY_UNAVAILABLE');
    }
    return {
      provider: 'BAIDU',
      clientId: this.clientId,
      externalAccountId: identity.id,
      principalMasked: identity.principal,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      accessExpiresAt: token.expiresAt,
      scopes: [...this.scopes],
      // Supported xpan operations, not a claim that a media download was tested.
      capabilities:
        this.appId === null
          ? ['SOURCE_BROWSE', 'SOURCE_DOWNLOAD']
          : ['SOURCE_BROWSE', 'SOURCE_DOWNLOAD', 'SHARE_TRANSFER'],
      provisionState: 'NOT_REQUESTED',
    };
  }

  private async tokenRequest(
    fields: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<TokenEnvelope> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: this.scopes.join(' '),
      ...fields,
    });
    const decoded = await this.requestJson(
      new URL('/oauth/2.0/token', this.oauthOrigin),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body,
      },
      signal,
    );
    const record = objectRecord(decoded, 'BAIDU_TOKEN_RESPONSE_INVALID');
    const accessToken = stringField(record, 'access_token', 16_384);
    const refreshToken = optionalStringField(record, 'refresh_token', 16_384);
    const expiresIn = numericField(record, 'expires_in');
    if (!Number.isSafeInteger(expiresIn) || expiresIn < 60 || expiresIn > 366 * 24 * 60 * 60) {
      throw new Error('BAIDU_TOKEN_RESPONSE_INVALID');
    }
    const scopes =
      typeof record.scope === 'string'
        ? normalizeScopes(record.scope.split(/[\s,]+/))
        : [...this.scopes];
    return {
      accessToken,
      refreshToken,
      accessExpiresAt: this.now() + expiresIn * 1_000,
      scopes,
    };
  }

  private async identity(accessToken: string, signal?: AbortSignal): Promise<BaiduIdentity> {
    const url = new URL('/rest/2.0/xpan/nas', this.panOrigin);
    url.searchParams.set('method', 'uinfo');
    url.searchParams.set('access_token', accessToken);
    const decoded = await this.requestJson(
      url,
      { method: 'GET', headers: { accept: 'application/json' } },
      signal,
    );
    const record = objectRecord(decoded, 'BAIDU_IDENTITY_RESPONSE_INVALID');
    const errno = numericField(record, 'errno');
    if (errno !== 0)
      throw new Error(errno === -6 ? 'BAIDU_AUTH_EXPIRED' : 'BAIDU_IDENTITY_RESPONSE_INVALID');
    const id = decimalField(record, 'uk');
    const principal =
      optionalBoundedString(record.baidu_name, 256) ??
      optionalBoundedString(record.netdisk_name, 256) ??
      id;
    return { id, principal };
  }

  private async requestJson(url: URL, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    if (
      !new Set([this.oauthOrigin, this.panOrigin]).has(url.origin) ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password
    ) {
      throw new Error('BAIDU_PROVIDER_URL_REJECTED');
    }
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await this.fetcher(url, { ...init, redirect: 'error', signal: combined });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw new Error('BAIDU_PROVIDER_UNAVAILABLE');
    }
    if (response.status === 429) {
      throw new CloudProviderRateLimitError(response.headers.get('retry-after') ?? undefined);
    }
    if (!response.ok) {
      throw new Error(
        response.status === 401 || response.status === 403
          ? 'BAIDU_AUTH_EXPIRED'
          : 'BAIDU_PROVIDER_FAILED',
      );
    }
    const text = await boundedText(response, MAX_RESPONSE_BYTES);
    try {
      // Baidu account ids may exceed Number.MAX_SAFE_INTEGER. Quote only the
      // identity field before JSON.parse so its exact decimal value survives.
      return JSON.parse(text.replace(/("uk"\s*:\s*)(-?(?:0|[1-9][0-9]*))/g, '$1"$2"')) as unknown;
    } catch {
      throw new Error('BAIDU_PROVIDER_RESPONSE_INVALID');
    }
  }
}

async function boundedText(response: Response, maximum: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) throw new Error('BAIDU_PROVIDER_RESPONSE_TOO_LARGE');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

function objectRecord(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string, maximum: number): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new Error('BAIDU_PROVIDER_RESPONSE_INVALID');
  }
  return value;
}

function optionalStringField(
  record: Record<string, unknown>,
  key: string,
  maximum: number,
): string | null {
  const value = record[key];
  return value === undefined || value === null ? null : stringField(record, key, maximum);
}

function optionalBoundedString(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : null;
}

function decimalField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,39})$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new Error('BAIDU_IDENTITY_RESPONSE_INVALID');
}

function numericField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^-?(?:0|[1-9][0-9]*)$/.test(value)) return Number(value);
  return Number.NaN;
}

function normalizeScopes(scopes: readonly string[]): string[] {
  const normalized = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
  if (
    normalized.length === 0 ||
    normalized.length > 32 ||
    normalized.some((scope) => scope.length > 128 || /[\r\n\0]/.test(scope))
  ) {
    throw new Error('BAIDU_SCOPES_INVALID');
  }
  return normalized;
}

function exactHttpsOrigin(value: string, code: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(code);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(code);
  }
  return url.origin;
}

function bounded(value: string, minimum: number, maximum: number, code: string): string {
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum || /[\r\n\0]/.test(normalized)) {
    throw new Error(code);
  }
  return normalized;
}
