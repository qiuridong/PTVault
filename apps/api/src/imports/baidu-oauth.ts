import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { ImportDataPlaneError } from './data-plane/errors.js';
import { createBoundedRequestSignal } from './request-timeout.js';
import {
  decodeBaiduCredentialPair,
  type BaiduAppEnvelope,
  type BaiduTokenEnvelope,
  type TrustedBaiduClientProfile,
} from './baidu-client-profile.js';

export type BaiduOAuthSession = { appId: string | null; accessToken: string };

export interface BaiduAccessTokenProvider {
  getSession(signal?: AbortSignal): Promise<BaiduOAuthSession>;
}

type LegacyAppCredentialEnvelope = {
  version: 1;
  appId: string;
  clientId: string;
  clientSecret: string;
};

type LegacyTokenEnvelope = {
  version: 1;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};
type AppCredentialEnvelope = BaiduAppEnvelope;
type TokenEnvelope = BaiduTokenEnvelope;

export type FileBaiduOAuthTokenProviderOptions = {
  appCredentialFile: string;
  tokenFile: string;
  fetch?: typeof fetch;
  now?: () => Date;
  refreshSkewMs?: number;
  requestTimeoutMs?: number;
  trustedProfiles?: readonly TrustedBaiduClientProfile[];
};

const MAX_CREDENTIAL_BYTES = 64 * 1024;
const OAUTH_ENDPOINT = 'https://openapi.baidu.com/oauth/2.0/token';

/** Import legacy files once without ever refreshing or writing those files. */
export async function readLegacyBaiduEnvironmentFiles(
  appFile: string,
  tokenFile: string,
  trustedProfiles?: readonly TrustedBaiduClientProfile[],
) {
  if (!path.isAbsolute(appFile) || !path.isAbsolute(tokenFile))
    throw oauthFailure('AUTH_CREDENTIAL_PATH_INVALID');
  const [appPath, tokenPath] = await Promise.all([realpath(appFile), realpath(tokenFile)]);
  if (appPath === tokenPath) throw oauthFailure('AUTH_CREDENTIAL_PATH_INVALID');
  const paired = storedPair(
    await readPrivateJson(appFile, 'AUTH_APP_CREDENTIAL_INVALID'),
    await readPrivateJson(tokenFile, 'AUTH_TOKEN_FILE_INVALID'),
    trustedProfiles,
  );
  return {
    appPath,
    tokenPath,
    ...paired,
  };
}

function oauthFailure(code: string): ImportDataPlaneError {
  return new ImportDataPlaneError(code, 'Baidu OAuth operation failed');
}

function nonEmptyString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

async function fsyncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform !== 'win32' ||
      !['EINVAL', 'EPERM', 'EISDIR', 'EBADF'].includes(code ?? '')
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function readPrivateJson(filePath: string, errorCode: string): Promise<unknown> {
  try {
    const fileStat = await lstat(filePath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > MAX_CREDENTIAL_BYTES) {
      throw oauthFailure(errorCode);
    }
    if (process.platform !== 'win32' && (fileStat.mode & 0o077) !== 0) {
      throw oauthFailure(errorCode);
    }
    const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      return JSON.parse(await handle.readFile('utf8')) as unknown;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof ImportDataPlaneError) throw error;
    throw oauthFailure(errorCode);
  }
}

function appCredentials(value: unknown): LegacyAppCredentialEnvelope {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('appId' in value) ||
    !nonEmptyString(value.appId, 128) ||
    !('clientId' in value) ||
    !nonEmptyString(value.clientId, 512) ||
    !('clientSecret' in value) ||
    !nonEmptyString(value.clientSecret, 512)
  ) {
    throw oauthFailure('AUTH_APP_CREDENTIAL_INVALID');
  }
  return {
    version: 1,
    appId: value.appId,
    clientId: value.clientId,
    clientSecret: value.clientSecret,
  };
}

function tokenEnvelope(value: unknown): LegacyTokenEnvelope {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('accessToken' in value) ||
    !nonEmptyString(value.accessToken, 4096) ||
    !('refreshToken' in value) ||
    !nonEmptyString(value.refreshToken, 4096) ||
    !('expiresAt' in value) ||
    typeof value.expiresAt !== 'number' ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= 0
  ) {
    throw oauthFailure('AUTH_TOKEN_FILE_INVALID');
  }
  return {
    version: 1,
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: value.expiresAt,
  };
}

function storedPair(
  app: unknown,
  token: unknown,
  trustedProfiles?: readonly TrustedBaiduClientProfile[],
): { app: AppCredentialEnvelope; token: TokenEnvelope } {
  const version = (value: unknown) =>
    typeof value === 'object' && value !== null && 'version' in value ? value.version : null;
  if (version(app) !== 2 && version(token) !== 2)
    return { app: appCredentials(app), token: tokenEnvelope(token) };
  try {
    return decodeBaiduCredentialPair(app, token, trustedProfiles);
  } catch (error) {
    throw oauthFailure(
      error instanceof Error && /^AUTH_[A-Z_]+$/.test(error.message)
        ? error.message
        : 'AUTH_CLIENT_PROFILE_UNTRUSTED',
    );
  }
}

