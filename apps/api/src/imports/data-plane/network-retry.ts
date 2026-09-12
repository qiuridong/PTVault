import { DownloadTransportCodeSchema, type DownloadFailureDiagnostic } from '@ptvault/contracts';

/** Fixed diagnostics only; raw URLs, request text and nested errors stay private. */
export const SOURCE_NETWORK_RETRY_CODES = [
  'NETWORK_RESET',
  'NETWORK_CONNECT_TIMEOUT',
  'NETWORK_DNS_FAILED',
  'NETWORK_HEADERS_TIMEOUT',
  'NETWORK_BODY_TIMEOUT',
  'DLINK_EXPIRED',
  'SOURCE_RESPONSE_INVALID',
] as const;

const retryable = new Set<string>(SOURCE_NETWORK_RETRY_CODES);
export function isSourceNetworkRetryCode(code: string): boolean {
  return retryable.has(code);
}

export function networkFailureCode(error: unknown): string {
  const code = transportCode(error);
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return 'NETWORK_CONNECT_TIMEOUT';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'NETWORK_DNS_FAILED';
  if (code === 'UND_ERR_HEADERS_TIMEOUT') return 'NETWORK_HEADERS_TIMEOUT';
  if (code === 'UND_ERR_BODY_TIMEOUT') return 'NETWORK_BODY_TIMEOUT';
  return 'NETWORK_RESET';
}

function transportCode(error: unknown): DownloadFailureDiagnostic['transportCode'] {
  const queue = [{ value: error, depth: 0 }],
    seen = new Set<unknown>();
  for (let index = 0; index < queue.length && index < 16; index++) {
    const { value, depth } = queue[index]!;
    if (typeof value !== 'object' || value === null || seen.has(value) || depth >= 4) continue;
    seen.add(value);
    const parsed = DownloadTransportCodeSchema.safeParse('code' in value ? value.code : undefined);
    if (parsed.success) return parsed.data;
    if ('cause' in value) queue.push({ value: value.cause, depth: depth + 1 });
    if (value instanceof AggregateError)
      for (const nested of value.errors.slice(0, 4))
        queue.push({ value: nested, depth: depth + 1 });
  }
  return undefined;
}

export function networkFailureDiagnostic(
  error: unknown,
  phase: DownloadFailureDiagnostic['phase'],
): DownloadFailureDiagnostic {
  const code = transportCode(error);
  let kind: DownloadFailureDiagnostic['kind'] =
    phase === 'RESPONSE_BODY' ? 'BODY_READ_FAILED' : 'REQUEST_FAILED';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') kind = 'DNS_FAILED';
  else if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT')
    kind = phase === 'RESPONSE_BODY' ? 'BODY_TIMEOUT' : 'CONNECT_TIMEOUT';
  else if (code === 'UND_ERR_HEADERS_TIMEOUT') kind = 'HEADERS_TIMEOUT';
  else if (code === 'UND_ERR_BODY_TIMEOUT') kind = 'BODY_TIMEOUT';
  else if (code === 'ECONNRESET') kind = 'CONNECTION_RESET';
  else if (code === 'ECONNREFUSED') kind = 'CONNECTION_REFUSED';
  else if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') kind = 'NETWORK_UNREACHABLE';
  else if (code === 'EPIPE' || code === 'UND_ERR_SOCKET') kind = 'SOCKET_FAILED';
  else if (code !== undefined) kind = 'TLS_FAILED';
  return { version: 1, phase, kind, ...(code === undefined ? {} : { transportCode: code }) };
}
