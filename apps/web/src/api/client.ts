import { z, type ZodType, type ZodTypeDef } from 'zod';

import { resolveDemoRequest } from '../demo/demoApi.js';

/**
 * A schema used to parse a response body.
 *
 * The input side is `unknown` rather than `T` because that is what it really is:
 * JSON off the wire. Pinning input to `T` would reject any schema whose parsed
 * shape differs from its accepted shape — `SessionSchema`, for one, defaults
 * `mode` so an older server that omits it still yields a usable session.
 */
type ResponseSchema<T> = ZodType<T, ZodTypeDef, unknown>;

const CsrfResponseSchema = z.object({
  token: z.string().min(1).max(512),
});

const SafeErrorSchema = z.object({
  error: z.string().trim().min(1).max(200).optional(),
  message: z.string().trim().min(1).max(200).optional(),
  code: z.string().trim().min(1).max(100).optional(),
});

export class ApiError extends Error {
  readonly status: number;
  /** Stable machine code when the server supplied one; never inferred from prose. */
  readonly code: string | undefined;
  /**
   * Optional schema-validated metadata for the one surface that requested it.
   *
   * This is never the raw response body. A caller must provide a strict schema
   * before anything is retained here, which lets a disconnect refusal carry its
   * bounded reference counts without promoting provider prose or credentials
   * into application state.
   */
  readonly details: unknown;

