import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { decodeBaiduApp, type TrustedBaiduClientProfile } from '../imports/baidu-client-profile.js';
import { BaiduCloudProviderAdapter } from './baidu-provider.js';
import { BaiduDeviceTransport } from './baidu-device-transport.js';
import type { OAuthConnectionCredential } from './secrets.js';

/** A shipped public application profile, not an environment-imported user credential. */
export function loadBaiduClientRuntime(
  filename: string,
  options: {
    trusted?: readonly TrustedBaiduClientProfile[];
    fetch?: typeof fetch;
    now?: () => number;
  } = {},
) {
  const entry = lstatSync(filename);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 65536)
    throw new Error('AUTH_CLIENT_PROFILE_UNTRUSTED');
  const fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let value: unknown;
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.dev !== entry.dev ||
      stat.ino !== entry.ino ||
      stat.size < 1 ||
      stat.size > 65536
    )
      throw new Error('AUTH_CLIENT_PROFILE_UNTRUSTED');
    const bytes = Buffer.alloc(65537);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (read === 0) break;
      count += read;
    }
    if (count !== stat.size || count > 65536) throw new Error('AUTH_CLIENT_PROFILE_UNTRUSTED');
    try {
      value = JSON.parse(bytes.subarray(0, count).toString('utf8'));
    } catch {
      throw new Error('AUTH_CLIENT_PROFILE_UNTRUSTED');
    }
  } finally {
    closeSync(fd);
  }
  const app = decodeBaiduApp(value, options.trusted);
  if (app.version !== 2) throw new Error('AUTH_CLIENT_PROFILE_UNTRUSTED');
  const runtimeOptions = {
    clientId: app.clientId,
    clientSecret: app.clientSecret,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
  const provider = new BaiduCloudProviderAdapter({ ...runtimeOptions, appId: null });
  const profile = { id: app.clientProfileId, fingerprint: app.clientFingerprint };
  return {
    provider,
    profile,
    transport: new BaiduDeviceTransport(runtimeOptions),
    resolve: (credential: OAuthConnectionCredential): BaiduCloudProviderAdapter | undefined =>
      credential.provider === 'BAIDU' &&
      credential.clientId === app.clientId &&
      credential.baiduClientProfile?.id === profile.id &&
      credential.baiduClientProfile.fingerprint === profile.fingerprint
        ? provider
        : undefined,
  };
}
