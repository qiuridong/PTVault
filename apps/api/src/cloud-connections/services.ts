import { createHmac, randomUUID } from 'node:crypto';

import type {
  CloudConnection,
  CloudConnectionAction,
  CloudConnectionCapabilities,
  CloudProvider,
} from '@ptvault/contracts';

import { SecretBox } from '../core/crypto.js';
import type { AppDatabase } from '../db/database.js';
import {
  CloudConnectionError,
  OAuthFlowRepository,
  OAuthFlowService,
  type OAuthProviderAdapter,
} from './oauth.js';
import { CloudConnectionRateLimitAuthority } from './rate-limit.js';
import {
  CloudConnectionOperationReceiptRepository,
  type CloudConnectionOperationScope,
} from './idempotency.js';
import { CloudConnectionReferencedError, CloudConnectionRepository } from './repository.js';
import {
  CloudConnectionTokenRefreshCoordinator,
  type CloudConnectionProviderSession,
  type CloudTokenRefreshProvider,
} from './refresh-coordinator.js';
import { EncryptedSecretRepository, type OAuthConnectionCredential } from './secrets.js';
import type { BaiduDeviceService } from './baidu-device.js';
import type { OneDriveProvisionService } from './onedrive-provision.js';
import type { BaiduConnectionBrowseService } from './baidu-browse.js';

export interface CloudConnectionProbeAdapter {
  readonly provider: CloudProvider;
  testSession(session: CloudConnectionProviderSession): Promise<{ healthy: boolean }>;
}

export type CloudConnectionProbeProof = {
  connectionId: string;
  expectedRevision: number;
};

