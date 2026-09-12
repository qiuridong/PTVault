import {
  CloudConnectionCapabilitySchema,
  CloudConnectionProvisionStateSchema,
  CloudConnectionSchema,
  CloudProviderSchema,
  type CloudConnection,
  type CloudConnectionAction,
  type CloudConnectionCapability,
  type CloudConnectionReference,
  type CloudConnectionProvisionState,
  type CloudConnectionReferenceSummary,
  type CloudProvider,
} from '@ptvault/contracts';

import type { AppDatabase } from '../db/database.js';
import {
  deriveCloudConnectionCapabilities,
  validateCloudCapabilityEvidence,
} from './capabilities.js';
import type { OAuthConnectionCredentialRef } from './secrets.js';

type ConnectionRow = {
  legacyEnvironment: number;
  clientProfileId: string | null;
  id: string;
  provider: CloudProvider;
  label: string;
  externalAccountId: string;
  principalMasked: string;
  authState: CloudConnectionAuthority['authState'];
  secretRef: string | null;
  scopesJson: string;
  capabilitiesJson: string;
  accessExpiresAt: number | null;
  provisionState: CloudConnectionProvisionState;
  revision: number;
  lastCheckedAt: number | null;
  createdAt: number;
  updatedAt: number;
  disconnectedAt: number | null;
  rateLimitedUntil: number | null;
  rateLimitCode: CloudConnection['rateLimit']['code'];
  rateLimitUpdatedAt: number | null;
  runtimeRevision: number;
  sourceImportJobs: number;
  destinationImportJobs: number;
  activeOffloadJobs: number;
  mountReferences: number;
  catalogReferences: number;
  recoveryReferences: number;
  replicaReferences: number;
  storageBindingReferences: number;
  verifiedHealthyStorageBindings: number;
  healthyMountBindings: number;
  activeProvisionAttempts: number;
  eligibleLegacyTakeoverAccounts: number;
  storageAccountIdsJson: string;
  materializationPending: number;
  materializationLeaseExpiresAt: number | null;
};

export type CloudConnectionAuthority = {
  legacy?: boolean;
  id: string;
  provider: CloudProvider;
  externalAccountId: string;
  authState: 'CONNECTED' | 'REAUTH_REQUIRED' | 'DISABLED' | 'DISCONNECTED' | 'ERROR';
  secretRef: OAuthConnectionCredentialRef | null;
  accessExpiresAt: number | null;
  revision: number;
  disconnectedAt: number | null;
};

export type OAuthConnectionMaterial = {
  provider: CloudProvider;
  externalAccountId: string;
  principalMasked: string;
  scopes: string[];
  capabilities: CloudConnectionCapability[];
  accessExpiresAt: number;
  provisionState: CloudConnectionProvisionState;
};

export type CloudConnectionRefreshLease = {
  connectionId: string;
  ownerId: string;
  fencingToken: number;
  leaseExpiresAt: number;
  acquiredAt: number;
  updatedAt: number;
};

