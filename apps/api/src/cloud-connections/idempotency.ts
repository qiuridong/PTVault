import { createHash, randomUUID } from 'node:crypto';

import type { AppDatabase } from '../db/database.js';

export type CloudConnectionOperation =
  | 'START_OAUTH'
  | 'TEST'
  | 'EDIT'
  | 'REAUTHORIZE'
  | 'ENABLE'
  | 'DISABLE'
  | 'DISCONNECT'
  | 'PROVISION'
  | 'TAKEOVER_LEGACY';

export type CloudConnectionOperationScope = {
  adminId: string;
  operation: CloudConnectionOperation;
  resourceId: string;
  idempotencyKey: string;
  requestFingerprint: string;
};

export type CloudConnectionOperationHttpResponse = {
  statusCode: number;
  body: unknown;
};

export type CloudConnectionOperationExecution = {
  replayed: boolean;
  response: CloudConnectionOperationHttpResponse;
};

export type CloudConnectionOperationReceiptErrorCode =
  'IDEMPOTENCY_KEY_CONFLICT' | 'IDEMPOTENCY_OPERATION_IN_PROGRESS' | 'IDEMPOTENCY_RECEIPT_CORRUPT';

export class CloudConnectionOperationReceiptError extends Error {
  constructor(readonly code: CloudConnectionOperationReceiptErrorCode) {
    super(code);
    this.name = 'CloudConnectionOperationReceiptError';
  }
}

type ReceiptRow = {
  requestFingerprint: string;
  status: 'IN_PROGRESS' | 'COMPLETED';
  ownerToken: string;
  httpStatus: number | null;
  responseJson: string | null;
};

type ReceiptClaim =
  | { kind: 'CLAIMED'; ownerToken: string }
  | { kind: 'REPLAY'; response: CloudConnectionOperationHttpResponse }
  | { kind: 'WAIT' };

export type CloudConnectionOperationReceiptRepositoryOptions = {
  waitMs?: number;
  waitTimeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

const DEFAULT_WAIT_MS = 10;
const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
const MAX_SAFE_RESPONSE_BYTES = 65_536;

/**
 * Durable, administrator + operation + resource + key scoped operation receipt.
 *
 * Synchronous database mutations execute in the same IMMEDIATE transaction as
 * receipt reservation/completion. Async provider operations reserve first and
 * are never automatically taken over: after an owner crash, an unknown external
 * side effect remains fail-closed instead of being repeated.
 */
export class CloudConnectionOperationReceiptRepository {
  private readonly waitMs: number;
  private readonly waitTimeoutMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => number = () => Date.now(),
    options: CloudConnectionOperationReceiptRepositoryOptions = {},
  ) {
    this.waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    this.waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    if (this.waitMs <= 0 || this.waitTimeoutMs <= 0) {
      throw new Error('INVALID_CLOUD_OPERATION_RECEIPT_TIMING');
    }
  }

  executeSync(
    scope: CloudConnectionOperationScope,
    operation: () => CloudConnectionOperationHttpResponse,
  ): CloudConnectionOperationExecution {
    validateScope(scope);
    return this.db
      .transaction(() => {
        const claim = this.claim(scope);
        if (claim.kind === 'REPLAY') return { replayed: true, response: claim.response };
        if (claim.kind === 'WAIT') {
          throw new CloudConnectionOperationReceiptError('IDEMPOTENCY_OPERATION_IN_PROGRESS');
        }
        const response = validateResponse(operation());
        this.complete(scope, claim.ownerToken, response);
        return { replayed: false, response };
      })
      .immediate();
  }

  /** Read-only terminal lookup; never claims or revives an abandoned operation. */
  lookupCompleted(scope: CloudConnectionOperationScope): CloudConnectionOperationHttpResponse | null {
    validateScope(scope);
    const row = this.read(scope);
    if (row === null) return null;
    const existing = this.classifyExisting(row, scope.requestFingerprint);
    return existing.kind === 'REPLAY' ? existing.response : null;
  }

  async executeAsync<T = CloudConnectionOperationHttpResponse>(
    scope: CloudConnectionOperationScope,
    operation: () => Promise<T>,
    finalize?: (result: T) => CloudConnectionOperationHttpResponse,
    beforeOperation?: () => void,
  ): Promise<CloudConnectionOperationExecution> {
    validateScope(scope);
    const claim = this.db
      .transaction(() => {
        const claimed = this.claim(scope);
        if (claimed.kind === 'CLAIMED') beforeOperation?.();
        return claimed;
      })
      .immediate();
    if (claim.kind === 'REPLAY') return { replayed: true, response: claim.response };
    if (claim.kind === 'WAIT') {
      return { replayed: true, response: await this.waitForCompletion(scope) };
    }

    const result = await operation();
    const response = this.db
      .transaction(() => {
        const finalized = validateResponse(
          finalize ? finalize(result) : (result as CloudConnectionOperationHttpResponse),
        );
        this.complete(scope, claim.ownerToken, finalized);
        return finalized;
      })
      .immediate();
    return { replayed: false, response };
  }

  private claim(scope: CloudConnectionOperationScope): ReceiptClaim {
    const existing = this.read(scope);
    if (existing !== null) return this.classifyExisting(existing, scope.requestFingerprint);

    const ownerToken = randomUUID();
    const timestamp = this.now();
    try {
      this.db
        .prepare(
          `INSERT INTO cloud_connection_operation_receipts(
             admin_id, operation, resource_id, idempotency_key, request_fingerprint,
             status, owner_token, http_status, response_json, created_at, updated_at
           ) VALUES (
             @adminId, @operation, @resourceId, @idempotencyKey, @requestFingerprint,
             'IN_PROGRESS', @ownerToken, NULL, NULL, @timestamp, @timestamp
           )`,
        )
        .run({ ...scope, ownerToken, timestamp });
      return { kind: 'CLAIMED', ownerToken };
    } catch (error) {
      // Another SQLite connection may have won the composite primary key after
      // our initial read. Re-read and apply the same fingerprint/state rules.
      const raced = this.read(scope);
      if (raced !== null) return this.classifyExisting(raced, scope.requestFingerprint);
      throw error;
    }
  }

  private classifyExisting(existing: ReceiptRow, requestFingerprint: string): ReceiptClaim {
    if (existing.requestFingerprint !== requestFingerprint) {
      throw new CloudConnectionOperationReceiptError('IDEMPOTENCY_KEY_CONFLICT');
    }
    if (existing.status === 'IN_PROGRESS') return { kind: 'WAIT' };
    return { kind: 'REPLAY', response: parseCompleted(existing) };
  }

  private complete(
    scope: CloudConnectionOperationScope,
    ownerToken: string,
    response: CloudConnectionOperationHttpResponse,
  ): void {
    const responseJson = JSON.stringify(response.body);
    const completed = this.db
      .prepare(
        `UPDATE cloud_connection_operation_receipts
         SET status = 'COMPLETED', http_status = @httpStatus,
             response_json = @responseJson, updated_at = @updatedAt
         WHERE admin_id = @adminId AND operation = @operation
           AND resource_id = @resourceId AND idempotency_key = @idempotencyKey
           AND request_fingerprint = @requestFingerprint
           AND status = 'IN_PROGRESS' AND owner_token = @ownerToken`,
      )
      .run({
        ...scope,
        ownerToken,
        httpStatus: response.statusCode,
        responseJson,
        updatedAt: this.now(),
      });
    if (completed.changes !== 1) {
      throw new CloudConnectionOperationReceiptError('IDEMPOTENCY_RECEIPT_CORRUPT');
    }
  }

  private async waitForCompletion(
    scope: CloudConnectionOperationScope,
  ): Promise<CloudConnectionOperationHttpResponse> {
    const deadline = Date.now() + this.waitTimeoutMs;
    do {
      await this.sleep(this.waitMs);
      const row = this.read(scope);
      if (row === null || row.requestFingerprint !== scope.requestFingerprint) {
        throw new CloudConnectionOperationReceiptError('IDEMPOTENCY_RECEIPT_CORRUPT');
      }
      if (row.status === 'COMPLETED') return parseCompleted(row);
    } while (Date.now() < deadline);
    throw new CloudConnectionOperationReceiptError('IDEMPOTENCY_OPERATION_IN_PROGRESS');
  }

  private read(scope: CloudConnectionOperationScope): ReceiptRow | null {
    const row = this.db
      .prepare(
        `SELECT request_fingerprint AS requestFingerprint, status,
                owner_token AS ownerToken, http_status AS httpStatus,
                response_json AS responseJson
         FROM cloud_connection_operation_receipts
         WHERE admin_id = @adminId AND operation = @operation
           AND resource_id = @resourceId AND idempotency_key = @idempotencyKey`,
      )
      .get(scope) as ReceiptRow | undefined;
    return row ?? null;
  }
}

