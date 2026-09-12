import { createHash } from 'node:crypto';
import {
  ArchiveCandidatesSchema,
  ImportFileIdentitySchema,
  importLibraryAcceptsMediaType,
} from '@ptvault/contracts';

import type { Clock } from '../core/clock.js';
import type { EventHub } from '../events/hub.js';
import type { AppMode } from '../config/env.js';
import type { ImportDestinationCatalog } from './destinations.js';
import type { LegacyImportSourceBindingService } from './legacy-source-binding.js';
import { ImportControlError, importInvariant } from './errors.js';
import type { ImportLibraryCatalog } from '../jellyfin/import-libraries.js';
import type { JellyfinLibraryDiscoveryError } from '@ptvault/contracts';
import type {
  ImportDestination,
  ImportJobSummary,
  ImportPlan,
  ImportPublication,
  ImportShareCredential,
  JellyfinImportLibrary,
  PlannerResult,
} from './model.js';
import type { ImportRepository } from './repository.js';
import type { ImportPublicationController } from './publication.js';
import type {
  ImportSourceCleanupController,
  ImportSourceCleanupExecuteInput,
  ImportSourceCleanupPreviewInput,
} from './source-cleanup.js';
import type { ImportSecretStore } from './secret-store.js';
import type {
  FrozenImportSourceBinding,
  ImportSourceConnectionCatalog,
} from './source-connections.js';
import type { CreateImportRequest, ImportPlanRequest, MediaPublicationRequest } from './schemas.js';
import { normalizeInlinePasscode, sanitizeBaiduShareReference } from './share-reference.js';
import { isCanonicalBaiduPath, isManagedBaiduMutationPath } from './baidu-paths.js';
import {
  archiveBaseManifest,
  buildArchiveSourceManifest,
  canonicalSourceManifest,
  sourceManifestDigest,
} from './source-manifest.js';
import { archivePlanSummary, planArchive } from './archive/planning.js';
import type { ArchivePasswordStore } from './archive/secrets.js';
import { FILE_IMPORT_CREATION_ENABLED } from './file-creation-mode.js';
import { pipelinePlanOptions, type ImportPipelineRepository } from './groups/repository.js';
import { planImportGroups } from './groups/planning.js';
import {
  ImportPipelineOptionsSchema,
  type ImportPipelineOptions,
  type ImportPipelineSummary,
} from '@ptvault/contracts';

export type ImportPlannerInput = {
  sourceKind: ImportPlanRequest['sourceKind'];
  sourceBinding?: FrozenImportSourceBinding | null;
  selection: unknown;
  secretRef: string | null;
  destination: ImportDestination;
};

export interface ImportPlanner {
  plan(input: ImportPlannerInput): Promise<PlannerResult>;
}

export type ImportControlServiceOptions = {
  grouping?: {
    enabled?: () => boolean;
    repository: ImportPipelineRepository;
    limits: () => { residentMaxBytes: string; waitingCacheMaxBytes: string };
  };
  archive?: {
    passwords: Pick<ArchivePasswordStore, 'put' | 'read' | 'delete' | 'fingerprint'>;
    spoolMaxBytes: () => string;
  };
  legacySources?: Pick<LegacyImportSourceBindingService, 'status' | 'bind' | 'replay'>;
  mode: AppMode;
  /** Compatibility shorthand: when set alone, configures both runtime and creation. */
  featureEnabled?: boolean;
  runtimeConfigured?: boolean;
  shareSourceConfigured?: boolean;
  creationEnabled?: boolean | (() => boolean);
  /** False is compatibility read-only mode for FILE, including actions on existing V2 jobs. */
  fileCreationEnabled?: boolean;
  repository: ImportRepository;
  destinations: ImportDestinationCatalog;
  events: Pick<EventHub, 'publish'>;
  planner?: ImportPlanner | undefined;
  secrets?: ImportSecretStore | undefined;
  libraries?: readonly JellyfinImportLibrary[] | undefined;
  libraryCatalog?: ImportLibraryCatalog;
  publicationEnabled?: boolean | undefined;
  jellyfinConfigured?: boolean;
  publicationController?: ImportPublicationController | undefined;
  sourceCleanupController?: ImportSourceCleanupController | undefined;
  allowedBaiduHosts?: readonly string[] | undefined;
  sourceConnections?: ImportSourceConnectionCatalog | undefined;
  defaultSourceConnectionId?: (() => string | null) | undefined;
  defaultDestinationAccountId?: (() => string | null) | undefined;
  defaultPublicationPolicy?: (() => 'ARCHIVE_ONLY' | 'PUBLISH_TO_JELLYFIN') | undefined;
  planTtlMs?: number | undefined;
  secretTtlMs?: number | undefined;
  now?: Clock | undefined;
};

type ResolvedCredential = { ref: string | null; createdRef: string | null };

export class ImportControlService {
  private readonly grouping: ImportControlServiceOptions['grouping'];
  private readonly archive: ImportControlServiceOptions['archive'];
  private readonly legacySources: ImportControlServiceOptions['legacySources'];
  readonly mode: AppMode;
  private readonly runtimeConfigured: boolean;
  private readonly shareSourceConfigured: boolean;
  private readonly creationEnabled: () => boolean;
  private readonly fileCreationEnabled: boolean;
  private readonly repository: ImportRepository;
  private readonly destinations: ImportDestinationCatalog;
  private readonly events: Pick<EventHub, 'publish'>;
  private readonly planner: ImportPlanner | undefined;
  private readonly secrets: ImportSecretStore | undefined;
  private readonly staticLibraries: readonly JellyfinImportLibrary[];
  private readonly libraryCatalog: ImportLibraryCatalog | undefined;
  private readonly publicationEnabled: boolean;
  private readonly jellyfinConfigured: boolean;
  private readonly publicationController: ImportPublicationController | undefined;
  private readonly sourceCleanupController: ImportSourceCleanupController | undefined;
  private readonly allowedBaiduHosts: readonly string[];
  private readonly sourceConnections: ImportSourceConnectionCatalog | undefined;
  private readonly defaultSourceConnectionId: () => string | null;
  private readonly defaultDestinationAccountId: () => string | null;
  private readonly defaultPublicationPolicy: () => 'ARCHIVE_ONLY' | 'PUBLISH_TO_JELLYFIN';
  private readonly planTtlMs: number;
  private readonly secretTtlMs: number;
  private readonly now: Clock;

