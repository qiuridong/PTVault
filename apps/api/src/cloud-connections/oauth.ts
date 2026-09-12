import { createHash, randomUUID } from 'node:crypto';

import {
  CloudOAuthFlowSchema,
  CloudOAuthReturnToSchema,
  CloudProviderSchema,
  type CloudConnectionCapability,
  type CloudConnectionProvisionState,
  type CloudOAuthFailureCode,
  type CloudOAuthFlow,
  type CloudOAuthReturnTo,
  type CloudOAuthStartResponse,
  type CloudProvider,
} from '@ptvault/contracts';

import { digestToken, newOpaqueToken as secureOpaqueToken } from '../core/crypto.js';
import type { AppDatabase } from '../db/database.js';
import { type CloudConnectionRepository, type OAuthConnectionMaterial } from './repository.js';
import { type EncryptedSecretRepository, type OAuthFlowVerifierRef, type OAuthConnectionCredential } from './secrets.js';

export type OAuthTokenExchangeResult = OAuthConnectionMaterial & {
  clientId: string;
  accessToken: string;
  refreshToken: string;
};

export interface OAuthProviderAdapter {
  readonly provider: CloudProvider;
  readonly clientId: string;
  readonly usesPkce: boolean;
  createAuthorizationUrl(input: {
    state: string;
    redirectUri: string;
    codeChallenge: string | null;
  }): string;
  exchangeCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string | null;
  }): Promise<OAuthTokenExchangeResult>;
}

export type CloudConnectionErrorCode =
  | 'NOT_PROVISIONED'
  | 'FLOW_NOT_FOUND'
  | 'STATE_INVALID'
  | 'FLOW_EXPIRED'
  | 'FLOW_ALREADY_USED'
  | 'PROVIDER_MISMATCH'
  | 'SESSION_MISMATCH'
  | 'REDIRECT_URI_MISMATCH'
  | 'TOKEN_EXCHANGE_FAILED'
  | 'IDENTITY_MISMATCH'
  | 'USER_CANCELLED'
  | 'CONNECTION_NOT_FOUND'
  | 'CONNECTION_REVISION_CONFLICT'
  | 'CONNECTION_AUTH_STATE_INVALID'
  | 'CONNECTION_TEST_FAILED'
  | 'CONNECTION_READ_ONLY'
  | 'MFA_STEP_UP_FAILED';

export class CloudConnectionError extends Error {
  constructor(
    readonly code: CloudConnectionErrorCode,
    readonly statusCode: number,
  ) {
    super(code);
    this.name = 'CloudConnectionError';
  }
}

type OAuthFlowRow = {
  id: string;
  provider: CloudProvider;
  stateHash: string;
  pkceVerifierRef: string | null;
  adminId: string;
  sessionFingerprint: string;
  redirectUri: string;
  returnTo: CloudOAuthReturnTo;
  expiresAt: number;
  usedAt: number | null;
  completedConnectionId: string | null;
  targetConnectionId: string | null;
  targetConnectionRevision: number | null;
  status: CloudOAuthFlow['status'];
  failureCode: CloudOAuthFailureCode | null;
  createdAt: number;
  processingDeadlineAt: number | null;
};

const FLOW_SELECT = `
  SELECT id, provider, state_hash AS stateHash,
         pkce_verifier_ref AS pkceVerifierRef, admin_id AS adminId,
         session_fingerprint AS sessionFingerprint, redirect_uri AS redirectUri,
         return_to AS returnTo, expires_at AS expiresAt, used_at AS usedAt,
         completed_connection_id AS completedConnectionId,
         target_connection_id AS targetConnectionId,
         target_connection_revision AS targetConnectionRevision,
         status, failure_code AS failureCode, created_at AS createdAt,
         processing_deadline_at AS processingDeadlineAt
  FROM oauth_flows`;

function status(row: OAuthFlowRow): CloudOAuthFlow {
  return CloudOAuthFlowSchema.parse({
    provider: row.provider,
    flowId: row.id,
    expiresAt: row.expiresAt,
    status: row.status,
    returnTo: row.returnTo,
    completedConnectionId: row.completedConnectionId,
    failure: row.failureCode,
  });
}