export class CloudConnectionManagementService {
  constructor(
    private readonly connections: CloudConnectionRepository,
    private readonly secrets: EncryptedSecretRepository,
    private readonly refresh: CloudConnectionTokenRefreshCoordinator,
    private readonly rateLimits: CloudConnectionRateLimitAuthority,
    private readonly probes: ReadonlyMap<CloudProvider, CloudConnectionProbeAdapter>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  list(): CloudConnection[] {
    return this.connections.list();
  }

  patchLabel(input: { id: string; revision: number; label: string }): CloudConnection {
    try {
      return this.connections.patchLabel({
        id: input.id,
        expectedRevision: input.revision,
        label: input.label,
        at: this.now(),
      });
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  disable(input: { id: string; revision: number }): CloudConnection {
    try {
      return this.connections.disable({
        id: input.id,
        expectedRevision: input.revision,
        at: this.now(),
      });
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  enable(input: { id: string; revision: number }): CloudConnection {
    try {
      return this.connections.enable({
        id: input.id,
        expectedRevision: input.revision,
        at: this.now(),
      });
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  disconnect(input: { id: string; revision: number }): CloudConnection {
    try {
      return this.connections.transaction(() => {
        const result = this.connections.disconnect({
          id: input.id,
          expectedRevision: input.revision,
          at: this.now(),
        });
        if (result.removedSecretRef !== null) {
          this.secrets.deleteOAuthConnectionCredential(result.removedSecretRef);
        }
        return result.connection;
      });
    } catch (error) {
      if (error instanceof CloudConnectionReferencedError) throw error;
      throw mapRepositoryError(error);
    }
  }

  async testConnection(input: { id: string; revision: number }): Promise<CloudConnection> {
    const proof = await this.probeConnection(input);
    return this.recordSuccessfulProbe(proof);
  }

  async probeConnection(input: {
    id: string;
    revision: number;
  }): Promise<CloudConnectionProbeProof> {
    let authority;
    try {
      authority = this.connections.authority(input.id);
    } catch (error) {
      throw mapRepositoryError(error);
    }
    if (authority.revision !== input.revision) {
      throw new CloudConnectionError('CONNECTION_REVISION_CONFLICT', 409);
    }
    const probe = this.probes.get(authority.provider);
    if (!probe || probe.provider !== authority.provider) {
      throw new CloudConnectionError('NOT_PROVISIONED', 503);
    }
    let result: { healthy: boolean };
    try {
      const session = await this.refresh.getSession(input.id);
      result = await this.rateLimits.runProviderOperation(
        {
          connectionId: session.connectionId,
          provider: session.provider,
          connectionRevision: session.connectionRevision,
          secretRefId: session.secretRefId,
        },
        () => probe.testSession(session),
      );
    } catch (error) {
      if (error instanceof CloudConnectionError) throw error;
      throw new CloudConnectionError('CONNECTION_TEST_FAILED', 503);
    }
    if (!result.healthy) throw new CloudConnectionError('CONNECTION_TEST_FAILED', 503);
    return { connectionId: input.id, expectedRevision: authority.revision };
  }

  recordSuccessfulProbe(proof: CloudConnectionProbeProof): CloudConnection {
    try {
      return this.connections.recordChecked({
        id: proof.connectionId,
        expectedRevision: proof.expectedRevision,
        at: this.now(),
      });
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }
}

export type CloudConnectionServices = {
  repository: CloudConnectionRepository;
  secrets: EncryptedSecretRepository;
  oauth: OAuthFlowService;
  refresh: CloudConnectionTokenRefreshCoordinator;
  rateLimits: CloudConnectionRateLimitAuthority;
  management: CloudConnectionManagementService;
  receipts: CloudConnectionOperationReceiptRepository;
  oauthBindingToken: (scope: CloudConnectionOperationScope) => string;
  supportsConnectionAction: (provider: CloudProvider, action: CloudConnectionAction) => boolean;
  capabilities: CloudConnectionCapabilities;
  baiduDevice?: BaiduDeviceService;
  /** Present only when the closed-by-default OneDrive materializer is configured. */
  oneDriveProvision?: Pick<OneDriveProvisionService, 'provision' | 'takeOverLegacy'>;
  /** Exact-connection, read-only Baidu directory browser. */
  baiduBrowse?: Pick<BaiduConnectionBrowseService, 'browse'> &
    Partial<Pick<BaiduConnectionBrowseService, 'search'>>;
};

export type CreateCloudConnectionServicesOptions = {
  db: AppDatabase;
  masterKey: Buffer;
  oauthProviders?: ReadonlyMap<CloudProvider, OAuthProviderAdapter>;
  refreshProviders?: ReadonlyMap<CloudProvider, CloudTokenRefreshProvider>;
  connectionRefreshProviders?: ReadonlyMap<string, CloudTokenRefreshProvider>;
  profileRefreshProvider?: (credential: OAuthConnectionCredential) => CloudTokenRefreshProvider | undefined;
  baiduDeviceEnabled?: boolean;
  probeProviders?: ReadonlyMap<CloudProvider, CloudConnectionProbeAdapter>;
  oauthCallbackOrigins?: ReadonlyMap<CloudProvider, string>;
  ownerId?: string;
  now?: () => number;
  newId?: () => string;
  newSecretId?: () => string;
  newOpaqueToken?: () => string;
  oneDriveRuntimeConfigured?: boolean;
  /** True only when the exact-connection Baidu browser adapter is wired. */
  baiduBrowseConfigured?: boolean;
  /** True only when the OneDrive materializer exists and its mutation gate is open. */
  oneDriveProvisionEnabled?: boolean;
  onProviderSession?: (session: CloudConnectionProviderSession) => Promise<void>;
};

export function createCloudConnectionServices(
  options: CreateCloudConnectionServicesOptions,
): CloudConnectionServices {
  const now = options.now ?? (() => Date.now());
  const repository = new CloudConnectionRepository(options.db, now, {
    oneDriveRuntimeConfigured: options.oneDriveRuntimeConfigured ?? false,
  });
  const secrets = new EncryptedSecretRepository({
    db: options.db,
    secretBox: new SecretBox(options.masterKey),
    wrappingKey: { id: 'ptvault-master', version: 1 },
    now,
    ...(options.newSecretId ? { newId: options.newSecretId } : {}),
  });
  const oauth = new OAuthFlowService({
    flows: new OAuthFlowRepository(options.db),
    connections: repository,
    secrets,
    providers: options.oauthProviders ?? new Map(),
    callbackOrigins: options.oauthCallbackOrigins ?? new Map(),
    now,
    ...(options.newId ? { newId: options.newId } : {}),
    ...(options.newOpaqueToken ? { newOpaqueToken: options.newOpaqueToken } : {}),
    onConnectionCredentialsChanged: async (id) => {
      refresh.invalidate(id);
      if (
        repository.get(id).provider === 'ONEDRIVE' &&
        repository.get(id).storageAccountIds.length > 0
      )
        await refresh.getSession(id);
    },
  });
  const rateLimits = new CloudConnectionRateLimitAuthority({ db: options.db, now });
  const refresh = new CloudConnectionTokenRefreshCoordinator({
    connections: repository,
    secrets,
    providers: options.refreshProviders ?? new Map(),
    ...(options.profileRefreshProvider === undefined ? {} : { profileRefreshProvider: options.profileRefreshProvider }),
    ...(options.connectionRefreshProviders === undefined
      ? {}
      : { connectionProviders: options.connectionRefreshProviders }),
    rateLimits,
    ownerId: options.ownerId ?? randomUUID(),
    now,
    ...(options.onProviderSession === undefined ? {} : { onSession: options.onProviderSession }),
  });
  const management = new CloudConnectionManagementService(
    repository,
    secrets,
    refresh,
    rateLimits,
    options.probeProviders ?? new Map(),
    now,
  );
  const receipts = new CloudConnectionOperationReceiptRepository(options.db, now);
  const oauthBindingKey = Buffer.from(options.masterKey);
  const oauthBindingToken = (scope: CloudConnectionOperationScope): string =>
    createHmac('sha256', oauthBindingKey)
      .update('ptvault-oauth-binding-v1\0')
      .update(scope.adminId)
      .update('\0')
      .update(scope.operation)
      .update('\0')
      .update(scope.resourceId)
      .update('\0')
      .update(scope.idempotencyKey)
      .update('\0')
      .update(scope.requestFingerprint)
      .digest('base64url');
  const oauthProviderSet = new Set(options.oauthProviders?.keys() ?? []);
  const probeProviderSet = new Set(options.probeProviders?.keys() ?? []);
  const refreshProviderSet = new Set(options.refreshProviders?.keys() ?? []);
  if (options.profileRefreshProvider) refreshProviderSet.add('BAIDU');
  for (const provider of options.connectionRefreshProviders?.values() ?? [])
    refreshProviderSet.add(provider.provider);
  const oauthProviders = [...oauthProviderSet].sort();
  const testProviders = [...probeProviderSet].filter((provider) =>
    refreshProviderSet.has(provider),
  );
  const supportsConnectionAction = (
    provider: CloudProvider,
    action: CloudConnectionAction,
  ): boolean => {
    if (action === 'START_OAUTH') return false;
    if (action === 'REAUTHORIZE') return oauthProviderSet.has(provider) || (provider === 'BAIDU' && options.baiduDeviceEnabled === true);
    if (action === 'TEST') {
      return probeProviderSet.has(provider) && refreshProviderSet.has(provider);
    }
    if (action === 'BROWSE') {
      return provider === 'BAIDU' && (options.baiduBrowseConfigured ?? false);
    }
    if (action === 'PROVISION' || action === 'TAKEOVER_LEGACY') {
      return provider === 'ONEDRIVE' && (options.oneDriveProvisionEnabled ?? false);
    }
    return true;
  };
  const capabilities: CloudConnectionCapabilities = {
    oauthEnabled: oauthProviders.length > 0,
    ...(options.baiduDeviceEnabled ? { baiduDeviceEnabled: true } : {}),
    providers: oauthProviders,
    supportedActions: [
      ...(oauthProviders.length > 0 ? (['START_OAUTH'] as const) : []),
      ...(oauthProviders.length > 0 || options.baiduDeviceEnabled ? (['REAUTHORIZE'] as const) : []),
      ...(testProviders.length > 0 ? (['TEST'] as const) : []),
      'EDIT',
      'ENABLE',
      'DISABLE',
      'DISCONNECT',
      ...(options.baiduBrowseConfigured ? (['BROWSE'] as const) : []),
      ...(options.oneDriveProvisionEnabled ? (['PROVISION', 'TAKEOVER_LEGACY'] as const) : []),
    ],
    disabledReason: oauthProviders.length > 0 || options.baiduDeviceEnabled ? null : 'NOT_CONFIGURED',
  };
  return {
    repository,
    secrets,
    oauth,
    refresh,
    rateLimits,
    management,
    receipts,
    oauthBindingToken,
    supportsConnectionAction,
    capabilities,
  };
}

function mapRepositoryError(error: unknown): CloudConnectionError {
  if (error instanceof CloudConnectionError) return error;
  if (!(error instanceof Error))
    return new CloudConnectionError('CONNECTION_AUTH_STATE_INVALID', 409);
  if (error.message === 'CONNECTION_NOT_FOUND') {
    return new CloudConnectionError('CONNECTION_NOT_FOUND', 404);
  }
  if (error.message === 'CONNECTION_REVISION_CONFLICT') {
    return new CloudConnectionError('CONNECTION_REVISION_CONFLICT', 409);
  }
  if (error.message === 'CONNECTION_READ_ONLY')
    return new CloudConnectionError('CONNECTION_READ_ONLY', 409);
  return new CloudConnectionError('CONNECTION_AUTH_STATE_INVALID', 409);
}