  constructor(options: ImportControlServiceOptions) {
    this.grouping = options.grouping;
    this.archive = options.archive;
    this.legacySources = options.legacySources;
    this.mode = options.mode;
    this.runtimeConfigured = options.runtimeConfigured ?? options.featureEnabled ?? false;
    this.shareSourceConfigured = options.shareSourceConfigured ?? true;
    this.fileCreationEnabled = options.fileCreationEnabled ?? FILE_IMPORT_CREATION_ENABLED;
    const configuredCreation = options.creationEnabled ?? options.featureEnabled ?? false;
    this.creationEnabled =
      typeof configuredCreation === 'function' ? configuredCreation : () => configuredCreation;
    this.repository = options.repository;
    this.destinations = options.destinations;
    this.events = options.events;
    this.planner = options.planner;
    this.secrets = options.secrets;
    this.staticLibraries = options.libraries ?? [];
    this.libraryCatalog = options.libraryCatalog;
    this.publicationEnabled = options.publicationEnabled ?? false;
    this.jellyfinConfigured =
      options.jellyfinConfigured ?? options.publicationController !== undefined;
    this.publicationController = options.publicationController;
    this.sourceCleanupController = options.sourceCleanupController;
    this.allowedBaiduHosts = options.allowedBaiduHosts ?? ['pan.baidu.com'];
    this.sourceConnections = options.sourceConnections;
    this.defaultSourceConnectionId = options.defaultSourceConnectionId ?? (() => null);
    this.defaultDestinationAccountId = options.defaultDestinationAccountId ?? (() => null);
    this.defaultPublicationPolicy = options.defaultPublicationPolicy ?? (() => 'ARCHIVE_ONLY');
    this.planTtlMs = options.planTtlMs ?? 15 * 60_000;
    this.secretTtlMs = options.secretTtlMs ?? 30 * 60_000;
    this.now = options.now ?? (() => new Date());
  }

  private get libraries(): readonly JellyfinImportLibrary[] {
    return this.libraryCatalog?.list() ?? this.staticLibraries;
  }
  private get publicationLibraries(): readonly JellyfinImportLibrary[] {
    return this.libraries.filter(
      (library) =>
        library.unavailableReason == null &&
        (importLibraryAcceptsMediaType('MOVIE', library.contentType) ||
          importLibraryAcceptsMediaType('SERIES', library.contentType)),
    );
  }
  async refreshLibraries(force = false): Promise<void> {
    await this.libraryCatalog?.refresh(force);
  }

  capabilities(): {
    capabilities: {
      mode: AppMode;
      createEnabled: boolean;
      fileSelectionEnabled: boolean;
      archiveExtractionEnabled: boolean;
      groupedPipelinesEnabled: boolean;
      fileSourceCleanupEnabled: boolean;
      sources: Array<{
        kind: 'BAIDU_SHARE' | 'BAIDU_APP_DIR' | 'OTHER';
        enabled: boolean;
        disabledReason:
          'NOT_CONFIGURED' | 'FEATURE_DISABLED' | 'SHADOW_MODE' | 'CAPABILITY_UNAVAILABLE' | null;
      }>;
      publishToJellyfinEnabled: boolean;
      publishDisabledReason:
        | 'IMPORT_RUNTIME_NOT_CONFIGURED'
        | 'PUBLICATION_RUNTIME_NOT_CONFIGURED'
        | 'SHADOW_MODE'
        | 'FEATURE_DISABLED'
        | 'JELLYFIN_NOT_CONFIGURED'
        | 'NO_ALLOWLISTED_LIBRARY'
        | 'DESTINATION_UNSUPPORTED'
        | null;
      libraries: JellyfinImportLibrary[];
      libraryDiscoveryError?: JellyfinLibraryDiscoveryError | null;
      supportedActions: Array<
        'PAUSE' | 'RESUME' | 'CANCEL' | 'RETRY' | 'PROVIDE_CREDENTIALS' | 'REPUBLISH' | 'UNPUBLISH'
      >;
    };
    destinations: ImportDestination[];
  } {
    const runtimeEnabled = this.isRuntimeEnabled();
    const createEnabled = runtimeEnabled && this.creationEnabled();
    const disabledReason = this.mode === 'SHADOW' ? 'SHADOW_MODE' : 'FEATURE_DISABLED';
    const sourceDisabledReason = createEnabled
      ? null
      : this.mode === 'SHADOW'
        ? 'SHADOW_MODE'
        : !runtimeEnabled
          ? 'NOT_CONFIGURED'
          : 'FEATURE_DISABLED';
    const publishEnabled = this.isPublicationMutationEnabled();
    const publishDisabledReason = publishEnabled
      ? null
      : this.mode === 'SHADOW'
        ? 'SHADOW_MODE'
        : !runtimeEnabled
          ? 'IMPORT_RUNTIME_NOT_CONFIGURED'
          : !this.publicationEnabled
            ? 'FEATURE_DISABLED'
            : !this.jellyfinConfigured
              ? 'JELLYFIN_NOT_CONFIGURED'
              : this.publicationLibraries.length === 0
                ? 'NO_ALLOWLISTED_LIBRARY'
                : 'PUBLICATION_RUNTIME_NOT_CONFIGURED';

    return {
      capabilities: {
        mode: this.mode,
        createEnabled,
        fileSelectionEnabled: createEnabled && this.fileCreationEnabled,
        archiveExtractionEnabled: createEnabled && this.archive !== undefined,
        groupedPipelinesEnabled:
          createEnabled &&
          this.archive !== undefined &&
          this.grouping?.repository.enabled === true &&
          this.grouping.enabled?.() !== false,
        fileSourceCleanupEnabled:
          createEnabled &&
          this.fileCreationEnabled &&
          (this.sourceCleanupController?.fileSourceCleanupEnabled?.() ?? false),
        sources: [
          {
            kind: 'BAIDU_SHARE',
            enabled: createEnabled && this.shareSourceConfigured,
            disabledReason:
              sourceDisabledReason ??
              (this.shareSourceConfigured ? null : 'CAPABILITY_UNAVAILABLE'),
          },
          { kind: 'BAIDU_APP_DIR', enabled: createEnabled, disabledReason: sourceDisabledReason },
          { kind: 'OTHER', enabled: false, disabledReason },
        ],
        publishToJellyfinEnabled: publishEnabled,
        publishDisabledReason,
        libraries: [...this.libraries],
        ...(this.libraryCatalog === undefined
          ? {}
          : { libraryDiscoveryError: this.libraryCatalog.error() }),
        supportedActions: [
          'PAUSE',
          'RESUME',
          'CANCEL',
          'RETRY',
          'PROVIDE_CREDENTIALS',
          ...(publishEnabled ? (['REPUBLISH', 'UNPUBLISH'] as const) : []),
        ],
      },
      destinations: this.destinations.list(),
    };
  }

