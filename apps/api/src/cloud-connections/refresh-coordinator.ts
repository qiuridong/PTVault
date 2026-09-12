import type { CloudProvider } from '@ptvault/contracts';

import type {
  CloudConnectionAuthority,
  CloudConnectionRefreshLease,
  CloudConnectionRepository,
} from './repository.js';
import type {
  EncryptedSecretRepository,
  OAuthConnectionCredential,
  OAuthConnectionCredentialRef,
} from './secrets.js';
import type { CloudConnectionRateLimitAuthority } from './rate-limit.js';

export { CloudProviderRateLimitError } from './rate-limit.js';

export type CloudTokenRefreshResult = {
  provider: CloudProvider;
  clientId: string;
  externalAccountId: string;
  accessToken: string;
  refreshToken?: string | null;
  accessExpiresAt: number;
};

export interface CloudTokenRefreshProvider {
  readonly provider: CloudProvider;
  readonly clientId: string;
  refresh(input: {
    connectionId: string;
    refreshToken: string;
    externalAccountId: string;
    signal?: AbortSignal;
  }): Promise<CloudTokenRefreshResult>;
}

export type CloudConnectionProviderSession = {
  connectionId: string;
  provider: CloudProvider;
  externalAccountId: string;
  accessToken: string;
  accessExpiresAt: number;
  connectionRevision: number;
  secretRefId: string;
};

export type RefreshCoordinatorErrorCode =
  | 'CONNECTION_NOT_FOUND'
  | 'CONNECTION_AUTH_STATE_INVALID'
  | 'REFRESH_NOT_PROVISIONED'
  | 'REFRESH_CREDENTIAL_INVALID'
  | 'REFRESH_PROVIDER_FAILED'
  | 'REFRESH_FENCE_REJECTED';

export class RefreshCoordinatorError extends Error {
  constructor(readonly code: RefreshCoordinatorErrorCode) {
    super(code);
    this.name = 'RefreshCoordinatorError';
  }
}

export type CloudConnectionTokenRefreshCoordinatorOptions = {
  connections: CloudConnectionRepository;
  secrets: EncryptedSecretRepository;
  providers: ReadonlyMap<CloudProvider, CloudTokenRefreshProvider>;
  connectionProviders?: ReadonlyMap<string, CloudTokenRefreshProvider>;
  profileRefreshProvider?: (credential: OAuthConnectionCredential) => CloudTokenRefreshProvider | undefined;
  rateLimits: Pick<
    CloudConnectionRateLimitAuthority,
    'waitUntilAvailable' | 'reportProvider429' | 'runProviderOperation'
  >;
  ownerId: string;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  leaseMs?: number;
  heartbeatMs?: number;
  heartbeatSleep?: (milliseconds: number) => Promise<void>;
  pollMs?: number;
  refreshSkewMs?: number;
  onSession?: (session: CloudConnectionProviderSession) => Promise<void>;
};

/**
 * Sole owner of provider refresh calls for database-backed cloud connections.
 * The in-process map is only a fast path; the durable lease and fencing token
 * are the cross-instance correctness boundary.
 */
export class CloudConnectionTokenRefreshCoordinator {
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly heartbeatSleep: (milliseconds: number) => Promise<void>;
  private readonly pollMs: number;
  private readonly refreshSkewMs: number;
  private readonly refreshing = new Map<string, Promise<CloudConnectionProviderSession>>();

  constructor(private readonly options: CloudConnectionTokenRefreshCoordinatorOptions) {
    if (options.ownerId.length === 0) throw new Error('REFRESH_OWNER_ID_REQUIRED');
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.leaseMs = options.leaseMs ?? 30_000;
    this.heartbeatMs = options.heartbeatMs ?? Math.max(1, Math.floor(this.leaseMs / 3));
    this.heartbeatSleep =
      options.heartbeatSleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.pollMs = options.pollMs ?? 100;
    this.refreshSkewMs = options.refreshSkewMs ?? 30_000;
    if (
      this.leaseMs <= 0 ||
      this.heartbeatMs <= 0 ||
      this.heartbeatMs >= this.leaseMs ||
      this.pollMs <= 0 ||
      this.refreshSkewMs < 0
    ) {
      throw new Error('INVALID_REFRESH_COORDINATOR_TIMING');
    }
  }

  getSession(connectionId: string): Promise<CloudConnectionProviderSession> {
    const active = this.refreshing.get(connectionId);
    if (active) return active;
    const operation = this.resolveSession(connectionId)
      .then(async (value) => {
        await this.options.onSession?.(value);
        const current = this.authority(connectionId);
        if (
          current.revision !== value.connectionRevision ||
          current.secretRef?.id !== value.secretRefId ||
          current.accessExpiresAt !== value.accessExpiresAt
        ) {
          throw new RefreshCoordinatorError('REFRESH_FENCE_REJECTED');
        }
        return value;
      })
      .finally(() => {
        if (this.refreshing.get(connectionId) === operation) this.refreshing.delete(connectionId);
      });
    this.refreshing.set(connectionId, operation);
    return operation;
  }

