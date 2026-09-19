import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { open as openFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { FastifyInstance } from 'fastify';

import { buildApp } from './app.js';
import { AuditRepository } from './audit/repository.js';
import { AuthRepository } from './auth/repository.js';
import { AuthService } from './auth/service.js';
import { resolveMasterKeyCredential } from './config/credentials.js';
import { parseConfig, type AppConfig } from './config/env.js';
import { BootstrapService } from './onboarding/bootstrap.js';
import type { ManagedSetup } from './onboarding/routes.js';
import { ManagedMountRegistry } from './onboarding/mount-registry.js';
import { SecretBox } from './core/crypto.js';
import { openDatabase, type AppDatabase } from './db/database.js';
import { migrations } from './db/migrations.js';
import { EventHub } from './events/hub.js';
import {
  createRecoveryPreparationContext,
  type RecoveryPreparationContext,
} from './recovery/preparation-context.js';
import { recoveryPreparationCompatibilityReadOnly } from './recovery/preparation-compatibility.js';
import { OfficialBaiduGateway } from './imports/baidu-official-gateway.js';
import { BaiduCloudProviderAdapter } from './cloud-connections/baidu-provider.js';
import { loadBaiduClientRuntime } from './cloud-connections/baidu-client-runtime.js';
import { BaiduDeviceService } from './cloud-connections/baidu-device.js';
import { BaiduDeviceTransport } from './cloud-connections/baidu-device-transport.js';
import type { CloudConnectionProviderSession } from './cloud-connections/refresh-coordinator.js';
import { BaiduConnectionBrowseService } from './cloud-connections/baidu-browse.js';
import { MicrosoftOneDriveProviderAdapter } from './cloud-connections/onedrive-provider.js';
import { createCloudConnectionServices } from './cloud-connections/services.js';
import {
  EncryptionProfileRepository,
  EncryptionProfileService,
} from './cloud-connections/encryption-profiles.js';
import {
  OneDriveProvisionRepository,
  OneDriveProvisionService,
} from './cloud-connections/onedrive-provision.js';
import { RcloneOneDriveProvisionAdapter } from './cloud-connections/rclone-onedrive-provision.js';
import { OneDriveCredentialMaterializer } from './cloud-connections/onedrive-credentials.js';
import { DatabaseNativeRcloneAuthority } from './cloud-connections/native-rclone-authority.js';
import {
  loadLegacyBaiduEnvironment,
  registerLegacyBaiduEnvironment,
} from './cloud-connections/legacy-baidu.js';
import { BaiduImportPlanner } from './imports/baidu-planner.js';
import { DatabaseImportDestinationCatalog } from './imports/destinations.js';
import { ImportRepository } from './imports/repository.js';
import { GroupPipelineRuntime } from './imports/groups/runtime.js';
import { PipelineActivitySampler } from './system/pipeline-activity.js';
import { ImportPublicationService } from './imports/publication.js';
import { ImportSourceCleanupService } from './imports/source-cleanup.js';
import { readSourceDeleteApprovals } from './imports/source-delete-approvals.js';
import { ImportRevisionWatcher } from './imports/revision-watcher.js';
import { FileImportSecretStore } from './imports/secret-store.js';
import { ImportControlService, type ImportPlannerInput } from './imports/service.js';
import { DatabaseImportSourceConnectionCatalog } from './imports/source-connections.js';
import { ImportWorkerRepository } from './imports/worker-repository.js';
import { RecoveryWorkflowImportBackupWriter } from './imports/data-plane/backup-writer.js';
import { BaiduImportSource } from './imports/data-plane/baidu-source.js';
import { ImportDataPlaneLoop } from './imports/data-plane/loop.js';
import { ImportDataPlaneProcessor } from './imports/data-plane/processor.js';
import { ArchiveImportProcessor } from './imports/archive/processor.js';
import { ArchivePasswordStore } from './imports/archive/secrets.js';
import { ArchiveRepository } from './imports/archive/repository.js';
import { SevenZipArchiveCodec } from './imports/archive/sevenzip.js';
import { ArchiveVideoProbe } from './imports/archive/video-probe.js';
import { validateArchiveRuntime } from './imports/archive/runtime.js';
import type { ImportDataPlaneSourceResolver } from './imports/data-plane/types.js';
import { RangeDownloader } from './imports/data-plane/range-downloader.js';
import {
  DatabaseImportSourceResolver,
  importSourceBindingKey,
  legacyBoundSourceJob,
} from './imports/data-plane/source-resolver.js';
import { ImportDataPlaneError } from './imports/data-plane/errors.js';
import { ConnectionBoundBaiduGateway } from './imports/connection-bound-baidu-gateway.js';
import { ImportResourceScheduler } from './imports/data-plane/resource-scheduler.js';
import { ImportSpoolCapacityGate } from './imports/data-plane/spool-capacity.js';
import { LegacyImportSourceBindingService } from './imports/legacy-source-binding.js';
import {
  CommandRunnerRcloneExecutor,
  DatabaseRcloneImportDestinationResolver,
} from './imports/data-plane/rclone-destination.js';
import { SpoolManager } from './imports/data-plane/spool.js';
import { JobRepository } from './jobs/repository.js';
import { Worker } from './jobs/worker.js';
import { createJellyfinLibraryNotifier } from './jellyfin/library.js';
import { createStrictImportJellyfin } from './jellyfin/import-publication.js';
import { LiveImportLibraryCatalog } from './jellyfin/import-libraries.js';
import { createJellyfinPlaybackProbe } from './jellyfin/playback.js';
import { QbInventoryScheduler } from './qb/scheduler.js';
import { createQbServices } from './qb/services.js';
import { readDiskUsage } from './media/disk.js';
import { mountPointForAccount, rcAddressForIndex } from './media/mount-layout.js';
import { loadRehydratePlan } from './media/plan.js';
import { createMountProbe, createPrefetchReader } from './media/probe.js';
import { createMountDirectoryCache } from './media/publish.js';
import { createRcClient, createRcCredentialReader } from './media/rc-client.js';
import { MediaReconciler } from './media/reconciler.js';
import { createMediaServices, registerMediaHandlers } from './media/services.js';
import type { MediaServices } from './media/services.js';
import type { FarmPlanEntry } from './media/symlink-farm.js';
import { StorageAccountRepository } from './storage/accounts.js';
import { StorageAccountMonitor } from './storage/account-monitor.js';
import { HostMetricsSampler } from './system/host-metrics.js';
import type { CatalogRecorder } from './storage/offload-handler.js';
import type { CatalogCleanup, MountRefresh } from './storage/cleanup.js';
import {
  TransferSettingsRepository,
  TransferSettingsService,
} from './settings/transfer-settings.js';
import { NetdiskSettingsRepository, NetdiskSettingsService } from './settings/netdisk-settings.js';
import { OffloadSnapshotEventPublisher } from './storage/offload-event-publisher.js';
import { ProcessRunner } from './storage/process-runner.js';
import { RcloneClient } from './storage/rclone.js';
import {
  createOffloadServices,
  createRecoveryServices,
  registerOffloadHandlers,
} from './storage/services.js';
import type { OffloadServices, RecoveryServices } from './storage/services.js';

export type StartupMetadata = {
  host: string;
  port: number;
  environment: AppConfig['nodeEnv'];
  migrationVersion: number;
  processCorrelationId: string;
};

export type RuntimeClosers = {
  /** `undefined` when no rclone.conf is configured, so quota cannot be probed. */
  accountMonitor: { stop: () => Promise<void> } | undefined;
  hostMetrics: { stop: () => Promise<void> };
  groupPipeline?: { close: () => Promise<void> };
  worker: { stop: () => Promise<void> };
  /** Present whenever the complete ACTIVE import runtime is provisioned. */
  importDataPlaneLoop?: { stop: () => Promise<void> } | undefined;
  importRevisionWatcher: { stop: () => Promise<void> };
  /** Cancels the global OFFLOAD telemetry SSE timer before Fastify/EventHub close. */
  offloadSnapshotEvents: { close: () => void };
  scheduler: { stop: () => Promise<void> };
  /** `undefined` when no media paths are configured, so there is nothing to reconcile. */
  mediaReconciler: { stop: () => Promise<void> } | undefined;
  app: { close: () => Promise<void> };
  db: { close: () => unknown };
};

export type ShutdownSignal = 'SIGTERM' | 'SIGINT';

export type ShutdownSignalTarget = {
  exitCode: number | string | null | undefined;
  once: (signal: ShutdownSignal, listener: () => void) => unknown;
  off: (signal: ShutdownSignal, listener: () => void) => unknown;
};

export type ServerRuntime = RuntimeClosers & {
  config: AppConfig;
  app: FastifyInstance;
  db: AppDatabase;
  auth: AuthService;
  audit: AuditRepository;
  events: EventHub;
  jobs: JobRepository;
  worker: Worker;
  /** Bridges schema-v17 revisions written by the import data-plane to SSE. */
  importRevisionWatcher: ImportRevisionWatcher;
  /** The HTTP control plane shares the same schema-v17 authority as the worker. */
  imports: ImportControlService;
  /** Durable scheduler configuration and its live effective/activity projection. */
  transferSettings: TransferSettingsService;
  /** Independent netdisk/import scheduler and policy authority. */
  netdiskSettings: NetdiskSettingsService;
  /** Executes provider→spool→rclone work whenever the complete ACTIVE runtime is provisioned. */
  importDataPlaneLoop: ImportDataPlaneLoop | undefined;
  scheduler: QbInventoryScheduler;
  /** Refreshes account health and quota from each raw rclone remote. */
  accountMonitor: StorageAccountMonitor | undefined;
  /** Samples `/proc` so the dashboard can show load, bandwidth, and disk I/O. */
  hostMetrics: HostMetricsSampler;
  groupPipeline: GroupPipelineRuntime;
  /** Built only in ACTIVE mode; `undefined` means nothing can execute an offload. */
  offload: OffloadServices | undefined;
  /**
   * Built in both modes whenever an rclone.conf is configured. `undefined` means
   * no rclone.conf was given, so a bundle could not name the remotes it teaches
   * the operator to reconnect.
   */
  recovery: RecoveryServices | undefined;
  preparation: RecoveryPreparationContext;
  /**
   * Built whenever the media paths are configured, in either mode.
   *
   * Present in SHADOW on purpose: the read surface reports whether cloud playback
   * works, and hiding it made a SHADOW deployment look identical to a broken mount.
   * The ability to *act* is held out elsewhere — `registerMediaHandlers` returns no
   * handlers unless ACTIVE, and every command route re-checks the mode.
   */
  media: MediaServices | undefined;
  /** Public-only registry/probe refresh; no service restart or provider mutation. */
  refreshManagedMounts?: () => void;
  /**
   * Probes mounts and reconciles the farm on a timer. `undefined` when no media
   * paths are configured, since there would be nothing to probe.
   */
  mediaReconciler: MediaReconciler | undefined;
  processCorrelationId: string;
  stop: () => Promise<void>;
};

export type StartServerOptions = {
  guidedSetup?: boolean;
  bootstrapCredential?: Omit<ConstructorParameters<typeof BootstrapService>[0], 'auth' | 'hasAdmin'>;
  managedSetup?: ManagedSetup;
  initialImportBudget?: { maxBytes: string; reserveBytes: string };
  configureApp?: (runtime: Omit<ServerRuntime, 'stop' | 'processCorrelationId'>) => Promise<void> | void;
  providerFetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  processCorrelationId?: string;
  installSignalHandlers?: boolean;
  logStartup?: (metadata: StartupMetadata) => void;
  onStartupStage?: (stage: StartupStage) => void;
};

export type StartupStage =
  | 'CONFIGURATION'
  | 'DATABASE'
  | 'SERVICE_GRAPH'
  | 'BAIDU_CONFIGURATION'
  | 'RCLONE_RECOVERY'
  | 'RECOVERY_MATERIAL'
  | 'WORKERS'
  | 'LISTEN';

function migrationVersion(db: AppDatabase): number {
  const version = db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get();
  return typeof version === 'number' ? version : (migrations.at(-1)?.version ?? 0);
}

async function createResources(
  config: AppConfig,
  providerFetch?: typeof fetch,
  onStartupStage: (stage: StartupStage) => void = () => undefined,
  options: StartServerOptions = {},
): Promise<Omit<ServerRuntime, 'stop' | 'processCorrelationId'>> {
  onStartupStage('DATABASE');
  mkdirSync(config.stateDir, { recursive: true });
  const db = openDatabase(path.join(config.stateDir, 'ptvault.db'));
  const events = new EventHub();
  const offloadSnapshotEvents = new OffloadSnapshotEventPublisher({ sink: events });
  let groupPipeline: GroupPipelineRuntime | undefined;

  try {
    onStartupStage('SERVICE_GRAPH');
    // Environment values seed exactly once. INSERT OR IGNORE inside this
    // repository makes every later restart database-authoritative.
    const transferSettingsRepository = new TransferSettingsRepository(db, {
      offload: {
        // Before schema v22 an ACTIVE deployment always accepted serial
        // offloads, even while the parallel rollout flag was closed. Preserve
        // that first-start intent; the flag controls parallel provisioning,
        // not whether the legacy single-job path exists.
        creationEnabled: config.mode === 'ACTIVE' && config.offloadEnabled !== false,
        maxInFlight: config.offloadMaxInFlight,
        preflightConcurrency: config.offloadPreflightConcurrency,
        pauseSnapshotConcurrency: config.offloadPauseSnapshotConcurrency,
        maxPausedPipelines: config.offloadMaxPausedPipelines,
        hashConcurrency: config.offloadHashConcurrency,
        uploadConcurrency: 2,
        readbackConcurrency: 1,
      },
      netdisk: { creationEnabled: config.importEnabled, maxInFlight: 2 },
    });
    const netdiskSettingsRepository = new NetdiskSettingsRepository(db, {
      creationEnabled: config.importEnabled,
      maxInFlight: 2,
      localPreparationConcurrency: 2,
      uploadConcurrency: 1,
      spoolMaxBytes: options.initialImportBudget?.maxBytes ?? '1099511627776',
      spoolReserveBytes: options.initialImportBudget?.reserveBytes ?? '10737418240',
      defaultSourceConnectionId: null,
      defaultDestinationAccountId: null,
      defaultPublicationPolicy: 'ARCHIVE_ONLY',
      sourceStagingCleanupEnabled: false,
      sourceDeleteEnabled: false,
      sourceDeleteGraceSeconds: 604800,
    });
    const auth = new AuthService({
      repository: new AuthRepository(db),
      secretBox: new SecretBox(config.masterKey),
      now: () => new Date(),
    });
    const audit = new AuditRepository(db);
    onStartupStage('BAIDU_CONFIGURATION');
    const legacyBaidu =
      config.importBaiduAppCredentialFile !== null && config.importBaiduTokenFile !== null
        ? await loadLegacyBaiduEnvironment({
            appCredentialFile: config.importBaiduAppCredentialFile,
            tokenFile: config.importBaiduTokenFile,
            ...(providerFetch === undefined ? {} : { fetch: providerFetch }),
          })
        : undefined;
    const baiduProvider =
      config.baiduOauthClientId != null &&
      config.baiduOauthClientSecret != null &&
      config.baiduAppId != null
        ? new BaiduCloudProviderAdapter({
            clientId: config.baiduOauthClientId,
            clientSecret: config.baiduOauthClientSecret,
            appId: config.baiduAppId,
            ...(providerFetch === undefined ? {} : { fetch: providerFetch }),
          })
        : undefined;
    const oneDriveProvider =
      config.oneDriveOauthClientId == null
        ? undefined
        : new MicrosoftOneDriveProviderAdapter({
            clientId: config.oneDriveOauthClientId,
            ...(config.oneDriveOauthClientSecret == null
              ? {}
              : { clientSecret: config.oneDriveOauthClientSecret }),
            tenant: config.oneDriveTenant ?? 'organizations',
        });
    const baiduClientRuntime = config.baiduClientProfileFile == null ? undefined : loadBaiduClientRuntime(config.baiduClientProfileFile, { ...(providerFetch ? { fetch: providerFetch } : {}) });
    const deviceProvider = baiduClientRuntime?.provider ?? (config.guidedSetup ? baiduProvider : undefined);
    const providerAdapters = [baiduProvider, oneDriveProvider].filter(
      (provider): provider is NonNullable<typeof provider> => provider !== undefined,
    );
    const callbackOrigins = new Map(
      config.cloudOauthCallbackOrigin == null
        ? []
        : providerAdapters.map(
            (provider) => [provider.provider, config.cloudOauthCallbackOrigin!] as const,
          ),
    );
    let oneDriveCredentials: OneDriveCredentialMaterializer | undefined;
    const baseCloudConnections = createCloudConnectionServices({
      db,
      masterKey: config.masterKey,
      oauthProviders: new Map((config.cloudOauthCallbackOrigin == null ? [] : providerAdapters).map((provider) => [provider.provider, provider])),
      refreshProviders: new Map(providerAdapters.map((provider) => [provider.provider, provider])),
      ...(baiduClientRuntime ? { profileRefreshProvider: baiduClientRuntime.resolve } : {}),
      baiduDeviceEnabled: deviceProvider !== undefined,
      probeProviders: new Map(
        [...(legacyBaidu === undefined ? [] : [legacyBaidu.provider]), ...(baiduClientRuntime ? [baiduClientRuntime.provider] : []), ...providerAdapters].map(
          (provider) => [provider.provider, provider],
        ),
      ),
      connectionRefreshProviders: new Map(
        legacyBaidu === undefined ? [] : [[legacyBaidu.connectionId, legacyBaidu.provider]],
      ),
      oauthCallbackOrigins: callbackOrigins,
      oneDriveRuntimeConfigured: oneDriveProvider !== undefined && config.rcloneConfigPath !== null,
      baiduBrowseConfigured: baiduProvider !== undefined || legacyBaidu !== undefined || baiduClientRuntime !== undefined,
      oneDriveProvisionEnabled:
        oneDriveProvider !== undefined &&
        config.rcloneConfigPath !== null &&
        (config.oneDriveProvisionEnabled ?? false),
      onProviderSession: async (session) => {
        await oneDriveCredentials?.ensure(session);
      },
    });
    if (legacyBaidu !== undefined && !recoveryPreparationCompatibilityReadOnly)
      await registerLegacyBaiduEnvironment(db, baseCloudConnections.secrets, legacyBaidu);
    const rcloneRunner = new ProcessRunner({
      nativeConfig: {
        authority: new DatabaseNativeRcloneAuthority({
          db,
          secrets: baseCloudConnections.secrets,
          canonicalPath: config.rcloneConfigPath,
          onCredentialChanged: (connectionId) =>
            baseCloudConnections.refresh.invalidate(connectionId),
        }),
      },
    });
    // Recover native/candidate journals before HTTP or any worker can read an
    // old DB credential. An orphan still running requires an explicit drain;
    // starting another token source over it is not a successful restart.
    onStartupStage('RCLONE_RECOVERY');
    if (config.rcloneConfigPath !== null && !recoveryPreparationCompatibilityReadOnly)
      await rcloneRunner.recoverRcloneConfig(config.rcloneConfigPath);
    const oneDriveProvision =
      oneDriveProvider !== undefined && config.rcloneConfigPath !== null
        ? (() => {
            const profiles = new EncryptionProfileRepository(db);
            const profileService = new EncryptionProfileService({
              profiles,
              secrets: baseCloudConnections.secrets,
            });
            const escrowBox = new SecretBox(config.masterKey);
            const adapter = new RcloneOneDriveProvisionAdapter({
              runner: rcloneRunner,
              executable: config.rcloneBin,
              configPath: config.rcloneConfigPath,
              secrets: baseCloudConnections.secrets,
              sealEscrow: (plaintext) => escrowBox.seal(plaintext),
              ...(config.oneDriveOauthClientSecret == null
                ? {}
                : { clientSecret: config.oneDriveOauthClientSecret }),
            });
            oneDriveCredentials = new OneDriveCredentialMaterializer({ db, adapter });
            return new OneDriveProvisionService({
              repository: new OneDriveProvisionRepository(db),
              profiles,
              profileService,
              refresh: baseCloudConnections.refresh,
              adapter,
              credentials: oneDriveCredentials,
              enabled: config.oneDriveProvisionEnabled ?? false,
            });
          })()
        : undefined;
    const createBoundBaiduGateway =
      baiduProvider === undefined && legacyBaidu === undefined && baiduClientRuntime === undefined
        ? undefined
        : (binding: { connectionId: string; externalAccountId: string }) => {
            const appIdForSession = (session: CloudConnectionProviderSession): string | null => {
              const authority = baseCloudConnections.repository.authority(binding.connectionId);
              if (authority.provider !== 'BAIDU' || authority.externalAccountId !== binding.externalAccountId || authority.revision !== session.connectionRevision || authority.secretRef?.id !== session.secretRefId)
                throw new ImportDataPlaneError('AUTH_SOURCE_IDENTITY_DRIFT');
              const credential = baseCloudConnections.secrets.readOAuthConnectionCredential(authority.secretRef);
              const provider = authority.legacy
                ? legacyBaidu?.connectionId === binding.connectionId ? legacyBaidu.provider : undefined
                : credential.baiduClientProfile ? baiduClientRuntime?.resolve(credential) : baiduProvider;
              if (!provider || provider.clientId !== credential.clientId) throw new ImportDataPlaneError('AUTH_SOURCE_CLIENT_NOT_CONFIGURED');
              return provider.appId;
            };
            return new ConnectionBoundBaiduGateway({
              connectionId: binding.connectionId,
              externalAccountId: binding.externalAccountId,
              appId: null,
              appIdForSession,
              refresh: baseCloudConnections.refresh,
              rateLimits: baseCloudConnections.rateLimits,
              createGateway: (session) =>
                new OfficialBaiduGateway({
                  tokens: { getSession: () => Promise.resolve(session) },
                  ...(providerFetch === undefined ? {} : { fetch: providerFetch }),
                }),
            });
          };
    const baiduBrowse =
      createBoundBaiduGateway === undefined
        ? undefined
        : new BaiduConnectionBrowseService(db, createBoundBaiduGateway);
    const cloudConnections = {
      ...baseCloudConnections,
      ...(deviceProvider === undefined ? {} : { baiduDevice: new BaiduDeviceService({ cloud: baseCloudConnections, clientId: deviceProvider.clientId, inspect: token => deviceProvider.inspectLegacyToken(token), clientLabel: baiduClientRuntime ? 'AList 公共百度客户端（基本浏览与下载）' : '自定义百度客户端', ...(baiduClientRuntime ? { profile: baiduClientRuntime.profile } : {}), transport: baiduClientRuntime?.transport ?? new BaiduDeviceTransport({ clientId: config.baiduOauthClientId!, clientSecret: config.baiduOauthClientSecret!, ...(providerFetch ? { fetch: providerFetch } : {}) }) }) }),
      ...(oneDriveProvision === undefined ? {} : { oneDriveProvision }),
      ...(baiduBrowse === undefined ? {} : { baiduBrowse }),
    };
    const jobs = new JobRepository(db);
    const qb = createQbServices({ db, config });

    // Filled in below, once the media graph exists. The offload graph is built
    // first because the media graph needs real disk capacity read from the hot
    // root, while a commit — which is what writes a catalog row — can only happen
    // after both are constructed.
    const catalogRecorder: { current?: CatalogRecorder } = {};
    const cleanupCatalog: { current?: CatalogCleanup } = {};
    const cleanupRefresh: { current?: MountRefresh } = {};
    const playback =
      config.jellyfinUrl !== null && config.jellyfinTokenFile !== null
        ? createJellyfinPlaybackProbe({
            baseUrl: config.jellyfinUrl,
            tokenFile: config.jellyfinTokenFile,
            pathMaps: config.jellyfinPathMaps,
          })
        : undefined;

    // SHADOW never builds the executor at all, so there is no object in this
    // process capable of pausing a torrent, uploading a byte, or deleting a local
    // file — the worker's handler table stays empty and an OFFLOAD job would land
    // in BLOCKED/HANDLER_NOT_REGISTERED. `parseConfig` guarantees a non-null
    // rclone config whenever the mode is ACTIVE, which is what makes this narrow.
    onStartupStage('RECOVERY_MATERIAL');
    const preparation = createRecoveryPreparationContext({ db, stateDirectory: config.stateDir });
    await preparation.writer.reconcileStartup(preparation.readOnly);
    onStartupStage('SERVICE_GRAPH');
    const offload: OffloadServices | undefined =
      config.mode === 'ACTIVE' &&
      config.offloadEnabled !== false &&
      config.rcloneConfigPath !== null
        ? createOffloadServices({
            preparation,
            db,
            rcloneRunner,
            config: {
              masterKey: config.masterKey,
              rcloneBin: config.rcloneBin,
              rcloneConfigPath: config.rcloneConfigPath,
              offloadParallelEnabled: config.offloadParallelEnabled,
              offloadPreflightConcurrency: config.offloadPreflightConcurrency,
              offloadPauseSnapshotConcurrency: config.offloadPauseSnapshotConcurrency,
              offloadMaxPausedPipelines: config.offloadMaxPausedPipelines,
              offloadHashConcurrency: config.offloadHashConcurrency,
              offloadRemoteDataConcurrency: config.offloadRemoteDataConcurrency,
            },
            registry: qb.registry,
            torrentRepository: qb.repository,
            preflight: qb.preflight,
            jobs,
            settings: transferSettingsRepository,
            catalogRecorder,
            cleanupCatalog,
            cleanupRefresh,
            onSnapshot: (snapshot, eventCode, publication) =>
              offloadSnapshotEvents.publish(snapshot, eventCode, publication),
            ...(playback ? { playback } : {}),
          })
        : undefined;

    // Built in BOTH modes, unlike the executor above. `OffloadHandler` asks the
    // recovery gate for a deletion permit during HASHING — before a single byte
    // moves — so an operator who cannot build recovery material first cannot
    // upload at all. Gating this on ACTIVE would demand they arm the destructive
    // switch before the material that makes deletion survivable could exist.
    // Generating a bundle pauses no torrent and deletes nothing local; it writes
    // a few MB of encrypted metadata to the operator's own accounts.
    const recovery: RecoveryServices | undefined =
      config.rcloneConfigPath !== null
        ? createRecoveryServices({
            preparation,
            db,
            rcloneRunner,
            config: {
              rcloneBin: config.rcloneBin,
              ageBin: config.ageBin,
              stateDir: config.stateDir,
              rcloneConfigPath: config.rcloneConfigPath,
            },
            torrentRepository: qb.repository,
          })
        : undefined;
    // Read before the graph is built so the reserve comes from the real disk. A
    // guessed capacity would put the safety line in the wrong place, and this line
    // is what keeps qB's own downloads from being starved by cache.
    const mediaTotalBytes =
      config.mediaHotRoot === null ? 0 : (await readDiskUsage(config.mediaHotRoot)).totalBytes;
    // The cache disk is read separately because it is a separate disk: the operator
    // put temporary viewing cache on the system SSD, deliberately away from the data
    // disk qB writes to. Bounding the cache ceiling by the hot disk's size is how the
    // API came to believe it had 250 GiB per mount on a 125 GB disk.
    const mediaCacheTotalBytes =
      config.mediaCacheDir === null
        ? mediaTotalBytes
        : (await readDiskUsage(config.mediaCacheDir)).totalBytes;

    // Built whenever the media paths are configured, in either mode.
    //
    // Not gated on ACTIVE, unlike the executor: this graph's read surface — the
    // catalog, mount health, the farm — is how an operator sees whether cloud
    // playback works at all, and gating it made a SHADOW deployment answer 404 on
    // every media route while `mount_health` stayed empty. That is indistinguishable
    // from a broken mount, which is the one thing this surface exists to report.
    //
    // What must not exist in SHADOW is the ability to *act*: a restore writes
    // hundreds of gigabytes to the hot disk and then tells qB to announce. That is
    // held out by `registerMediaHandlers`, which returns no handlers unless ACTIVE,
    // and by the command routes below — the same split the offload graph already
    // uses, where planning is available in both modes and only the executor is not.
    const mediaHotRoot = config.mediaHotRoot;
    const mediaMountRoot = config.mediaMountRoot;
    const mediaFarmRoot = config.mediaFarmRoot;

    // One mount, one probe, one RC listener per storage account. Built from the
    // accounts table so registering an account is all it takes for its mount to be
    // supervised — the previous single-mount shape pointed at whichever remote was
    // configured, and on the real machine that was not the account holding the only
    // migrated title.
    //
    // Sorted by account id, not by label: the index decides which loopback RC port a
    // mount answers on, and a renamed label would shuffle every port after it.
    // Reads the RC password once and caches it. Built outside the loop so every
    // mount shares one reader rather than each re-reading the same file per probe.
    const readRcCredential =
      config.mediaRcCredentialFile === null
        ? undefined
        : createRcCredentialReader(config.mediaRcCredentialFile);
    const mediaAccounts = new StorageAccountRepository(db, () => Date.now(), {
      legacyRcloneConfigured: config.rcloneConfigPath !== null,
      webOAuthRuntimeConfigured: config.rcloneConfigPath !== null,
    });
    const isMediaAccountEligible = (accountId: string): boolean => {
      try {
        mediaAccounts.getEligible(accountId, 'EXISTING_WORK');
        return true;
      } catch {
        return false;
      }
    };
    const managedMountRegistry = options.guidedSetup ? new ManagedMountRegistry(config.stateDir) : undefined;
    const listMediaAccounts = () => mediaAccounts.listEligible('EXISTING_WORK').sort((a,b)=>a.id.localeCompare(b.id));
    const makeMediaMounts = () => {
      const accounts = mediaMountRoot === null ? [] : listMediaAccounts();
      const addresses = managedMountRegistry?.allocate(accounts.map(account=>account.id));
      return (
      mediaMountRoot === null
        ? []
        : accounts
            .map((account) => account.id)
            .sort()
            .map((accountId, index) => {
              const mountPoint = mountPointForAccount(mediaMountRoot, accountId);
              // One client per mount, addressed by this account's index — each
              // mount is its own rclone process, and asking the wrong one returns
              // another account's numbers while the mount in question is dead.
              // Without a password file there is nothing to authenticate with, so
              // the probe reports the mount unreachable rather than pretending:
              // `mounted` then stays false, which is the honest answer for a mount
              // this process cannot interrogate.
              //
              // Held in a variable rather than inlined into the probe because the
              // directory cache below speaks to the same listener: a refresh sent to
              // one account's rclone does nothing for another's cache.
              const rc =
                readRcCredential === undefined
                  ? { call: () => Promise.reject(new Error('MOUNT_RC_NOT_CONFIGURED')) }
                  : createRcClient({
                      address: addresses?.get(accountId)?.media ?? rcAddressForIndex(config.mediaRcBasePort, index),
                      readCredential: readRcCredential,
                    });
              return {
                accountId,
                mountPoint,
                probe: createMountProbe({ mountPoint, rc }),
                directoryCache: createMountDirectoryCache({ accountId, rc }),
              };
            }));
    };
    const mediaMounts = makeMediaMounts();
    // Split rather than passed through as one shape: the supervisor's contract is
    // that it only observes, and handing it an object able to make rclone re-walk an
    // account's blob tree would quietly break that.
    const supervisedMounts = mediaMounts.map(({ accountId, mountPoint, probe }) => ({
      accountId,
      mountPoint,
      probe,
    }));
    const mountDirectoryCaches = mediaMounts.map((mount) => mount.directoryCache);
    // Existing PT mounts expose crypt:blobs. Netdisk objects live under
    // crypt:ptvault-imports and must never be projected into the PT namespace.
    const makeImportMounts = () => {
      const addresses = managedMountRegistry?.allocate(mediaMounts.map(mount=>mount.accountId));
      return (
      config.importMountRoot === null || readRcCredential === undefined
        ? []
        : mediaMounts.map(({ accountId }, index) => {
            const rc = createRcClient({
              address: addresses?.get(accountId)?.imports ?? rcAddressForIndex(config.importRcBasePort, index),
              readCredential: readRcCredential,
            });
            return {
              accountId,
              probe: createMountProbe({
                mountPoint: mountPointForAccount(config.importMountRoot!, accountId),
                rc,
              }),
              directoryCache: createMountDirectoryCache({ accountId, rc }),
            };
          }));
    };
    const importMounts = makeImportMounts();
    const mediaRclone =
      config.mode !== 'ACTIVE' || config.rcloneConfigPath === null
        ? undefined
        : new RcloneClient({
            runner: rcloneRunner,
            executable: config.rcloneBin,
            configPath: config.rcloneConfigPath,
          });
    // Filled after the independent import publication catalog is constructed.
    // The media reconciler reads through the closure on every tick, so turning
    // the publication mutation gate off never removes an already-published link.
    const importPublicationPlan: { current: () => readonly FarmPlanEntry[] } = {
      current: () => [],
    };
    const media: MediaServices | undefined =
      mediaHotRoot !== null && mediaMountRoot !== null && mediaFarmRoot !== null
        ? createMediaServices({
            db,
            readOnly: preparation.readOnly,
            config: {
              rcloneBin: config.rcloneBin,
              mediaHotRoot,
              mediaMountRoot,
              ...(config.importMountRoot === null
                ? {}
                : { importMountRoot: config.importMountRoot }),
              mediaFarmRoot,
              mediaCacheDir: config.mediaCacheDir,
            },
            registry: qb.registry,
            torrentRepository: qb.repository,
            readSavings: () => qb.repository.storageSavings(),
            // One supervised mount per storage account, read from the accounts table
            // rather than configured by hand. Accounts are registered through the
            // API, and a hand-maintained list would silently omit whichever account
            // was added last — which is exactly the failure the real machine had,
            // where the single mount pointed at one account while the only migrated
            // title lived on the other.
            mounts: supervisedMounts,
            directoryCaches: mountDirectoryCaches,
            additionalFarmPlan: () => importPublicationPlan.current(),
            isAccountEligible: isMediaAccountEligible,
            // Only when Jellyfin is configured. Without it the farm still
            // reconciles correctly; the library just learns about it on its own
            // next scan instead of immediately.
            ...(config.jellyfinUrl !== null && config.jellyfinTokenFile !== null
              ? {
                  onFarmChanged: (result) =>
                    createJellyfinLibraryNotifier({
                      baseUrl: config.jellyfinUrl as string,
                      tokenFile: config.jellyfinTokenFile as string,
                      farmRoot: mediaFarmRoot,
                      pathMaps: config.jellyfinPathMaps,
                    }).notify(result),
                }
              : {}),
            reader: createPrefetchReader({
              // Through the farm, so a warmed range lands in the cache of whichever
              // account actually backs that title.
              farmRoot: mediaFarmRoot,
              open: async (absolutePath) => {
                const handle = await openFile(absolutePath, 'r');
                return {
                  read: async (buffer, offset, length, position) =>
                    (await handle.read(buffer, offset, length, position)).bytesRead,
                  close: () => handle.close(),
                };
              },
            }),
            rclone: {
              copyTo: (remotePath, localPath, signal) => {
                if (!mediaRclone) return Promise.reject(new Error('RCLONE_NOT_CONFIGURED'));
                return mediaRclone.copy(remotePath, localPath, signal);
              },
            },
            loadPlan: (input) => {
              const accountId = db
                .prepare(
                  `SELECT active_account_id FROM media_catalog
                   WHERE instance_id = ? AND torrent_hash = ?`,
                )
                .pluck()
                .get(input.instanceId, input.torrentHash);
              if (typeof accountId !== 'string' || !isMediaAccountEligible(accountId)) return null;
              return loadRehydratePlan(db, input);
            },
            // Capacity is read at startup so the reserve is derived from the real
            // disk rather than a guess; a wrong reserve is a wrong safety line.
            totalBytes: mediaTotalBytes,
            cacheTotalBytes: mediaCacheTotalBytes,
          })
        : undefined;
    let managedMountSignature = JSON.stringify(mediaMounts.map(mount=>mount.accountId));
    const refreshManagedMounts = () => {
      if (!managedMountRegistry) return;
      const accounts = media === undefined ? [] : listMediaAccounts();
      const signature = JSON.stringify(accounts.map(account=>account.id));
      if (media !== undefined && signature !== managedMountSignature) {
        const next = makeMediaMounts();
        mediaMounts.splice(0,mediaMounts.length,...next);
        supervisedMounts.splice(0,supervisedMounts.length,...next.map(({accountId,mountPoint,probe})=>({accountId,mountPoint,probe})));
        mountDirectoryCaches.splice(0,mountDirectoryCaches.length,...next.map(mount=>mount.directoryCache));
        importMounts.splice(0,importMounts.length,...makeImportMounts());
        media.replaceMounts?.(supervisedMounts,mountDirectoryCaches);
        managedMountSignature = signature;
      }
      managedMountRegistry.publish({enabled:media!==undefined,accounts:accounts.map(({id,cryptRemote})=>({id,cryptRemote})),
        cacheMaxBytes:media?.policy.cacheMaxBytes ?? 0,reserveBytes:media?.policy.cacheReserveBytes ?? 0});
    };
    // Reachable from a commit only now that the media graph exists. Assigned only
    // when there is one: under `exactOptionalPropertyTypes` writing `undefined` and
    // leaving the property absent are different states, and "no media surface
    // configured" is the absent one.
    if (media !== undefined) {
      catalogRecorder.current = media.catalogRecorder;
      cleanupCatalog.current = media.catalog;
    }

    // Filled in once `app` exists. `onHandlerError` reads through this holder
    // rather than capturing a logger, because the worker must be constructed
    // before `buildApp` yet a handler can only run after startup completes — by
    // which time the logger is always present.
    const logger: { current?: FastifyInstance['log'] } = {};
    const importWorkerRepository = new ImportWorkerRepository(db);
    const importRevisionWatcher = new ImportRevisionWatcher({
      repository: importWorkerRepository,
      events,
      onError: () => {
        logger.current?.warn('import revision poll failed');
      },
    });
    const importRuntimeConfigured =
      config.mode === 'ACTIVE' &&
      config.importSecretRoot !== null &&
      config.importSpoolRoot !== null &&
      (baiduProvider !== undefined || legacyBaidu !== undefined || baiduClientRuntime !== undefined) &&
      config.rcloneConfigPath !== null &&
      config.importRecoveryAccountIds.length >= 2 &&
      recovery !== undefined;
    const importSecrets = importRuntimeConfigured
      ? new FileImportSecretStore(config.importSecretRoot as string)
      : undefined;
    const boundBaiduGateway =
      createBoundBaiduGateway === undefined
        ? undefined
        : (binding: { sourceConnectionId: string; sourceExternalAccountId: string }) =>
            createBoundBaiduGateway({
              connectionId: binding.sourceConnectionId,
              externalAccountId: binding.sourceExternalAccountId,
            });
    const importPlanner =
      boundBaiduGateway !== undefined && importSecrets !== undefined
        ? {
            plan: async (input: ImportPlannerInput) => {
              if (input.sourceBinding == null) {
                throw new ImportDataPlaneError('IMPORT_SOURCE_BINDING_REQUIRED');
              }
              return new BaiduImportPlanner({
                gateway: boundBaiduGateway(input.sourceBinding),
                secrets: importSecrets,
              }).plan(input);
            },
          }
        : undefined;
    const importPhotoRoots = [
      ...(mediaMountRoot === null
        ? []
        : [path.posix.join(mediaMountRoot, 'ptvault-classification/photos')]),
      '/cloud/ptvault-classification/photos',
    ];
    const importLibraryCatalog =
      config.importPublicationEnabled &&
      mediaFarmRoot !== null &&
      config.jellyfinUrl !== null &&
      config.jellyfinTokenFile !== null
        ? new LiveImportLibraryCatalog({
            baseUrl: config.jellyfinUrl,
            readToken: () => readFile(config.jellyfinTokenFile!, 'utf8'),
            farmRoot: mediaFarmRoot,
            pathMaps: config.jellyfinPathMaps,
            legacy: config.importJellyfinLibraries,
            photoRoots: importPhotoRoots,
          })
        : undefined;
    await importLibraryCatalog?.refresh();
    const importPublication: ImportPublicationService | undefined =
      media !== undefined &&
      mediaFarmRoot !== null &&
      config.jellyfinUrl !== null &&
      config.jellyfinTokenFile !== null &&
      config.importMountRoot !== null
        ? new ImportPublicationService({
            db,
            libraries: config.importJellyfinLibraries,
            ...(importLibraryCatalog === undefined ? {} : { libraryCatalog: importLibraryCatalog }),
            farm: media.farm,
            baseFarmPlan: media.buildBaseFarmPlan,
            isMountable: async (accountId) => {
              const mount = importMounts.find((candidate) => candidate.accountId === accountId);
              if (mount === undefined || !isMediaAccountEligible(accountId)) return false;
              return (
                importDestinations.supportsPublication(accountId) &&
                (await mount.probe.mountpointPresent()) &&
                (await mount.probe.rcReachable())
              );
            },
            refreshVfs: async (accountId, cloudLogicalPaths) => {
              const cache = importMounts.find(
                (candidate) => candidate.accountId === accountId,
              )?.directoryCache;
              if (cache === undefined) throw new Error('MOUNT_DIRECTORY_CACHE_NOT_FOUND');
              await cache.invalidate(cloudLogicalPaths);
            },
            probeLink: async (linkRelativePath, expectedSize) => {
              const handle = await openFile(path.posix.join(mediaFarmRoot, linkRelativePath), 'r');
              try {
                const stats = await handle.stat({ bigint: true });
                if (!stats.isFile() || stats.size.toString() !== expectedSize) {
                  throw new Error('IMPORT_PUBLICATION_TARGET_MISMATCH');
                }
                if (stats.size > 0n) {
                  const probe = Buffer.alloc(1);
                  const read = await handle.read(probe, 0, 1, 0);
                  if (read.bytesRead !== 1) throw new Error('IMPORT_PUBLICATION_READ_EMPTY');
                }
              } finally {
                await handle.close();
              }
            },
            jellyfin: createStrictImportJellyfin({
              photoRoots: importPhotoRoots,
              baseUrl: config.jellyfinUrl,
              tokenFile: config.jellyfinTokenFile,
              farmRoot: mediaFarmRoot,
              pathMaps: config.jellyfinPathMaps,
            }),
          })
        : undefined;
    if (importPublication !== undefined) {
      importPublicationPlan.current = () => importPublication.buildPublicationFarmPlan();
    }
    const importSourceCleanup =
      boundBaiduGateway === undefined
        ? undefined
        : new ImportSourceCleanupService({
            db,
            sourceDeleteApprovals: () =>
              readSourceDeleteApprovals(config.importSourceDeleteApprovalFile ?? null, Date.now()),
            featureEnabled: importRuntimeConfigured && config.importSourceCleanupEnabled,
            selectedSourceDeleteEnabled:
              importRuntimeConfigured &&
              config.importSourceCleanupEnabled &&
              config.importSelectedSourceDeleteEnabled,
            settings: () => {
              const values = netdiskSettingsRepository.read().values;
              return {
                sourceStagingCleanupEnabled: values.sourceStagingCleanupEnabled,
                sourceDeleteEnabled: values.sourceDeleteEnabled,
                sourceDeleteGraceSeconds: values.sourceDeleteGraceSeconds,
              };
            },
            requiredRecoveryAccountIds: config.importRecoveryAccountIds,
            providers: {
              resolve: (binding) =>
                boundBaiduGateway({
                  sourceConnectionId: binding.connectionId,
                  sourceExternalAccountId: binding.externalAccountId,
                }),
            },
          });
    const importDestinations: DatabaseImportDestinationCatalog =
      new DatabaseImportDestinationCatalog(
        db,
        config.mode,
        importRuntimeConfigured,
        () => netdiskSettingsRepository.read().values.creationEnabled,
        () => new Date(),
        {
          enabled: () => config.importPublicationEnabled && importPublication !== undefined,
          libraries: config.importJellyfinLibraries,
          ...(importLibraryCatalog === undefined ? {} : { libraryCatalog: importLibraryCatalog }),
          mounts: supervisedMounts,
        },
      );
    let archivePasswords: ArchivePasswordStore | undefined;
    if (
      config.importArchiveRuntime != null &&
      config.mode === 'ACTIVE' &&
      !preparation.readOnly &&
      importRuntimeConfigured &&
      config.importSecretRoot !== null &&
      recovery !== undefined
    ) {
      await validateArchiveRuntime(config.importArchiveRuntime);
      archivePasswords = new ArchivePasswordStore({
        root: path.join(config.importSecretRoot, 'archive-candidates'),
        box: new SecretBox(config.masterKey),
        fingerprintKey: config.masterKey,
      });
      archivePasswords.pruneExpired();
    }
    let importDataPlaneLoop: ImportDataPlaneLoop | undefined;
    const groupedProvisioned =
      config.mode === 'ACTIVE' &&
      !preparation.readOnly &&
      importRuntimeConfigured &&
      archivePasswords !== undefined &&
      boundBaiduGateway !== undefined &&
      recovery !== undefined;
    groupPipeline = new GroupPipelineRuntime({
      activity: new PipelineActivitySampler({
        db,
        ...(groupedProvisioned && config.jellyfinUrl !== null && config.jellyfinTokenFile !== null
          ? {
              jellyfin: {
                baseUrl: config.jellyfinUrl,
                readToken: () => readFile(config.jellyfinTokenFile!, 'utf8'),
              },
            }
          : {}),
      }),
      db,
      provisioned: () => groupedProvisioned,
      legacySettings: () => netdiskSettingsRepository.read().values,
      reservedBytes: () => importSpoolCapacity.reservedBytes(),
      observationPath: path.join(config.stateDir, 'pipeline-observations.sqlite'),
      build: `${config.buildVersion ?? 'development'} / ${config.buildCommit ?? 'unrecorded'}`,
      onCapacityChanged: () => importDataPlaneLoop?.notifyCapacityChanged(),
    });
    const groupRuntime = groupPipeline;
    const imports = new ImportControlService({
      grouping: {
        enabled: () => groupedProvisioned,
        repository: groupRuntime.repository,
        limits: () => groupRuntime.planLimits(),
      },
      ...(archivePasswords === undefined
        ? {}
        : {
            archive: {
              passwords: archivePasswords,
              spoolMaxBytes: () => netdiskSettingsRepository.read().values.spoolMaxBytes,
            },
          }),
      mode: config.mode,
      runtimeConfigured: importRuntimeConfigured,
      shareSourceConfigured: baiduProvider?.appId != null || legacyBaidu?.provider.appId != null,
      creationEnabled: () => netdiskSettingsRepository.read().values.creationEnabled,
      repository: new ImportRepository(db),
      destinations: importDestinations,
      events,
      sourceConnections: new DatabaseImportSourceConnectionCatalog(db),
      defaultSourceConnectionId: () =>
        netdiskSettingsRepository.read().values.defaultSourceConnectionId,
      defaultDestinationAccountId: () =>
        netdiskSettingsRepository.read().values.defaultDestinationAccountId,
      defaultPublicationPolicy: () =>
        netdiskSettingsRepository.read().values.defaultPublicationPolicy,
      libraries: config.importJellyfinLibraries,
      ...(importLibraryCatalog === undefined ? {} : { libraryCatalog: importLibraryCatalog }),
      publicationEnabled: config.importPublicationEnabled,
      jellyfinConfigured: config.jellyfinUrl !== null && config.jellyfinTokenFile !== null,
      ...(importPublication === undefined ? {} : { publicationController: importPublication }),
      ...(importSourceCleanup === undefined
        ? {}
        : { sourceCleanupController: importSourceCleanup }),
      ...(importPlanner === undefined ? {} : { planner: importPlanner }),
      ...(boundBaiduGateway === undefined
        ? {}
        : {
            legacySources: new LegacyImportSourceBindingService({
              db,
              providers: { resolve: boundBaiduGateway },
            }),
          }),
      ...(importSecrets === undefined ? {} : { secrets: importSecrets }),
    });
    const importResources = new ImportResourceScheduler(
      {
        maxInFlight: netdiskSettingsRepository.read().values.maxInFlight,
        localPreparationConcurrency:
          netdiskSettingsRepository.read().values.localPreparationConcurrency,
        uploadConcurrency: netdiskSettingsRepository.read().values.uploadConcurrency,
      },
      {
        waiting: (jobId, kind, observation) =>
          importWorkerRepository.recordResourceWait({
            jobId,
            kind,
            position: observation.position,
            active: observation.active,
            capacity: observation.capacity,
          }),
        acquired: (jobId, kind) => importWorkerRepository.clearResourceWait(jobId, kind),
        released: (jobId, kind) => importWorkerRepository.clearResourceWait(jobId, kind),
      },
    );
    const importSpoolCapacity = new ImportSpoolCapacityGate(
      db,
      () => {
        const values = netdiskSettingsRepository.read().values;
        return {
          spoolMaxBytes: values.spoolMaxBytes,
          spoolReserveBytes: values.spoolReserveBytes,
        };
      },
      {
        waiting: (jobId, position, availableBytes) =>
          importWorkerRepository.recordResourceWait({
            jobId,
            kind: 'SPOOL_CAPACITY',
            position,
            capacity: availableBytes,
          }),
        acquired: (jobId) => importWorkerRepository.clearResourceWait(jobId, 'SPOOL_CAPACITY'),
        released: (jobId) => importWorkerRepository.clearResourceWait(jobId, 'SPOOL_CAPACITY'),
      },
    );
    if (
      config.mode === 'ACTIVE' &&
      !preparation.readOnly &&
      importRuntimeConfigured &&
      importSecrets !== undefined &&
      boundBaiduGateway !== undefined &&
      recovery !== undefined
    ) {
      const spool = new SpoolManager({ root: config.importSpoolRoot as string });
      await spool.initialize();
      const rcloneExecutor = new CommandRunnerRcloneExecutor(rcloneRunner, config.rcloneBin);
      const importSources: ImportDataPlaneSourceResolver = {
        resolve: async (job) => {
          const resolvedBinding = legacyBoundSourceJob(db, job).job;
          if (
            resolvedBinding.sourceConnectionId == null ||
            (job.sourceKind !== 'BAIDU_SHARE' && job.sourceKind !== 'BAIDU_APP_DIR')
          ) {
            throw new ImportDataPlaneError('IMPORT_SOURCE_BINDING_REQUIRED');
          }
          const key = importSourceBindingKey(resolvedBinding.sourceConnectionId, job.sourceKind);
          return new DatabaseImportSourceResolver({
            db,
            factories: new Map([
              [
                key,
                (context) =>
                  new BaiduImportSource({
                    gateway: boundBaiduGateway({
                      sourceConnectionId: context.sourceConnectionId,
                      sourceExternalAccountId: context.sourceExternalAccountId,
                    }),
                    secrets: importSecrets,
                    transferJournal: importWorkerRepository,
                  }),
              ],
            ]),
          }).resolve(job);
        },
      };
      const importDownloader = new RangeDownloader({
        allowedHosts: config.importDownloadHosts,
        maximumParallelRequests: () => {
          const settings = groupRuntime.settings.status().effective;
          return settings.downloadConcurrency * settings.fileDownloadConnections;
        },
      });
      const archiveProcessing =
        archivePasswords === undefined || config.importArchiveRuntime == null
          ? undefined
          : new ArchiveImportProcessor({
              repository: new ArchiveRepository(db),
              worker: importWorkerRepository,
              sources: importSources,
              downloader: importDownloader,
              spool,
              spoolCapacity: importSpoolCapacity,
              codec: new SevenZipArchiveCodec(config.importArchiveRuntime),
              passwords: archivePasswords,
              reserveBytes: () => netdiskSettingsRepository.read().values.spoolReserveBytes,
              resources: importResources,
              groupResources: groupRuntime.resources,
              groupDownloadConnections: () =>
                groupRuntime.settings.status().effective.fileDownloadConnections,
              videoProbe: (filename, signal) =>
                new ArchiveVideoProbe({
                  runtimeRoot: config.importArchiveRuntime!.probeRuntimeRoot,
                  sandboxHelper: config.importArchiveRuntime!.sandboxHelper,
                }).probe(filename, signal),
            });
      importDataPlaneLoop = new ImportDataPlaneLoop({
        processor: new ImportDataPlaneProcessor({
          fileDownloadConnections: () => groupRuntime.settings.status().effective.fileDownloadConnections,
          ...(archiveProcessing === undefined
            ? {}
            : groupRuntime.attach({
                archive: archiveProcessing,
                worker: importWorkerRepository,
                spool,
                sources: importSources,
                downloader: importDownloader,
                capacity: importSpoolCapacity,
              })),
          repository: importWorkerRepository,
          sources: importSources,
          ...(archiveProcessing === undefined ? {} : { archiveProcessing }),
          destinations: new DatabaseRcloneImportDestinationResolver({
            db,
            executor: rcloneExecutor,
            configPath: config.rcloneConfigPath as string,
            webOAuthRuntimeConfigured: true,
          }),
          downloader: importDownloader,
          spool,
          backupWriter: new RecoveryWorkflowImportBackupWriter(
            recovery.workflow,
            config.importRecoveryAccountIds,
          ),
          resources: importResources,
          spoolCapacity: importSpoolCapacity,
          ...(config.importPublicationEnabled && importPublication !== undefined
            ? { publication: importPublication }
            : {}),
        }),
        // The loop provides bounded contenders; the scheduler owns the real,
        // independently resizable max-in-flight permit and durable wait state.
        maxInFlight: 8,
        onProcessorError: (error) => {
          logger.current?.error(
            { err: error instanceof Error ? { name: error.name, message: error.message } : error },
            'import data-plane processor failed',
          );
        },
      });
    }
    const worker = new Worker({
      repository: jobs,
      eventHub: events,
      handlers: offload
        ? {
            ...registerOffloadHandlers({
              mode: config.mode,
              handler: offload.handler,
              promoteHandler: offload.promoteHandler,
            }),
            ...(media
              ? registerMediaHandlers({
                  mode: config.mode,
                  rehydrateHandler: media.rehydrateHandler,
                  prefetchHandler: media.prefetchHandler,
                })
              : {}),
          }
        : {},
      offloadParallel: {
        enabled: config.offloadParallelEnabled,
        maxInFlight: () => transferSettingsRepository.read().offload.maxInFlight,
      },
      // A failed job stores only `HANDLER_FAILED`. Without this the reason never
      // reaches the operator, and a stalled migration becomes unexplainable.
      onHandlerError: (job, error) => {
        logger.current?.error(
          {
            jobId: job.id,
            kind: job.kind,
            attempt: job.attempt,
            err: error instanceof Error ? { name: error.name, message: error.message } : { error },
            // Present on the app's own typed errors and usually the whole answer.
            code:
              error !== null && typeof error === 'object' && 'code' in error
                ? String(error.code)
                : undefined,
          },
          'job handler failed',
        );
      },
    });
    const transferSettings = new TransferSettingsService(
      transferSettingsRepository,
      {
        mode: config.mode,
        offloadRuntimeConfigured: offload !== undefined,
        offloadParallelEnabled: config.offloadParallelEnabled,
        netdiskRuntimeConfigured: importRuntimeConfigured,
      },
      {
        offloadActiveHandlers: () => worker.activeOffloadJobCount,
        ...(offload === undefined ? {} : { offloadResources: () => offload.resources.stats() }),
        netdiskActiveJobs: () => importDataPlaneLoop?.activeJobCount ?? 0,
      },
      (record) => {
        if (offload !== undefined && config.offloadParallelEnabled) {
          offload.resources.applyLimits(record.offload);
        }
        worker.notifyCapacityChanged();
        importDataPlaneLoop?.notifyCapacityChanged();
      },
    );
    const netdiskSettings = new NetdiskSettingsService(
      netdiskSettingsRepository,
      {
        mode: config.mode,
        runtimeConfigured: importRuntimeConfigured,
        sourceStagingCleanupExecutorConfigured: config.importSourceCleanupEnabled,
        runtimeMissing: [
          ...(config.mode !== 'ACTIVE' ? ['ACTIVE_MODE' as const] : []),
          ...(config.importSecretRoot === null ? ['SECRET_ROOT' as const] : []),
          ...(config.importSpoolRoot === null ? ['SPOOL_ROOT' as const] : []),
          ...(baiduProvider === undefined && legacyBaidu === undefined && baiduClientRuntime === undefined
            ? ['BAIDU_PROVIDER' as const]
            : []),
          ...(config.rcloneConfigPath === null ? ['RCLONE_CONFIG' as const] : []),
          ...(config.importRecoveryAccountIds.length < 2 ? ['RECOVERY_ACCOUNTS' as const] : []),
          ...(recovery === undefined ? ['RECOVERY_RUNTIME' as const] : []),
        ],
        sourceDeleteExecutorConfigured:
          config.importSourceCleanupEnabled && config.importSelectedSourceDeleteEnabled,
      },
      {
        activeJobs: () => importDataPlaneLoop?.activeJobCount ?? 0,
        waitingJobs: () => netdiskSettingsRepository.waitingJobs(),
        resources: () => importResources.stats(),
        reservedSpoolBytes: () => importSpoolCapacity.reservedBytes(),
      },
      (record) => {
        importResources.applyLimits({
          maxInFlight: record.values.maxInFlight,
          localPreparationConcurrency: record.values.localPreparationConcurrency,
          uploadConcurrency: record.values.uploadConcurrency,
        });
        importSpoolCapacity.notifyCapacityChanged();
        importDataPlaneLoop?.notifyCapacityChanged();
      },
    );
    // Constructed before the app because the system route reads from it. Always
    // built, on every platform: on a host without `/proc` it reports why it has
    // no reading, which is a better answer than the endpoint not existing.
    const hostMetrics = new HostMetricsSampler({
      onSample: (host, extra) => groupRuntime.observations.onHostSample(host, extra),
      onError: (error) => {
        logger.current?.debug(
          { code: error instanceof Error ? error.message : 'unknown' },
          'host metrics sample failed',
        );
      },
    });
    // Runs in both modes, because both halves are reads: the probe stats a
    // mountpoint and reads a sentinel, and the farm only writes symlinks under its
    // own root. Without this nothing ever called either one — recorded mount health
    // stayed at its construction defaults, and the tree Jellyfin reads was never
    // built from the catalog rows that existed.
    //
    // Constructed before the app so the System settings route can expose its last
    // complete tick without inventing a timestamp from mount construction or a
    // failed probe.
    const mediaReconciler = media
      ? new MediaReconciler({
          media,
          onTick: (result) => {
            logger.current?.info(
              {
                healthy: result.healthy,
                mounts: result.mounts,
                created: result.farm.created.length,
                repointed: result.farm.repointed.length,
                removed: result.farm.removed.length,
              },
              'media reconciled',
            );
          },
          onError: () => {
            logger.current?.warn('media reconcile failed');
          },
        })
      : undefined;
    const app = await buildApp({
      ...(options.bootstrapCredential === undefined ? {} : {
        bootstrap: new BootstrapService({
          ...options.bootstrapCredential,
          auth,
          hasAdmin: () => new AuthRepository(db).hasAdmin(),
        }),
      }),
      ...(options.managedSetup === undefined ? {} : {
        managedSetup: options.managedSetup,
        ...(config.rcloneConfigPath === null ? {} : { rcloneImport: new RcloneImportService({ db, stateDir: config.stateDir, configPath: config.rcloneConfigPath, probe: createRcloneImportProbe(config.rcloneBin) }) }),
      }),
      groupSettings: groupRuntime.settings,
      pipelineObservations: groupRuntime.observations,
      config,
      db,
      auth,
      audit,
      events,
      qb,
      ...(offload && { offload }),
      ...(recovery && { recovery }),
      preparation,
      ...(media && { media }),
      imports,
      transferSettings,
      netdiskSettings,
      cloudConnections,
      jobs,
      worker,
      host: () => hostMetrics.snapshot(),
      ...(mediaReconciler ? { mediaReconcileStatus: () => mediaReconciler.status() } : {}),
    });
    logger.current = app.log;
    const accountMonitor =
      config.rcloneConfigPath === null
        ? undefined
        : new StorageAccountMonitor({
            accounts: offload?.accounts ?? recovery?.accounts ?? new StorageAccountRepository(db),
            rclone: new RcloneClient({
              runner: rcloneRunner,
              executable: config.rcloneBin,
              configPath: config.rcloneConfigPath,
            }),
            onAccountUpdated: (accountId, healthy) => {
              try {
                events.publish({
                  type: 'health.updated',
                  component: `storage:${accountId}`,
                  healthy,
                });
              } catch {
                // A closed/overloaded event stream cannot make quota refresh fail.
              }
            },
            onTick: (result) => {
              app.log.info(result, 'storage account quota refreshed');
            },
            onError: () => {
              app.log.warn('storage account quota refresh failed');
            },
          });
    const scheduler = new QbInventoryScheduler({
      coordinator: qb.coordinator,
      intervalMs: 300_000,
      onTick: (report) => {
        app.log.info(
          { succeeded: report.successes.length, failed: report.failures.length },
          'qb inventory refreshed',
        );
      },
      onError: () => {
        app.log.warn('qb inventory refresh failed');
      },
    });
    // The publisher, not a bare reconcile tick. A tick rebuilds the farm and stops
    // there, which is what the first production cleanup did: it created the link,
    // reported COMPLETED, and left Jellyfin reading a target the mount could not
    // resolve for the next 72 hours. The publisher refreshes the mounts' directory
    // caches first and then reads back what it published, so a deletion cannot
    // report success over an unreadable library entry.
    if (media !== undefined) {
      cleanupRefresh.current = media.publisher;
    }

    return {
      config,
      app,
      db,
      auth,
      audit,
      events,
      jobs,
      worker,
      importRevisionWatcher,
      offloadSnapshotEvents,
      importDataPlaneLoop,
      imports,
      transferSettings,
      netdiskSettings,
      accountMonitor,
      hostMetrics,
      groupPipeline: groupRuntime,
      scheduler,
      mediaReconciler,
      ...(managedMountRegistry ? { refreshManagedMounts } : {}),
      offload,
      recovery,
      preparation,
      media,
    };
  } catch (error) {
    await groupPipeline?.close();
    offloadSnapshotEvents.close();
    events.close();
    db.close();
    throw error;
  }
}

export async function stopRuntime(runtime: RuntimeClosers): Promise<void> {
  let failed = false;

  // Interrupt both external-command owners before awaiting either one. Their
  // stop methods abort synchronously, so systemd cannot kill a child rclone or
  // an in-flight provider download before Node has checkpointed the handoff.
  let workerStop: Promise<void> | undefined;
  let importStop: Promise<void> | undefined;
  try {
    workerStop = runtime.worker.stop();
  } catch {
    failed = true;
  }
  try {
    importStop = runtime.importDataPlaneLoop?.stop();
  } catch {
    failed = true;
  }
  try {
    await workerStop;
  } catch {
    failed = true;
  }
  try {
    await importStop;
  } catch {
    failed = true;
  }

  try {
    runtime.offloadSnapshotEvents.close();
  } catch {
    failed = true;
  }

  try {
    await runtime.importRevisionWatcher.stop();
  } catch {
    failed = true;
  }

  try {
    await runtime.accountMonitor?.stop();
  } catch {
    failed = true;
  }

  try {
    await runtime.hostMetrics.stop();
  } catch {
    failed = true;
  }

  try {
    await runtime.groupPipeline?.close();
  } catch {
    /* disposable observation history */
  }

  try {
    await runtime.scheduler.stop();
  } catch {
    failed = true;
  }

  try {
    await runtime.mediaReconciler?.stop();
  } catch {
    failed = true;
  }

  try {
    await runtime.app.close();
  } catch {
    failed = true;
  }

  try {
    runtime.db.close();
  } catch {
    failed = true;
  }

  if (failed) throw new Error('SERVER_SHUTDOWN_FAILED');
}

export function installShutdownSignals(
  stop: () => Promise<void>,
  target: ShutdownSignalTarget = process,
): () => void {
  let stopping: Promise<void> | undefined;
  const onSignal = (): void => {
    if (stopping) return;

    stopping = stop().catch(() => {
      target.exitCode = 1;
    });
  };

  target.once('SIGTERM', onSignal);
  target.once('SIGINT', onSignal);

  return () => {
    target.off('SIGTERM', onSignal);
    target.off('SIGINT', onSignal);
  };
}

export async function startServer(options: StartServerOptions = {}): Promise<ServerRuntime> {
  options.onStartupStage?.('CONFIGURATION');
  const config = parseConfig(resolveMasterKeyCredential(options.env ?? process.env), { guidedSetup: options.guidedSetup ?? false });
  const processCorrelationId = options.processCorrelationId ?? randomUUID();
  const resources = await createResources(config, options.providerFetch, options.onStartupStage, options);

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= stopRuntime(resources);
    return stopping;
  };
  let disposeSignals: (() => void) | undefined;

  try {
    await options.configureApp?.(resources);
    options.onStartupStage?.('WORKERS');
    resources.hostMetrics.start();
    if (!resources.preparation.readOnly) {
      resources.accountMonitor?.start();
      resources.scheduler.start();
      resources.mediaReconciler?.start();
      resources.importRevisionWatcher.start();
      await resources.importDataPlaneLoop?.start();
      await resources.worker.start();
    }
    options.onStartupStage?.('LISTEN');
    await resources.app.listen({ host: config.host, port: config.port });

    const metadata: StartupMetadata = {
      host: config.host,
      port: config.port,
      environment: config.nodeEnv,
      migrationVersion: migrationVersion(resources.db),
      processCorrelationId,
    };
    (options.logStartup ?? ((value) => resources.app.log.info(value, 'server started')))(metadata);

    disposeSignals =
      options.installSignalHandlers === false ? undefined : installShutdownSignals(stop);

    return {
      ...resources,
      processCorrelationId,
      stop: async () => {
        disposeSignals?.();
        await stop();
      },
    };
  } catch (error) {
    disposeSignals?.();
    try { await stop(); }
    catch {
      throw Object.assign(new Error('SERVER_STARTUP_CLEANUP_FAILED'), { code: 'SERVER_STARTUP_CLEANUP_FAILED' });
    }
    throw error;
  }
}