  async plan(request: ImportPlanRequest): Promise<ImportPlan> {
    if (request.grouped === true)
      importInvariant(this.grouping?.enabled?.() !== false, 'GROUP_RUNTIME_UNAVAILABLE', 503);
    if (request.grouped === true)
      importInvariant(
        this.grouping?.repository.enabled === true &&
          request.archive !== undefined &&
          request.sourceKind === 'BAIDU_APP_DIR' &&
          request.sourceScope !== 'FILE',
        'GROUP_DIRECTORY_SOURCE_REQUIRED',
        409,
      );
    if (request.archive !== undefined) {
      importInvariant(this.archive !== undefined, 'ARCHIVE_RUNTIME_UNAVAILABLE', 503);
      importInvariant(request.sourceKind === 'BAIDU_APP_DIR', 'ARCHIVE_SOURCE_UNSUPPORTED', 400);
    }
    const fileScope = request.sourceScope === 'FILE';
    importInvariant(!fileScope || this.fileCreationEnabled, 'IMPORT_FILE_CREATION_DISABLED', 409);
    importInvariant(
      fileScope
        ? request.sourceKind === 'BAIDU_APP_DIR' &&
            request.sourcePath !== undefined &&
            request.expectedSourceRootFsid === undefined &&
            ImportFileIdentitySchema.safeParse(request.expectedFile).success
        : request.expectedFile === undefined &&
            (request.sourceScope === undefined || request.sourceKind === 'BAIDU_APP_DIR'),
      'IMPORT_SOURCE_IDENTITY_NOT_APPLICABLE',
      400,
    );
    importInvariant(
      request.expectedSourceRootFsid === undefined || request.sourceKind === 'BAIDU_APP_DIR',
      'IMPORT_SOURCE_IDENTITY_NOT_APPLICABLE',
      400,
    );
    this.assertCreationEnabled();
    importInvariant(
      request.sourceKind !== 'BAIDU_SHARE' || this.shareSourceConfigured,
      'IMPORT_SOURCE_CAPABILITY_MISSING',
      409,
    );
    const destinationId = this.resolveDestinationId(request.destinationId);
    const destination = this.destinations.require(destinationId);
    importInvariant(destination.available, 'IMPORT_DESTINATION_UNAVAILABLE', 409);
    importInvariant(request.sourceKind !== 'OTHER', 'IMPORT_SOURCE_UNSUPPORTED', 409);
    const sourceBinding = this.resolveSourceBinding(request.sourceConnectionId, request.sourceKind);

    let selection: unknown;
    let sourceAlias: string;
    let embeddedPasscode: string | null = null;
    if (request.sourceKind === 'BAIDU_SHARE') {
      importInvariant(request.shareUrl !== undefined, 'IMPORT_SHARE_URL_REQUIRED', 400);
      const share = sanitizeBaiduShareReference(request.shareUrl, this.allowedBaiduHosts);
      embeddedPasscode = share.inlinePasscode;
      selection = {
        sourceKind: request.sourceKind,
        sanitizedShareUrl: share.sanitizedUrl,
        fingerprint: share.fingerprint,
      };
      sourceAlias = `百度分享 · ${share.fingerprint.slice(0, 8)}`;
    } else {
      importInvariant(request.sourcePath !== undefined, 'IMPORT_SOURCE_PATH_REQUIRED', 400);
      const normalizedPath = this.validateSourcePath(request.sourcePath);
      const fingerprint = createHash('sha256').update(normalizedPath).digest('hex');
      selection = { sourceKind: request.sourceKind, sourcePath: normalizedPath, fingerprint };
      if (fileScope)
        selection = {
          ...(selection as Record<string, unknown>),
          sourceScope: 'FILE',
          expectedFile: ImportFileIdentitySchema.parse(request.expectedFile),
        };
      sourceAlias = `百度${fileScope ? '文件' : '应用目录'} · ${fingerprint.slice(0, 8)}`;
      importInvariant(request.credential.kind === 'NONE', 'IMPORT_CREDENTIAL_NOT_APPLICABLE', 400);
    }

    const credential = this.resolveCredential(request.credential, embeddedPasscode, null);
    let archiveRef: string | null = null;
    try {
      let planned = await this.planner!.plan({
        sourceKind: request.sourceKind,
        sourceBinding,
        selection,
        secretRef: credential.ref,
        destination,
      });
      this.validatePlannerResult(planned);
      if (fileScope || planned.sourceManifest?.version === 2) {
        try {
          const manifest = canonicalSourceManifest(planned.sourceManifest);
          const object = manifest.objects[0]!;
          importInvariant(
            fileScope &&
              manifest.version === 2 &&
              manifest.rootPath === request.sourcePath &&
              object.fsid === request.expectedFile?.fsid &&
              object.size === request.expectedFile?.size &&
              object.mtime === request.expectedFile?.mtime,
            'SOURCE_CHANGED',
            409,
          );
        } catch {
          throw new ImportControlError('SOURCE_CHANGED', 409);
        }
      }
      if (request.expectedSourceRootFsid !== undefined) {
        // A provider may replace a folder at the same path after the user selected it.
        // Compare the real snapshot, not a request echo, before persisting any plan.
        try {
          const manifest = canonicalSourceManifest(planned.sourceManifest);
          importInvariant(
            manifest.version === 1 &&
              manifest.sourceKind === 'BAIDU_APP_DIR' &&
              manifest.rootPath === (selection as { sourcePath: string }).sourcePath &&
              manifest.sourceIdentity === request.expectedSourceRootFsid,
            'SOURCE_CHANGED',
            409,
          );
        } catch {
          throw new ImportControlError('SOURCE_CHANGED', 409);
        }
      }
      if (request.archive !== undefined) {
        if (request.grouped === true) {
          const limits = this.grouping!.limits();
          const options: ImportPipelineOptions = ImportPipelineOptionsSchema.parse({
            version: 1,
            processing: {
              mode: 'RECURSIVE_VIDEO',
              maxDepth: request.archive.maxDepth,
              maxFiles: 100000,
              maxExpandedBytes: request.archive.maxExpandedBytes,
            },
            ...limits,
          });
          const groups = planImportGroups(
            canonicalSourceManifest(planned.sourceManifest),
            options.processing,
            options.residentMaxBytes,
          );
          importInvariant(groups.length <= 10000, 'GROUP_COUNT_LIMIT', 409);
          planned = {
            ...planned,
            requiredSpoolBytes: groups.reduce(
              (max, group) =>
                BigInt(group.requiredSpoolBytes) > BigInt(max) ? group.requiredSpoolBytes : max,
              '0',
            ),
          };
          selection = { ...(selection as Record<string, unknown>), groupPipeline: options };
        } else planned = planArchive(planned, request.archive, this.archive!.spoolMaxBytes());
        const candidates = [...new Set(request.archive.candidates)];
        archiveRef = candidates.length === 0 ? null : this.archive!.passwords.put(candidates);
        selection = {
          ...(selection as Record<string, unknown>),
          archiveIngress: { ref: archiveRef, count: candidates.length },
        };
      }
      const stored = this.repository.createPlan({
        sourceKind: request.sourceKind,
        ...(sourceBinding ?? {
          sourceConnectionId: null,
          sourceProvider: null,
          sourceExternalAccountId: null,
          sourceManifestRevision: null,
        }),
        sourceAlias,
        sourceRequiresPasscode: planned.sourceRequiresPasscode,
        sourceAuthState: planned.sourceAuthState,
        ...(planned.sourceManifest === undefined ? {} : { sourceManifest: planned.sourceManifest }),
        destinationId: destination.destinationId,
        objectCount: planned.objectCount,
        totalBytes: planned.totalBytes,
        largestObjectBytes: planned.largestObjectBytes,
        requiredSpoolBytes: planned.requiredSpoolBytes,
        pathConflicts: planned.pathConflicts,
        destinationLimitIssues: planned.destinationLimitIssues,
        plannedPolicy: this.defaultPublicationPolicy(),
        mode: this.mode,
        selection,
        secretRef: credential.ref,
        destination,
        expiresAt: this.now().getTime() + this.planTtlMs,
      });
      return this.publicPlan(stored);
    } catch (error) {
      if (archiveRef !== null) this.archive?.passwords.delete(archiveRef);
      if (credential.createdRef !== null) this.secrets?.delete(credential.createdRef);
      throw error;
    }
  }

