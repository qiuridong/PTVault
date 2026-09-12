import type { CloudProvider } from '@ptvault/contracts';

import type { OAuthProviderAdapter, OAuthTokenExchangeResult } from './oauth.js';
import { CloudProviderRateLimitError } from './rate-limit.js';
import type {
  CloudConnectionProviderSession,
  CloudTokenRefreshProvider,
  CloudTokenRefreshResult,
} from './refresh-coordinator.js';
import type { CloudConnectionProbeAdapter } from './services.js';

const DEFAULT_SCOPES = ['offline_access', 'Files.ReadWrite', 'User.Read'] as const;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

type TokenEnvelope = {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: number;
  scopes: string[];
};

type DriveIdentity = {
  id: string;
  principal: string;
};

export type MicrosoftOneDriveProviderAdapterOptions = {
  clientId: string;
  clientSecret?: string;
  tenant?: string;
  scopes?: readonly string[];
  authorityOrigin?: string;
  graphOrigin?: string;
  fetch?: typeof fetch;
  now?: () => number;
  requestTimeoutMs?: number;
};

/**
 * Production Microsoft identity/Graph adapter shared by OAuth, refresh and
 * connection probes.  It deliberately returns only stable, allowlisted fields;
 * provider bodies never cross the adapter boundary.
 */
