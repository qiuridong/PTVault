import { createHash } from 'node:crypto';
export type TrustedBaiduClientProfile = {
  profileId: string;
  sourceCommit: string;
  sourceSha256: string;
  clientFingerprint: string;
  appId: null;
};
/** Software-owned immutable registry. File claims never add trusted profiles. */
export const TRUSTED_BAIDU_CLIENT_PROFILES: readonly TrustedBaiduClientProfile[] = [
  {
    profileId: 'alist-public-baidu-e5662efad3ef',
    sourceCommit: 'e5662efad3efb8fea8a6057e537af439d4c7997b',
    sourceSha256: 'd190b639248ff452627329d7ba45a587ff5a9e930ee7d4b0b5b608848357e6f8',
    clientFingerprint: '27d4d7f1a57d6491a4df24976ee8c26178090d38fcc81a8c08f38eea1503b5c9',
    appId: null,
  },
];
export type BaiduAppEnvelope =
  | { version: 1; appId: string; clientId: string; clientSecret: string }
  | {
      version: 2;
      provider: 'BAIDU';
      appId: null;
      clientId: string;
      clientSecret: string;
      clientProfileId: string;
      clientFingerprint: string;
      sourceCommit: string;
      sourceSha256: string;
    };
export type BaiduTokenEnvelope =
  | { version: 1; accessToken: string; refreshToken: string; expiresAt: number }
  | {
      version: 2;
      clientProfileId: string;
      clientFingerprint: string;
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
    };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('AUTH_CREDENTIAL_INVALID');
  return value as Record<string, unknown>;
}
function string(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.length || value.length > max)
    throw new Error('AUTH_CREDENTIAL_INVALID');
  return value;
}
export function decodeBaiduApp(
  appValue: unknown,
  trusted: readonly TrustedBaiduClientProfile[] = TRUSTED_BAIDU_CLIENT_PROFILES,
): BaiduAppEnvelope {
  const app = record(appValue);
  const clientId = string(app.clientId, 512),
    clientSecret = string(app.clientSecret, 512);
  if (app.version === 1)
    return { version: 1, clientId, clientSecret, appId: string(app.appId, 128) };
  if (app.version !== 2) throw new Error('AUTH_CLIENT_PROFILE_MISMATCH');
  const profile = trusted.find((p) => p.profileId === app.clientProfileId);
  if (!profile) throw new Error('AUTH_CLIENT_PROFILE_UNTRUSTED');
  const fingerprint = createHash('sha256')
    .update(clientId + '\0' + clientSecret)
    .digest('hex');
  if (
    app.provider !== 'BAIDU' ||
    app.appId !== profile.appId ||
    app.sourceCommit !== profile.sourceCommit ||
    app.sourceSha256 !== profile.sourceSha256 ||
    app.clientFingerprint !== profile.clientFingerprint ||
    fingerprint !== profile.clientFingerprint
  )
    throw new Error('AUTH_CLIENT_PROFILE_UNTRUSTED');
  return {
    version: 2,
    provider: 'BAIDU',
    appId: null,
    clientId,
    clientSecret,
    clientProfileId: profile.profileId,
    clientFingerprint: profile.clientFingerprint,
    sourceCommit: profile.sourceCommit,
    sourceSha256: profile.sourceSha256,
  };
}
export function decodeBaiduCredentialPair(
  appValue: unknown,
  tokenValue: unknown,
  trusted: readonly TrustedBaiduClientProfile[] = TRUSTED_BAIDU_CLIENT_PROFILES,
): { app: BaiduAppEnvelope; token: BaiduTokenEnvelope } {
  const app = decodeBaiduApp(appValue, trusted),
    token = record(tokenValue);
  const accessToken = string(token.accessToken, 4096),
    refreshToken = string(token.refreshToken, 4096);
  if (
    typeof token.expiresAt !== 'number' ||
    !Number.isSafeInteger(token.expiresAt) ||
    token.expiresAt <= 0
  )
    throw new Error('AUTH_TOKEN_FILE_INVALID');
  if (app.version === 1 && token.version === 1)
    return { app, token: { version: 1, accessToken, refreshToken, expiresAt: token.expiresAt } };
  if (
    app.version !== 2 ||
    token.version !== 2 ||
    token.clientProfileId !== app.clientProfileId ||
    token.clientFingerprint !== app.clientFingerprint
  )
    throw new Error('AUTH_CLIENT_PROFILE_MISMATCH');
  return {
    app,
    token: {
      version: 2,
      clientProfileId: app.clientProfileId,
      clientFingerprint: app.clientFingerprint,
      accessToken,
      refreshToken,
      expiresAt: token.expiresAt,
    },
  };
}