  create(request: CreateImportRequest): ImportJobSummary {
    return this.createVerified(request, null);
  }

  pipelineList(): ImportPipelineSummary[] {
    return this.grouping?.repository.list() ?? [];
  }

  pipelineAction(
    id: string,
    action: 'PAUSE' | 'RESUME' | 'CANCEL' | 'RETRY',
    key: string,
  ): ImportPipelineSummary {
    this.assertRuntimeEnabled();
    importInvariant(this.grouping?.repository.enabled === true, 'GROUP_RUNTIME_UNAVAILABLE', 503);
    return this.grouping.repository.action(this.repository, id, action, key);
  }

  pipelineDetail(id: string, offset = 0, limit = 100) {
    importInvariant(this.grouping?.repository.enabled === true, 'GROUP_RUNTIME_UNAVAILABLE', 503);
    const detail = this.grouping.repository.detail(id, offset, limit);
    return {
      ...detail,
      groups: detail.groups.map((group) => {
        if (group.jobId === null) return group;
        const summary = this.repository.requireSummary(group.jobId, {
          includeRetryImpact: !['COMPLETED', 'CANCELLED'].includes(group.stage),
          publicationActionsEnabled: this.isPublicationMutationEnabled(),
          publicationLibraryIds: this.publicationLibraries.map((x) => x.libraryId),
        });
        return {
          ...group,
          retryImpact: summary.archive?.retryImpact,
          availableActions: summary.availableActions.filter(
            (action) => !detail.paused || !['RESUME', 'RETRY'].includes(action),
          ),
        };
      }),
    };
  }

  async createPipelineWithSourceRevalidation(
    request: CreateImportRequest,
  ): Promise<ImportPipelineSummary> {
    importInvariant(this.grouping?.repository.enabled === true, 'GROUP_RUNTIME_UNAVAILABLE', 503);
    const plan = this.repository.requirePlan(request.planId),
      options = pipelinePlanOptions(plan);
    importInvariant(
      options !== null && plan.sourceManifest?.version === 1 && plan.sourceKind === 'BAIDU_APP_DIR',
      'GROUP_PLAN_INVALID',
      409,
    );
    importInvariant(
      request.processingMode === 'GROUPED_VIDEO',
      'GROUP_PROCESSING_ACK_REQUIRED',
      409,
    );
    importInvariant(
      (request.sourceCleanupPolicy ?? 'KEEP') === 'KEEP' &&
        request.sourceCleanupRequiresPublication !== true,
      'ARCHIVE_SOURCE_KEEP_REQUIRED',
      409,
    );
    importInvariant(request.credential.kind === 'NONE', 'IMPORT_CREDENTIAL_NOT_APPLICABLE', 400);
    const replay = this.grouping.repository.replayCreate(plan, request);
    if (replay !== null) return replay;
    try {
      if ((request.publicationPolicy ?? plan.plannedPolicy) === 'PUBLISH_TO_JELLYFIN')
        await this.refreshLibraries();
      importInvariant(this.grouping.enabled?.() !== false, 'GROUP_RUNTIME_UNAVAILABLE', 503);
      this.assertCreationEnabled();
      importInvariant(this.archive !== undefined, 'ARCHIVE_RUNTIME_UNAVAILABLE', 503);
      importInvariant(
        Date.parse(plan.expiresAt) > this.now().getTime(),
        'IMPORT_PLAN_EXPIRED',
        409,
      );
      importInvariant(plan.sourceAuthState === 'AUTHORIZED', 'IMPORT_PLAN_AUTH_REQUIRED', 409);
      const destinationId = request.destinationId ?? plan.destinationId;
      importInvariant(destinationId === plan.destinationId, 'IMPORT_PLAN_DESTINATION_CHANGED', 409);
      const destination = this.destinations.require(destinationId);
      importInvariant(destination.available, 'IMPORT_DESTINATION_UNAVAILABLE', 409);
      const binding = this.resolveSourceBinding(
        plan.sourceConnectionId ?? undefined,
        plan.sourceKind,
      );
      importInvariant(
        binding === null ||
          (binding.sourceConnectionId === plan.sourceConnectionId &&
            binding.sourceExternalAccountId === plan.sourceExternalAccountId),
        'SOURCE_CHANGED',
        409,
      );
      const checked = await this.planner!.plan({
        sourceKind: plan.sourceKind,
        sourceBinding: binding,
        selection: structuredClone(plan.selection),
        secretRef: null,
        destination,
      });
      try {
        importInvariant(
          sourceManifestDigest(canonicalSourceManifest(checked.sourceManifest)) ===
            plan.sourceManifestDigest,
          'SOURCE_CHANGED',
          409,
        );
      } catch {
        throw new ImportControlError('SOURCE_CHANGED', 409);
      }
      const current = this.resolveSourceBinding(
        plan.sourceConnectionId ?? undefined,
        plan.sourceKind,
      );
      importInvariant(
        current === null ||
          (current.sourceConnectionId === plan.sourceConnectionId &&
            current.sourceExternalAccountId === plan.sourceExternalAccountId),
        'SOURCE_CHANGED',
        409,
      );
      const ingress = (plan.selection as { archiveIngress: { ref: string | null } }).archiveIngress;
      if (ingress.ref !== null) this.archive.passwords.read(ingress.ref);
      const publicationPolicy = request.publicationPolicy ?? plan.plannedPolicy;
      let publication: Parameters<ImportRepository['createJob']>[0]['publication'];
      if (publicationPolicy === 'PUBLISH_TO_JELLYFIN') {
        importInvariant(this.publicationEnabled, 'IMPORT_PUBLICATION_FEATURE_DISABLED', 409);
        importInvariant(this.publicationController, 'IMPORT_PUBLICATION_NOT_CONFIGURED', 503);
        importInvariant(
          destination.supportsJellyfin === true,
          'IMPORT_DESTINATION_UNSUPPORTED',
          409,
        );
        importInvariant(request.publication !== undefined, 'IMPORT_PUBLICATION_REQUIRED', 400);
        const library = this.publicationLibraries.find(
          (x) => x.libraryId === request.publication!.libraryId,
        );
        importInvariant(library !== undefined, 'IMPORT_LIBRARY_NOT_ALLOWLISTED', 409);
        importInvariant(
          importLibraryAcceptsMediaType(request.publication.mediaType, library.contentType),
          'IMPORT_MEDIA_TYPE_MISMATCH',
          409,
        );
        this.validateLogicalPath(request.publication.logicalPath);
        importInvariant(
          request.publication.logicalPath.length <= 4000,
          'GROUP_PUBLICATION_PATH_TOO_LONG',
          400,
        );
        publication = { request: request.publication, library };
      } else
        importInvariant(
          request.publication === undefined,
          'IMPORT_PUBLICATION_NOT_APPLICABLE',
          400,
        );
      return this.grouping.repository.create(this.repository, {
        plan,
        destination,
        secretRef: null,
        publicationPolicy,
        ...(publication === undefined ? {} : { publication }),
        sourceCleanupPolicy: 'KEEP',
        idempotencyKey: request.idempotencyKey,
      });
    } catch (error) {
      const concurrent = this.grouping.repository.replayCreate(plan, request);
      if (concurrent !== null) return concurrent;
      throw error;
    }
  }