export function fingerprintCloudConnectionOperation(value: unknown): string {
  return createHash('sha256')
    .update(stableJson(withoutMfa(value)))
    .digest('hex');
}

/** TOTP proves the first execution; it is neither durable intent nor receipt identity. */
function withoutMfa(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutMfa);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'mfaCode')
      .map(([key, nested]) => [key, withoutMfa(nested)]),
  );
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('CLOUD_OPERATION_FINGERPRINT_INVALID');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function validateScope(scope: CloudConnectionOperationScope): void {
  if (
    scope.adminId.length === 0 ||
    scope.resourceId.length === 0 ||
    !/^[A-Za-z0-9._:-]{8,128}$/.test(scope.idempotencyKey) ||
    !/^[0-9a-f]{64}$/.test(scope.requestFingerprint)
  ) {
    throw new Error('INVALID_CLOUD_OPERATION_RECEIPT_SCOPE');
  }
}

function validateResponse(
  response: CloudConnectionOperationHttpResponse,
): CloudConnectionOperationHttpResponse {
  if (
    !Number.isInteger(response.statusCode) ||
    response.statusCode < 200 ||
    response.statusCode > 599
  ) {
    throw new CloudConnectionOperationReceiptError('IDEMPOTENCY_RECEIPT_CORRUPT');
  }
  const responseJson = JSON.stringify(response.body);
  if (
    responseJson === undefined ||
    Buffer.byteLength(responseJson, 'utf8') > MAX_SAFE_RESPONSE_BYTES
  ) {
    throw new CloudConnectionOperationReceiptError('IDEMPOTENCY_RECEIPT_CORRUPT');
  }
  return { statusCode: response.statusCode, body: JSON.parse(responseJson) as unknown };
}

function parseCompleted(row: ReceiptRow): CloudConnectionOperationHttpResponse {
  if (row.httpStatus === null || row.responseJson === null) {
    throw new CloudConnectionOperationReceiptError('IDEMPOTENCY_RECEIPT_CORRUPT');
  }
  try {
    return validateResponse({ statusCode: row.httpStatus, body: JSON.parse(row.responseJson) });
  } catch (error) {
    if (error instanceof CloudConnectionOperationReceiptError) throw error;
    throw new CloudConnectionOperationReceiptError('IDEMPOTENCY_RECEIPT_CORRUPT');
  }
}
