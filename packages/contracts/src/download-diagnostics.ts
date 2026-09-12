import { z } from 'zod';

/** Closed vocabulary: no URL, hostname, headers, error prose or credentials. */
export const DownloadTransportCodeSchema = z.enum([
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'ETIMEDOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'UND_ERR_SOCKET',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
]);
const bytes = z.string().regex(/^(?:0|[1-9]\d{0,29})$/);
export const DownloadFailureDiagnosticSchema = z
  .object({
    version: z.literal(1),
    phase: z.enum(['REQUEST', 'RESPONSE_HEADERS', 'RESPONSE_BODY']),
    kind: z.enum([
      'DNS_FAILED',
      'CONNECT_TIMEOUT',
      'HEADERS_TIMEOUT',
      'BODY_TIMEOUT',
      'CONNECTION_RESET',
      'CONNECTION_REFUSED',
      'NETWORK_UNREACHABLE',
      'SOCKET_FAILED',
      'TLS_FAILED',
      'REQUEST_FAILED',
      'BODY_READ_FAILED',
      'BODY_MISSING',
      'BODY_EMPTY_CHUNK',
      'BODY_INCOMPLETE',
      'HTTP_SERVER_ERROR',
      'HTTP_RATE_LIMITED',
      'LEASE_REJECTED',
      'HTTP_UNEXPECTED_STATUS',
    ]),
    transportCode: DownloadTransportCodeSchema.optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    /** Bytes in this response, not a promise that every byte was checkpointed. */
    receivedBytes: bytes.optional(),
    expectedBytes: bytes.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const http = value.kind.startsWith('HTTP_') || value.kind === 'LEASE_REJECTED';
    if (http && (value.phase !== 'RESPONSE_HEADERS' || value.httpStatus === undefined))
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'HTTP evidence is required' });
    if (value.kind === 'HTTP_SERVER_ERROR' && (value.httpStatus ?? 0) < 500)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected a server error status' });
    if (value.kind === 'HTTP_RATE_LIMITED' && value.httpStatus !== 429)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected HTTP 429' });
    if (value.kind === 'LEASE_REJECTED' && value.httpStatus !== 401 && value.httpStatus !== 403)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Expected a rejected lease status',
      });
    if (
      (value.receivedBytes === undefined) !== (value.expectedBytes === undefined) ||
      (value.receivedBytes !== undefined && value.phase !== 'RESPONSE_BODY')
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Body byte evidence must be paired',
      });
    if (JSON.stringify(value).length > 300)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Diagnostic exceeds the event budget',
      });
  });

export type DownloadFailureDiagnostic = z.infer<typeof DownloadFailureDiagnosticSchema>;