  async createWithSourceRevalidation(request: CreateImportRequest): Promise<ImportJobSummary> {
    const plan = this.repository.requirePlan(request.planId);
    importInvariant(pipelinePlanOptions(plan) === null, 'GROUP_PARENT_REQUIRES_PIPELINE', 409);
    if (plan.sourceManifest?.version !== 2 && plan.sourceManifest?.version !== 3) {
      if ((request.publicationPolicy ?? plan.plannedPolicy) === 'PUBLISH_TO_JELLYFIN')
        await this.refreshLibraries();
      return this.create(request);
    }
    const replay = this.repository.replayFileCreate(request, plan);
    if (replay !== null) return this.fileCompatibilityView(replay);
    try {
      if ((request.publicationPolicy ?? plan.plannedPolicy) === 'PUBLISH_TO_JELLYFIN')
        await this.refreshLibraries();
      return await this.createRevalidatedFile(request, plan);
    } catch (error) {
      // Another identical request may have persisted while this request awaited the provider.
      const concurrentReplay = this.repository.replayFileCreate(request, plan);
      if (concurrentReplay !== null) return this.fileCompatibilityView(concurrentReplay);
      throw error;
    }
  }

  private async createRevalidatedFile(
    request: CreateImportRequest,
    plan: ReturnType<ImportRepository['requirePlan']>,
  ): Promise<ImportJobSummary> {
    importInvariant(
      plan.sourceManifest?.version !== 2 || this.fileCreationEnabled,
      'IMPORT_FILE_CREATION_DISABLED',
      409,
    );
    this.assertArchivePlan(request, plan);
    this.assertCreationEnabled();
    this.assertFileCleanupPolicy(request, plan);
    importInvariant(Date.parse(plan.expiresAt) > this.now().getTime(), 'IMPORT_PLAN_EXPIRED', 409);
    importInvariant(plan.sourceAuthState === 'AUTHORIZED', 'IMPORT_PLAN_AUTH_REQUIRED', 409);
    const binding = this.resolveSourceBinding(
      plan.sourceConnectionId ?? undefined,
      plan.sourceKind,
    );
    importInvariant(
      binding === null ||
        (binding.sourceConnectionId === plan.sourceConnectionId &&
          binding.sourceExternalAccountId === plan.sourceExternalAccountId),
      'SOURCE_CHANGED',
      409,
    );
    const checked = await this.planner!.plan({
      sourceKind: plan.sourceKind,
      sourceBinding: binding,
      selection: structuredClone(plan.selection),
      secretRef: plan.secretRef,
      destination: this.destinations.require(plan.destinationId),
    });
    try {
      const manifest = canonicalSourceManifest(checked.sourceManifest);
      const expected = plan.sourceManifest!;
      const verified =
        expected.version === 3
          ? buildArchiveSourceManifest(manifest, {
              mode: expected.archive.mode,
              maxDepth: expected.archive.maxDepth,
              maxFiles: expected.archive.maxFiles,
              maxExpandedBytes: expected.archive.maxExpandedBytes,
            })
          : manifest;
      importInvariant(
        verified.version === expected.version &&
          sourceManifestDigest(verified) === plan.sourceManifestDigest,
        'SOURCE_CHANGED',
        409,
      );
    } catch {
      throw new ImportControlError('SOURCE_CHANGED', 409);
    }
    const current = this.resolveSourceBinding(
      plan.sourceConnectionId ?? undefined,
      plan.sourceKind,
    );
    importInvariant(
      current === null ||
        (current.sourceConnectionId === plan.sourceConnectionId &&
          current.sourceExternalAccountId === plan.sourceExternalAccountId),
      'SOURCE_CHANGED',
      409,
    );
    return this.createVerified(request, plan.sourceManifestDigest);
  }

  private createVerified(
    request: CreateImportRequest,
    fileDigest: string | null,
  ): ImportJobSummary {
    this.assertCreationEnabled();
    const plan = this.repository.requirePlan(request.planId);
    this.assertArchivePlan(request, plan);
    importInvariant(
      (plan.sourceManifest?.version !== 2 && plan.sourceManifest?.version !== 3) ||
        (fileDigest !== null && fileDigest === plan.sourceManifestDigest),
      'IMPORT_FILE_REVALIDATION_REQUIRED',
      409,
    );
    importInvariant(Date.parse(plan.expiresAt) > this.now().getTime(), 'IMPORT_PLAN_EXPIRED', 409);
    importInvariant(plan.sourceAuthState === 'AUTHORIZED', 'IMPORT_PLAN_AUTH_REQUIRED', 409);
    importInvariant(
      this.sourceConnections === undefined || plan.sourceManifest !== null,
      'IMPORT_SOURCE_MANIFEST_REQUIRED',
      409,
    );
    const destinationId = request.destinationId ?? plan.destinationId;
    importInvariant(plan.destinationId === destinationId, 'IMPORT_PLAN_DESTINATION_CHANGED', 409);
    const destination = this.destinations.require(destinationId);
    importInvariant(destination.available, 'IMPORT_DESTINATION_UNAVAILABLE', 409);
    const credential = this.resolveCredential(request.credential, null, plan.secretRef);
    importInvariant(
      !plan.sourceRequiresPasscode || credential.ref !== null,
      'IMPORT_CREDENTIAL_REQUIRED',
      409,
    );

    const publicationPolicy = request.publicationPolicy ?? plan.plannedPolicy;
    const sourceCleanupPolicy = request.sourceCleanupPolicy ?? 'KEEP';
    this.assertFileCleanupPolicy(request, plan);
    if (sourceCleanupPolicy === 'SELECTED_SOURCE' && plan.sourceKind === 'BAIDU_APP_DIR') {
      const selection = plan.selection as { sourcePath?: unknown };
      importInvariant(
        typeof selection.sourcePath === 'string' &&
          isManagedBaiduMutationPath(selection.sourcePath),
        'IMPORT_SOURCE_CLEANUP_SCOPE_UNSUPPORTED',
        409,
      );
    }
    importInvariant(
      plan.sourceKind !== 'BAIDU_SHARE' || sourceCleanupPolicy !== 'SELECTED_SOURCE',
      'IMPORT_SHARE_SOURCE_DELETE_FORBIDDEN',
      409,
    );
    importInvariant(
      sourceCleanupPolicy === 'KEEP' ||
        (plan.sourceKind === 'BAIDU_SHARE' && sourceCleanupPolicy === 'JOB_STAGING_ONLY') ||
        (plan.sourceKind === 'BAIDU_APP_DIR' && sourceCleanupPolicy === 'SELECTED_SOURCE'),
      'IMPORT_SOURCE_CLEANUP_POLICY_INVALID',
      409,
    );
    importInvariant(
      request.sourceCleanupRequiresPublication !== true ||
        (sourceCleanupPolicy !== 'KEEP' && publicationPolicy === 'PUBLISH_TO_JELLYFIN'),
      'IMPORT_SOURCE_CLEANUP_POLICY_INVALID',
      409,
    );
    let publication: Parameters<ImportRepository['createJob']>[0]['publication'];
    if (publicationPolicy === 'PUBLISH_TO_JELLYFIN') {
      importInvariant(this.publicationEnabled, 'IMPORT_PUBLICATION_FEATURE_DISABLED', 409);
      importInvariant(this.publicationController, 'IMPORT_PUBLICATION_NOT_CONFIGURED', 503);
      importInvariant(request.publication !== undefined, 'IMPORT_PUBLICATION_REQUIRED', 400);
      importInvariant(destination.supportsJellyfin === true, 'IMPORT_DESTINATION_UNSUPPORTED', 409);
      const library = this.publicationLibraries.find(
        (candidate) => candidate.libraryId === request.publication?.libraryId,
      );
      importInvariant(library, 'IMPORT_LIBRARY_NOT_ALLOWLISTED', 409);
      importInvariant(
        importLibraryAcceptsMediaType(request.publication.mediaType, library.contentType),
        'IMPORT_MEDIA_TYPE_MISMATCH',
        409,
      );
      this.validateLogicalPath(request.publication.logicalPath);
      publication = { request: request.publication, library };
    } else {
      importInvariant(request.publication === undefined, 'IMPORT_PUBLICATION_NOT_APPLICABLE', 400);
    }

    try {
      const job = this.repository.createJob({
        plan,
        destination,
        secretRef: credential.ref,
        publicationPolicy,
        sourceCleanupPolicy,
        sourceCleanupRequiresPublication: request.sourceCleanupRequiresPublication ?? false,
        ...(publication === undefined ? {} : { publication }),
        idempotencyKey: request.idempotencyKey,
      });
      this.publish(job);
      if (credential.createdRef !== null) {
        const persistedRef = this.repository.secretRef(job.jobId);
        if (persistedRef === credential.createdRef) {
          // A newly created job owns the replacement. Its older plan secret can
          // be retired only after the job row durably references the new one.
          if (plan.secretRef !== null && plan.secretRef !== persistedRef) {
            this.secrets?.delete(plan.secretRef);
          }
        } else {
          // Idempotent replay returned the existing job. The just-created secret
          // is unused and must be removed; deleting the plan/job secret here
          // would strand the already queued task on AUTH_REQUIRED.
          this.secrets?.delete(credential.createdRef);
        }
      }
      return job;
    } catch (error) {
      if (credential.createdRef !== null) this.secrets?.delete(credential.createdRef);
      throw error;
    }
  }

