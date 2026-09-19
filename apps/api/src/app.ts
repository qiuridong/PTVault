import cookie from '@fastify/cookie';
import csrfProtection from '@fastify/csrf-protection';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { LogController, type FastifyInstance, type onRequestHookHandler } from 'fastify';

import { registerAuditRoutes } from './audit/routes.js';
import type { AuditRepository } from './audit/repository.js';
import { createSessionGuard, createRecentMfaGuard, SESSION_COOKIE_NAME } from './auth/guards.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerBootstrapRoutes } from './onboarding/bootstrap-routes.js';
import type { BootstrapService } from './onboarding/bootstrap.js';
import type { RcloneImportService } from './onboarding/rclone-import.js';
import { registerSetupRoutes, type ManagedSetup } from './onboarding/routes.js';
import type { AuthService } from './auth/service.js';
import type { AppConfig } from './config/env.js';
import { registerCloudConnectionRoutes } from './cloud-connections/routes.js';
import {
  createCloudConnectionServices,
  type CloudConnectionServices,
} from './cloud-connections/services.js';
import type { AppDatabase } from './db/database.js';
import type { EventHub } from './events/hub.js';
import { registerEventRoutes } from './events/routes.js';
import { DatabaseImportDestinationCatalog } from './imports/destinations.js';
import { ImportRepository } from './imports/repository.js';
import { registerImportRoutes } from './imports/routes.js';
import { ImportControlService } from './imports/service.js';
import { JobRepository } from './jobs/repository.js';
import type { Worker } from './jobs/worker.js';
import { registerJellyfinRoutes } from './jellyfin/routes.js';
import { registerQbRoutes } from './qb/routes.js';
import { createQbServices, type QbServices } from './qb/services.js';
import {
  createRecoveryPreparationContext,
  type RecoveryPreparationContext,
} from './recovery/preparation-context.js';
import { preparationCompatibilityAllows } from './recovery/preparation-compatibility.js';
import { RecoveryDownloadService } from './recovery/downloads.js';
import { registerRecoveryDownloadRoutes } from './recovery/download-routes.js';
import { registerMediaRoutes } from './media/routes.js';
import type { MediaServices } from './media/services.js';
import type { MediaReconcileStatus } from './media/reconciler.js';
import { registerRecoveryRoutes } from './recovery/routes.js';
import { StorageAccountRepository } from './storage/accounts.js';
import { OffloadMachine } from './storage/offload-machine.js';
import { registerOffloadTriggerRoutes } from './storage/offload-routes.js';
import { registerStorageRoutes } from './storage/routes.js';
import type { OffloadServices, RecoveryServices } from './storage/services.js';
import { registerTransferSettingsRoutes } from './settings/routes.js';
import {
  TransferSettingsRepository,
  TransferSettingsService,
} from './settings/transfer-settings.js';
import { registerNetdiskSettingsRoutes } from './settings/netdisk-routes.js';
import { NetdiskSettingsRepository, NetdiskSettingsService } from './settings/netdisk-settings.js';
import { GroupSettingsService } from './imports/groups/settings.js';
import { registerGroupSettingsRoutes } from './imports/groups/settings-routes.js';
import { registerSystemRoutes } from './system/routes.js';
import { registerPipelineObservationRoutes } from './system/pipeline-observation-routes.js';
import type { PipelineObservationService } from './system/pipeline-observation-service.js';
import type { HostSnapshot } from './system/host-metrics.js';