export class OAuthFlowRepository {
  constructor(private readonly db: AppDatabase) {}

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation).immediate();
  }

  create(input: {
    id: string;
    provider: CloudProvider;
    stateHash: string;
    pkceVerifierRef: OAuthFlowVerifierRef | null;
    adminId: string;
    sessionFingerprint: string;
    redirectUri: string;
    returnTo: CloudOAuthReturnTo;
    expiresAt: number;
    targetConnectionId?: string | null;
    targetConnectionRevision?: number | null;
    createdAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO oauth_flows(
           id, provider, state_hash, pkce_verifier_ref, admin_id,
           session_fingerprint, redirect_uri, return_to, expires_at,
           used_at, completed_connection_id, target_connection_id,
           target_connection_revision, status, failure_code, created_at
         ) VALUES (
           @id, @provider, @stateHash, @pkceVerifierRef, @adminId,
           @sessionFingerprint, @redirectUri, @returnTo, @expiresAt,
           NULL, NULL, @targetConnectionId, @targetConnectionRevision,
           'PENDING', NULL, @createdAt
         )`,
      )
      .run({
        ...input,
        pkceVerifierRef: input.pkceVerifierRef?.id ?? null,
        targetConnectionId: input.targetConnectionId ?? null,
        targetConnectionRevision: input.targetConnectionRevision ?? null,
      });
  }

  assertStateProvider(stateHash: string, provider: CloudProvider): void {
    const row = this.db
      .prepare('SELECT provider FROM oauth_flows WHERE state_hash = ?')
      .get(stateHash) as { provider: CloudProvider } | undefined;
    if (!row) throw new CloudConnectionError('STATE_INVALID', 400);
    if (row.provider !== provider) throw new CloudConnectionError('PROVIDER_MISMATCH', 400);
  }

  callbackAdminId(stateHash: string, sessionFingerprint: string): string {
    const row = this.db
      .prepare(
        `SELECT admin_id AS adminId, session_fingerprint AS sessionFingerprint
         FROM oauth_flows WHERE state_hash = ?`,
      )
      .get(stateHash) as { adminId: string; sessionFingerprint: string } | undefined;
    if (!row) throw new CloudConnectionError('STATE_INVALID', 400);
    if (row.sessionFingerprint !== sessionFingerprint) {
      throw new CloudConnectionError('SESSION_MISMATCH', 403);
    }
    return row.adminId;
  }

  claim(input: {
    stateHash: string;
    provider: CloudProvider;
    adminId: string;
    sessionFingerprint: string;
    redirectUri: string;
    now: number;
    processingDeadlineAt: number;
  }): OAuthFlowRow {
    const result = this.transaction<
      { row: OAuthFlowRow; error?: never } | { row?: never; error: CloudConnectionError }
    >(() => {
      const row = this.db.prepare(`${FLOW_SELECT} WHERE state_hash = ?`).get(input.stateHash) as
        OAuthFlowRow | undefined;
      if (!row) return { error: new CloudConnectionError('STATE_INVALID', 400) };
      if (row.provider !== input.provider) {
        return { error: new CloudConnectionError('PROVIDER_MISMATCH', 400) };
      }
      if (row.adminId !== input.adminId || row.sessionFingerprint !== input.sessionFingerprint) {
        return { error: new CloudConnectionError('SESSION_MISMATCH', 403) };
      }
      if (row.redirectUri !== input.redirectUri) {
        return { error: new CloudConnectionError('REDIRECT_URI_MISMATCH', 400) };
      }
      if (row.status === 'EXPIRED') {
        return { error: new CloudConnectionError('FLOW_EXPIRED', 410) };
      }
      if (row.status !== 'PENDING' || row.usedAt !== null) {
        return { error: new CloudConnectionError('FLOW_ALREADY_USED', 410) };
      }
      if (input.now >= row.expiresAt) {
        this.db
          .prepare(
            `UPDATE oauth_flows
             SET status = 'EXPIRED', failure_code = 'FLOW_EXPIRED'
             WHERE id = ? AND status = 'PENDING'`,
          )
          .run(row.id);
        return { error: new CloudConnectionError('FLOW_EXPIRED', 410) };
      }
      const claimed = this.db
        .prepare(
          `UPDATE oauth_flows
           SET status = 'PROCESSING', used_at = ?, processing_deadline_at = ?
           WHERE id = ? AND status = 'PENDING' AND used_at IS NULL`,
        )
        .run(input.now, input.processingDeadlineAt, row.id);
      if (claimed.changes !== 1) {
        return { error: new CloudConnectionError('FLOW_ALREADY_USED', 410) };
      }
      return { row: this.getRow(row.id) };
    });
    if (result.error) throw result.error;
    return result.row;
  }

  markCompleted(
    id: string,
    connectionId: string,
  ): {
    flow: CloudOAuthFlow;
    verifierRef: OAuthFlowVerifierRef | null;
  } {
    const before = this.getRow(id);
    const result = this.db
      .prepare(
        `UPDATE oauth_flows
         SET status = 'COMPLETED', completed_connection_id = ?, failure_code = NULL,
             pkce_verifier_ref = NULL, processing_deadline_at = NULL
         WHERE id = ? AND status = 'PROCESSING'`,
      )
      .run(connectionId, id);
    if (result.changes !== 1) throw new CloudConnectionError('FLOW_ALREADY_USED', 410);
    return { flow: status(this.getRow(id)), verifierRef: verifierRef(before) };
  }

  markFailed(
    id: string,
    failure: Exclude<CloudOAuthFailureCode, 'FLOW_EXPIRED'>,
  ): {
    flow: CloudOAuthFlow;
    verifierRef: OAuthFlowVerifierRef | null;
  } {
    const before = this.getRow(id);
    const result = this.db
      .prepare(
        `UPDATE oauth_flows
         SET status = 'FAILED', completed_connection_id = NULL, failure_code = ?,
             pkce_verifier_ref = NULL, processing_deadline_at = NULL
         WHERE id = ? AND status = 'PROCESSING'`,
      )
      .run(failure, id);
    if (result.changes !== 1) throw new CloudConnectionError('FLOW_ALREADY_USED', 410);
    return { flow: status(this.getRow(id)), verifierRef: verifierRef(before) };
  }

  reapTimedOut(now: number): OAuthFlowVerifierRef[] {
    const expired = this.db
      .prepare(
        `${FLOW_SELECT}
         WHERE (status = 'PENDING' AND expires_at <= ?)
            OR (status = 'PROCESSING' AND processing_deadline_at IS NOT NULL
                AND processing_deadline_at <= ?)
         ORDER BY created_at, id`,
      )
      .all(now, now) as OAuthFlowRow[];
    const update = this.db.prepare(
      `UPDATE oauth_flows
       SET status = 'EXPIRED', failure_code = 'FLOW_EXPIRED',
           used_at = COALESCE(used_at, ?), pkce_verifier_ref = NULL,
           processing_deadline_at = NULL
       WHERE id = ? AND status IN ('PENDING', 'PROCESSING')`,
    );
    const refs: OAuthFlowVerifierRef[] = [];
    for (const row of expired) {
      if (update.run(now, row.id).changes !== 1) continue;
      const ref = verifierRef(row);
      if (ref !== null) refs.push(ref);
    }
    return refs;
  }

  poll(
    id: string,
    adminId: string,
    sessionFingerprint: string | undefined,
    now: number,
  ): CloudOAuthFlow {
    const result = this.transaction<
      { row: OAuthFlowRow; error?: never } | { row?: never; error: CloudConnectionError }
    >(() => {
      const row = this.getRowOrUndefined(id);
      if (!row) return { error: new CloudConnectionError('FLOW_NOT_FOUND', 404) };
      if (
        row.adminId !== adminId ||
        (sessionFingerprint !== undefined && row.sessionFingerprint !== sessionFingerprint)
      ) {
        return { error: new CloudConnectionError('SESSION_MISMATCH', 403) };
      }
      if (row.status === 'PENDING' && now >= row.expiresAt) {
        this.db
          .prepare(
            `UPDATE oauth_flows
             SET status = 'EXPIRED', failure_code = 'FLOW_EXPIRED'
             WHERE id = ? AND status = 'PENDING'`,
          )
          .run(id);
        return { row: this.getRow(id) };
      }
      return { row };
    });
    if (result.error) throw result.error;
    return status(result.row);
  }

  private getRow(id: string): OAuthFlowRow {
    const row = this.getRowOrUndefined(id);
    if (!row) throw new CloudConnectionError('FLOW_NOT_FOUND', 404);
    return row;
  }

  private getRowOrUndefined(id: string): OAuthFlowRow | undefined {
    return this.db.prepare(`${FLOW_SELECT} WHERE id = ?`).get(id) as OAuthFlowRow | undefined;
  }
}

export type OAuthFlowServiceOptions = {
  flows: OAuthFlowRepository;
  connections: CloudConnectionRepository;
  secrets: EncryptedSecretRepository;
  providers: ReadonlyMap<CloudProvider, OAuthProviderAdapter>;
  now?: () => number;
  newId?: () => string;
  newOpaqueToken?: () => string;
  flowTtlMs?: number;
  processingTimeoutMs?: number;
  callbackOrigins?: ReadonlyMap<CloudProvider, string>;
  onConnectionCredentialsChanged?: (connectionId: string) => Promise<void>;
};

export class OAuthFlowService {
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly newOpaqueToken: () => string;
  private readonly flowTtlMs: number;
  private readonly processingTimeoutMs: number;
  private readonly callbackOrigins: ReadonlyMap<CloudProvider, string>;

  constructor(private readonly options: OAuthFlowServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? randomUUID;
    this.newOpaqueToken = options.newOpaqueToken ?? secureOpaqueToken;
    this.flowTtlMs = options.flowTtlMs ?? 300_000;
    this.processingTimeoutMs = options.processingTimeoutMs ?? 300_000;
    this.callbackOrigins = options.callbackOrigins ?? new Map();
    if (
      this.flowTtlMs <= 0 ||
      this.flowTtlMs > 600_000 ||
      this.processingTimeoutMs <= 0 ||
      this.processingTimeoutMs > 600_000
    ) {
      throw new Error('INVALID_OAUTH_FLOW_TTL');
    }
    for (const provider of options.providers.keys()) {
      oauthRedirectUri(provider, this.callbackOrigin(provider));
    }
  }

  start(input: {
    provider: CloudProvider;
    returnTo: CloudOAuthReturnTo;
    adminId: string;
    sessionFingerprint: string;
  }): CloudOAuthStartResponse {
    return this.startAuthority({
      ...input,
      targetConnectionId: null,
      targetConnectionRevision: null,
    });
  }

  startReauthorization(input: {
    connectionId: string;
    expectedRevision: number;
    returnTo: CloudOAuthReturnTo;
    adminId: string;
    sessionFingerprint: string;
  }): CloudOAuthStartResponse {
    let authority;
    try {
      authority = this.options.connections.authority(input.connectionId);
    } catch {
      throw new CloudConnectionError('CONNECTION_NOT_FOUND', 404);
    }
    if (authority.revision !== input.expectedRevision) {
      throw new CloudConnectionError('CONNECTION_REVISION_CONFLICT', 409);
    }
    if (authority.authState === 'DISCONNECTED' || authority.secretRef === null) {
      throw new CloudConnectionError('CONNECTION_AUTH_STATE_INVALID', 409);
    }
    if (this.options.connections.get(authority.id).readOnly)
      throw new CloudConnectionError('CONNECTION_READ_ONLY', 409);
    return this.startAuthority({
      provider: authority.provider,
      returnTo: input.returnTo,
      adminId: input.adminId,
      sessionFingerprint: input.sessionFingerprint,
      targetConnectionId: authority.id,
      targetConnectionRevision: authority.revision,
    });
  }

  async callback(input: {
    provider: CloudProvider;
    state: string;
    code?: string;
    error?: 'access_denied';
    adminId: string;
    sessionFingerprint: string;
    redirectUri: string;
  }): Promise<CloudOAuthFlow> {
    const provider = CloudProviderSchema.parse(input.provider);
    const stateHash = digestToken(input.state);
    const timestamp = this.now();
    this.reapTimedOut(timestamp);
    this.options.flows.assertStateProvider(stateHash, provider);
    const adapter = this.adapter(provider);
    const row = this.options.flows.claim({
      stateHash,
      provider,
      adminId: input.adminId,
      sessionFingerprint: input.sessionFingerprint,
      redirectUri: input.redirectUri,
      now: timestamp,
      processingDeadlineAt: timestamp + this.processingTimeoutMs,
    });
    if (input.error === 'access_denied') {
      return this.finishFailed(row.id, 'USER_CANCELLED');
    }
    if (!input.code) {
      return this.finishFailed(row.id, 'TOKEN_EXCHANGE_FAILED');
    }

    let codeVerifier: string | null = null;
    try {
      if (row.pkceVerifierRef !== null) {
        codeVerifier = this.options.secrets.readOAuthFlowVerifier({
          id: row.pkceVerifierRef,
          kind: 'OAUTH_FLOW_VERIFIER',
        });
      }
      const exchanged = await adapter.exchangeCode({
        code: input.code,
        redirectUri: row.redirectUri,
        codeVerifier,
      });
      this.validateExchange(adapter, exchanged);
      const completed = this.completeExchange(row, exchanged);
      if (completed.completedConnectionId !== null) {
        // OAuth success remains success if runtime materialization fails. Its
        // durable pending stamp denies storage work and exposes a retry action.
        await this.options
          .onConnectionCredentialsChanged?.(completed.completedConnectionId)
          .catch(() => undefined);
      }
      return completed;
    } catch (error) {
      if (error instanceof CloudConnectionError && error.code === 'IDENTITY_MISMATCH') {
        return this.finishFailed(row.id, 'IDENTITY_MISMATCH');
      }
      if (isIdentityConstraint(error)) {
        return this.finishFailed(row.id, 'IDENTITY_MISMATCH');
      }
      if (error instanceof CloudConnectionError && error.code === 'FLOW_ALREADY_USED') {
        throw error;
      }
      return this.finishFailed(row.id, 'TOKEN_EXCHANGE_FAILED');
    }
  }

  poll(flowId: string, adminId: string, sessionFingerprint?: string): CloudOAuthFlow {
    const timestamp = this.now();
    this.reapTimedOut(timestamp);
    return this.options.flows.poll(flowId, adminId, sessionFingerprint, timestamp);
  }

  redirectUri(provider: CloudProvider): string {
    return oauthRedirectUri(provider, this.callbackOrigin(provider));
  }

  callbackAdminId(state: string, sessionFingerprint: string): string {
    return this.options.flows.callbackAdminId(digestToken(state), sessionFingerprint);
  }

  private startAuthority(input: {
    provider: CloudProvider;
    returnTo: CloudOAuthReturnTo;
    adminId: string;
    sessionFingerprint: string;
    targetConnectionId: string | null;
    targetConnectionRevision: number | null;
  }): CloudOAuthStartResponse {
    const provider = CloudProviderSchema.parse(input.provider);
    const returnTo = CloudOAuthReturnToSchema.parse(input.returnTo);
    if (!/^[0-9a-f]{64}$/.test(input.sessionFingerprint)) {
      throw new CloudConnectionError('SESSION_MISMATCH', 403);
    }
    const adapter = this.adapter(provider);
    const createdAt = this.now();
    this.reapTimedOut(createdAt);
    const state = this.newOpaqueToken();
    const verifier = adapter.usesPkce ? this.newOpaqueToken() : null;
    const codeChallenge =
      verifier === null ? null : createHash('sha256').update(verifier).digest('base64url');
    const redirectUri = this.redirectUri(provider);
    const authorizationUrl = adapter.createAuthorizationUrl({ state, redirectUri, codeChallenge });
    assertAuthorizationUrl(authorizationUrl, { state, redirectUri, codeChallenge, verifier });
    const flowId = this.newId();
    this.options.flows.transaction(() => {
      const verifierRef =
        verifier === null ? null : this.options.secrets.createOAuthFlowVerifier(verifier);
      this.options.flows.create({
        id: flowId,
        provider,
        stateHash: digestToken(state),
        pkceVerifierRef: verifierRef,
        adminId: input.adminId,
        sessionFingerprint: input.sessionFingerprint,
        redirectUri,
        returnTo,
        expiresAt: createdAt + this.flowTtlMs,
        targetConnectionId: input.targetConnectionId,
        targetConnectionRevision: input.targetConnectionRevision,
        createdAt,
      });
    });
    return {
      provider,
      flowId,
      authorizationUrl,
      expiresAt: createdAt + this.flowTtlMs,
      status: 'PENDING',
      returnTo,
    };
  }

  private completeExchange(row: OAuthFlowRow, exchanged: OAuthTokenExchangeResult): CloudOAuthFlow {
    return this.options.connections.transaction(() => {
      const connectionId = saveOAuthConnection({ connections: this.options.connections, secrets: this.options.secrets, exchanged, target: row.targetConnectionId === null || row.targetConnectionRevision === null ? null : { id: row.targetConnectionId, revision: row.targetConnectionRevision }, now: this.now, newId: this.newId });
      const completed = this.options.flows.markCompleted(row.id, connectionId);
      if (completed.verifierRef !== null) {
        this.options.secrets.deleteOAuthFlowVerifier(completed.verifierRef);
      }
      return completed.flow;
    });
  }

  private finishFailed(
    flowId: string,
    failure: Exclude<CloudOAuthFailureCode, 'FLOW_EXPIRED'>,
  ): CloudOAuthFlow {
    return this.options.flows.transaction(() => {
      const failed = this.options.flows.markFailed(flowId, failure);
      if (failed.verifierRef !== null) {
        this.options.secrets.deleteOAuthFlowVerifier(failed.verifierRef);
      }
      return failed.flow;
    });
  }

  private reapTimedOut(timestamp: number = this.now()): void {
    this.options.flows.transaction(() => {
      const refs = this.options.flows.reapTimedOut(timestamp);
      for (const ref of refs) this.options.secrets.deleteOAuthFlowVerifier(ref);
    });
  }

  private callbackOrigin(provider: CloudProvider): string {
    const origin = this.callbackOrigins.get(provider);
    if (origin === undefined) throw new CloudConnectionError('NOT_PROVISIONED', 503);
    return origin;
  }

  private validateExchange(
    adapter: OAuthProviderAdapter,
    exchanged: OAuthTokenExchangeResult,
  ): void {
    if (exchanged.provider !== adapter.provider || exchanged.clientId !== adapter.clientId) {
      throw new CloudConnectionError('IDENTITY_MISMATCH', 409);
    }
    CloudProviderSchema.parse(exchanged.provider);
    for (const capability of exchanged.capabilities) {
      // The contracts package is the server capability allowlist.
      if (!isCapability(capability)) throw new CloudConnectionError('TOKEN_EXCHANGE_FAILED', 502);
    }
    if (!isProvisionState(exchanged.provisionState)) {
      throw new CloudConnectionError('TOKEN_EXCHANGE_FAILED', 502);
    }
    // Wave 1 has no OneDrive materialization/escrow/readback worker. OAuth alone
    // must therefore never manufacture a READY connection.
    if (exchanged.provisionState === 'READY') {
      throw new CloudConnectionError('TOKEN_EXCHANGE_FAILED', 502);
    }
  }

  private adapter(provider: CloudProvider): OAuthProviderAdapter {
    const adapter = this.options.providers.get(provider);
    if (!adapter || adapter.provider !== provider) {
      throw new CloudConnectionError('NOT_PROVISIONED', 503);
    }
    return adapter;
  }
}

/** Shared transactional credential commit for redirect and device authorization. */
export function saveOAuthConnection(options: {
  connections: CloudConnectionRepository; secrets: EncryptedSecretRepository;
  exchanged: OAuthTokenExchangeResult; target: { id: string; revision: number } | null;
  baiduClientProfile?: OAuthConnectionCredential['baiduClientProfile']; now?: () => number; newId?: () => string;
}): string {
  const { connections, secrets, exchanged, target } = options;
  const at = (options.now ?? Date.now)();
  return connections.transaction(() => {
    const secretRef = secrets.createOAuthConnectionCredential({
      provider: exchanged.provider, clientId: exchanged.clientId, externalAccountId: exchanged.externalAccountId,
      accessToken: exchanged.accessToken, refreshToken: exchanged.refreshToken, accessExpiresAt: exchanged.accessExpiresAt, scopes: exchanged.scopes,
      ...(options.baiduClientProfile === undefined ? {} : { baiduClientProfile: options.baiduClientProfile }),
    });
    if (target === null) {
      const tombstone = connections.authorityByIdentity(exchanged.provider, exchanged.externalAccountId);
      if (tombstone === null) {
        const id = (options.newId ?? randomUUID)();
        connections.insertOAuthConnection({ id, label: exchanged.principalMasked, secretRef, material: exchanged, at });
        return id;
      }
      if (tombstone.authState !== 'DISCONNECTED' || tombstone.secretRef !== null) throw new CloudConnectionError('IDENTITY_MISMATCH', 409);
      connections.reviveDisconnectedOAuthConnection({ id: tombstone.id, expectedRevision: tombstone.revision, newSecretRef: secretRef, material: exchanged, at });
      return tombstone.id;
    }
    const authority = connections.authority(target.id);
    if (authority.provider !== exchanged.provider || authority.externalAccountId !== exchanged.externalAccountId || authority.secretRef === null || authority.revision !== target.revision)
      throw new CloudConnectionError('IDENTITY_MISMATCH', 409);
    connections.reauthorizeOAuthConnection({ id: authority.id, expectedRevision: target.revision, previousSecretRef: authority.secretRef, newSecretRef: secretRef, material: exchanged, at });
    secrets.deleteOAuthConnectionCredential(authority.secretRef);
    return authority.id;
  });
}

export function oauthRedirectUri(provider: CloudProvider, allowedOrigin: string): string {
  let origin: URL;
  try {
    origin = new URL(allowedOrigin);
  } catch {
    throw new CloudConnectionError('NOT_PROVISIONED', 503);
  }
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    (origin.pathname !== '/' && origin.pathname !== '')
  ) {
    throw new CloudConnectionError('NOT_PROVISIONED', 503);
  }
  return new URL(`/api/storage/connections/oauth/callback/${provider}`, origin.origin).toString();
}

function verifierRef(row: OAuthFlowRow): OAuthFlowVerifierRef | null {
  return row.pkceVerifierRef === null
    ? null
    : Object.freeze({ id: row.pkceVerifierRef, kind: 'OAUTH_FLOW_VERIFIER' });
}

function assertAuthorizationUrl(
  raw: string,
  expected: {
    state: string;
    redirectUri: string;
    codeChallenge: string | null;
    verifier: string | null;
  },
): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CloudConnectionError('NOT_PROVISIONED', 503);
  }
  const forbiddenQueryKey =
    /access.?token|refresh.?token|client.?secret|code.?verifier|authorization.?code|dlink|passcode|password/i;
  const hasForbiddenQuery = [...parsed.searchParams.keys()].some((key) =>
    forbiddenQueryKey.test(key),
  );
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.hash.length > 0 ||
    raw.length > 8192 ||
    hasForbiddenQuery ||
    parsed.searchParams.get('state') !== expected.state ||
    parsed.searchParams.get('redirect_uri') !== expected.redirectUri ||
    (expected.codeChallenge === null
      ? parsed.searchParams.has('code_challenge')
      : parsed.searchParams.get('code_challenge') !== expected.codeChallenge) ||
    (expected.verifier !== null && raw.includes(expected.verifier))
  ) {
    throw new CloudConnectionError('NOT_PROVISIONED', 503);
  }
}

const CAPABILITIES = new Set<CloudConnectionCapability>([
  'SOURCE_BROWSE',
  'SOURCE_DOWNLOAD',
  'SHARE_TRANSFER',
  'SOURCE_DELETE',
  'ARCHIVE_DESTINATION',
  'JELLYFIN_MOUNT',
  'RECOVERY_ELIGIBLE',
  'RECOVERY_ACTIVE',
]);

function isCapability(value: string): value is CloudConnectionCapability {
  return CAPABILITIES.has(value as CloudConnectionCapability);
}

function isProvisionState(value: string): value is CloudConnectionProvisionState {
  return ['NOT_REQUESTED', 'PROVISIONING', 'READY', 'PROVISION_FAILED'].includes(value);
}

function isIdentityConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('cloud_connections.provider, cloud_connections.external_account_id') ||
      error.message === 'OAUTH_REAUTHORIZE_FENCE_REJECTED')
  );
}