export async function main(
  options: StartServerOptions = {},
  output: { write: (line: string) => unknown } = process.stderr,
): Promise<void> {
  let stage: StartupStage = 'CONFIGURATION';
  const proposedCorrelationId = options.processCorrelationId ?? randomUUID();
  const correlationId = /^[a-zA-Z0-9-]{1,64}$/.test(proposedCorrelationId)
    ? proposedCorrelationId
    : randomUUID();
  try {
    await startServer({
      ...options,
      processCorrelationId: correlationId,
      onStartupStage: (value) => {
        stage = value;
        options.onStartupStage?.(value);
      },
    });
  } catch (error) {
    process.exitCode = 1;
    // Never serialize error.message/stack/cause or configuration: provider errors may contain tokens.
    const suppliedCode =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    const allowedCodes = [
      'EADDRINUSE',
      'EACCES',
      'EPERM',
      'ENOENT',
      'ENOSPC',
      'EMFILE',
      'ETIMEDOUT',
      'ECONNREFUSED',
      'SQLITE_BUSY',
      'SQLITE_LOCKED',
      'SQLITE_CORRUPT',
      'SQLITE_CANTOPEN',
      'SQLITE_IOERR',
      'SQLITE_CONSTRAINT',
    ];
    const code =
      typeof suppliedCode === 'string' && allowedCodes.includes(suppliedCode)
        ? suppliedCode
        : stage === 'CONFIGURATION'
          ? 'CONFIGURATION_INVALID'
          : 'STARTUP_OPERATION_FAILED';
    try {
      output.write(
        `${JSON.stringify({
          level: 'error',
          event: 'SERVER_STARTUP_FAILED',
          stage,
          code,
          correlationId,
          pid: process.pid,
          timestamp: new Date().toISOString(),
        })}\n`,
      );
    } catch {
      // Logging failure must not turn a failed start into exit0.
    }
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  void main();
}
import { RcloneImportService } from './onboarding/rclone-import.js';
import { createRcloneImportProbe } from './onboarding/rclone-import-probe.js';