const CONNECTION_SELECT = `
  SELECT connection.id,
         EXISTS(SELECT 1 FROM legacy_environment_connections WHERE connection_id=connection.id) AS legacyEnvironment,
         (SELECT profile_id FROM baidu_profile_environment_connections WHERE connection_id=connection.id) AS clientProfileId,
         connection.provider,
         connection.label,
         connection.external_account_id AS externalAccountId,
         connection.principal_masked AS principalMasked,
         connection.auth_state AS authState,
         connection.secret_ref AS secretRef,
         connection.scopes_json AS scopesJson,
         connection.capabilities_json AS capabilitiesJson,
         connection.access_expires_at AS accessExpiresAt,
         connection.provision_state AS provisionState,
         connection.revision,
         connection.last_checked_at AS lastCheckedAt,
         connection.created_at AS createdAt,
         connection.updated_at AS updatedAt,
         connection.disconnected_at AS disconnectedAt,
         runtime.rate_limited_until AS rateLimitedUntil,
         runtime.rate_limit_code AS rateLimitCode,
         runtime.rate_limit_updated_at AS rateLimitUpdatedAt,
         COALESCE(runtime.runtime_revision, 0) AS runtimeRevision,
         (
           SELECT COUNT(*)
           FROM import_jobs AS job
           WHERE (job.source_connection_id = connection.id OR EXISTS(SELECT 1 FROM legacy_import_source_bindings AS legacy_binding WHERE legacy_binding.job_id=job.id AND legacy_binding.connection_id=connection.id))
             AND job.state IN ('QUEUED', 'RUNNING', 'RETRY_WAIT', 'BLOCKED', 'FAILED_SAFE')
         ) AS sourceImportJobs,
         (
           SELECT COUNT(*)
           FROM import_jobs AS job
           WHERE job.state IN ('QUEUED', 'RUNNING', 'RETRY_WAIT', 'BLOCKED', 'FAILED_SAFE')
             AND EXISTS (
               SELECT 1 FROM storage_accounts AS account
               WHERE account.connection_id = connection.id
                 AND (
                   job.destination_id = 'onedrive-raw:' || account.id
                   OR job.destination_id = 'onedrive-crypt:' || account.id
                   OR EXISTS (
                     SELECT 1 FROM import_objects AS object
                     WHERE object.job_id = job.id
                       AND object.destination_account_id = account.id
                   )
                 )
             )
         ) AS destinationImportJobs,
         (
           SELECT COUNT(*)
           FROM jobs AS job
           JOIN offload_snapshots AS snapshot ON snapshot.job_id = job.id
           JOIN storage_accounts AS account ON account.id = snapshot.selected_account_id
           WHERE account.connection_id = connection.id
             AND job.state IN ('QUEUED', 'RUNNING', 'RETRY_WAIT', 'BLOCKED', 'FAILED_SAFE')
         ) AS activeOffloadJobs,
         (
           SELECT COUNT(*) FROM mount_health AS mount
           JOIN storage_accounts AS account ON account.id = mount.account_id
           WHERE account.connection_id = connection.id
         ) AS mountReferences,
         (
           SELECT COUNT(*) FROM media_catalog AS catalog
           JOIN storage_accounts AS account ON account.id = catalog.active_account_id
           WHERE account.connection_id = connection.id
         ) AS catalogReferences,
         (
           SELECT COUNT(*) FROM recovery_cloud_copies AS copy
           JOIN storage_accounts AS account ON account.id = copy.account_id
           WHERE account.connection_id = connection.id
         ) AS recoveryReferences,
         (
           SELECT COUNT(*) FROM cloud_replicas AS replica
           JOIN storage_accounts AS account ON account.id = replica.account_id
           WHERE account.connection_id = connection.id AND replica.active = 1
         ) AS replicaReferences,
         (
           SELECT COUNT(*) FROM storage_accounts AS account
           WHERE account.connection_id = connection.id
         ) AS storageBindingReferences,
         (
           SELECT COUNT(*) FROM storage_accounts AS account
           JOIN encryption_profiles AS profile
             ON profile.id = account.encryption_profile_id
           WHERE account.connection_id = connection.id
             AND account.provider = 'ONEDRIVE'
             AND account.provisioning_mode = 'WEB_OAUTH'
             AND account.enabled = 1 AND account.health = 'HEALTHY'
             AND profile.escrow_state = 'VERIFIED'
             AND profile.crypt_roundtrip_state = 'PASSED'
         ) AS verifiedHealthyStorageBindings,
         (
           SELECT COUNT(*) FROM mount_health AS mount
           JOIN storage_accounts AS account ON account.id = mount.account_id
           WHERE account.connection_id = connection.id
             AND account.enabled = 1 AND account.health = 'HEALTHY'
             AND mount.mounted = 1 AND mount.rc_reachable = 1
             AND mount.pressure <> 'CRITICAL'
         ) AS healthyMountBindings,
         (
           SELECT COUNT(*) FROM cloud_connection_provision_attempts AS attempt
           WHERE attempt.connection_id = connection.id
             AND attempt.state IN ('PREPARING', 'VERIFIED')
         ) AS activeProvisionAttempts,
         (
           SELECT COUNT(*) FROM storage_accounts AS account
           WHERE account.provisioning_mode = 'LEGACY_RCLONE'
             AND account.connection_id IS NULL
         ) AS eligibleLegacyTakeoverAccounts,
         COALESCE((
           SELECT json_group_array(account.id)
           FROM (
             SELECT id FROM storage_accounts
             WHERE connection_id = connection.id ORDER BY id
           ) AS account
         ), '[]') AS storageAccountIdsJson,
         EXISTS(SELECT 1 FROM cloud_connection_materializations AS materialization
           WHERE materialization.connection_id = connection.id
             AND materialization.materialized_secret_ref IS NOT connection.secret_ref) AS materializationPending,
         (SELECT lease_expires_at FROM cloud_connection_materializations WHERE connection_id = connection.id) AS materializationLeaseExpiresAt
  FROM cloud_connections AS connection
  LEFT JOIN cloud_connection_runtime AS runtime
         ON runtime.connection_id = connection.id`;