  legacySourceStatus(jobId: string) {
    importInvariant(this.legacySources !== undefined, 'IMPORT_LEGACY_RECOVERY_NOT_CONFIGURED', 503);
    return this.legacySources.status(jobId);
  }

  bindLegacySource(
    input: Parameters<NonNullable<ImportControlServiceOptions['legacySources']>['bind']>[0],
  ) {
    this.assertFileMutationAllowed(input.jobId);
    importInvariant(
      this.mode === 'ACTIVE' && this.runtimeConfigured && this.legacySources !== undefined,
      'IMPORT_LEGACY_RECOVERY_NOT_CONFIGURED',
      503,
    );
    return this.legacySources.bind(input);
  }

  replayLegacySourceBinding(
    input: Parameters<NonNullable<ImportControlServiceOptions['legacySources']>['bind']>[0],
  ) {
    this.assertFileMutationAllowed(input.jobId);
    importInvariant(
      this.mode === 'ACTIVE' && this.runtimeConfigured && this.legacySources !== undefined,
      'IMPORT_LEGACY_RECOVERY_NOT_CONFIGURED',
      503,
    );
    return this.legacySources.replay(input);
  }

  list(): ImportJobSummary[] {
    return this.repository
      .list({
        publicationActionsEnabled: this.isPublicationMutationEnabled(),
        publicationLibraryIds: this.publicationLibraries.map((library) => library.libraryId),
      })
      .map((job) => this.fileCompatibilityView(job));
  }

  detail(jobId: string) {
    return this.fileCompatibilityView(
      this.repository.requireDetail(jobId, {
        publicationActionsEnabled: this.isPublicationMutationEnabled(),
        publicationLibraryIds: this.publicationLibraries.map((library) => library.libraryId),
      }),
    );
  }

  action(
    jobId: string,
    action: 'PAUSE' | 'RESUME' | 'CANCEL' | 'RETRY',
    idempotencyKey: string,
  ): ImportJobSummary {
    this.assertFileMutationAllowed(jobId);
    this.assertRuntimeEnabled();
    const job =
      this.grouping === undefined
        ? this.repository.mutateAction(jobId, action, idempotencyKey)
        : this.grouping.repository.childAction(this.repository, jobId, action, idempotencyKey);
    this.publish(job);
    return job;
  }

  provideCredentials(
    jobId: string,
    credential: ImportShareCredential,
    idempotencyKey: string,
  ): ImportJobSummary {
    this.assertFileMutationAllowed(jobId);
    importInvariant(
      this.repository.archives.status(jobId) === null,
      'ARCHIVE_USE_CANDIDATE_CREDENTIALS',
      409,
    );
    this.assertRuntimeEnabled();
    const previousRef = this.repository.secretRef(jobId);
    const resolved = this.resolveCredential(credential, null, null);
    importInvariant(resolved.ref !== null, 'IMPORT_CREDENTIAL_REQUIRED', 400);
    try {
      const job = this.repository.provideCredentials(jobId, resolved.ref, idempotencyKey);
      this.publish(job);
      if (previousRef !== null && previousRef !== resolved.ref) this.secrets?.delete(previousRef);
      return job;
    } catch (error) {
      if (resolved.createdRef !== null) this.secrets?.delete(resolved.createdRef);
      throw error;
    }
  }

  publication(publicationId: string): ImportPublication {
    return (
      this.publicationController?.get(publicationId) ??
      this.repository.requirePublication(publicationId)
    );
  }

  provideArchiveCredentials(input: {
    jobId: string;
    adminId: string;
    idempotencyKey: string;
    expectedRevision: number;
    candidates: string[];
  }): ImportJobSummary {
    this.assertRuntimeEnabled();
    this.assertFileMutationAllowed(input.jobId);
    importInvariant(this.archive !== undefined, 'ARCHIVE_RUNTIME_UNAVAILABLE', 503);
    const parsed = ArchiveCandidatesSchema.min(1).safeParse(input.candidates);
    importInvariant(parsed.success, 'ARCHIVE_CREDENTIAL_INVALID', 400);
    const candidates = [...new Set(parsed.data)],
      fingerprint = this.archive.passwords.fingerprint({
        jobId: input.jobId,
        expectedRevision: input.expectedRevision,
        candidates,
      });
    const operation = { ...input, fingerprint };
    if (this.repository.archives.credentialReplay(operation)) return this.detail(input.jobId);
    this.repository.archives.assertCredentialUpdate(input.jobId, input.expectedRevision);
    const previous = this.repository.archives.secretRef(input.jobId),
      ref = this.archive.passwords.put(candidates);
    try {
      this.repository.archives.updateCredentials({ ...operation, ref, count: candidates.length });
    } catch (error) {
      this.archive.passwords.delete(ref);
      throw error;
    }
    if (
      previous !== null &&
      previous !== ref &&
      !this.repository.archives.hasSecretReference(previous)
    )
      this.archive.passwords.delete(previous);
    const job = this.detail(input.jobId);
    this.publish(job);
    return job;
  }

