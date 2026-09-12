/** Official device-code endpoint. No redirect, external relay or browser token delivery. */
export type BaiduDeviceGrant = {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  intervalMs: number;
};
export type BaiduDeviceToken = { accessToken: string; refreshToken: string; expiresAt: number };
export type BaiduDevicePoll =
  | { status: 'PENDING' | 'SLOW_DOWN' | 'DENIED' | 'EXPIRED' }
  | { status: 'AUTHORIZED'; token: BaiduDeviceToken };
export class BaiduDeviceError extends Error {
  constructor(
    readonly code:
      | 'DEVICE_NETWORK_RETRYABLE'
      | 'DEVICE_RESPONSE_INVALID'
      | 'DEVICE_SCOPE_INSUFFICIENT'
      | 'DEVICE_REJECTED',
  ) {
    super(code);
    this.name = 'BaiduDeviceError';
  }
}
export class BaiduDeviceTransport {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  constructor(
    private readonly options: {
      clientId: string;
      clientSecret: string;
      fetch?: typeof fetch;
      now?: () => number;
    },
  ) {
    bounded(options.clientId, 512);
    bounded(options.clientSecret, 512);
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }
  async begin(): Promise<BaiduDeviceGrant> {
    const answer = await this.get('/oauth/2.0/device/code', {
      response_type: 'device_code',
      client_id: this.options.clientId,
      scope: 'basic,netdisk',
    });
    if (answer.error !== undefined) throw new BaiduDeviceError('DEVICE_REJECTED');
    const verificationUrl = bounded(answer.verification_url, 256);
    if (!/^https:\/\/openapi\.baidu\.com(?::443)?\/device\/?$/.test(verificationUrl))
      throw new BaiduDeviceError('DEVICE_RESPONSE_INVALID');
    const userCode = bounded(answer.user_code, 64);
    if (!/^[A-Za-z0-9-]+$/.test(userCode)) throw new BaiduDeviceError('DEVICE_RESPONSE_INVALID');
    return {
      deviceCode: bounded(answer.device_code, 4096),
      userCode,
      verificationUrl,
      expiresAt: this.now() + Math.min(integer(answer.expires_in, 86400), 1800) * 1000,
      intervalMs: Math.max(5, integer(answer.interval ?? 5, 3600)) * 1000,
    };
  }
  async poll(deviceCode: string): Promise<BaiduDevicePoll> {
    const answer = await this.get('/oauth/2.0/token', {
      grant_type: 'device_token',
      code: bounded(deviceCode, 4096),
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
    });
    if (answer.error === 'authorization_pending') return { status: 'PENDING' };
    if (answer.error === 'slow_down') return { status: 'SLOW_DOWN' };
    if (answer.error === 'access_denied' || answer.error === 'authorization_declined')
      return { status: 'DENIED' };
    if (answer.error === 'expired_token' || answer.error === 'expired_device_code')
      return { status: 'EXPIRED' };
    if (answer.error !== undefined) throw new BaiduDeviceError('DEVICE_REJECTED');
    const scopes = bounded(answer.scope, 4096).split(/[\s,]+/);
    if (!scopes.includes('basic') || !scopes.includes('netdisk'))
      throw new BaiduDeviceError('DEVICE_SCOPE_INSUFFICIENT');
    return {
      status: 'AUTHORIZED',
      token: {
        accessToken: bounded(answer.access_token, 4096),
        refreshToken: bounded(answer.refresh_token, 4096),
        expiresAt: this.now() + integer(answer.expires_in, 366 * 86400) * 1000,
      },
    };
  }
  private async get(
    path: string,
    params: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const url = new URL(path, 'https://openapi.baidu.com');
    url.search = new URLSearchParams(params).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.fetcher(url, {
        method: 'GET',
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (response.status === 429) {
        await response.body?.cancel();
        return { error: 'slow_down' };
      }
      if (response.status >= 500) throw new BaiduDeviceError('DEVICE_NETWORK_RETRYABLE');
      if (response.status >= 300 && response.status < 400)
        throw new BaiduDeviceError('DEVICE_RESPONSE_INVALID');
      if (!response.body) throw new BaiduDeviceError('DEVICE_RESPONSE_INVALID');
      reader = response.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 65536) throw new BaiduDeviceError('DEVICE_RESPONSE_INVALID');
        chunks.push(next.value);
      }
      let result: unknown;
      try {
        result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new BaiduDeviceError('DEVICE_RESPONSE_INVALID');
      }
      if (!result || typeof result !== 'object' || Array.isArray(result))
        throw new BaiduDeviceError('DEVICE_RESPONSE_INVALID');
      const record = result as Record<string, unknown>;
      if (!response.ok && record.error === undefined)
        throw new BaiduDeviceError('DEVICE_RESPONSE_INVALID');
      return record;
    } catch (error) {
      if (error instanceof BaiduDeviceError) throw error;
      throw new BaiduDeviceError('DEVICE_NETWORK_RETRYABLE');
    } finally {
      clearTimeout(timer);
      controller.abort();
      await reader?.cancel().catch(() => undefined);
    }
  }
}
function bounded(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max)
    throw new BaiduDeviceError('DEVICE_RESPONSE_INVALID');
  return value;
}
function integer(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max)
    throw new BaiduDeviceError('DEVICE_RESPONSE_INVALID');
  return value;
}