function parseStringArray(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    throw new Error('CLOUD_CONNECTION_ARRAY_CORRUPT');
  }
  return parsed as string[];
}

function toConnection(
  row: ConnectionRow,
  now: number,
  oneDriveRuntimeConfigured: boolean,
): CloudConnection {
  const evidence = parseStringArray(row.capabilitiesJson).map((capability) =>
    CloudConnectionCapabilitySchema.parse(capability),
  );
  const capabilities = deriveCloudConnectionCapabilities({
    provider: row.provider,
    authState: row.authState,
    provisionState: row.provisionState,
    evidence,
    oneDriveRuntimeConfigured,
    verifiedHealthyStorageBinding:
      row.verifiedHealthyStorageBindings > 0 && row.materializationPending === 0,
    healthyMountBinding: row.healthyMountBindings > 0 && row.materializationPending === 0,
    activeRecoveryCopy: row.recoveryReferences > 0,
  });
  const activeReferences: CloudConnectionReference[] = [
    { kind: 'SOURCE_IMPORT_JOB', count: row.sourceImportJobs },
    { kind: 'DESTINATION_IMPORT_JOB', count: row.destinationImportJobs },
    { kind: 'ACTIVE_OFFLOAD_JOB', count: row.activeOffloadJobs },
    { kind: 'MOUNT', count: row.mountReferences },
    { kind: 'CLOUD_CATALOG', count: row.catalogReferences },
    { kind: 'RECOVERY_COPY', count: row.recoveryReferences },
    { kind: 'CLOUD_REPLICA', count: row.replicaReferences },
    { kind: 'STORAGE_BINDING', count: row.storageBindingReferences },
  ].filter((reference) => reference.count > 0) as CloudConnectionReference[];
  const supportedActions = connectionActions(row, capabilities, activeReferences, now);
  const rateLimitActive = row.rateLimitedUntil !== null && row.rateLimitedUntil > now;
  return CloudConnectionSchema.parse({
    id: row.id,
    provider: row.provider,
    label: row.label,
    principalMasked: row.principalMasked,
    authState: row.authState,
    provisionState:
      row.materializationPending === 1 && row.provisionState === 'READY'
        ? 'PROVISION_FAILED'
        : row.provisionState,
    capabilities,
    supportedActions,
    accessExpiresAt: row.accessExpiresAt,
    revision: row.revision,
    lastCheckedAt: row.lastCheckedAt,
    legacy: row.legacyEnvironment === 1,
    readOnly: row.legacyEnvironment === 1 || row.clientProfileId !== null,
    ...(row.clientProfileId === null
      ? {}
      : {
          clientProfile: {
            id: row.clientProfileId,
            appIdKnown: false,
            downloadVerification: 'NOT_PERFORMED_BY_LOGIN' as const,
          },
        }),
    rateLimit: {
      retryAt: rateLimitActive ? row.rateLimitedUntil : null,
      code: rateLimitActive ? row.rateLimitCode : null,
      updatedAt: rateLimitActive ? row.rateLimitUpdatedAt : null,
      revision: row.runtimeRevision,
    },
    activeJobCount: row.sourceImportJobs + row.destinationImportJobs + row.activeOffloadJobs,
    activeReferences,
    storageAccountIds: parseStringArray(row.storageAccountIdsJson),
    provisionFailureCode:
      row.provisionState === 'PROVISION_FAILED' || row.materializationPending === 1
        ? 'STORAGE_PROVISION_FAILED'
        : null,
  });
}