async function boundedResponseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_CREDENTIAL_BYTES) throw oauthFailure('AUTH_RESPONSE_INVALID');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

/**
 * Reads an operator-provisioned token and rotates it through Baidu's official
 * OAuth endpoint. Only the token file is writable; app credentials stay in a
 * separate private file so a refresh cannot overwrite the long-lived secret.
 */
export class FileBaiduOAuthTokenProvider implements BaiduAccessTokenProvider {
  private readonly appCredentialFile: string;
  private readonly tokenFile: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly refreshSkewMs: number;
  private readonly requestTimeoutMs: number;
  private refreshing: Promise<BaiduOAuthSession> | undefined;
  private readonly trustedProfiles: readonly TrustedBaiduClientProfile[] | undefined;

  constructor(options: FileBaiduOAuthTokenProviderOptions) {
    if (!path.isAbsolute(options.appCredentialFile) || !path.isAbsolute(options.tokenFile)) {
      throw oauthFailure('AUTH_CREDENTIAL_PATH_INVALID');
    }
    this.appCredentialFile = path.resolve(options.appCredentialFile);
    this.tokenFile = path.resolve(options.tokenFile);
    if (this.appCredentialFile === this.tokenFile) {
      throw oauthFailure('AUTH_CREDENTIAL_PATH_INVALID');
    }
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.trustedProfiles = options.trustedProfiles;
    this.refreshSkewMs = options.refreshSkewMs ?? 5 * 60_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.refreshSkewMs) || this.refreshSkewMs < 0) {
      throw oauthFailure('AUTH_REFRESH_CONFIG_INVALID');
    }
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1) {
      throw oauthFailure('AUTH_REFRESH_CONFIG_INVALID');
    }
  }

  async getSession(signal?: AbortSignal): Promise<BaiduOAuthSession> {
    const { app: credentials, token } = storedPair(
      await readPrivateJson(this.appCredentialFile, 'AUTH_APP_CREDENTIAL_INVALID'),
      await readPrivateJson(this.tokenFile, 'AUTH_TOKEN_FILE_INVALID'),
      this.trustedProfiles,
    );
    if (token.expiresAt > this.now().getTime() + this.refreshSkewMs) {
      return { appId: credentials.appId, accessToken: token.accessToken };
    }
    this.refreshing ??= this.refresh(credentials, token, signal).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async refresh(
    credentials: AppCredentialEnvelope,
    token: TokenEnvelope,
    signal: AbortSignal | undefined,
  ): Promise<BaiduOAuthSession> {
    const url = new URL(OAUTH_ENDPOINT);
    url.searchParams.set('grant_type', 'refresh_token');
    url.searchParams.set('refresh_token', token.refreshToken);
    url.searchParams.set('client_id', credentials.clientId);
    url.searchParams.set('client_secret', credentials.clientSecret);
    const requestSignal = createBoundedRequestSignal(signal, this.requestTimeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await this.fetcher(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: requestSignal.signal,
      });
      text = await boundedResponseText(response);
    } catch (error) {
      if (error instanceof ImportDataPlaneError) throw error;
      if (signal?.aborted) throw error;
      throw oauthFailure('AUTH_REFRESH_UNAVAILABLE');
    } finally {
      requestSignal.dispose();
    }
    if (!response.ok) {
      throw oauthFailure(response.status === 429 ? 'RATE_LIMITED' : 'AUTH_EXPIRED');
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(text) as unknown;
    } catch {
      throw oauthFailure('AUTH_RESPONSE_INVALID');
    }
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      !('access_token' in decoded) ||
      !nonEmptyString(decoded.access_token, 4096) ||
      !('expires_in' in decoded) ||
      (typeof decoded.expires_in !== 'number' && typeof decoded.expires_in !== 'string')
    ) {
      throw oauthFailure('AUTH_EXPIRED');
    }
    const expiresIn = Number(decoded.expires_in);
    if (!Number.isSafeInteger(expiresIn) || expiresIn < 60 || expiresIn > 366 * 24 * 60 * 60) {
      throw oauthFailure('AUTH_RESPONSE_INVALID');
    }
    const refreshToken =
      'refresh_token' in decoded && nonEmptyString(decoded.refresh_token, 4096)
        ? decoded.refresh_token
        : token.refreshToken;
    const rotated: TokenEnvelope = {
      ...token,
      accessToken: decoded.access_token,
      refreshToken,
      expiresAt: this.now().getTime() + expiresIn * 1_000,
    };
    await this.writeToken(rotated);
    return { appId: credentials.appId, accessToken: rotated.accessToken };
  }

  private async writeToken(token: TokenEnvelope): Promise<void> {
    const directory = path.dirname(this.tokenFile);
    const temporary = path.join(directory, `.${path.basename(this.tokenFile)}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(token), 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(temporary, 0o600);
      await rename(temporary, this.tokenFile);
      await fsyncDirectory(directory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      if (error instanceof ImportDataPlaneError) throw error;
      throw oauthFailure('AUTH_TOKEN_WRITE_FAILED');
    }
  }
}