export class MicrosoftOneDriveProviderAdapter
  implements OAuthProviderAdapter, CloudTokenRefreshProvider, CloudConnectionProbeAdapter
{
  readonly provider: CloudProvider = 'ONEDRIVE';
  readonly clientId: string;
  readonly usesPkce = true;
  private readonly clientSecret: string | undefined;
  private readonly tenant: string;
  private readonly scopes: readonly string[];
  private readonly authorityOrigin: string;
  private readonly graphOrigin: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;

  constructor(options: MicrosoftOneDriveProviderAdapterOptions) {
    this.clientId = bounded(options.clientId, 1, 256, 'ONEDRIVE_CLIENT_ID_INVALID');
    this.clientSecret = options.clientSecret;
    this.tenant = bounded(options.tenant ?? 'organizations', 1, 128, 'ONEDRIVE_TENANT_INVALID');
    if (!/^[A-Za-z0-9._-]+$/.test(this.tenant)) throw new Error('ONEDRIVE_TENANT_INVALID');
    this.scopes = normalizeScopes(options.scopes ?? DEFAULT_SCOPES);
    this.authorityOrigin = exactHttpsOrigin(
      options.authorityOrigin ?? 'https://login.microsoftonline.com',
      'ONEDRIVE_AUTHORITY_INVALID',
    );
    this.graphOrigin = exactHttpsOrigin(
      options.graphOrigin ?? 'https://graph.microsoft.com',
      'ONEDRIVE_GRAPH_ORIGIN_INVALID',
    );
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1) {
      throw new Error('ONEDRIVE_REQUEST_TIMEOUT_INVALID');
    }
  }

  createAuthorizationUrl(input: {
    state: string;
    redirectUri: string;
    codeChallenge: string | null;
  }): string {
    if (input.codeChallenge === null || input.codeChallenge.length === 0) {
      throw new Error('ONEDRIVE_PKCE_REQUIRED');
    }
    const url = new URL(
      `/${encodeURIComponent(this.tenant)}/oauth2/v2.0/authorize`,
      this.authorityOrigin,
    );
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_mode', 'query');
    url.searchParams.set('scope', this.scopes.join(' '));
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  async exchangeCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string | null;
  }): Promise<OAuthTokenExchangeResult> {
    if (input.codeVerifier === null || input.codeVerifier.length === 0) {
      throw new Error('ONEDRIVE_PKCE_REQUIRED');
    }
    const token = await this.tokenRequest({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    });
    if (token.refreshToken === null) throw new Error('ONEDRIVE_REFRESH_TOKEN_REQUIRED');
    const identity = await this.driveIdentity(token.accessToken);
    return {
      provider: 'ONEDRIVE',
      clientId: this.clientId,
      externalAccountId: identity.id,
      principalMasked: identity.principal,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      accessExpiresAt: token.accessExpiresAt,
      scopes: token.scopes,
      // OAuth alone is not destination evidence. Provisioning promotes this
      // exact connection only after escrow/readback/crypt verification passes.
      capabilities: [],
      // OAuth authenticates a drive; it never claims the rclone/escrow probes ran.
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
    const identity = await this.driveIdentity(token.accessToken, input.signal);
    if (identity.id !== input.externalAccountId) throw new Error('ONEDRIVE_IDENTITY_MISMATCH');
    return {
      provider: 'ONEDRIVE',
      clientId: this.clientId,
      externalAccountId: identity.id,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      accessExpiresAt: token.accessExpiresAt,
    };
  }

  async testSession(session: CloudConnectionProviderSession): Promise<{ healthy: boolean }> {
    if (session.provider !== 'ONEDRIVE') return { healthy: false };
    const identity = await this.driveIdentity(session.accessToken);
    return { healthy: identity.id === session.externalAccountId };
  }

  private async tokenRequest(
    fields: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<TokenEnvelope> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      scope: this.scopes.join(' '),
      ...fields,
    });
    if (this.clientSecret !== undefined) body.set('client_secret', this.clientSecret);
    const decoded = await this.requestJson(
      new URL(`/${encodeURIComponent(this.tenant)}/oauth2/v2.0/token`, this.authorityOrigin),
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      },
      signal,
    );
    const record = objectRecord(decoded, 'ONEDRIVE_TOKEN_RESPONSE_INVALID');
    const accessToken = stringField(record, 'access_token', 16_384);
    const refreshToken = optionalStringField(record, 'refresh_token', 16_384);
    const expiresIn = numericField(record, 'expires_in');
    if (!Number.isSafeInteger(expiresIn) || expiresIn < 30 || expiresIn > 86_400) {
      throw new Error('ONEDRIVE_TOKEN_RESPONSE_INVALID');
    }
    const responseScopes =
      typeof record.scope === 'string'
        ? normalizeScopes(record.scope.split(/\s+/))
        : [...this.scopes];
    return {
      accessToken,
      refreshToken,
      accessExpiresAt: this.now() + expiresIn * 1_000,
      scopes: responseScopes,
    };
  }

  private async driveIdentity(accessToken: string, signal?: AbortSignal): Promise<DriveIdentity> {
    const url = new URL('/v1.0/me/drive', this.graphOrigin);
    url.searchParams.set('$select', 'id,driveType,owner');
    const decoded = await this.requestJson(
      url,
      { method: 'GET', headers: { authorization: `Bearer ${accessToken}` } },
      signal,
    );
    const drive = objectRecord(decoded, 'ONEDRIVE_IDENTITY_RESPONSE_INVALID');
    const id = stringField(drive, 'id', 256);
    let principal = id;
    if (drive.owner !== null && typeof drive.owner === 'object') {
      const owner = drive.owner as Record<string, unknown>;
      if (owner.user !== null && typeof owner.user === 'object') {
        const user = owner.user as Record<string, unknown>;
        if (typeof user.email === 'string' && user.email.length <= 256 && user.email.length > 0) {
          principal = user.email;
        } else if (
          typeof user.displayName === 'string' &&
          user.displayName.length <= 256 &&
          user.displayName.length > 0
        ) {
          principal = user.displayName;
        }
      }
    }
    return { id, principal };
  }

  private async requestJson(url: URL, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    const expectedOrigins = new Set([this.authorityOrigin, this.graphOrigin]);
    if (
      !expectedOrigins.has(url.origin) ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password
    ) {
      throw new Error('ONEDRIVE_PROVIDER_URL_REJECTED');
    }
    const bounded = AbortSignal.timeout(this.requestTimeoutMs);
    const combined = signal === undefined ? bounded : AbortSignal.any([signal, bounded]);
    let response: Response;
    try {
      response = await this.fetcher(url, { ...init, redirect: 'error', signal: combined });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw new Error('ONEDRIVE_PROVIDER_UNAVAILABLE');
    }
    if (response.status === 429) {
      throw new CloudProviderRateLimitError(response.headers.get('retry-after') ?? undefined);
    }
    if (!response.ok) {
      throw new Error(
        response.status === 401 || response.status === 403
          ? 'ONEDRIVE_AUTH_EXPIRED'
          : 'ONEDRIVE_PROVIDER_FAILED',
      );
    }
    const text = await boundedText(response, MAX_PROVIDER_RESPONSE_BYTES);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error('ONEDRIVE_PROVIDER_RESPONSE_INVALID');
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
      if (total > maximum) throw new Error('ONEDRIVE_PROVIDER_RESPONSE_TOO_LARGE');
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
    throw new Error('ONEDRIVE_PROVIDER_RESPONSE_INVALID');
  }
  return value;
}

function optionalStringField(
  record: Record<string, unknown>,
  key: string,
  maximum: number,
): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  return stringField(record, key, maximum);
}

function numericField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)) return Number(value);
  return Number.NaN;
}

function normalizeScopes(scopes: readonly string[]): string[] {
  const normalized = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
  if (
    normalized.length === 0 ||
    normalized.length > 32 ||
    normalized.some((scope) => scope.length > 128 || /[\r\n\0]/.test(scope))
  ) {
    throw new Error('ONEDRIVE_SCOPES_INVALID');
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