  invalidate(connectionId: string): void {
    // An in-flight old operation retains its DB fence, but new callers must not
    // join it after a reauthorization/revocation revision change.
    this.refreshing.delete(connectionId);
  }

  private async resolveSession(connectionId: string): Promise<CloudConnectionProviderSession> {
    // A session is the only credential-bearing entry point for provider calls.
    // Gate it before either a fresh-token request or the refresh endpoint so all
    // callers of this connection observe one durable retryAt authority.
    await this.options.rateLimits.waitUntilAvailable(connectionId);
    for (;;) {
      const authority = this.authority(connectionId);
      const credential = this.credential(authority);
      const provider = this.provider(authority, credential);
      if (credential.accessExpiresAt > this.now() + this.refreshSkewMs) {
        return session(authority, credential);
      }

      const lease = this.options.connections.tryAcquireRefreshLease({
        connectionId,
        ownerId: this.options.ownerId,
        now: this.now(),
        leaseMs: this.leaseMs,
      });
      if (lease !== null) {
        return this.refreshWithFence(authority, credential, provider, lease);
      }

      const currentLease = this.options.connections.refreshLease(connectionId);
      const untilTakeover =
        currentLease === null ? this.pollMs : Math.max(1, currentLease.leaseExpiresAt - this.now());
      await this.sleep(Math.max(1, Math.min(this.pollMs, untilTakeover)));
    }
  }

  private async refreshWithFence(
    authority: CloudConnectionAuthority,
    credential: OAuthConnectionCredential,
    provider: CloudTokenRefreshProvider,
    lease: CloudConnectionRefreshLease,
  ): Promise<CloudConnectionProviderSession> {
    const providerAbort = new AbortController();
    let stopped = false;
    let leaseLost = false;
    let providerCompleted = false;
    let stopHeartbeat!: () => void;
    let signalLeaseLost!: () => void;
    const heartbeatStopped = new Promise<void>((resolve) => {
      stopHeartbeat = resolve;
    });
    const leaseLostSignal = new Promise<void>((resolve) => {
      signalLeaseLost = resolve;
    });
    const heartbeat = (async () => {
      for (;;) {
        const shouldStop = await Promise.race([
          this.heartbeatSleep(this.heartbeatMs).then(() => false),
          heartbeatStopped.then(() => true),
        ]);
        if (shouldStop || stopped) return;
        const renewed = this.options.connections.renewRefreshLease({
          connectionId: authority.id,
          ownerId: lease.ownerId,
          fencingToken: lease.fencingToken,
          expectedRevision: authority.revision,
          expectedProvider: authority.provider,
          expectedSecretRef: requiredSecretRef(authority),
          now: this.now(),
          leaseMs: this.leaseMs,
        });
        if (renewed === null) {
          leaseLost = true;
          signalLeaseLost();
          providerAbort.abort(new Error('REFRESH_FENCE_REJECTED'));
          return;
        }
      }
    })();

    try {
      // The gate is checked again inside the owned critical section. A 429 can
      // arrive after the outer resolve-loop check but before this provider call.
      await Promise.race([
        this.options.rateLimits.waitUntilAvailable(authority.id),
        leaseLostSignal.then(() => {
          throw new RefreshCoordinatorError('REFRESH_FENCE_REJECTED');
        }),
      ]);
      if (leaseLost) throw new RefreshCoordinatorError('REFRESH_FENCE_REJECTED');

      const providerOperation = this.options.rateLimits.runProviderOperation(
        {
          connectionId: authority.id,
          provider: authority.provider,
          connectionRevision: authority.revision,
          secretRefId: requiredSecretRef(authority).id,
          refreshFence: {
            ownerId: lease.ownerId,
            fencingToken: lease.fencingToken,
          },
        },
        () =>
          provider.refresh({
            connectionId: authority.id,
            refreshToken: credential.refreshToken,
            externalAccountId: authority.externalAccountId,
            signal: providerAbort.signal,
          }),
      );
      const outcome = await Promise.race([
        providerOperation.then(
          (value) => ({ kind: 'PROVIDER' as const, value }),
          (error: unknown) => ({ kind: 'ERROR' as const, error }),
        ),
        leaseLostSignal.then(() => ({ kind: 'LEASE_LOST' as const })),
      ]);
      if (outcome.kind === 'LEASE_LOST' || leaseLost) {
        void providerOperation.catch(() => undefined);
        throw new RefreshCoordinatorError('REFRESH_FENCE_REJECTED');
      }
      if (outcome.kind === 'ERROR') throw outcome.error;
      const refreshed = outcome.value;
      providerCompleted = true;

      if (
        refreshed.provider !== authority.provider ||
        refreshed.clientId !== credential.clientId ||
        refreshed.externalAccountId !== authority.externalAccountId ||
        refreshed.accessToken.length === 0 ||
        !Number.isSafeInteger(refreshed.accessExpiresAt) ||
        refreshed.accessExpiresAt <= this.now()
      ) {
        throw new RefreshCoordinatorError('REFRESH_CREDENTIAL_INVALID');
      }

      const nextCredential: OAuthConnectionCredential = {
        ...credential,
        accessToken: refreshed.accessToken,
        refreshToken:
          typeof refreshed.refreshToken === 'string' && refreshed.refreshToken.length > 0
            ? refreshed.refreshToken
            : credential.refreshToken,
        accessExpiresAt: refreshed.accessExpiresAt,
      };
      this.options.connections.transaction(() => {
        this.options.connections.assertRefreshFence({
          connectionId: authority.id,
          ownerId: lease.ownerId,
          fencingToken: lease.fencingToken,
          expectedRevision: authority.revision,
          expectedProvider: authority.provider,
          expectedExternalAccountId: authority.externalAccountId,
          expectedSecretRef: requiredSecretRef(authority),
          now: this.now(),
        });
        // Re-read under the write transaction so refresh-token fallback is valid
        // only while the same identity/revision/fence is still authoritative.
        const currentCredential = this.options.secrets.readOAuthConnectionCredential(
          requiredSecretRef(authority),
        );
        if (
          currentCredential.provider !== credential.provider ||
          currentCredential.clientId !== credential.clientId ||
          currentCredential.baiduClientProfile?.id !== credential.baiduClientProfile?.id ||
          currentCredential.baiduClientProfile?.fingerprint !== credential.baiduClientProfile?.fingerprint ||
          currentCredential.externalAccountId !== credential.externalAccountId
        ) {
          throw new Error('REFRESH_FENCE_REJECTED');
        }
        this.options.secrets.replaceOAuthConnectionCredential(
          requiredSecretRef(authority),
          nextCredential,
          this.now(),
        );
        this.options.connections.markRefreshCommitted({
          connectionId: authority.id,
          ownerId: lease.ownerId,
          fencingToken: lease.fencingToken,
          expectedRevision: authority.revision,
          expectedProvider: authority.provider,
          expectedExternalAccountId: authority.externalAccountId,
          expectedSecretRef: requiredSecretRef(authority),
          accessExpiresAt: refreshed.accessExpiresAt,
          now: this.now(),
        });
      });
      return session(authority, nextCredential);
    } catch (error) {
      if (
        leaseLost ||
        error instanceof RefreshCoordinatorError ||
        (error instanceof Error && error.message === 'REFRESH_FENCE_REJECTED')
      ) {
        if (error instanceof RefreshCoordinatorError) throw error;
        throw new RefreshCoordinatorError('REFRESH_FENCE_REJECTED');
      }
      if (providerCompleted) throw error;
      throw new RefreshCoordinatorError('REFRESH_PROVIDER_FAILED');
    } finally {
      stopped = true;
      stopHeartbeat();
      await heartbeat;
    }
  }