  /** Fast gate used before a route spends or validates mutation credentials. */
  assertPublicationMutationReady(): void {
    this.assertPublicationMutationEnabled();
  }

  async requestPublication(
    request: MediaPublicationRequest,
    idempotencyKey: string,
  ): Promise<ImportPublication> {
    this.assertFileMutationAllowed(request.jobId);
    return this.assertPublicationMutationEnabled().request(request, idempotencyKey);
  }

  async retryPublication(
    publicationId: string,
    idempotencyKey: string,
  ): Promise<ImportPublication> {
    if (!this.fileCreationEnabled)
      this.assertFileMutationAllowed(this.repository.publicationJobId(publicationId));
    return this.assertPublicationMutationEnabled().retry(publicationId, idempotencyKey);
  }

  async unpublishPublication(
    publicationId: string,
    idempotencyKey: string,
  ): Promise<{
    publicationId: string;
    state: 'UNPUBLISHED';
    cloudObjectsDeleted: false;
  }> {
    if (!this.fileCreationEnabled)
      this.assertFileMutationAllowed(this.repository.publicationJobId(publicationId));
    return this.assertPublicationMutationEnabled().unpublish(publicationId, idempotencyKey);
  }

  sourceCleanupStatus(jobId: string) {
    return this.sourceCleanupController?.status(jobId) ?? null;
  }

  sourceCleanupPreview(input: ImportSourceCleanupPreviewInput) {
    this.assertFileMutationAllowed(input.jobId);
    return this.requireSourceCleanupController().preview(input);
  }

  replaySourceCleanupExecute(input: ImportSourceCleanupExecuteInput) {
    this.assertFileMutationAllowed(input.jobId);
    return this.requireSourceCleanupController().replayExecute(input);
  }

  executeSourceCleanup(input: ImportSourceCleanupExecuteInput) {
    this.assertFileMutationAllowed(input.jobId);
    return this.requireSourceCleanupController().execute(input);
  }

  /** Compatibility builds expose V2 history without advertising unsupported mutations. */
  private fileCompatibilityView<T extends ImportJobSummary>(job: T): T {
    return (this.archive === undefined && job.archive !== undefined) ||
      (!this.fileCreationEnabled && this.repository.isFileJob(job.jobId))
      ? { ...job, availableActions: [] }
      : job;
  }

  private assertFileMutationAllowed(jobId: string): void {
    importInvariant(
      this.archive !== undefined || this.repository.archives.status(jobId) === null,
      'ARCHIVE_RUNTIME_UNAVAILABLE',
      503,
    );
    importInvariant(
      this.fileCreationEnabled || !this.repository.isFileJob(jobId),
      'IMPORT_FILE_CREATION_DISABLED',
      409,
    );
  }

  private isRuntimeEnabled(): boolean {
    return (
      this.mode === 'ACTIVE' &&
      this.runtimeConfigured &&
      this.planner !== undefined &&
      this.secrets !== undefined
    );
  }

  private isPublicationMutationEnabled(): boolean {
    return (
      this.isRuntimeEnabled() &&
      this.jellyfinConfigured &&
      this.publicationEnabled &&
      this.publicationController !== undefined &&
      this.publicationLibraries.length > 0
    );
  }

  private assertRuntimeEnabled(): void {
    if (this.mode === 'SHADOW') throw new ImportControlError('IMPORT_SHADOW_MODE', 409);
    if (!this.runtimeConfigured || !this.planner || !this.secrets) {
      throw new ImportControlError('IMPORT_NOT_CONFIGURED', 503);
    }
  }

  private assertCreationEnabled(): void {
    this.assertRuntimeEnabled();
    if (!this.creationEnabled()) {
      throw new ImportControlError('IMPORT_CREATION_DISABLED', 409);
    }
  }

  private assertPublicationMutationEnabled(): ImportPublicationController {
    this.assertRuntimeEnabled();
    if (!this.publicationEnabled) {
      throw new ImportControlError('IMPORT_PUBLICATION_FEATURE_DISABLED', 409);
    }
    if (!this.jellyfinConfigured || this.publicationController === undefined) {
      throw new ImportControlError('IMPORT_PUBLICATION_NOT_CONFIGURED', 503);
    }
    return this.publicationController;
  }

  private requireSourceCleanupController(): ImportSourceCleanupController {
    if (this.sourceCleanupController === undefined) {
      throw new ImportControlError('IMPORT_SOURCE_CLEANUP_NOT_CONFIGURED', 503);
    }
    return this.sourceCleanupController;
  }

  private assertFileCleanupPolicy(
    request: CreateImportRequest,
    plan: ReturnType<ImportRepository['requirePlan']>,
  ): void {
    if (plan.sourceManifest?.version === 3) {
      importInvariant(
        (request.sourceCleanupPolicy ?? 'KEEP') === 'KEEP',
        'ARCHIVE_SOURCE_KEEP_REQUIRED',
        409,
      );
      return;
    }
    if (plan.sourceManifest?.version !== 2 || (request.sourceCleanupPolicy ?? 'KEEP') === 'KEEP')
      return;
    const object = plan.sourceManifest.objects[0]!;
    importInvariant(
      request.sourceCleanupPolicy === 'SELECTED_SOURCE' &&
        plan.sourceConnectionId !== null &&
        plan.sourceExternalAccountId !== null &&
        this.sourceCleanupController?.canCreateFileCleanup?.({
          connectionId: plan.sourceConnectionId,
          externalAccountId: plan.sourceExternalAccountId,
          fsid: object.fsid,
          path: object.path,
          size: object.size,
          mtime: object.mtime,
        }) === true,
      'IMPORT_SOURCE_CLEANUP_SCOPE_UNSUPPORTED',
      409,
    );
  }

  private resolveCredential(
    credential: ImportShareCredential,
    embeddedPasscode: string | null,
    fallbackRef: string | null,
  ): ResolvedCredential {
    importInvariant(
      !(embeddedPasscode !== null && credential.kind === 'REF'),
      'IMPORT_CREDENTIAL_AMBIGUOUS',
      400,
    );
    if (credential.kind === 'REF') {
      this.secrets!.read(credential.secretRef);
      return { ref: credential.secretRef, createdRef: null };
    }
    const explicit =
      credential.kind === 'INLINE' ? normalizeInlinePasscode(credential.passcode) : null;
    importInvariant(
      !(embeddedPasscode !== null && explicit !== null && embeddedPasscode !== explicit),
      'IMPORT_PASSCODE_CONFLICT',
      400,
    );
    const inline = explicit ?? embeddedPasscode;
    if (inline !== null) {
      const stored = this.secrets!.put(inline, this.secretTtlMs);
      return { ref: stored.ref, createdRef: stored.ref };
    }
    if (fallbackRef !== null) {
      this.secrets!.read(fallbackRef);
      return { ref: fallbackRef, createdRef: null };
    }
    return { ref: null, createdRef: null };
  }