export type AppDependencies = {
  config: AppConfig;
  db: AppDatabase;
  auth: AuthService;
  audit: AuditRepository;
  events: EventHub;
  /** Only the managed installer may supply a private first-administrator enrollment. */
  bootstrap?: BootstrapService;
  managedSetup?: ManagedSetup;
  rcloneImport?: RcloneImportService;
  /** Unified cloud-login authority. Empty provider maps fail closed with 503. */
  cloudConnections?: CloudConnectionServices;
  /** Optional provisioned import graph. Absence exposes the read-only fallback surface. */
  imports?: ImportControlService;
  /** Durable transfer scheduler settings; the server injects the live runtime graph. */
  transferSettings?: TransferSettingsService;
  /** Independent netdisk/import settings authority. */
  netdiskSettings?: NetdiskSettingsService;
  groupSettings?: GroupSettingsService;
  pipelineObservations?: PipelineObservationService;
  /**
   * Needed by the media routes to queue a `REHYDRATE` job. Optional so `buildApp`
   * stays callable without the full runtime, matching the other graphs here.
   */
  jobs?: JobRepository;
  /** Same worker that owns the active OFFLOAD AbortControllers. */
  worker?: Pick<
    Worker,
    | 'activeJobCount'
    | 'activeOffloadJobCount'
    | 'requestOffloadPause'
    | 'requestOffloadCancel'
    | 'requestAllOffloadPauses'
  >;
  /**
   * Optional so tests can call `buildApp` alone. The server passes the same graph
   * it gave the periodic scheduler: sharing one `QbInventorySync` is what makes
   * the `SYNC_IN_PROGRESS` guard cover the timer and the manual refresh together.
   */
  qb?: QbServices;
  /**
   * Present only when the offload executor was built (ACTIVE mode). Passing it
   * makes the read-only routes report from the same `OffloadMachine` the handler
   * writes to; without it they fall back to their own read-only repositories,
   * which is all SHADOW needs since no handler is registered there.
   */
  offload?: OffloadServices;
  /**
   * Present in both modes. Recovery material gates uploading, not just deleting,
   * so these routes must be reachable while the system is still in SHADOW.
   */
  recovery?: RecoveryServices;
  preparation?: RecoveryPreparationContext;
  /**
   * Built only when the media paths are configured. Absent means the playback
   * surface does not exist in this process, so its routes are 404 rather than
   * present-and-broken.
   */
  media?: MediaServices;
  /** Last successful media probe/farm sync, when the media reconciler is wired. */
  mediaReconcileStatus?: () => MediaReconcileStatus;
  /**
   * Reads the last host telemetry sample. Absent in tests and in any process
   * without a sampler, which the system route reports rather than hides.
   */
  host?: () => HostSnapshot;
};