  private authority(connectionId: string): CloudConnectionAuthority {
    let authority: CloudConnectionAuthority;
    try {
      authority = this.options.connections.authority(connectionId);
    } catch {
      throw new RefreshCoordinatorError('CONNECTION_NOT_FOUND');
    }
    if (
      authority.authState !== 'CONNECTED' ||
      authority.disconnectedAt !== null ||
      authority.secretRef === null
    ) {
      throw new RefreshCoordinatorError('CONNECTION_AUTH_STATE_INVALID');
    }
    return authority;
  }

  private credential(authority: CloudConnectionAuthority): OAuthConnectionCredential {
    try {
      const credential = this.options.secrets.readOAuthConnectionCredential(
        requiredSecretRef(authority),
      );
      if (
        credential.provider !== authority.provider ||
        credential.externalAccountId !== authority.externalAccountId ||
        credential.accessExpiresAt !== authority.accessExpiresAt
      ) {
        throw new Error('CREDENTIAL_AUTHORITY_MISMATCH');
      }
      return credential;
    } catch (error) {
      if (error instanceof RefreshCoordinatorError) throw error;
      throw new RefreshCoordinatorError('REFRESH_CREDENTIAL_INVALID');
    }
  }

  private provider(
    authority: CloudConnectionAuthority,
    credential: OAuthConnectionCredential,
  ): CloudTokenRefreshProvider {
    const provider =
      authority.legacy === true
        ? this.options.connectionProviders?.get(authority.id)
        : credential.baiduClientProfile !== undefined
          ? this.options.profileRefreshProvider?.(credential)
          : this.options.providers.get(authority.provider);
    if (
      !provider ||
      provider.provider !== authority.provider ||
      provider.clientId !== credential.clientId
    ) {
      throw new RefreshCoordinatorError('REFRESH_NOT_PROVISIONED');
    }
    return provider;
  }
}

function requiredSecretRef(authority: CloudConnectionAuthority): OAuthConnectionCredentialRef {
  if (authority.secretRef === null) {
    throw new RefreshCoordinatorError('CONNECTION_AUTH_STATE_INVALID');
  }
  return authority.secretRef;
}

function session(
  authority: CloudConnectionAuthority,
  credential: OAuthConnectionCredential,
): CloudConnectionProviderSession {
  return {
    connectionId: authority.id,
    provider: authority.provider,
    externalAccountId: authority.externalAccountId,
    accessToken: credential.accessToken,
    accessExpiresAt: credential.accessExpiresAt,
    connectionRevision: authority.revision,
    secretRefId: requiredSecretRef(authority).id,
  };
}