  constructor(status: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * The server answered, and the body does not match the contract this bundle holds.
 *
 * Kept distinct from `ApiError` because the two want opposite handling. A 5xx or
 * a dropped connection may well succeed on the next attempt; a body that fails
 * its schema will fail identically every time, so retrying it only spends the
 * backoff window looking exactly like a slow load. It is also a different
 * sentence from a 404: 404 means this API has no such route, while this means
 * the route is there and the two sides disagree about its shape — which is the
 * normal consequence of the web bundle and the API deploying down separate paths.
 */
export class ContractError extends Error {
  /** Request path, so a report names the endpoint that drifted. */
  readonly path: string;
  /** Field paths and issue codes only — never the received values. */
  readonly issues: string;

  constructor(path: string, issues: string) {
    super(`Response from ${path} did not match its contract (${issues})`);
    this.name = 'ContractError';
    this.path = path;
    this.issues = issues;
  }
}

/**
 * Field paths and issue codes, never the offending values.
 *
 * A Zod message can echo what it received; a response body can hold anything the
 * server put there. Reporting only the location and the kind of mismatch keeps
 * that out of an error string that ends up in a log or on screen.
 */
function summarizeIssues(error: z.ZodError): string {
  const issues = error.issues.slice(0, 3).map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${where}: ${issue.code}`;
  });
  if (error.issues.length > issues.length)
    issues.push(`+${error.issues.length - issues.length} more`);
  return issues.join('; ');
}

function parseBody<T>(path: string, schema: ResponseSchema<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw new ContractError(path, summarizeIssues(parsed.error));
}

async function errorFrom<T>(
  response: Response,
  detailsSchema?: ResponseSchema<T>,
): Promise<ApiError> {
  const fallback = `Request failed (${response.status})`;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return new ApiError(response.status, fallback);
  }

  try {
    const body: unknown = await response.json();
    const parsed = SafeErrorSchema.safeParse(body);
    if (!parsed.success) return new ApiError(response.status, fallback);
    // Fastify's `message` may contain the thrown exception while `error` is the
    // deliberately public summary. Prefer that summary whenever both exist so a
    // backend path, parameter or secret is not promoted into UI-visible text.
    const message = parsed.data.error ?? parsed.data.message ?? fallback;
    const details = detailsSchema?.safeParse(body);
    return new ApiError(
      response.status,
      message,
      parsed.data.code,
      details?.success === true ? details.data : undefined,
    );
  } catch {
    return new ApiError(response.status, fallback);
  }
}

async function credentialedFetch(path: string, init: RequestInit): Promise<Response> {
  const demoResponse = resolveDemoRequest(path, init);
  if (demoResponse) return demoResponse;
  return fetch(path, {
    ...init,
    credentials: 'include',
  });
}

async function successfulResponse(path: string, init: RequestInit): Promise<Response> {
  const response = await credentialedFetch(path, init);
  if (!response.ok) throw await errorFrom(response);
  return response;
}

export async function apiGet<T>(
  path: string,
  schema: ResponseSchema<T>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const response = await successfulResponse(path, { method: 'GET', ...options });
  return parseBody(path, schema, await response.json());
}

async function csrfToken(): Promise<string> {
  const response = await apiGet('/api/auth/csrf', CsrfResponseSchema);
  return response.token;
}

async function mutate(path: string, body?: unknown): Promise<Response> {
  const token = await csrfToken();
  const headers = new Headers({ 'x-csrf-token': token });
  const init: RequestInit = { method: 'POST', headers };
  if (body !== undefined) {
    headers.set('content-type', 'application/json');
    init.body = JSON.stringify(body);
  }
  return successfulResponse(path, init);
}

/**
 * Like `apiMutation`, but treats one status as a normal outcome rather than an error.
 *
 * The offload trigger answers 409 with the full per-target rejection list when
 * nothing could be queued. Turning that into a bare `ApiError` discards the only
 * explanation of *why* — which is how "already migrating" reached the operator
 * with no indication of which job was holding the torrent.
 */
export async function apiMutationAllowing<T>(
  path: string,
  body: unknown,
  schema: ResponseSchema<T>,
  allowedStatus: number,
): Promise<T> {
  const token = await csrfToken();
  const headers = new Headers({ 'x-csrf-token': token, 'content-type': 'application/json' });
  const response = await credentialedFetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok && response.status !== allowedStatus) throw await errorFrom(response);
  return parseBody(path, schema, await response.json());
}

/**
 * A key that makes one operator control action safe to send twice.
 *
 * The durable pause/resume routes refuse a request that carries none (400
 * `IDEMPOTENCY_KEY_REQUIRED`) and replay the recorded receipt when the same key
 * arrives again. That replay is the point: an operator who presses 「暂停」 and
 * loses the answer to a dropped connection must be able to press it again
 * without booking a second pause, so a caller mints one key per *intent* and
 * reuses it across retries rather than minting one per attempt.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // `randomUUID` is gated on a secure context; `getRandomValues` is not. 32 hex
  // characters sits inside the 8..200 the server's key schema accepts.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * A durable control mutation: an idempotency key is mandatory, and 202 is an answer.
 *
 * Two things separate it from `apiMutation`. The control routes reject a request
 * with no `idempotency-key` header outright, and they answer 202 for the case
 * that matters most — a pause that has been durably recorded but not yet
 * acknowledged by the handler. Treating that as a failure would discard the only
 * receipt saying what was asked and how far it got, and would report "暂停失败"
 * for a pause that is in fact in flight with bytes still moving.
 *
 * `method` defaults to POST, which is what the offload control routes are. The
 * transfer-settings route is a PATCH — it edits one durable record rather than
 * booking an action — and it wants the identical treatment otherwise: same CSRF
 * header, same mandatory idempotency key, same receipt replay. Sending it as a
 * POST would simply 404, and giving it a second near-copy of this function would
 * leave two places to keep the header set in.
 */
export async function apiControlMutation<T, E = unknown>(
  path: string,
  body: unknown,
  schema: ResponseSchema<T>,
  options: {
    idempotencyKey: string;
    allowedStatus?: readonly number[];
    /** Strict, secret-free metadata retained on `ApiError` for this surface. */
    errorSchema?: ResponseSchema<E>;
    method?: 'POST' | 'PATCH';
  },
): Promise<T> {
  const token = await csrfToken();
  const headers = new Headers({
    'x-csrf-token': token,
    'content-type': 'application/json',
    'idempotency-key': options.idempotencyKey,
  });
  const response = await credentialedFetch(path, {
    method: options.method ?? 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const allowed = options.allowedStatus ?? [];
  if (!response.ok && !allowed.includes(response.status)) {
    throw await errorFrom(response, options.errorSchema);
  }
  return parseBody(path, schema, await response.json());
}

export async function apiMutation<T>(
  path: string,
  body: unknown,
  schema: ResponseSchema<T>,
): Promise<T> {
  const response = await mutate(path, body);
  return parseBody(path, schema, await response.json());
}

export async function apiMutationVoid(path: string): Promise<void> {
  await mutate(path);
}