export const LOGGER_REDACTION_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.cookies',
  'req.body',
  'req.query',
  'res.headers["set-cookie"]',
  'authorization',
  'cookie',
  'password',
  'code',
  'otp',
  'otpCode',
  'rcloneToken',
  'rclone_token',
  'recoveryCode',
  'recoveryCodes',
  'recoveryMaterial',
  'recovery_material',
  '*.authorization',
  '*.cookie',
  '*.password',
  '*.passcode',
  '*.credential.passcode',
  '*.extractionCode',
  '*.code',
  '*.otp',
  '*.otpCode',
  '*.rcloneToken',
  '*.rclone_token',
  '*.recoveryCode',
  '*.recoveryCodes',
  '*.recoveryMaterial',
  '*.recovery_material',
  '*.accessToken',
  '*.access_token',
  '*.refreshToken',
  '*.refresh_token',
  '*.authorizationCode',
  '*.authorization_code',
  '*.clientSecret',
  '*.client_secret',
  '*.pkceVerifier',
  '*.pkce_verifier',
  '*.dlink',
  '*.cryptPassword',
  '*.cryptPassword2',
  '*.encryptedPayload',
  '*.encrypted_payload',
] as const;

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
    logger: {
      level: deps.config.nodeEnv === 'test' ? 'silent' : 'info',
      redact: {
        paths: [...LOGGER_REDACTION_PATHS],
        censor: '[REDACTED]',
      },
    },
    trustProxy: deps.config.trustedProxyCidrs.length > 0 ? deps.config.trustedProxyCidrs : false,
  });
  const defaultErrorHandler = app.errorHandler.bind(app);
  deps.managedSetup?.installAdmission?.(app);
  const preparation =
    deps.preparation ??
    deps.recovery?.preparation ??
    deps.offload?.preparation ??
    createRecoveryPreparationContext({ db: deps.db, stateDirectory: deps.config.stateDir });
  if (
    (deps.recovery && deps.recovery.preparation !== preparation) ||
    (deps.offload && deps.offload.preparation !== preparation)
  ) {
    throw new Error('RECOVERY_PREPARATION_CONTEXT_MISMATCH');
  }
  app.addHook('preHandler', async (request, reply) => {
    if (
      preparation.readOnly &&
      !preparationCompatibilityAllows(request.method, request.routeOptions.url ?? '')
    ) {
      await reply.code(409).send({
        code: 'RECOVERY_COMPATIBILITY_READ_ONLY',
        error: '兼容回滚为只读模式；保留登录、历史和恢复文件下载，暂停业务写入。',
      });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    if (statusCode >= 500) {
      return reply.code(500).send({
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'Internal Server Error',
      });
    }

    return defaultErrorHandler(error, request, reply);
  });

  app.addHook('onRequest', (request, reply, done) => {
    if (
      request.url === '/api/auth' ||
      request.url.startsWith('/api/auth?') ||
      request.url.startsWith('/api/auth/') ||
      request.url === '/api/audit' ||
      request.url.startsWith('/api/audit?') ||
      request.url.startsWith('/api/audit/') ||
      request.url === '/api/events' ||
      request.url.startsWith('/api/events?') ||
      request.url === '/api/import-destinations' ||
      request.url === '/api/imports' ||
      request.url.startsWith('/api/imports?') ||
      request.url.startsWith('/api/imports/') ||
      request.url === '/api/netdisk' ||
      request.url.startsWith('/api/netdisk?') ||
      request.url.startsWith('/api/netdisk/') ||
      request.url === '/api/media-publications' ||
      request.url.startsWith('/api/media-publications/') ||
      request.url === '/api/qb' ||
      request.url.startsWith('/api/qb?') ||
      request.url.startsWith('/api/qb/') ||
      request.url === '/api/storage' ||
      request.url.startsWith('/api/storage/') ||
      request.url === '/api/offloads' ||
      request.url.startsWith('/api/offloads?') ||
      request.url.startsWith('/api/offloads/') ||
      request.url === '/api/settings' ||
      request.url.startsWith('/api/settings?') ||
      request.url.startsWith('/api/settings/') ||
      request.url === '/api/recovery' ||
      request.url.startsWith('/api/recovery?') ||
      request.url.startsWith('/api/recovery/') ||
      request.url === '/api/jellyfin' ||
      request.url.startsWith('/api/jellyfin/') ||
      request.url.startsWith('/api/system/')
    ) {
      void reply.header('cache-control', 'no-store');
    }
    done();
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        // The managed first-run page is loopback HTTP over an SSH tunnel.
        upgradeInsecureRequests: deps.config.guidedSetup ? null : [],
      },
    },
    frameguard: { action: 'deny' },
    hsts:
      deps.config.nodeEnv === 'production' && !deps.config.guidedSetup
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
        : false,
  });
  await app.register(cookie);
  await app.register(csrfProtection, {
    cookieKey: 'ptvault_csrf',
    cookieOpts: {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
    },
    getToken: (request) => {
      const header = request.headers['x-csrf-token'];
      return Array.isArray(header) ? header[0] : header;
    },
  });
  await app.register(rateLimit, { global: false });

  app.addHook('onSend', (request, reply, payload) => {
    // Keep successful idempotent replays available. Only translate a refused
    // step-up response; verifyStepUp owns the shared attempt budget itself.
    if (reply.statusCode !== 403 || !request.body || typeof request.body !== 'object' ||
      (!Object.hasOwn(request.body, 'mfaCode') && !Object.hasOwn(request.body, 'stepUpCode'))) return Promise.resolve(payload);
    const raw = request.cookies[SESSION_COOKIE_NAME];
    const principal = raw ? deps.auth.requireSession(raw) : null;
    const retryAfter = principal ? deps.auth.stepUpRetryAfter(principal.adminId) : 0;
    if (retryAfter > 0) {
      void reply.code(429).header('retry-after', String(retryAfter));
      return Promise.resolve(JSON.stringify({ code: 'MFA_RATE_LIMITED',
        error: `验证码错误次数过多，请在 ${retryAfter} 秒后重试；当前草稿与登录会话保留。` }));
    }
    return Promise.resolve(payload);
  });

  app.decorateRequest('authenticatedAdmin', null);
  const requireSession = createSessionGuard(deps.auth);
  const requireRecentMfa = createRecentMfaGuard(deps.auth);
  const protectCsrf: onRequestHookHandler = (request, reply, done) => {
    app.csrfProtection(request, reply, done);
  };

  registerAuthRoutes(app, {
    db: deps.db,
    auth: deps.auth,
    audit: deps.audit,
    requireSession,
    mode: deps.config.mode,
  });
  registerBootstrapRoutes(app, {
    db: deps.db,
    audit: deps.audit,
    port: deps.config.port,
    protectCsrf,
    ...(deps.bootstrap === undefined ? {} : { bootstrap: deps.bootstrap }),
  });
  registerAuditRoutes(app, { audit: deps.audit, requireSession });
  registerSystemRoutes(app, {
    db: deps.db,
    mode: deps.config.mode,
    version: deps.config.buildVersion,
    buildCommit: deps.config.buildCommit,
    ...(deps.media
      ? {
          media: () => {
            const mounts = deps.media!.supervisor.list();
            return {
              total: mounts.length,
              healthy: mounts.filter((mount) => mount.mounted).length,
              lastReconciledAt: deps.mediaReconcileStatus?.().lastReconciledAt ?? null,
            };
          },
        }
      : {}),
    // `deps.host` is absent in tests and in any process without a sampler; the
    // route answers with an explicit UNAVAILABLE rather than a missing endpoint,
    // so a dashboard can tell "no telemetry here" from "the box is idle".
    ...(deps.host ? { host: deps.host } : {}),
    requireSession,
  });
  registerJellyfinRoutes(app, {
    config: deps.config,
    requireSession,
    protectCsrf,
  });
  registerEventRoutes(app, { auth: deps.auth, events: deps.events, requireSession });
  const imports =
    deps.imports ??
    new ImportControlService({
      mode: deps.config.mode,
      runtimeConfigured: false,
      creationEnabled: false,
      repository: new ImportRepository(deps.db),
      destinations: new DatabaseImportDestinationCatalog(
        deps.db,
        deps.config.mode,
        false,
        () => false,
      ),
      events: deps.events,
    });
  registerImportRoutes(app, {
    service: imports,
    audit: deps.audit,
    auth: deps.auth,
    requireSession,
    protectCsrf,
  });
  const transferSettings =
    deps.transferSettings ??
    new TransferSettingsService(
      new TransferSettingsRepository(deps.db, {
        offload: {
          creationEnabled: deps.config.mode === 'ACTIVE' && deps.config.offloadEnabled !== false,
          maxInFlight: deps.config.offloadMaxInFlight,
          preflightConcurrency: deps.config.offloadPreflightConcurrency,
          pauseSnapshotConcurrency: deps.config.offloadPauseSnapshotConcurrency,
          maxPausedPipelines: deps.config.offloadMaxPausedPipelines,
          hashConcurrency: deps.config.offloadHashConcurrency,
          uploadConcurrency: 2,
          readbackConcurrency: 1,
        },
        netdisk: { creationEnabled: deps.config.importEnabled, maxInFlight: 2 },
      }),
      {
        mode: deps.config.mode,
        offloadRuntimeConfigured: false,
        offloadParallelEnabled: deps.config.offloadParallelEnabled,
        netdiskRuntimeConfigured: false,
      },
    );
  registerTransferSettingsRoutes(app, {
    service: transferSettings,
    auth: deps.auth,
    audit: deps.audit,
    requireSession,
    protectCsrf,
  });
  const netdiskSettings =
    deps.netdiskSettings ??
    new NetdiskSettingsService(
      new NetdiskSettingsRepository(deps.db, {
        creationEnabled: deps.config.importEnabled,
        maxInFlight: 2,
        localPreparationConcurrency: 2,
        uploadConcurrency: 1,
        spoolMaxBytes: '1099511627776',
        spoolReserveBytes: '10737418240',
        defaultSourceConnectionId: null,
        defaultDestinationAccountId: null,
        defaultPublicationPolicy: 'ARCHIVE_ONLY',
        sourceStagingCleanupEnabled: false,
        sourceDeleteEnabled: false,
        sourceDeleteGraceSeconds: 604800,
      }),
      {
        mode: deps.config.mode,
        runtimeConfigured: false,
      },
    );
  registerNetdiskSettingsRoutes(app, {
    service: netdiskSettings,
    auth: deps.auth,
    audit: deps.audit,
    requireSession,
    protectCsrf,
  });
  registerGroupSettingsRoutes(app, {
    service:
      deps.groupSettings ??
      new GroupSettingsService({
        db: deps.db,
        residentBudgetBytes: () => {
          const values = netdiskSettings.currentRecord().values;
          return (BigInt(values.spoolMaxBytes) - BigInt(values.spoolReserveBytes)).toString();
        },
        provisioned: () => false,
      }),
    auth: deps.auth,
    audit: deps.audit,
    requireSession,
    protectCsrf,
  });
  registerPipelineObservationRoutes(app, {
    ...(deps.pipelineObservations ? { service: deps.pipelineObservations } : {}),
    requireSession,
  });

  const qb = deps.qb ?? createQbServices({ db: deps.db, config: deps.config });
  registerQbRoutes(app, {
    repository: qb.repository,
    credentials: qb.credentials,
    sync: qb.sync,
    coordinator: qb.coordinator,
    preflight: qb.preflight,
    requireSession,
    protectCsrf,
  });

  const cloudConnections =
    deps.cloudConnections ??
    createCloudConnectionServices({
      db: deps.db,
      masterKey: deps.config.masterKey,
    });
  registerCloudConnectionRoutes(app, {
    services: cloudConnections,
    auth: deps.auth,
    audit: deps.audit,
    requireSession,
    protectCsrf,
  });
  registerSetupRoutes(app, {
    config: deps.config, db: deps.db, auth: deps.auth, audit: deps.audit,
    imports, netdisk: netdiskSettings, qb, preparation,
    offloadConfigured: deps.offload !== undefined,
    ...(deps.managedSetup === undefined ? {} : { managed: deps.managedSetup }),
    ...(deps.rcloneImport === undefined ? {} : { rcloneImport: deps.rcloneImport }),
    requireSession, protectCsrf,
  });

  // One repository for both the read-only storage routes and the offload trigger:
  // two instances over one database would be two names for the same rows.
  const jobRepository = new JobRepository(deps.db);
  registerStorageRoutes(app, {
    accounts: deps.offload?.accounts ?? new StorageAccountRepository(deps.db),
    machine: deps.offload?.machine ?? new OffloadMachine(deps.db),
    jobs: jobRepository,
    recovery: preparation.repository,
    readiness: preparation.readiness,
    requireSession,
  });
  registerRecoveryDownloadRoutes(app, {
    downloads: new RecoveryDownloadService({
      repository: preparation.repository,
      directory: `${deps.config.stateDir}/recovery`,
    }),
    requireSession,
  });

  // Registered in BOTH modes, unlike the offload trigger. Recovery material is a
  // precondition for uploading at all (the handler asks the gate for a permit
  // during HASHING, before any byte moves), so hiding these behind ACTIVE would
  // mean the operator must arm the destructive switch before they can build the
  // material that makes deletion survivable.
  registerRecoveryRoutes(app, {
    preparation,
    repository: preparation.repository,
    readiness: preparation.readiness,
    workflow: deps.recovery?.workflow,
    requireSession,
    requireRecentMfa,
    protectCsrf,
    audit: deps.audit,
  });

  // Reads are registered in both modes: knowing what is cached, unavailable, or
  // pinned changes nothing. The mutation routes inside re-check ACTIVE themselves,
  // so a restore cannot start in SHADOW even though the read surface is present.
  if (deps.media) {
    const media = deps.media;
    registerMediaRoutes(app, {
      mode: deps.config.mode,
      catalog: media.catalog,
      supervisor: media.supervisor,
      governor: media.governor,
      rehydrate: media.rehydrateMachine,
      cancelRehydrate: (jobId) => media.rehydrateHandler.cancel(jobId),
      policy: media.policy,
      readFreeBytes: media.readFreeBytes,
      readDisks: media.readDisks,
      audit: deps.audit,
      requireSession,
      requireRecentMfa,
      protectCsrf,
    });
  }

  // The trigger exists only where something can execute it. In SHADOW there is
  // no executor, so the route is absent rather than present-and-inert: a request
  // that would start an upload gets a 404 from a process that has no upload path
  // in it at all.
  if (deps.offload) {
    if (!deps.worker) throw new Error('OFFLOAD_WORKER_REQUIRED');
    registerOffloadTriggerRoutes(app, {
      mode: deps.config.mode,
      machine: deps.offload.machine,
      preflight: qb.preflight,
      cleanup: deps.offload.cleanup,
      recoveryGate: deps.offload.recoveryGate,
      auth: deps.auth,
      audit: deps.audit,
      events: deps.events,
      worker: deps.worker,
      requireSession,
      protectCsrf,
    });
  }

  app.addHook('preClose', () => {
    deps.events.close();
  });

  app.get('/health', () => ({ status: 'ok' as const }));

  return app;
}