function connectionActions(
  row: ConnectionRow,
  capabilities: CloudConnectionCapability[],
  references: CloudConnectionReference[],
  now: number,
): CloudConnectionAction[] {
  if (row.authState === 'DISCONNECTED') return [];
  if (row.legacyEnvironment === 1 || row.clientProfileId !== null)
    return row.authState === 'CONNECTED'
      ? ['TEST', ...(capabilities.includes('SOURCE_BROWSE') ? ['BROWSE' as const] : [])]
      : [];
  const actions: CloudConnectionAction[] = ['EDIT', 'REAUTHORIZE'];
  if (row.authState === 'CONNECTED') {
    actions.push('TEST', 'DISABLE');
    if (row.provider === 'BAIDU' && capabilities.includes('SOURCE_BROWSE')) {
      actions.push('BROWSE');
    }
    const canProvision =
      row.provider === 'ONEDRIVE' &&
      row.secretRef !== null &&
      (row.provisionState === 'NOT_REQUESTED' || row.provisionState === 'PROVISION_FAILED') &&
      row.storageBindingReferences === 0 &&
      row.activeProvisionAttempts === 0;
    if (canProvision) {
      actions.push('PROVISION');
      if (row.eligibleLegacyTakeoverAccounts > 0) actions.push('TAKEOVER_LEGACY');
    }
    if (
      row.provider === 'ONEDRIVE' &&
      row.secretRef !== null &&
      row.storageBindingReferences > 0 &&
      row.materializationPending === 1 &&
      (row.materializationLeaseExpiresAt === null || row.materializationLeaseExpiresAt <= now)
    ) {
      actions.push('PROVISION');
    }
  } else if (row.authState === 'DISABLED') {
    actions.push('ENABLE');
  } else {
    actions.push('DISABLE');
  }
  if (references.length === 0) actions.push('DISCONNECT');
  return actions;
}