  private validateSourcePath(value: string): string {
    const normalized = value;
    importInvariant(isCanonicalBaiduPath(normalized, false), 'IMPORT_SOURCE_PATH_REJECTED', 400);
    return normalized;
  }

  private resolveSourceBinding(
    requested: string | undefined,
    sourceKind: ImportPlanRequest['sourceKind'],
  ): FrozenImportSourceBinding | null {
    if (this.sourceConnections === undefined) return null;
    const connectionId = requested ?? this.defaultSourceConnectionId();
    importInvariant(connectionId !== null, 'IMPORT_SOURCE_CONNECTION_REQUIRED', 409);
    return this.sourceConnections.requireBaiduSource(connectionId, sourceKind);
  }

  private resolveDestinationId(requested: string | undefined): string {
    if (requested !== undefined) return requested;
    const accountId = this.defaultDestinationAccountId();
    importInvariant(accountId !== null, 'IMPORT_DESTINATION_REQUIRED', 409);
    return `onedrive-crypt:${accountId}`;
  }

  private validateLogicalPath(value: string): void {
    importInvariant(
      !value.startsWith('/') &&
        !value.includes('\\') &&
        !value.includes('\0') &&
        value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
      'IMPORT_LOGICAL_PATH_REJECTED',
      400,
    );
  }

  private validatePlannerResult(result: PlannerResult): void {
    importInvariant(
      Number.isSafeInteger(result.objectCount) && result.objectCount >= 0,
      'IMPORT_PLAN_INVALID',
      502,
    );
    for (const value of [result.totalBytes, result.largestObjectBytes, result.requiredSpoolBytes]) {
      importInvariant(/^(?:0|[1-9][0-9]{0,29})$/.test(value), 'IMPORT_PLAN_INVALID', 502);
    }
    importInvariant(result.pathConflicts.length <= 500, 'IMPORT_PLAN_INVALID', 502);
    importInvariant(result.destinationLimitIssues.length <= 500, 'IMPORT_PLAN_INVALID', 502);
  }

  private publicPlan(plan: ReturnType<ImportRepository['requirePlan']>): ImportPlan {
    const options = pipelinePlanOptions(plan);
    const groups =
      options === null
        ? null
        : planImportGroups(
            canonicalSourceManifest(plan.sourceManifest),
            options.processing,
            options.residentMaxBytes,
          );
    const base =
      plan.sourceManifest?.version === 3
        ? archiveBaseManifest(plan.sourceManifest)
        : plan.sourceManifest;
    const archive = archivePlanSummary(plan);
    const file = base?.version === 2 ? canonicalSourceManifest(base) : null;
    return {
      ...(options === null || groups === null
        ? {}
        : {
            pipeline: {
              options,
              groupCount: groups.length,
              candidateCount: (plan.selection as { archiveIngress: { count: number } })
                .archiveIngress.count,
              executableCount: groups.filter((x) => x.issue === null).length,
              attentionCount: groups.filter((x) => x.issue !== null).length,
              largestGroupBytes: groups.reduce(
                (max, g) =>
                  BigInt(g.requiredSpoolBytes) > BigInt(max) ? g.requiredSpoolBytes : max,
                '0',
              ),
              groups: groups.slice(0, 500),
              groupsTruncated: groups.length > 500,
            },
          }),
      ...(archive === undefined ? {} : { archive }),
      planId: plan.planId,
      sourceKind: plan.sourceKind,
      sourceConnectionId: plan.sourceConnectionId,
      ...(file === null
        ? {}
        : {
            sourceFileProof: {
              scope: 'FILE' as const,
              path: file.rootPath,
              fsid: file.objects[0]!.fsid,
              size: file.objects[0]!.size,
              mtime: file.objects[0]!.mtime,
            },
          }),
      sourceRootFsid:
        plan.sourceKind === 'BAIDU_APP_DIR' && base !== null && base.version === 1
          ? canonicalSourceManifest(base).sourceIdentity
          : null,
      sourceAlias: plan.sourceAlias,
      sourceRequiresPasscode: plan.sourceRequiresPasscode,
      sourceAuthState: plan.sourceAuthState,
      destinationId: plan.destinationId,
      objectCount: plan.objectCount,
      totalBytes: plan.totalBytes,
      largestObjectBytes: plan.largestObjectBytes,
      requiredSpoolBytes: plan.requiredSpoolBytes,
      pathConflicts: plan.pathConflicts,
      destinationLimitIssues: plan.destinationLimitIssues,
      plannedPolicy: plan.plannedPolicy,
      mode: plan.mode,
      transferStarted: false,
      credentialRef: plan.secretRef,
      expiresAt: plan.expiresAt,
    };
  }

  private assertArchivePlan(
    request: CreateImportRequest,
    plan: ReturnType<ImportRepository['requirePlan']>,
  ): void {
    importInvariant(pipelinePlanOptions(plan) === null, 'GROUP_PARENT_REQUIRES_PIPELINE', 409);
    importInvariant(plan.sourceManifest?.version !== 4, 'GROUP_CHILD_CREATION_INTERNAL_ONLY', 409);
    if (plan.sourceManifest?.version !== 3) {
      importInvariant(
        request.processingMode !== 'RECURSIVE_VIDEO' && request.processingMode !== 'GROUPED_VIDEO',
        'ARCHIVE_PROCESSING_ACK_REQUIRED',
        409,
      );
      return;
    }
    importInvariant(this.archive !== undefined, 'ARCHIVE_RUNTIME_UNAVAILABLE', 503);
    importInvariant(
      request.processingMode === 'RECURSIVE_VIDEO',
      'ARCHIVE_PROCESSING_ACK_REQUIRED',
      409,
    );
    importInvariant(
      (request.sourceCleanupPolicy ?? 'KEEP') === 'KEEP' &&
        request.sourceCleanupRequiresPublication !== true,
      'ARCHIVE_SOURCE_KEEP_REQUIRED',
      409,
    );
    const ingress = (plan.selection as { archiveIngress: { ref: string | null } }).archiveIngress;
    if (ingress.ref !== null) this.archive.passwords.read(ingress.ref);
  }

  private publish(job: ImportJobSummary): void {
    const total = BigInt(job.progress.jobBytesTotal);
    const verified = BigInt(job.progress.jobBytesVerified);
    const progress = total === 0n ? 0 : Number((verified * 1_000_000n) / total) / 1_000_000;
    this.events.publish({
      type: 'job.updated',
      jobId: job.jobId,
      state: job.progress.state,
      progress: Math.max(0, Math.min(1, progress)),
    });
  }
}