export class CloudConnectionRepository {
  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => number = () => Date.now(),
    private readonly options: { oneDriveRuntimeConfigured?: boolean } = {},
  ) {}

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation).immediate();
  }

  list(): CloudConnection[] {
    return (
      this.db
        .prepare(`${CONNECTION_SELECT} ORDER BY connection.created_at, connection.id`)
        .all() as ConnectionRow[]
    ).map((row) => toConnection(row, this.now(), this.options.oneDriveRuntimeConfigured ?? false));
  }

  get(id: string): CloudConnection {
    const row = this.db.prepare(`${CONNECTION_SELECT} WHERE connection.id = ?`).get(id) as
      ConnectionRow | undefined;
    if (!row) throw new Error('CONNECTION_NOT_FOUND');
    return toConnection(row, this.now(), this.options.oneDriveRuntimeConfigured ?? false);
  }

  authority(id: string): CloudConnectionAuthority {
    const row = this.db
      .prepare(
        `SELECT id, provider, external_account_id AS externalAccountId,
                (EXISTS(SELECT 1 FROM legacy_environment_connections WHERE connection_id=cloud_connections.id) OR EXISTS(SELECT 1 FROM baidu_profile_environment_connections WHERE connection_id=cloud_connections.id)) AS legacy,
                auth_state AS authState, secret_ref AS secretRef,
                access_expires_at AS accessExpiresAt, revision,
                disconnected_at AS disconnectedAt
         FROM cloud_connections WHERE id = ?`,
      )
      .get(id) as
      (Omit<CloudConnectionAuthority, 'secretRef'> & { secretRef: string | null }) | undefined;
    if (!row) throw new Error('CONNECTION_NOT_FOUND');
    return {
      ...row,
      legacy: Boolean(row.legacy),
      provider: CloudProviderSchema.parse(row.provider),
      secretRef:
        row.secretRef === null
          ? null
          : Object.freeze({ id: row.secretRef, kind: 'OAUTH_CONNECTION_CREDENTIAL' }),
    };
  }

  authorityByIdentity(
    provider: CloudProvider,
    externalAccountId: string,
  ): CloudConnectionAuthority | null {
    const row = this.db
      .prepare(
        `SELECT id FROM cloud_connections
         WHERE provider = ? AND external_account_id = ?`,
      )
      .get(provider, externalAccountId) as { id: string } | undefined;
    return row ? this.authority(row.id) : null;
  }

  insertOAuthConnection(input: {
    id: string;
    label: string;
    secretRef: OAuthConnectionCredentialRef;
    material: OAuthConnectionMaterial;
    at?: number;
  }): CloudConnection {
    const timestamp = input.at ?? this.now();
    const material = this.validateMaterial(input.material);
    this.db
      .prepare(
        `INSERT INTO cloud_connections(
           id, provider, label, external_account_id, principal_masked,
           auth_state, secret_ref, scopes_json, capabilities_json,
           access_expires_at, provision_state, revision, last_checked_at,
           created_at, updated_at, disconnected_at
         ) VALUES (
           @id, @provider, @label, @externalAccountId, @principalMasked,
           'CONNECTED', @secretRef, @scopesJson, @capabilitiesJson,
           @accessExpiresAt, @provisionState, 0, @timestamp,
           @timestamp, @timestamp, NULL
         )`,
      )
      .run({
        id: input.id,
        label: input.label,
        secretRef: input.secretRef.id,
        ...material,
        scopesJson: JSON.stringify(material.scopes),
        capabilitiesJson: JSON.stringify(material.capabilities),
        timestamp,
      });
    return this.get(input.id);
  }

  reauthorizeOAuthConnection(input: {
    id: string;
    expectedRevision: number;
    previousSecretRef: OAuthConnectionCredentialRef;
    newSecretRef: OAuthConnectionCredentialRef;
    material: OAuthConnectionMaterial;
    at?: number;
  }): CloudConnection {
    this.assertWebManaged(input.id);
    const timestamp = input.at ?? this.now();
    const material = this.validateMaterial(input.material);
    const result = this.db
      .prepare(
        `UPDATE cloud_connections
         SET principal_masked = @principalMasked, auth_state = 'CONNECTED',
             secret_ref = @newSecretRef, scopes_json = @scopesJson,
             capabilities_json = CASE WHEN provider = 'ONEDRIVE' AND EXISTS(SELECT 1 FROM storage_accounts WHERE connection_id = cloud_connections.id)
               THEN capabilities_json ELSE @capabilitiesJson END,
             access_expires_at = @accessExpiresAt,
             provision_state = CASE WHEN provider = 'ONEDRIVE' AND EXISTS(SELECT 1 FROM storage_accounts WHERE connection_id = cloud_connections.id)
               THEN provision_state ELSE @provisionState END, revision = revision + 1,
             last_checked_at = @timestamp, updated_at = @timestamp,
             disconnected_at = NULL
         WHERE id = @id AND revision = @expectedRevision
           AND provider = @provider AND external_account_id = @externalAccountId
           AND secret_ref = @previousSecretRef
           AND auth_state <> 'DISCONNECTED'`,
      )
      .run({
        id: input.id,
        expectedRevision: input.expectedRevision,
        previousSecretRef: input.previousSecretRef.id,
        newSecretRef: input.newSecretRef.id,
        ...material,
        scopesJson: JSON.stringify(material.scopes),
        capabilitiesJson: JSON.stringify(material.capabilities),
        timestamp,
      });
    if (result.changes !== 1) throw new Error('OAUTH_REAUTHORIZE_FENCE_REJECTED');
    this.db.prepare('DELETE FROM cloud_connection_runtime WHERE connection_id = ?').run(input.id);
    return this.get(input.id);
  }

  reviveDisconnectedOAuthConnection(input: {
    id: string;
    expectedRevision: number;
    newSecretRef: OAuthConnectionCredentialRef;
    material: OAuthConnectionMaterial;
    at?: number;
  }): CloudConnection {
    this.assertWebManaged(input.id);
    const timestamp = input.at ?? this.now();
    const material = this.validateMaterial(input.material);
    const revived = this.db
      .prepare(
        `UPDATE cloud_connections
         SET label = @principalMasked, principal_masked = @principalMasked,
             auth_state = 'CONNECTED', secret_ref = @newSecretRef,
             scopes_json = @scopesJson, capabilities_json = @capabilitiesJson,
             access_expires_at = @accessExpiresAt, provision_state = @provisionState,
             revision = revision + 1, last_checked_at = @timestamp,
             updated_at = @timestamp, disconnected_at = NULL
         WHERE id = @id AND revision = @expectedRevision
           AND provider = @provider AND external_account_id = @externalAccountId
           AND auth_state = 'DISCONNECTED' AND secret_ref IS NULL`,
      )
      .run({
        id: input.id,
        expectedRevision: input.expectedRevision,
        newSecretRef: input.newSecretRef.id,
        ...material,
        scopesJson: JSON.stringify(material.scopes),
        capabilitiesJson: JSON.stringify(material.capabilities),
        timestamp,
      });
    if (revived.changes !== 1) throw new Error('OAUTH_REAUTHORIZE_FENCE_REJECTED');
    this.db.prepare('DELETE FROM cloud_connection_runtime WHERE connection_id = ?').run(input.id);
    return this.get(input.id);
  }

  patchLabel(input: {
    id: string;
    expectedRevision: number;
    label: string;
    at?: number;
  }): CloudConnection {
    this.assertWebManaged(input.id);
    const result = this.db
      .prepare(
        `UPDATE cloud_connections
         SET label = @label, revision = revision + 1, updated_at = @updatedAt
         WHERE id = @id AND revision = @expectedRevision
           AND auth_state <> 'DISCONNECTED'`,
      )
      .run({
        ...input,
        label: input.label.trim(),
        updatedAt: input.at ?? this.now(),
      });
    if (result.changes !== 1) this.throwMutationMiss(input.id, input.expectedRevision);
    return this.get(input.id);
  }

  disable(input: { id: string; expectedRevision: number; at?: number }): CloudConnection {
    this.assertWebManaged(input.id);
    return this.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE cloud_connections
           SET auth_state = 'DISABLED', revision = revision + 1, updated_at = @updatedAt
           WHERE id = @id AND revision = @expectedRevision
             AND auth_state IN ('CONNECTED', 'REAUTH_REQUIRED', 'ERROR')`,
        )
        .run({ ...input, updatedAt: input.at ?? this.now() });
      if (result.changes !== 1) this.throwMutationMiss(input.id, input.expectedRevision);
      this.db.prepare('DELETE FROM cloud_connection_runtime WHERE connection_id = ?').run(input.id);
      return this.get(input.id);
    });
  }

  enable(input: { id: string; expectedRevision: number; at?: number }): CloudConnection {
    this.assertWebManaged(input.id);
    return this.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE cloud_connections
           SET auth_state = 'CONNECTED', revision = revision + 1, updated_at = @updatedAt
           WHERE id = @id AND revision = @expectedRevision
             AND auth_state = 'DISABLED' AND secret_ref IS NOT NULL`,
        )
        .run({ ...input, updatedAt: input.at ?? this.now() });
      if (result.changes !== 1) this.throwMutationMiss(input.id, input.expectedRevision);
      this.db.prepare('DELETE FROM cloud_connection_runtime WHERE connection_id = ?').run(input.id);
      return this.get(input.id);
    });
  }

  disconnect(input: { id: string; expectedRevision: number; at?: number }): {
    connection: CloudConnection;
    removedSecretRef: OAuthConnectionCredentialRef | null;
  } {
    this.assertWebManaged(input.id);
    return this.transaction(() => {
      const authority = this.authority(input.id);
      if (authority.revision !== input.expectedRevision) {
        throw new Error('CONNECTION_REVISION_CONFLICT');
      }
      if (authority.authState === 'DISCONNECTED') {
        throw new Error('CONNECTION_AUTH_STATE_INVALID');
      }
      const references = this.referenceSummary(input.id);
      if (Object.values(references).some((count) => count > 0)) {
        throw new CloudConnectionReferencedError(references);
      }
      const timestamp = input.at ?? this.now();
      const changed = this.db
        .prepare(
          `UPDATE cloud_connections
           SET auth_state = 'DISCONNECTED', secret_ref = NULL, scopes_json = '[]',
               capabilities_json = '[]', access_expires_at = NULL,
               revision = revision + 1, updated_at = ?, disconnected_at = ?
           WHERE id = ? AND revision = ? AND auth_state <> 'DISCONNECTED'`,
        )
        .run(timestamp, timestamp, input.id, input.expectedRevision);
      if (changed.changes !== 1) throw new Error('CONNECTION_REVISION_CONFLICT');
      this.db.prepare('DELETE FROM cloud_connection_runtime WHERE connection_id = ?').run(input.id);
      return { connection: this.get(input.id), removedSecretRef: authority.secretRef };
    });
  }

  recordChecked(input: { id: string; expectedRevision: number; at?: number }): CloudConnection {
    const timestamp = input.at ?? this.now();
    const changed = this.db
      .prepare(
        `UPDATE cloud_connections
         SET last_checked_at = ?, updated_at = ?
         WHERE id = ? AND revision = ? AND auth_state = 'CONNECTED'`,
      )
      .run(timestamp, timestamp, input.id, input.expectedRevision);
    if (changed.changes !== 1) this.throwMutationMiss(input.id, input.expectedRevision);
    return this.get(input.id);
  }

  referenceSummary(connectionId: string): CloudConnectionReferenceSummary {
    const row = this.db
      .prepare(`${CONNECTION_SELECT} WHERE connection.id = ?`)
      .get(connectionId) as ConnectionRow | undefined;
    if (!row) throw new Error('CONNECTION_NOT_FOUND');
    return {
      activeImportJobs: row.sourceImportJobs,
      destinationImportJobs: row.destinationImportJobs,
      activeOffloadJobs: row.activeOffloadJobs,
      mounts: row.mountReferences,
      storageBindings: row.storageBindingReferences,
      activeCatalogEntries: row.catalogReferences,
      recoveryCopies: row.recoveryReferences,
      activeCloudReplicas: row.replicaReferences,
    };
  }

  tryAcquireRefreshLease(input: {
    connectionId: string;
    ownerId: string;
    now: number;
    leaseMs: number;
  }): CloudConnectionRefreshLease | null {
    return this.transaction(() => {
      const current = this.refreshLease(input.connectionId);
      const leaseExpiresAt = input.now + input.leaseMs;
      if (current === null) {
        this.db
          .prepare(
            `INSERT INTO cloud_connection_refresh_leases(
               connection_id, owner_id, fencing_token, lease_expires_at,
               acquired_at, updated_at
             ) VALUES (?, ?, 1, ?, ?, ?)`,
          )
          .run(input.connectionId, input.ownerId, leaseExpiresAt, input.now, input.now);
        return this.refreshLease(input.connectionId);
      }
      if (current.leaseExpiresAt > input.now) return null;
      const changed = this.db
        .prepare(
          `UPDATE cloud_connection_refresh_leases
           SET owner_id = ?, fencing_token = fencing_token + 1,
               lease_expires_at = ?, acquired_at = ?, updated_at = ?
           WHERE connection_id = ? AND fencing_token = ? AND lease_expires_at <= ?`,
        )
        .run(
          input.ownerId,
          leaseExpiresAt,
          input.now,
          input.now,
          input.connectionId,
          current.fencingToken,
          input.now,
        );
      return changed.changes === 1 ? this.refreshLease(input.connectionId) : null;
    });
  }

  refreshLease(connectionId: string): CloudConnectionRefreshLease | null {
    const row = this.db
      .prepare(
        `SELECT connection_id AS connectionId, owner_id AS ownerId,
                fencing_token AS fencingToken, lease_expires_at AS leaseExpiresAt,
                acquired_at AS acquiredAt, updated_at AS updatedAt
         FROM cloud_connection_refresh_leases WHERE connection_id = ?`,
      )
      .get(connectionId) as CloudConnectionRefreshLease | undefined;
    return row ?? null;
  }

  renewRefreshLease(input: {
    connectionId: string;
    ownerId: string;
    fencingToken: number;
    expectedRevision: number;
    expectedProvider: CloudProvider;
    expectedSecretRef: OAuthConnectionCredentialRef;
    now: number;
    leaseMs: number;
  }): CloudConnectionRefreshLease | null {
    const renewed = this.db
      .prepare(
        `UPDATE cloud_connection_refresh_leases
         SET lease_expires_at = @leaseExpiresAt, updated_at = @now
         WHERE connection_id = @connectionId AND owner_id = @ownerId
           AND fencing_token = @fencingToken AND lease_expires_at > @now
           AND EXISTS (
             SELECT 1 FROM cloud_connections AS connection
             WHERE connection.id = @connectionId
               AND connection.revision = @expectedRevision
               AND connection.provider = @expectedProvider
               AND connection.secret_ref = @expectedSecretRefId
               AND connection.auth_state = 'CONNECTED'
               AND connection.disconnected_at IS NULL
           )`,
      )
      .run({
        ...input,
        expectedSecretRefId: input.expectedSecretRef.id,
        leaseExpiresAt: input.now + input.leaseMs,
      });
    return renewed.changes === 1 ? this.refreshLease(input.connectionId) : null;
  }

  assertRefreshFence(input: {
    connectionId: string;
    ownerId: string;
    fencingToken: number;
    expectedRevision: number;
    expectedProvider: CloudProvider;
    expectedExternalAccountId: string;
    expectedSecretRef: OAuthConnectionCredentialRef;
    now: number;
  }): CloudConnectionAuthority {
    const lease = this.refreshLease(input.connectionId);
    if (
      lease === null ||
      lease.ownerId !== input.ownerId ||
      lease.fencingToken !== input.fencingToken ||
      lease.leaseExpiresAt <= input.now
    ) {
      throw new Error('REFRESH_FENCE_REJECTED');
    }
    const authority = this.authority(input.connectionId);
    if (
      authority.revision !== input.expectedRevision ||
      authority.provider !== input.expectedProvider ||
      authority.externalAccountId !== input.expectedExternalAccountId ||
      authority.secretRef?.id !== input.expectedSecretRef.id ||
      authority.authState !== 'CONNECTED' ||
      authority.disconnectedAt !== null
    ) {
      throw new Error('REFRESH_FENCE_REJECTED');
    }
    return authority;
  }

  markRefreshCommitted(input: {
    connectionId: string;
    ownerId: string;
    fencingToken: number;
    expectedRevision: number;
    expectedProvider: CloudProvider;
    expectedExternalAccountId: string;
    expectedSecretRef: OAuthConnectionCredentialRef;
    accessExpiresAt: number;
    now: number;
  }): void {
    const changed = this.db
      .prepare(
        `UPDATE cloud_connections
         SET access_expires_at = @accessExpiresAt,
             last_checked_at = @now, updated_at = @now
         WHERE id = @connectionId
           AND revision = @expectedRevision
           AND provider = @expectedProvider
           AND external_account_id = @expectedExternalAccountId
           AND secret_ref = @expectedSecretRef
           AND auth_state = 'CONNECTED' AND disconnected_at IS NULL
           AND EXISTS (
             SELECT 1 FROM cloud_connection_refresh_leases AS lease
             WHERE lease.connection_id = @connectionId
               AND lease.owner_id = @ownerId
               AND lease.fencing_token = @fencingToken
               AND lease.lease_expires_at > @now
           )`,
      )
      .run({
        ...input,
        expectedSecretRef: input.expectedSecretRef.id,
      });
    if (changed.changes !== 1) throw new Error('REFRESH_FENCE_REJECTED');
  }

  private validateMaterial(material: OAuthConnectionMaterial): OAuthConnectionMaterial {
    const provider = CloudProviderSchema.parse(material.provider);
    const provisionState = CloudConnectionProvisionStateSchema.parse(material.provisionState);
    const capabilities = material.capabilities.map((capability) =>
      CloudConnectionCapabilitySchema.parse(capability),
    );
    validateCloudCapabilityEvidence({ provider, provisionState, capabilities });
    return {
      provider,
      externalAccountId: material.externalAccountId,
      principalMasked: maskCloudPrincipal(material.externalAccountId),
      scopes: [...material.scopes],
      capabilities,
      accessExpiresAt: material.accessExpiresAt,
      provisionState,
    };
  }

  private throwMutationMiss(id: string, expectedRevision: number): never {
    const row = this.db
      .prepare('SELECT revision, auth_state AS authState FROM cloud_connections WHERE id = ?')
      .get(id) as { revision: number; authState: string } | undefined;
    if (!row) throw new Error('CONNECTION_NOT_FOUND');
    if (row.revision !== expectedRevision) throw new Error('CONNECTION_REVISION_CONFLICT');
    throw new Error('CONNECTION_AUTH_STATE_INVALID');
  }

  assertWebManaged(id: string): void {
    if (
      this.db
        .prepare(
          'SELECT 1 FROM legacy_environment_connections WHERE connection_id=? UNION ALL SELECT 1 FROM baidu_profile_environment_connections WHERE connection_id=?',
        )
        .get(id, id) !== undefined
    )
      throw new Error('CONNECTION_READ_ONLY');
  }
}

export function maskCloudPrincipal(rawIdentity: string): string {
  const value = rawIdentity.trim();
  if (value.length === 0) throw new Error('CLOUD_PRINCIPAL_INVALID');
  const at = value.indexOf('@');
  if (at > 0 && at === value.lastIndexOf('@') && at < value.length - 1) {
    return `${value[0]}***@${value.slice(at + 1)}`.slice(0, 120);
  }
  if (value.length === 1) return '*';
  return `${value[0]}***${value.at(-1)}`.slice(0, 120);
}

export class CloudConnectionReferencedError extends Error {
  readonly code = 'CONNECTION_REFERENCED';

  constructor(readonly references: CloudConnectionReferenceSummary) {
    super('CONNECTION_REFERENCED');
    this.name = 'CloudConnectionReferencedError';
  }
}
