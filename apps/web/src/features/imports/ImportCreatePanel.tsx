import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  CheckCircle2,
  CircleSlash,
  Cloud,
  Clapperboard,
  FileWarning,
  KeyRound,
  Link2,
  ListTree,
  Lock,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { libraryChoiceReason, libraryOptionLabel } from './libraryChoices.js';

import type {
  ArchivePlanRequest,
  CloudConnection,
  ImportCapabilities,
  ImportDestination,
  ImportJobSummary,
  ImportPipelineSummary,
  ImportMediaType,
  ImportPlan,
  ImportShareCredential,
  ImportSourceCleanupPolicy,
  ImportSourceKind,
  PublicationPolicy,
  NetdiskSettingsValues,
} from '@ptvault/contracts';

import { isDemoSessionActive } from '../../demo/demoSession.js';
import { useReveal } from '../../showcase/useReveal.js';
import { ArchiveCandidatesField } from './ArchiveCandidatesField.js';
import { ArchivePlanPanel } from './ArchiveProgressPanel.js';
import { GroupPipelinePlanPanel } from './GroupPipelinePlanPanel.js';
import { createGroupPipeline, groupErrorMessage, groupPipelinesQueryKey } from './groupApi.js';
import { cloudConnectionsQueryKey, getCloudConnections } from '../storage/connectionApi.js';
import { BaiduSourceBrowser } from './BaiduSourceBrowser.js';
import { DirectoryBatchPlans } from './DirectoryBatchPlans.js';
import { runDirectoryPlanRequest } from './directoryBatch.js';
import {
  directorySubmissionKey,
  freezeDirectorySubmission,
  type DirectorySubmission,
  type DirectorySubmissions,
} from './directorySubmissions.js';
import { verifyDirectoryPlanIdentity } from './directoryPlanIdentity.js';
import { verifyFilePlanIdentity } from './filePlanIdentity.js';
import {
  removeSourceDirectory,
  sourceDirectoryKey,
  type SourceDirectory,
  type SourceFile,
} from './sourceSelection.js';
import {
  createImport,
  importsQueryKey,
  planImport,
  isDefiniteImportCreateRejection,
  refreshImportLibraries,
  importDestinationsQueryKey,
} from './importApi.js';
import { validPublicationLogicalPath } from './publicationPath.js';
import { formatDecimalBytes, splitSharePasscode } from './importFormatting.js';
import {
  DESTINATION_UNAVAILABLE_LABELS,
  IMPORT_DESTINATION_KIND_LABELS,
  IMPORT_MEDIA_TYPE_LABELS,
  IMPORT_SOURCE_LABELS,
  PUBLICATION_POLICY_LABELS,
  PUBLISH_DISABLED_LABELS,
} from './importLabels.js';

/** Why writes are refused, when they are. Drives the notice and the disabled state. */
export type ReadOnlyReason = 'DEMO' | 'SHADOW' | 'FEATURE_DISABLED' | null;

const READ_ONLY_LABELS: Record<Exclude<ReadOnlyReason, null>, string> = {
  DEMO: '演示只读',
  SHADOW: '只读影子模式',
  FEATURE_DISABLED: '尚未启用',
};

const READ_ONLY_NOTES: Record<Exclude<ReadOnlyReason, null>, string> = {
  DEMO: '这是公网演示账户。表单、计划和任务视图都是真的，但任何写操作都会被浏览器内的演示层拒绝。',
  SHADOW: '这台机器跑在只读影子模式：接口在，但不会真的创建迁移任务，也不会写入任何云端目标。',
  FEATURE_DISABLED: '这台机器上关闭了创建网盘迁移的能力，只能查看已有任务。',
};

const CONFLICT_LABELS = {
  DUPLICATE_PATH: '来源清单里有两个对象会落到同一个路径',
  EXISTING_OBJECT: '目标上已经存在同名对象',
  CASE_COLLISION: '只有大小写不同，目标不区分大小写',
} as const;

const LIMIT_LABELS = {
  PATH_TOO_LONG: '整条路径超出目标限制',
  SEGMENT_TOO_LONG: '某一层目录或文件名过长',
  ILLEGAL_CHARACTER: '含目标不接受的字符',
  OBJECT_TOO_LARGE: '单文件超出目标单对象上限',
  CRYPT_NAME_TOO_LONG: '加密后名称膨胀超限',
} as const;

const CLEANUP_POLICY_LABELS: Record<ImportSourceCleanupPolicy, string> = {
  KEEP: '保留来源',
  JOB_STAGING_ONLY: '只清理任务暂存对象',
  SELECTED_SOURCE: '已选来源移入回收站',
};

function cleanupPoliciesFor(kind: ImportSourceKind): readonly ImportSourceCleanupPolicy[] {
  if (kind === 'BAIDU_SHARE') return ['KEEP', 'JOB_STAGING_ONLY'];
  if (kind === 'BAIDU_APP_DIR') return ['KEEP', 'SELECTED_SOURCE'];
  return ['KEEP'];
}

/**
 * A read-only figure, or an honest statement that the API did not report one.
 *
 * The distinction the design standard makes load-bearing: an absent field means
 * this API version does not report it, `null` means it reports it and has none.
 * Both are drawn as words, never as `0`.
 */
function ReportedBytes({ value }: { value: string | null | undefined }) {
  if (value === undefined) {
    return <span className="instance-meta-value is-unknown">该 API 版本未报告</span>;
  }
  if (value === null) return <span className="instance-meta-value is-unknown">未提供</span>;
  return <span className="instance-meta-value">{formatDecimalBytes(value)}</span>;
}

function ReportedText({ value }: { value: string | null | undefined }) {
  if (value === undefined) {
    return <span className="instance-meta-value is-unknown">该 API 版本未报告</span>;
  }
  if (value === null) return <span className="instance-meta-value is-unknown">未提供</span>;
  return <span className="instance-meta-value is-mono">{value}</span>;
}

function ReportedFlag({ value }: { value: boolean | undefined }) {
  if (value === undefined) {
    return <span className="instance-meta-value is-unknown">该 API 版本未报告</span>;
  }
  return <span className="instance-meta-value">{value ? '支持' : '不支持'}</span>;
}

/**
 * Create one netdisk import.
 *
 * Three decisions shape this form:
 *
 * 1. **The passcode is a credential, handled like one.** It has its own masked
 *    field, it is lifted out of a pasted link before that link is stored
 *    anywhere, it never enters the URL or any storage, and it is dropped from
 *    component state the instant planning returns — after which creating the job
 *    references the server-side handle instead. No mutation cache holds it,
 *    because a cache that keeps its variables keeps the secret for the life of
 *    the page.
 * 2. **Archive-only is the default and stands alone.** A Jellyfin problem
 *    disables one radio and nothing else. An import is a verified backup;
 *    publishing is an extra that must be chosen on purpose.
 * 3. **Capability comes from the server.** Sources, destinations and the library
 *    allowlist are rendered from the capability response, never from a hardcoded
 *    list — a browser that decides for itself keeps offering things after they
 *    are switched off.
 */
export function ImportCreatePanel({
  capabilities,
  destinations,
  readOnlyReason,
  initialSourceConnectionId,
  initialSourceKind,
  defaults: requestedDefaults,
  onCreated,
  onPipelineCreated,
}: {
  capabilities: ImportCapabilities;
  destinations: readonly ImportDestination[];
  readOnlyReason: ReadOnlyReason;
  initialSourceConnectionId?: string;
  initialSourceKind?: ImportSourceKind;
  defaults?: Pick<NetdiskSettingsValues, 'defaultDestinationAccountId' | 'defaultPublicationPolicy'> | null;
  onCreated?: (job: ImportJobSummary) => void;
  onPipelineCreated?: (pipeline: ImportPipelineSummary) => void;
}) {
  const fieldId = useId();
  // A form's initial defaults are not a live binding. Background refreshes must
  // never replace the operator's choice or relabel an existing draft.
  const [defaults] = useState(requestedDefaults);
  const queryClient = useQueryClient();
  const revealRef = useReveal<HTMLDivElement>(60);
  const [formInteracted, setFormInteracted] = useState(false);

  const [sourceKind, setSourceKind] = useState<ImportSourceKind>(
    initialSourceKind ??
      capabilities.sources.find((source) => source.enabled && source.kind !== 'OTHER')?.kind ??
      'BAIDU_SHARE',
  );
  const [sourceConnectionId, setSourceConnectionId] = useState(initialSourceConnectionId ?? '');
  const [shareUrl, setShareUrl] = useState('');
  const [sourcePath, setSourcePath] = useState('');
  const [sourceDirectories, setSourceDirectories] = useState<SourceDirectory[]>([]);
  const [sourceFile, setSourceFile] = useState<SourceFile | null>(null);
  const [submissions, setSubmissions] = useState<DirectorySubmissions>({});
  const submissionsRef = useRef<DirectorySubmissions>({});
  const createdPlanIds = Object.values(submissions)
    .filter((record) => record.status === 'CREATED')
    .map((record) => record.plan.planId);
  const rememberSubmission = (record: DirectorySubmission): void => {
    const next = { ...submissionsRef.current, [record.key]: record };
    submissionsRef.current = next;
    setSubmissions(next);
  };
  const [activePlanSourcePath, setActivePlanSourcePath] = useState<string | null>(null);
  const isDirectoryBatch = sourceKind === 'BAIDU_APP_DIR' && sourceDirectories.length > 1;
  /**
   * The only copy of the plaintext passcode in the browser, and it is cleared as
   * soon as a request settles. Deliberately component state rather than anything
   * that outlives this panel.
   */
  const [passcode, setPasscode] = useState('');
  const [archiveMode, setArchiveMode] = useState(false);
  const [grouped, setGrouped] = useState(false);
  const groupMode = archiveMode && grouped && sourceFile === null && sourceKind === 'BAIDU_APP_DIR';
  const [archiveCandidates, setArchiveCandidates] = useState<string[]>([]);
  const [archiveDepth, setArchiveDepth] = useState(8);
  const [archiveGiB, setArchiveGiB] = useState(256);
  const [destinationId, setDestinationId] = useState(
    () => defaults === undefined
      ? destinations.find((destination) => destination.available)?.destinationId ?? ''
      : defaults?.defaultDestinationAccountId
        ? destinations.find((destination) => destination.destinationId === `onedrive-crypt:${defaults.defaultDestinationAccountId}`)?.destinationId ?? ''
        : '',
  );
  const [policy, setPolicy] = useState<PublicationPolicy>(defaults?.defaultPublicationPolicy ?? 'ARCHIVE_ONLY');
  const [sourceCleanupPolicy, setSourceCleanupPolicy] = useState<ImportSourceCleanupPolicy>('KEEP');
  const [sourceCleanupRequiresPublication, setSourceCleanupRequiresPublication] = useState(false);
  const [mediaType, setMediaType] = useState<ImportMediaType>('MOVIE');
  const [libraryId, setLibraryId] = useState('');
  const [libraryRefreshPending, setLibraryRefreshPending] = useState(false);
  const [libraryRefreshResult, setLibraryRefreshResult] = useState<string | null>(null);
  const [logicalPath, setLogicalPath] = useState('');

  const [plan, setPlan] = useState<ImportPlan | null>(null);
  /** Monotonic fence for a plan response racing a later input edit. */
  const planInputRevision = useRef(0);
  const [planPending, setPlanPending] = useState(false);
  const [planUnsupported, setPlanUnsupported] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [createPending, setCreatePending] = useState(false);
  const createInFlight = useRef(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createUnsupported, setCreateUnsupported] = useState(false);
  /**
   * Submit-time only. The *mismatch* below is derived instead, because it must
   * appear the moment the pair becomes incompatible rather than after a click —
   * switching the media type back leaves a library selected that cannot hold it,
   * and the server would refuse that on submit anyway.
   */
  const [missingLibrary, setMissingLibrary] = useState(false);
  /**
   * Which field made the plan on screen obsolete.
   *
   * Dropping the plan silently was the old behaviour, and it reads as the button
   * having broken: the figures vanish, the create button greys out, and nothing
   * says why. A plan is a preflight against one exact (source, destination) pair,
   * so anything that changes that pair must retire it *visibly* — otherwise the
   * safe thing (re-checking) looks like a malfunction.
   */
  const [planStaleReason, setPlanStaleReason] = useState<string | null>(null);

  const connectionsQuery = useQuery({
    queryKey: cloudConnectionsQueryKey,
    queryFn: getCloudConnections,
    enabled: !isDemoSessionActive(),
  });
  const connectionsAnswer = connectionsQuery.data;
  const connectionEnvelope = connectionsAnswer?.supported === true ? connectionsAnswer.data : null;
  const eligibleSourceConnections = useMemo(() => {
    const requiredCapabilities =
      sourceKind === 'BAIDU_SHARE'
        ? (['SHARE_TRANSFER', 'SOURCE_DOWNLOAD'] as const)
        : sourceKind === 'BAIDU_APP_DIR'
          ? (['SOURCE_BROWSE', 'SOURCE_DOWNLOAD'] as const)
          : ([] as const);
    if (requiredCapabilities.length === 0) return [];
    return (connectionEnvelope?.connections ?? []).filter(
      (connection): connection is CloudConnection =>
        connection.provider === 'BAIDU' &&
        connection.authState === 'CONNECTED' &&
        requiredCapabilities.every((capability) => connection.capabilities.includes(capability)),
    );
  }, [connectionEnvelope, sourceKind]);
  const selectedSourceConnection =
    eligibleSourceConnections.find((connection) => connection.id === sourceConnectionId) ?? null;
  const canBrowseSelectedSource =
    sourceKind === 'BAIDU_APP_DIR' &&
    selectedSourceConnection?.capabilities.includes('SOURCE_BROWSE') === true &&
    selectedSourceConnection.supportedActions.includes('BROWSE') &&
    connectionEnvelope?.capabilities.supportedActions.includes('BROWSE') === true;

  useEffect(() => {
    if (
      sourceConnectionId !== '' &&
      connectionEnvelope !== null &&
      !eligibleSourceConnections.some((connection) => connection.id === sourceConnectionId)
    ) {
      setSourceConnectionId('');
      setSourcePath('');
      setSourceDirectories([]);
      setSourceFile(null);
      setActivePlanSourcePath(null);
      setShareUrl('');
      setPasscode('');
      setPlanError(null);
      setPlanUnsupported(false);
      setPlanPending(false);
      // Same rule as a manual change: the plan was computed against a connection
      // the server no longer offers, so it is retired with a stated reason.
      if (plan !== null) setPlanStaleReason('来源账户');
      planInputRevision.current += 1;
      setPlan(null);
    }
  }, [connectionEnvelope, eligibleSourceConnections, plan, sourceConnectionId]);

  const availableCleanupPolicies =
    archiveMode ||
    (sourceFile !== null && capabilities.fileSourceCleanupEnabled !== true) ||
    (sourceKind === 'BAIDU_APP_DIR' &&
      (sourceDirectories.length > 0
        ? sourceDirectories.some((source) => !source.path.startsWith('/apps/bdpan/'))
        : !sourcePath.startsWith('/apps/bdpan/')))
      ? (['KEEP'] as const)
      : cleanupPoliciesFor(sourceKind);
  useEffect(() => {
    if (!availableCleanupPolicies.includes(sourceCleanupPolicy)) {
      setSourceCleanupPolicy('KEEP');
      setSourceCleanupRequiresPublication(false);
    }
  }, [availableCleanupPolicies, sourceCleanupPolicy]);

  const sourceEnabled = useMemo(
    () => new Map(capabilities.sources.map((source) => [source.kind, source])),
    [capabilities.sources],
  );
  const publishAllowed = capabilities.publishToJellyfinEnabled && capabilities.libraries.length > 0;
  const chosenLibrary = capabilities.libraries.find((library) => library.libraryId === libraryId);
  const writable = readOnlyReason === null && capabilities.createEnabled;

  const libraryMismatch =
    policy === 'PUBLISH_TO_JELLYFIN' && chosenLibrary !== undefined
      ? libraryChoiceReason(chosenLibrary, mediaType)
      : null;
  const libraryProblem =
    libraryMismatch ??
    (policy === 'PUBLISH_TO_JELLYFIN' && libraryId !== '' && chosenLibrary === undefined
      ? '之前选择的媒体库已不在当前清单中，请重新选择。'
      : missingLibrary
        ? '请选择一个 Jellyfin 媒体库。'
        : null);

  const refreshLibraryChoices = async (): Promise<void> => {
    if (libraryRefreshPending) return;
    setLibraryRefreshPending(true);
    setLibraryRefreshResult(null);
    try {
      await queryClient.cancelQueries({ queryKey: importDestinationsQueryKey });
      const answer = await refreshImportLibraries();
      if (!answer.supported) {
        setLibraryRefreshResult('当前服务未返回媒体库清单。');
        return;
      }
      queryClient.setQueryData(importDestinationsQueryKey, answer);
      setLibraryRefreshResult(
        answer.data.capabilities.libraryDiscoveryError == null
          ? '已更新媒体库清单，原表单内容保持。'
          : '读取 Jellyfin 媒体库失败；已保留上次清单，请稍后重试。',
      );
    } catch {
      setLibraryRefreshResult('刷新媒体库失败，请稍后重试；原表单内容保持。');
    } finally {
      setLibraryRefreshPending(false);
    }
  };

  /**
   * Retire the plan because one of its inputs changed, and say which.
   *
   * Only fields the plan was computed from call this. Publication and
   * cleanup choices are create-time arguments, not plan inputs, so changing them
   * leaves a valid plan alone.
   */
  const invalidatePlan = (field: string): void => {
    planInputRevision.current += 1;
    if (plan !== null || planPending) setPlanStaleReason(field);
    setPlan(null);
    setPlanPending(false);
    setActivePlanSourcePath(null);
  };
  const confirmSourceDirectories = (directories: SourceDirectory[]): void => {
    if (directories.some((source) => source.connectionId !== sourceConnectionId)) return;
    setSourceDirectories(directories);
    setSourceFile(null);
    setSourcePath(directories[0]?.path ?? '');
    invalidatePlan('来源目录清单');
  };

  /**
   * Lift a passcode out of a pasted link before the link is stored.
   *
   * Runs on every change rather than on paste alone: a link typed or dropped in
   * has to be treated the same way, and there is no event that covers all three.
   */
  const onShareUrlChange = (value: string): void => {
    const split = splitSharePasscode(value);
    setShareUrl(split.shareUrl);
    if (split.passcode !== null) setPasscode(split.passcode);
    invalidatePlan('分享链接');
  };

  const credentialFor = (stage: 'plan' | 'create'): ImportShareCredential => {
    if (stage === 'create') {
      // Planning already handed the secret inward and got a handle back, so
      // creating the job never re-sends plaintext.
      const ref = plan?.credentialRef;
      return ref === null || ref === undefined ? { kind: 'NONE' } : { kind: 'REF', secretRef: ref };
    }
    return passcode === '' ? { kind: 'NONE' } : { kind: 'INLINE', passcode };
  };

  const runPlan = async (): Promise<void> => {
    if (archiveMode && capabilities.archiveExtractionEnabled !== true) return;
    if (groupMode && capabilities.groupedPipelinesEnabled !== true) return;
    if (sourceFile !== null && capabilities.fileSelectionEnabled !== true) return;
    const reserved =
      sourceKind === 'BAIDU_APP_DIR'
        ? Object.values(submissionsRef.current).find(
            (record) =>
              record.destinationId === destinationId &&
              (sourceConnectionId === '' || record.source.connectionId === sourceConnectionId) &&
              (record.source.path === sourcePath ||
                sourceDirectories.some(
                  (source) => sourceDirectoryKey(source) === sourceDirectoryKey(record.source),
                )),
          )
        : undefined;
    if (reserved !== undefined) {
      setPlanError(
        reserved.status === 'CREATED'
          ? '此来源和目标在本批已创建任务；编辑选择不会再次创建。'
          : '此来源已有待确认提交，只能使用提交记录中的原请求重试。',
      );
      return;
    }
    const inputRevision = planInputRevision.current;
    const credential = credentialFor('plan');
    const archive = takeArchiveRequest();
    // The request owns this one-time value; later input/account changes must not retain it.
    setPasscode('');
    setPlanPending(true);
    setPlanError(null);
    setPlanUnsupported(false);
    setPlan(null);
    setPlanStaleReason(null);
    try {
      const result = await runDirectoryPlanRequest(
        () => inputRevision === planInputRevision.current,
        () =>
          planImport({
            sourceKind,
            ...(archive === undefined ? {} : { archive }),
            ...(groupMode ? { grouped: true } : {}),
            ...(sourceConnectionId === '' ? {} : { sourceConnectionId }),
            ...(sourceKind === 'BAIDU_SHARE' ? { shareUrl } : { sourcePath }),
            ...(sourceKind === 'BAIDU_APP_DIR' && sourceFile !== null
              ? {
                  sourceScope: 'FILE' as const,
                  expectedFile: {
                    fsid: sourceFile.fsid,
                    size: sourceFile.size,
                    mtime: sourceFile.mtime,
                  },
                }
              : {}),
            ...(sourceKind === 'BAIDU_APP_DIR' && sourceDirectories.length === 1
              ? { expectedSourceRootFsid: sourceDirectories[0]!.fsid }
              : {}),
            credential,
            destinationId,
          }),
      );
      if (result === undefined || inputRevision !== planInputRevision.current) return;
      if (result.supported) {
        if (sourceFile !== null) verifyFilePlanIdentity(sourceFile, destinationId, result.data);
        if (sourceKind === 'BAIDU_APP_DIR' && sourceDirectories.length === 1)
          verifyDirectoryPlanIdentity(sourceDirectories[0]!, destinationId, result.data);
        if (
          result.data.sourceKind === 'BAIDU_APP_DIR' &&
          result.data.sourceRootFsid != null &&
          result.data.sourceConnectionId != null
        ) {
          const prior =
            submissionsRef.current[
              directorySubmissionKey(
                { connectionId: result.data.sourceConnectionId, fsid: result.data.sourceRootFsid },
                result.data.destinationId,
              )
            ];
          if (prior !== undefined) {
            setPlanError('这个来源与目标已有提交记录；请查看原记录，不再采用新计划。');
            return;
          }
        }
        setPlan(result.data);
      } else {
        setPlanUnsupported(true);
      }
    } catch (error) {
      if (inputRevision === planInputRevision.current)
        setPlanError(
          error instanceof Error && error.message === 'FILE_PLAN_IDENTITY_UNVERIFIED'
            ? '服务端未确认所选文件身份，请重新浏览或更新API。'
            : error instanceof Error && error.message === 'DIRECTORY_PLAN_IDENTITY_UNVERIFIED'
              ? '服务端未确认所选目录身份，请重新浏览或更新API。'
              : groupErrorMessage(error),
        );
    } finally {
      // Never clear a new account's inputs or pending state when an old request settles.
      if (inputRevision === planInputRevision.current) {
        setPasscode('');
        setPlanPending(false);
      }
    }
  };

  /**
   * Only the publish policy has anything to validate.
   *
   * Written as an early return on the policy rather than as a required-field
   * check on a hidden input: a check written the other way round makes the
   * default — archive-only — unsubmittable, because the field it demands is not
   * on screen.
   */
  const validateLibrary = (): boolean => {
    if (policy === 'ARCHIVE_ONLY') {
      setMissingLibrary(false);
      return true;
    }
    if (chosenLibrary === undefined) {
      setMissingLibrary(true);
      return false;
    }
    setMissingLibrary(false);
    return libraryMismatch === null && validPublicationLogicalPath(logicalPath);
  };

  const submitRequest = async (
    request: Parameters<typeof createImport>[0],
    record?: DirectorySubmission,
  ): Promise<void> => {
    if (
      createInFlight.current ||
      !writable ||
      record?.status === 'REJECTED' ||
      record?.status === 'CREATED' ||
      (record !== undefined && submissionsRef.current[record.key]?.status === 'CREATED')
    )
      return;
    createInFlight.current = true;
    const inputRevision = planInputRevision.current;
    const submittedPlanId = request.planId;
    const activeRecord =
      record === undefined
        ? undefined
        : { ...record, status: 'PENDING' as const, attempts: record.attempts + 1, error: null };
    if (activeRecord !== undefined) rememberSubmission(activeRecord);
    setCreatePending(true);
    setCreateError(null);
    setCreateUnsupported(false);
    try {
      const result =
        request.processingMode === 'GROUPED_VIDEO'
          ? await createGroupPipeline(request)
          : await createImport(request);
      if (!result.supported) {
        if (activeRecord !== undefined)
          rememberSubmission({
            ...activeRecord,
            status: 'UNKNOWN',
            error: '创建接口未确认结果；请保留原请求，不要重新规划。',
          });
        if (inputRevision === planInputRevision.current) setCreateUnsupported(true);
        return;
      }
      // The server outcome belongs to the original submission even if inputs were invalidated.
      if (activeRecord !== undefined)
        rememberSubmission({
          ...activeRecord,
          status: 'CREATED',
          ...('pipelineId' in result.data
            ? { pipelineId: result.data.pipelineId, jobId: null }
            : { jobId: result.data.jobId }),
        });
      // A list refresh is not part of the create transaction and must not turn a
      // positively confirmed job into an UNKNOWN submission or keep inputs locked.
      void queryClient.invalidateQueries({ queryKey: importsQueryKey }).catch(() => undefined);
      if ('pipelineId' in result.data)
        void queryClient
          .invalidateQueries({ queryKey: groupPipelinesQueryKey })
          .catch(() => undefined);
      if (inputRevision !== planInputRevision.current) return;
      if (plan?.planId === submittedPlanId) setPlan(null);
      // Consumed, not invalidated: the job exists now.
      setPlanStaleReason(null);
      if ('pipelineId' in result.data) {
        if (activeRecord === undefined) onPipelineCreated?.(result.data);
      } else if (activeRecord === undefined) onCreated?.(result.data);
    } catch (error) {
      if (activeRecord !== undefined)
        rememberSubmission({
          ...activeRecord,
          status: isDefiniteImportCreateRejection(error) ? 'REJECTED' : 'UNKNOWN',
          error: groupErrorMessage(error),
        });
      else if (inputRevision === planInputRevision.current)
        setCreateError(groupErrorMessage(error));
    } finally {
      if (inputRevision === planInputRevision.current) setPasscode('');
      setCreatePending(false);
      createInFlight.current = false;
    }
  };
  const runCreate = async (): Promise<void> => {
    if (plan === null || createdPlanIds.includes(plan.planId)) return;
    const source: SourceDirectory | SourceFile | undefined =
      sourceFile !== null
        ? sourceFile
        : plan.sourceKind === 'BAIDU_APP_DIR' &&
            plan.sourceRootFsid != null &&
            plan.sourceConnectionId != null
          ? {
              connectionId: plan.sourceConnectionId,
              fsid: plan.sourceRootFsid,
              path: activePlanSourcePath ?? sourcePath,
            }
          : undefined;
    const prior =
      source === undefined
        ? undefined
        : submissionsRef.current[directorySubmissionKey(source, plan.destinationId)];
    if (prior !== undefined) {
      if (prior.status === 'UNKNOWN') await submitRequest(prior.request, prior);
      return;
    }
    if (sourceFile !== null && capabilities.fileSelectionEnabled !== true) return;
    if (!validateLibrary()) return;
    const request: Parameters<typeof createImport>[0] = {
      ...(plan.pipeline !== undefined
        ? { processingMode: 'GROUPED_VIDEO' }
        : plan.archive === undefined
          ? {}
          : { processingMode: 'RECURSIVE_VIDEO' }),
      planId: plan.planId,
      destinationId,
      publicationPolicy: policy,
      sourceCleanupPolicy:
        plan.archive === undefined && plan.pipeline === undefined ? sourceCleanupPolicy : 'KEEP',
      ...(sourceCleanupPolicy === 'KEEP' ? {} : { sourceCleanupRequiresPublication }),
      ...(policy === 'PUBLISH_TO_JELLYFIN' && chosenLibrary !== undefined
        ? {
            publication: {
              mediaType,
              libraryId: chosenLibrary.libraryId,
              logicalPath,
            },
          }
        : {}),
      credential: credentialFor('create'),
      idempotencyKey: `plan-${plan.planId}`,
    };
    const record =
      source === undefined ? undefined : freezeDirectorySubmission(source, plan, request);
    await submitRequest(request, record);
  };

  const takeArchiveRequest = (): ArchivePlanRequest | undefined => {
    if (!archiveMode) return undefined;
    const request: ArchivePlanRequest = {
      mode: 'RECURSIVE_VIDEO',
      candidates: archiveCandidates.filter((value) => value !== ''),
      maxDepth: archiveDepth,
      maxExpandedBytes: (BigInt(archiveGiB) * 1024n ** 3n).toString(),
    };
    setArchiveCandidates([]);
    return request;
  };

  const sourceReady =
    sourceKind === 'BAIDU_SHARE' ? shareUrl.trim() !== '' : sourcePath.trim() !== '';
  const fileSelectionReady = sourceFile === null || capabilities.fileSelectionEnabled === true;
  const selectedDestination =
    destinations.find((destination) => destination.destinationId === destinationId) ?? null;
  const selectedCreatedCount = sourceDirectories.filter(
    (source) => submissions[directorySubmissionKey(source, destinationId)]?.status === 'CREATED',
  ).length;
  const publishReady =
    policy === 'ARCHIVE_ONLY' ||
    (chosenLibrary !== undefined &&
      libraryMismatch === null &&
      validPublicationLogicalPath(logicalPath));

  /*
   * Why the next action cannot run yet.
   *
   * Each list mirrors its button's own disabled condition exactly. A reason that
   * disagreed with the gate would be worse than no reason at all — it would send
   * someone to fix a field that was never the blocker.
   */
  const planBlockers: string[] = [];
  if (!sourceReady) {
    planBlockers.push(
      sourceKind === 'BAIDU_SHARE' ? '第 1 步还没有填分享链接。' : '第 1 步还没有填账户目录路径。',
    );
  }
  if (destinationId === '') planBlockers.push('第 2 步还没有选择迁移目标。');
  if (!fileSelectionReady)
    planBlockers.push('服务端当前未启用新的单文件计划或创建；已有提交记录仍可核对。');

  const createBlockers: string[] = [];
  if (!fileSelectionReady) createBlockers.push('服务端当前未启用新的单文件创建。');
  if (!writable) createBlockers.push('这台机器当前不允许创建（原因见页面顶部）。');
  if (plan === null) {
    createBlockers.push(
      selectedCreatedCount > 0 && selectedCreatedCount === sourceDirectories.length
        ? '本批所选目录任务均已创建。'
        : isDirectoryBatch
          ? '请在独立计划清单中选择一个尚未创建的目录计划。'
          : '还没有生成迁移计划。计划是创建前的预检，不能跳过。',
    );
  }
  if (
    policy === 'PUBLISH_TO_JELLYFIN' &&
    (chosenLibrary === undefined || libraryMismatch !== null)
  ) {
    createBlockers.push('第 3 步选了发布到 Jellyfin，但媒体库还没有选好，或与所选媒体类型不相容。');
  }
  if (policy === 'PUBLISH_TO_JELLYFIN' && !validPublicationLogicalPath(logicalPath)) {
    createBlockers.push('第 3 步还需要填写媒体库内的有效相对目录。');
  }

  /** The strip at the top: what has been chosen so far, without scrolling. */
  const flowSummary: ReadonlyArray<{ step: number; label: string; value: string; done: boolean }> =
    [
      {
        step: 1,
        label: '来源',
        value: !sourceReady
          ? '未填写'
          : sourceKind === 'BAIDU_SHARE'
            ? '分享链接'
            : sourceKind === 'BAIDU_APP_DIR'
              ? sourceFile !== null
                ? '1 个文件'
                : isDirectoryBatch
                  ? `${sourceDirectories.length} 个目录`
                  : '账户目录'
              : '其他来源',
        done: sourceReady,
      },
      {
        step: 2,
        label: '目标',
        value: selectedDestination?.displayName ?? '未选择',
        done: selectedDestination !== null,
      },
      {
        step: 3,
        label: '发布',
        value: policy === 'ARCHIVE_ONLY' ? '仅备份' : '发布到 Jellyfin',
        done: publishReady,
      },
      {
        step: 4,
        label: '清理',
        // Terse on purpose: the full policy names are the radio labels below, and
        // repeating them here would put the same string on screen twice.
        value:
          sourceCleanupPolicy === 'KEEP'
            ? '保留'
            : sourceCleanupPolicy === 'JOB_STAGING_ONLY'
              ? '清暂存'
              : '移回收站',
        done: true,
      },
      {
        step: 5,
        label: isDirectoryBatch ? '计划与创建' : '计划',
        value: isDirectoryBatch
          ? `${selectedCreatedCount}/${sourceDirectories.length} 已创建`
          : plan !== null
            ? '已生成'
            : planPending
              ? '生成中'
              : '未生成',
        done: isDirectoryBatch ? selectedCreatedCount === sourceDirectories.length : plan !== null,
      },
    ];

  return (
    <div
      className="import-create"
      ref={revealRef}
      style={formInteracted ? { animation: 'none' } : undefined}
      onPointerDownCapture={() => setFormInteracted(true)}
      onFocusCapture={() => setFormInteracted(true)}
    >
      <fieldset
        disabled={createPending}
        style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
        aria-label="迁移配置与提交"
      >
        {readOnlyReason !== null ? (
          <p className="inline-message import-readonly" role="note">
            <Lock size={14} strokeWidth={1.9} aria-hidden="true" />
            <span>
              <strong>{READ_ONLY_LABELS[readOnlyReason]}</strong> —{' '}
              {READ_ONLY_NOTES[readOnlyReason]}
            </span>
          </p>
        ) : null}

        {/*
        A fixed summary rather than a wizard.

        Every field stays reachable — an operator who has to change the
        destination after reading the plan should not have to walk back through
        four steps to do it — but the order is now stated, and what has been
        chosen is legible without scrolling past four cards to find out.
      */}
        <ol className="import-flow" aria-label="创建流程">
          {flowSummary.map((stage) => (
            <li key={stage.step} data-done={stage.done}>
              <span className="import-flow-step" aria-hidden="true">
                {stage.step}
              </span>
              <span className="import-flow-body">
                <span className="import-flow-label">{stage.label}</span>
                <span className="import-flow-value">{stage.value}</span>
              </span>
            </li>
          ))}
        </ol>

        <section className="settings-card" aria-labelledby={`${fieldId}-source`}>
          <h3 id={`${fieldId}-source`}>
            <Link2 size={15} strokeWidth={1.9} aria-hidden="true" /> 1 · 来源
          </h3>

          <div className="import-radio-set" role="radiogroup" aria-label="来源类型">
            {(['BAIDU_SHARE', 'BAIDU_APP_DIR', 'OTHER'] as const).map((kind) => {
              const capability = sourceEnabled.get(kind);
              const enabled = capability?.enabled === true;
              return (
                <label
                  key={kind}
                  className="import-radio"
                  data-disabled={!enabled}
                  data-checked={sourceKind === kind}
                >
                  <input
                    type="radio"
                    name={`${fieldId}-source-kind`}
                    value={kind}
                    checked={sourceKind === kind}
                    disabled={!enabled}
                    onChange={() => {
                      setSourceKind(kind);
                      setArchiveMode(false);
                      setArchiveCandidates([]);
                      setSourceDirectories([]);
                      setSourceFile(null);
                      setSourcePath('');
                      invalidatePlan('来源类型');
                    }}
                  />
                  <span className="import-radio-body">
                    <span className="import-radio-title">{IMPORT_SOURCE_LABELS[kind]}</span>
                    <span className="import-radio-note">
                      {enabled
                        ? kind === 'BAIDU_SHARE'
                          ? '分享链接与提取码分开填写。'
                          : capabilities.fileSelectionEnabled === true
                            ? '已授权账户中选定的文件或目录；普通读取不扩展来源删除权限。'
                            : '已授权账户中选定的目录；普通读取不扩展来源删除权限。'
                        : capability?.disabledReason === 'CAPABILITY_UNAVAILABLE'
                          ? '分享能力尚未确认；已授权目录浏览不受影响。'
                          : '后端尚未启用'}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>

          <div className="field">
            <label htmlFor={`${fieldId}-source-connection`}>来源账户</label>
            <select
              id={`${fieldId}-source-connection`}
              value={sourceConnectionId}
              disabled={connectionsQuery.isPending || isDemoSessionActive()}
              onChange={(event) => {
                setSourceConnectionId(event.target.value);
                setSourcePath('');
                setSourceDirectories([]);
                setSourceFile(null);
                setShareUrl('');
                setPasscode('');
                setArchiveCandidates([]);
                setPlanError(null);
                setPlanUnsupported(false);
                setCreateError(null);
                setCreateUnsupported(false);
                invalidatePlan('来源账户');
              }}
            >
              <option value="">使用网盘设置中的默认来源账户</option>
              {eligibleSourceConnections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.label} · {connection.principalMasked}
                </option>
              ))}
            </select>
            <small className="field-hint">
              {connectionsQuery.isError
                ? '账户列表读取失败；留空时由服务端按独立网盘设置选择默认来源。'
                : connectionsAnswer?.supported === false
                  ? '当前 API 未提供统一云连接列表；留空时由服务端选择默认来源。'
                  : '选中后，计划会冻结这个连接的 UUID；留空才使用服务端配置的默认来源。'}
            </small>
          </div>

          {sourceKind === 'BAIDU_SHARE' ? (
            <div className="import-field-grid">
              {/*
              The hint sits outside the <label> and is attached with
              aria-describedby. Inside it, the label's text content — which is
              what an accessible name is computed from — would become "分享链接
              链接里带的 ?pwd= 会在这里…", so a screen reader would announce the
              whole paragraph as the field's name.
            */}
              <div className="field">
                <label htmlFor={`${fieldId}-url`}>分享链接</label>
                <input
                  id={`${fieldId}-url`}
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  placeholder="https://pan.baidu.com/s/…"
                  aria-describedby={`${fieldId}-url-hint`}
                  value={shareUrl}
                  onChange={(event) => onShareUrlChange(event.target.value)}
                />
                <small className="field-hint" id={`${fieldId}-url-hint`}>
                  链接里带的 <code>?pwd=</code>{' '}
                  会在这里就被摘出来放进提取码，不会随链接一起发送或记录。
                </small>
              </div>
              <div className="field">
                <label htmlFor={`${fieldId}-passcode`}>提取码</label>
                <input
                  id={`${fieldId}-passcode`}
                  // A credential, drawn as one: this console is read over
                  // shoulders and screenshotted into chats.
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby={`${fieldId}-passcode-hint`}
                  value={passcode}
                  onChange={(event) => {
                    setPasscode(event.target.value);
                    // A plan is bound to the credential handle returned by its
                    // preflight. Accepting a newly typed passcode while leaving that
                    // plan active would make Create silently ignore the new secret
                    // and reuse the old handle.
                    invalidatePlan('提取码');
                  }}
                />
                <small className="field-hint" id={`${fieldId}-passcode-hint`}>
                  <KeyRound size={12} strokeWidth={2} aria-hidden="true" />{' '}
                  只在这一次请求里向后端交付一次，请求结束立即从浏览器清除；不写入地址栏、不存本地、不进日志。
                </small>
              </div>
            </div>
          ) : (
            <>
              <div className="field">
                <label htmlFor={`${fieldId}-path`}>
                  {sourceFile === null ? '账户目录路径' : '文件路径'}
                </label>
                <input
                  id={`${fieldId}-path`}
                  type="text"
                  autoComplete="off"
                  placeholder="/apps/…"
                  value={
                    isDirectoryBatch
                      ? `已选择 ${sourceDirectories.length} 个目录，见下方清单`
                      : sourcePath
                  }
                  readOnly={isDirectoryBatch || sourceFile !== null}
                  onChange={(event) => {
                    setSourceDirectories([]);
                    setSourceFile(null);
                    setSourcePath(event.target.value);
                    invalidatePlan('账户目录路径');
                  }}
                />
              </div>
              {canBrowseSelectedSource && selectedSourceConnection !== null ? (
                <BaiduSourceBrowser
                  connectionId={selectedSourceConnection.id}
                  selectedPath={sourcePath}
                  selectedDirectories={sourceDirectories}
                  selectedFile={sourceFile}
                  {...(capabilities.fileSelectionEnabled === true
                    ? {
                        onSelectFile: (file: SourceFile) => {
                          if (file.connectionId !== sourceConnectionId) return;
                          setSourceFile(file);
                          setSourceDirectories([]);
                          setSourcePath(file.path);
                          setSourceCleanupPolicy('KEEP');
                          setSourceCleanupRequiresPublication(false);
                          setPasscode('');
                          invalidatePlan('来源文件');
                        },
                      }
                    : {})}
                  onConfirm={confirmSourceDirectories}
                  onSelect={(path) => {
                    setSourceDirectories([]);
                    setSourceFile(null);
                    setSourcePath(path);
                    invalidatePlan('账户目录路径');
                  }}
                />
              ) : sourceKind === 'BAIDU_APP_DIR' && sourceConnectionId !== '' ? (
                <p className="field-hint" role="note">
                  服务端未同时授予这个连接和部署级 <code>BROWSE</code>{' '}
                  动作；仍可填写账户目录路径，但页面不会猜测目录内容。
                </p>
              ) : null}
              {sourceFile === null ? null : (
                <section aria-label="已确认来源文件">
                  <p>
                    已确认 1 个文件 · {formatDecimalBytes(sourceFile.size)}（{sourceFile.size}{' '}
                    字节）
                  </p>
                  <code style={{ overflowWrap: 'anywhere' }}>{sourceFile.path}</code>
                  <p className="field-hint">
                    仅迁移此文件，不包含父目录或其他文件；
                    {sourceCleanupPolicy === 'KEEP'
                      ? '百度原件保留。'
                      : '来源清理仅限此文件，仍需精确授权、安全预览与 MFA 确认。'}
                  </p>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => {
                      setSourceFile(null);
                      setSourcePath('');
                      invalidatePlan('来源文件');
                    }}
                  >
                    清空已选文件
                  </button>
                </section>
              )}
              {sourceDirectories.length > 0 ? (
                <section aria-label="已确认来源目录">
                  <p>已确认 {sourceDirectories.length} 个目录</p>
                  <ul className="import-blockers">
                    {sourceDirectories.map((source) => (
                      <li key={sourceDirectoryKey(source)}>
                        <code style={{ overflowWrap: 'anywhere' }}>{source.path}</code>
                        <button
                          type="button"
                          className="ghost-button"
                          aria-label={`移除已选目录 ${source.path}`}
                          onClick={() =>
                            confirmSourceDirectories(
                              removeSourceDirectory(sourceDirectories, source),
                            )
                          }
                        >
                          移除
                        </button>
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => confirmSourceDirectories([])}
                  >
                    清空已确认目录
                  </button>
                </section>
              ) : null}
              {sourcePath === '' || isDirectoryBatch ? null : (
                <p className="field-hint" role="status">
                  已选来源：<code>{sourcePath}</code>；可重新浏览修改。
                </p>
              )}
            </>
          )}
        </section>

        {sourceKind === 'BAIDU_APP_DIR' ? (
          <section className="settings-card" aria-label="来源文件处理">
            <h3>压缩视频处理</h3>
            <label className="import-radio">
              <input
                type="checkbox"
                checked={archiveMode}
                disabled={capabilities.archiveExtractionEnabled !== true}
                onChange={(event) => {
                  setArchiveMode(event.target.checked);
                  setGrouped(
                    event.target.checked &&
                      sourceFile === null &&
                      capabilities.groupedPipelinesEnabled === true,
                  );
                  setArchiveCandidates([]);
                  invalidatePlan('解压模式');
                }}
              />
              <strong>递归解压为视频</strong>
            </label>
            <p className="field-hint">
              {capabilities.archiveExtractionEnabled === true
                ? '7z / ZIP / RAR / TAR 等格式按内容识别；改过后缀或多次压缩也逐层处理所有分支。001、002 等分卷请选择包含完整组的目录。'
                : '当前 API 未启用递归解压；原样备份保持原有行为。'}
            </p>
            {archiveMode ? (
              <>
                {sourceFile === null && capabilities.groupedPipelinesEnabled !== undefined ? (
                  <>
                    <label className="import-radio">
                      <input
                        type="checkbox"
                        checked={groupMode}
                        disabled={capabilities.groupedPipelinesEnabled !== true}
                        onChange={(event) => {
                          setGrouped(event.target.checked);
                          invalidatePlan('分组流水线模式');
                        }}
                      />
                      <strong>分组流水线（推荐整目录）</strong>
                    </label>
                    <p className="field-hint">
                      完整分卷作为一组，普通文件单独排队；健康组继续，缺卷或密码问题只暂停相关组。仅新任务采用此模式，原任务保持原执行方式。
                    </p>
                  </>
                ) : null}
                <ArchiveCandidatesField
                  value={archiveCandidates}
                  onChange={(values) => {
                    setArchiveCandidates(values);
                    invalidatePlan('候选解压密码');
                  }}
                  disabled={planPending}
                />
                <div className="import-field-grid">
                  <div className="field">
                    <label htmlFor={`${fieldId}-archive-depth`}>最多解压层数</label>
                    <input
                      id={`${fieldId}-archive-depth`}
                      type="number"
                      min={1}
                      max={16}
                      value={archiveDepth}
                      onChange={(event) => {
                        setArchiveDepth(
                          Math.min(16, Math.max(1, Math.floor(Number(event.target.value) || 1))),
                        );
                        invalidatePlan('解压限制');
                      }}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`${fieldId}-archive-bytes`}>
                      {groupMode ? '每组累计解压上限（GiB）' : '累计解压上限（GiB）'}
                    </label>
                    <input
                      id={`${fieldId}-archive-bytes`}
                      type="number"
                      min={1}
                      max={1024}
                      value={archiveGiB}
                      onChange={(event) => {
                        setArchiveGiB(
                          Math.min(1024, Math.max(1, Math.floor(Number(event.target.value) || 1))),
                        );
                        invalidatePlan('解压限制');
                      }}
                    />
                  </div>
                </div>
                <p className="field-hint">
                  仅上传通过内容检查的视频；含中间压缩包的累计展开量受上限约束。百度原始压缩包固定保留。下方仍需选择“发布到
                  Jellyfin”及媒体库。
                </p>
              </>
            ) : null}
          </section>
        ) : null}

        <section className="settings-card" aria-labelledby={`${fieldId}-destination`}>
          <h3 id={`${fieldId}-destination`}>
            <Cloud size={15} strokeWidth={1.9} aria-hidden="true" /> 2 · 目标
          </h3>
          <p className="field-hint">
            可选与不可选由服务端的能力响应决定，不在浏览器里写死。缺席的字段会写明「该 API
            版本未报告」，不会画成 0。
          </p>
          <div className="import-destination-grid" role="radiogroup" aria-label="迁移目标">
            {destinations.map((destination) => (
              <div
                key={destination.destinationId}
                className="import-destination"
                role="group"
                aria-label={destination.displayName}
                data-available={destination.available}
                data-checked={destinationId === destination.destinationId}
              >
                <label className="import-destination-head">
                  <input
                    type="radio"
                    name={`${fieldId}-destination-id`}
                    value={destination.destinationId}
                    checked={destinationId === destination.destinationId}
                    disabled={!destination.available}
                    aria-label={destination.displayName}
                    onChange={() => {
                      setDestinationId(destination.destinationId);
                      invalidatePlan('迁移目标');
                    }}
                  />
                  <span>
                    <span className="import-destination-name">{destination.displayName}</span>
                    <span className="import-destination-kind">
                      {IMPORT_DESTINATION_KIND_LABELS[destination.kind]}
                    </span>
                  </span>
                  <span className={`import-availability${destination.available ? ' is-on' : ''}`}>
                    {destination.available ? (
                      <CheckCircle2 size={13} strokeWidth={2} aria-hidden="true" />
                    ) : (
                      <Ban size={13} strokeWidth={2} aria-hidden="true" />
                    )}
                    {destination.available ? '可用' : '不可用'}
                  </span>
                </label>

                <dl className="instance-meta">
                  <div>
                    <dt>可用容量</dt>
                    <dd>
                      <ReportedBytes value={destination.availableBytes} />
                    </dd>
                  </div>
                  <div>
                    <dt>允许的根</dt>
                    <dd>
                      <ReportedText value={destination.allowedRoot} />
                    </dd>
                  </div>
                  <div>
                    <dt>支持恢复</dt>
                    <dd>
                      <ReportedFlag value={destination.supportsRestore} />
                    </dd>
                  </div>
                  <div>
                    {/* Not 「支持 Jellyfin」: the shared `dt` style uppercases and
                      letter-spaces its label, which broke that across two lines
                      in a narrow card. All-Chinese keeps it on one. */}
                    <dt>支持发布</dt>
                    <dd>
                      <ReportedFlag value={destination.supportsJellyfin} />
                    </dd>
                  </div>
                </dl>

                {destination.available ? null : (
                  <p className="import-destination-reason">
                    <TriangleAlert size={13} strokeWidth={2} aria-hidden="true" />
                    {destination.unavailableReason === null
                      ? '服务端没有说明原因。'
                      : DESTINATION_UNAVAILABLE_LABELS[destination.unavailableReason]}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="settings-card" aria-labelledby={`${fieldId}-policy`}>
          <h3 id={`${fieldId}-policy`}>
            <Clapperboard size={15} strokeWidth={1.9} aria-hidden="true" /> 3 · 备份与发布策略
          </h3>

          <button
            type="button"
            className="ghost-button"
            disabled={libraryRefreshPending || isDemoSessionActive()}
            onClick={() => {
              void refreshLibraryChoices();
            }}
          >
            {libraryRefreshPending ? '正在刷新媒体库…' : '刷新媒体库'}
          </button>
          <p className="field-hint">
            显示 Jellyfin
            当前的全部媒体库，不匹配的选项会注明原因。首次实际发布时只为所选库添加独立目录，保留原目录与库类型。
          </p>
          {capabilities.libraryDiscoveryError != null ? (
            <p className="inline-message is-warn" role="status">
              Jellyfin 媒体库清单暂未读取成功；点击“刷新媒体库”重试，仅备份功能不受影响。
            </p>
          ) : null}
          {libraryRefreshResult === null ? null : (
            <p className="field-hint" role="status">
              {libraryRefreshResult}
            </p>
          )}

          <div className="import-radio-set" role="radiogroup" aria-label="发布策略">
            <label className="import-radio" data-checked={policy === 'ARCHIVE_ONLY'}>
              <input
                type="radio"
                name={`${fieldId}-policy-choice`}
                value="ARCHIVE_ONLY"
                checked={policy === 'ARCHIVE_ONLY'}
                onChange={() => {
                  setPolicy('ARCHIVE_ONLY');
                  setMissingLibrary(false);
                  setSourceCleanupRequiresPublication(false);
                }}
              />
              <span className="import-radio-body">
                <span className="import-radio-title">
                  {PUBLICATION_POLICY_LABELS.ARCHIVE_ONLY}
                  {(defaults?.defaultPublicationPolicy ?? 'ARCHIVE_ONLY') === 'ARCHIVE_ONLY'
                    ? <span className="import-default-tag">默认</span> : null}
                </span>
                <span className="import-radio-note">
                  完成校验迁移与恢复材料；不建媒体目录、不建 symlink、不通知
                  Jellyfin。文档、压缩包、软件与不需要立刻播放的影片都用这一条。
                </span>
              </span>
            </label>

            <label
              className="import-radio"
              data-disabled={!publishAllowed}
              data-checked={policy === 'PUBLISH_TO_JELLYFIN'}
            >
              <input
                type="radio"
                name={`${fieldId}-policy-choice`}
                value="PUBLISH_TO_JELLYFIN"
                checked={policy === 'PUBLISH_TO_JELLYFIN'}
                disabled={!publishAllowed}
                onChange={() => setPolicy('PUBLISH_TO_JELLYFIN')}
              />
              <span className="import-radio-body">
                <span className="import-radio-title">发布到 Jellyfin
                  {defaults?.defaultPublicationPolicy === 'PUBLISH_TO_JELLYFIN'
                    ? <span className="import-default-tag">默认</span> : null}
                </span>
                <span className="import-radio-note">
                  {publishAllowed
                    ? '备份闭环完成后，另派一个发布任务把它放进指定媒体库。'
                    : capabilities.publishDisabledReason === null
                      ? '服务端没有说明原因。'
                      : PUBLISH_DISABLED_LABELS[capabilities.publishDisabledReason]}
                </span>
              </span>
            </label>
          </div>

          {policy === 'PUBLISH_TO_JELLYFIN' ? (
            <div className="import-publish-fields">
              {chosenLibrary?.contentType === 'HomeVideos' ? (
                <p className="field-hint">
                  独立视频库不要求季/集命名；沿用“电影”这一单视频类型，不更改原电影或剧集任务。
                </p>
              ) : null}
              <div className="import-field-grid">
                <div className="field">
                  <label htmlFor={`${fieldId}-media-type`}>媒体类型</label>
                  <select
                    id={`${fieldId}-media-type`}
                    value={mediaType}
                    onChange={(event) => {
                      setMediaType(event.target.value as ImportMediaType);
                      setMissingLibrary(false);
                    }}
                  >
                    {(['MOVIE', 'SERIES'] as const).map((value) => (
                      <option key={value} value={value}>
                        {IMPORT_MEDIA_TYPE_LABELS[value]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={`${fieldId}-library`}>Jellyfin 媒体库</label>
                  <select
                    id={`${fieldId}-library`}
                    value={libraryId}
                    onChange={(event) => {
                      setLibraryId(event.target.value);
                      setMissingLibrary(false);
                    }}
                  >
                    <option value="">请选择…</option>
                    {capabilities.libraries.map((library) => (
                      <option
                        key={library.libraryId}
                        value={library.libraryId}
                        disabled={libraryChoiceReason(library, mediaType) !== null}
                      >
                        {libraryOptionLabel(library, mediaType)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="field">
                <label htmlFor={`${fieldId}-logical`}>逻辑路径</label>
                <input
                  id={`${fieldId}-logical`}
                  type="text"
                  autoComplete="off"
                  placeholder={mediaType === 'SERIES' ? '剧名 (年份)/Season 01' : '片名 (年份)'}
                  aria-invalid={!validPublicationLogicalPath(logicalPath)}
                  aria-describedby={`${fieldId}-logical-hint`}
                  value={logicalPath}
                  onChange={(event) => setLogicalPath(event.target.value)}
                />
                <small className="field-hint" id={`${fieldId}-logical-hint`}>
                  必填库内相对目录；不以 / 开头，不含反斜杠、空路径段或 ..。发布目录：
                  <code>
                    {chosenLibrary === undefined
                      ? '选择媒体库后显示'
                      : validPublicationLogicalPath(logicalPath)
                        ? `${chosenLibrary.containerPath.replace(/\/$/, '')}/${logicalPath}`
                        : `${chosenLibrary.containerPath}/（待填写相对目录）`}
                  </code>
                </small>
              </div>

              <p className="inline-message" role="note">
                <ListTree size={14} strokeWidth={1.9} aria-hidden="true" />
                发布只创建 catalog/farm 投影，不复制第二份媒体字节；取消发布也只移除投影。
              </p>

              {libraryProblem === null ? null : (
                <p className="form-error" role="alert">
                  <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" /> {libraryProblem}
                </p>
              )}
            </div>
          ) : null}
        </section>

        <section className="settings-card" aria-labelledby={`${fieldId}-cleanup`}>
          <h3 id={`${fieldId}-cleanup`}>
            <Trash2 size={15} strokeWidth={1.9} aria-hidden="true" /> 4 · 来源清理策略
          </h3>
          <p className="field-hint">
            创建任务不会立即删除任何来源对象。这里仅冻结策略；归档、哈希链、恢复代次及其他安全门全部通过后，仍须单独生成预览并用
            MFA 执行。
          </p>
          <div className="import-radio-set" role="radiogroup" aria-label="来源清理策略">
            {availableCleanupPolicies.map((cleanupPolicy) => (
              <label
                key={cleanupPolicy}
                className="import-radio"
                data-checked={sourceCleanupPolicy === cleanupPolicy}
              >
                <input
                  type="radio"
                  name={`${fieldId}-cleanup-policy`}
                  value={cleanupPolicy}
                  checked={sourceCleanupPolicy === cleanupPolicy}
                  onChange={() => {
                    setSourceCleanupPolicy(cleanupPolicy);
                    if (cleanupPolicy === 'KEEP') setSourceCleanupRequiresPublication(false);
                  }}
                />
                <span className="import-radio-body">
                  <span className="import-radio-title">
                    {CLEANUP_POLICY_LABELS[cleanupPolicy]}
                    {cleanupPolicy === 'KEEP' ? (
                      <span className="import-default-tag">默认</span>
                    ) : null}
                  </span>
                  <span className="import-radio-note">
                    {cleanupPolicy === 'KEEP'
                      ? '不安排来源清理。归档或发布完成后，来源仍保持原状。'
                      : cleanupPolicy === 'JOB_STAGING_ONLY'
                        ? '只处理本任务在已绑定来源账户中创建的暂存对象，不把分享者的原始文件当作可删除对象。'
                        : '只以最终预览列出的精确根和对象为边界；服务商语义是移入回收站，不代表物理擦除。'}
                  </span>
                </span>
              </label>
            ))}
          </div>

          {sourceCleanupPolicy !== 'KEEP' && policy === 'PUBLISH_TO_JELLYFIN' ? (
            <label className="settings-check-row">
              <input
                type="checkbox"
                aria-label="发布成功后才允许来源清理"
                checked={sourceCleanupRequiresPublication}
                onChange={(event) => setSourceCleanupRequiresPublication(event.target.checked)}
              />
              <span>
                <strong>发布成功后才允许来源清理</strong>
                <small>把 PUBLICATION_READY 加入执行门；发布失败时来源保持不动。</small>
              </span>
            </label>
          ) : null}

          <p className="inline-message" role="note">
            <ShieldCheck size={14} strokeWidth={1.9} aria-hidden="true" />
            清理是独立、可审阅、带幂等键与 MFA 的后续操作；任务创建成功不等于已清理。
          </p>
        </section>

        {/*
        Stage five, and the two actions that live in it.

        The old layout put both buttons together above the plan, so the result of
        the preflight appeared *below* the button that acts on it: you planned,
        scrolled past 「创建迁移任务」 to read the findings, then scrolled back up to
        act. Two adjacent buttons also read as one pair of alternatives, when in
        fact one inspects and the other commits. Here the plan sits between them,
        in the order the work actually happens.
      */}
        <section className="settings-card import-stage-final" aria-labelledby={`${fieldId}-plan`}>
          <h3 id={`${fieldId}-plan`}>
            <ListTree size={15} strokeWidth={1.9} aria-hidden="true" /> 5 · 迁移计划与创建
          </h3>
          <p className="field-hint">
            这是两个动作，不是一个。<strong>生成迁移计划</strong>
            只读取来源清单并对目标做预检，不搬运任何字节；<strong>创建迁移任务</strong>
            才会把任务交给 VPS 上的执行器。没有计划就不能创建。
          </p>

          {isDirectoryBatch ? (
            <DirectoryBatchPlans
              grouped={groupMode}
              takeArchiveRequest={takeArchiveRequest}
              archiveRevision={planInputRevision.current}
              directories={sourceDirectories}
              destinationId={destinationId}
              availableBytes={selectedDestination?.availableBytes}
              createdPlanIds={createdPlanIds}
              submissions={submissions}
              disabled={createPending}
              onUsePlan={(source, selectedPlan) => {
                setPlan(selectedPlan);
                setActivePlanSourcePath(source.path);
                setPlanError(null);
                setPlanStaleReason(null);
                setCreateError(null);
                setCreateUnsupported(false);
              }}
            />
          ) : (
            <div className="import-stage-action">
              <button
                type="button"
                className="ghost-button"
                disabled={
                  !sourceReady || !fileSelectionReady || destinationId === '' || planPending
                }
                onClick={() => void runPlan()}
              >
                <ListTree size={15} strokeWidth={1.9} aria-hidden="true" />
                {planPending ? '正在读取来源清单…' : '生成迁移计划'}
              </button>
              {planBlockers.length === 0 ? null : (
                <ul className="import-blockers" aria-label="还不能生成计划的原因">
                  {planBlockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {planStaleReason === null ? null : (
            <p className="inline-message import-plan-stale" role="status">
              <FileWarning size={14} strokeWidth={1.9} aria-hidden="true" />
              <span>
                <strong>{planStaleReason}</strong>
                已更改，之前的迁移计划已作废。计划是针对某一组来源与目标的预检结果，换了输入就必须重新生成。
              </span>
            </p>
          )}

          {planUnsupported ? (
            <div className="settings-notbuilt">
              <span className="settings-notbuilt-glyph" aria-hidden="true">
                <CircleSlash size={18} strokeWidth={1.7} />
              </span>
              <div>
                <p>这台机器上的 API 版本还没有网盘迁移接口。</p>
                <p>
                  这不是「来源里没有文件」，也不是请求失败：<strong>这条路由根本不存在</strong>
                  ，下一步是部署带网盘迁移的 API，而不是检查分享链接。
                </p>
              </div>
            </div>
          ) : null}

          {planError === null ? null : (
            <p className="inline-message error-message" role="alert">
              <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" /> {planError}
            </p>
          )}

          {plan === null ? null : (
            <>
              {isDirectoryBatch && activePlanSourcePath !== null ? (
                <p role="status">
                  当前确认创建的目录：<code>{activePlanSourcePath}</code>
                  。仅创建这一项，其他目录需逐项确认；失败后重试沿用本计划幂等键。
                </p>
              ) : null}
              <section className="import-plan" role="group" aria-label="迁移计划">
                <header className="import-plan-head">
                  <h4>预检结果</h4>
                </header>

                {plan.archive === undefined ? null : <ArchivePlanPanel plan={plan.archive} />}
                {plan.pipeline === undefined ? null : (
                  <GroupPipelinePlanPanel key={plan.planId} plan={plan.pipeline} />
                )}

                <dl className="import-plan-figures">
                  <div>
                    <dt>文件数</dt>
                    <dd>{plan.objectCount}</dd>
                  </div>
                  <div>
                    <dt>总字节</dt>
                    <dd>{formatDecimalBytes(plan.totalBytes)}</dd>
                  </div>
                  <div>
                    <dt>最大单文件</dt>
                    <dd>{formatDecimalBytes(plan.largestObjectBytes)}</dd>
                  </div>
                  <div>
                    <dt>{plan.pipeline ? '单组预估最大暂存' : '所需 VPS 最大暂存'}</dt>
                    <dd>{formatDecimalBytes(plan.requiredSpoolBytes)}</dd>
                  </div>
                  <div>
                    <dt>来源提取码</dt>
                    <dd>{plan.sourceRequiresPasscode ? '需要（已提供）' : '不需要'}</dd>
                  </div>
                  <div>
                    <dt>来源账户</dt>
                    <dd>
                      {plan.sourceConnectionId === undefined
                        ? '旧版计划未报告'
                        : plan.sourceConnectionId === null
                          ? '服务端默认来源'
                          : plan.sourceConnectionId}
                    </dd>
                  </div>
                </dl>

                <div className="import-plan-issues">
                  <div>
                    <h5>
                      <FileWarning size={14} strokeWidth={1.9} aria-hidden="true" /> 路径冲突
                    </h5>
                    {plan.pathConflicts.length === 0 ? (
                      <p className="import-plan-clean">没有冲突。</p>
                    ) : (
                      <ul className="import-issue-list">
                        {plan.pathConflicts.map((conflict) => (
                          <li key={`${conflict.kind}-${conflict.pathAlias}`}>
                            <code>{conflict.pathAlias}</code>
                            <span>{CONFLICT_LABELS[conflict.kind]}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div>
                    <h5>
                      <FileWarning size={14} strokeWidth={1.9} aria-hidden="true" /> 目标路径限制
                    </h5>
                    {plan.destinationLimitIssues.length === 0 ? (
                      <p className="import-plan-clean">没有超限项。</p>
                    ) : (
                      <ul className="import-issue-list">
                        {plan.destinationLimitIssues.map((issue) => (
                          <li key={`${issue.kind}-${issue.pathAlias}`}>
                            <code>{issue.pathAlias}</code>
                            <span>{LIMIT_LABELS[issue.kind]}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>

                <p className="import-plan-note">
                  <CheckCircle2 size={14} strokeWidth={1.9} aria-hidden="true" />
                  这一步没有开始搬运任何文件。
                </p>
              </section>

              {/*
              The gate, collected in one place.

              Mode, authorisation and capacity each arrive from a different place —
              two from the plan, one from the destination probe — and each can
              independently make creating the wrong move. Reading them off three
              separate cards is how one gets missed. They are stated here and
              nowhere else, so nothing on this screen says the same thing twice.
            */}
              <dl className="import-confirm" aria-label="创建前确认">
                <div>
                  <dt>目标模式</dt>
                  <dd data-tone={plan.mode === 'ACTIVE' ? 'ok' : 'warn'}>
                    {plan.mode === 'ACTIVE' ? 'ACTIVE · 会真的写入目标' : 'SHADOW · 不会真的写入'}
                  </dd>
                </div>
                <div>
                  <dt>来源授权</dt>
                  <dd data-tone={plan.sourceAuthState === 'AUTHORIZED' ? 'ok' : 'warn'}>
                    {plan.sourceAuthState === 'AUTHORIZED'
                      ? '已授权'
                      : plan.sourceAuthState === 'PASSCODE_REQUIRED'
                        ? '需要提取码'
                        : plan.sourceAuthState === 'UNAUTHORIZED'
                          ? '未授权'
                          : '未知'}
                  </dd>
                </div>
                <div>
                  <dt>路径冲突</dt>
                  <dd data-tone={plan.pathConflicts.length === 0 ? 'ok' : 'warn'}>
                    {plan.pathConflicts.length === 0
                      ? '无'
                      : `${plan.pathConflicts.length} 项（见上）`}
                  </dd>
                </div>
                <div>
                  <dt>目标路径限制</dt>
                  <dd data-tone={plan.destinationLimitIssues.length === 0 ? 'ok' : 'warn'}>
                    {plan.destinationLimitIssues.length === 0
                      ? '无'
                      : `${plan.destinationLimitIssues.length} 项（见上）`}
                  </dd>
                </div>
                <div>
                  <dt>{plan.pipeline ? '冻结输入' : '本次写入'}</dt>
                  <dd>
                    {plan.objectCount} 个文件{plan.pipeline ? '；实际视频输出逐组确认' : ''}
                  </dd>
                </div>
                <div>
                  {/*
                  The one figure the plan cannot know on its own: what the
                  destination said it had. Absent stays absent — no verdict is
                  computed from a capacity nobody reported.
                */}
                  <dt>目标可用容量</dt>
                  <dd>
                    <ReportedBytes value={selectedDestination?.availableBytes} />
                  </dd>
                </div>
              </dl>
            </>
          )}

          <div className="import-stage-action">
            <button
              type="button"
              className="primary-button"
              disabled={
                plan === null || createPending || !writable || !publishReady || !fileSelectionReady
              }
              onClick={() => void runCreate()}
            >
              {createPending ? '正在创建…' : plan?.pipeline ? '创建分组流水线' : '创建迁移任务'}
            </button>
            {createBlockers.length === 0 ? null : (
              <ul className="import-blockers" aria-label="还不能创建任务的原因">
                {createBlockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            )}
          </div>

          {createUnsupported ? (
            <p className="inline-message" role="note">
              <CircleSlash size={14} strokeWidth={1.8} aria-hidden="true" />
              这台机器上的 API 版本还没有创建网盘迁移任务的接口。
            </p>
          ) : null}

          {createError === null ? null : (
            <p className="inline-message error-message" role="alert">
              <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" /> {createError}
            </p>
          )}
        </section>
      </fieldset>
      {Object.values(submissions).length === 0 ? null : (
        <section className="settings-card" aria-label="本批提交记录">
          <h3>本批提交记录（不随选择编辑清除）</h3>
          <p className="field-hint">
            来源身份与目标相同的成功项不再规划；结果未知时仅重试首次冻结的请求与幂等键，之后修改的策略不会覆盖该请求。
          </p>
          <ul className="import-blockers">
            {Object.values(submissions).map((record) => (
              <li key={record.key}>
                <code style={{ overflowWrap: 'anywhere' }}>{record.source.path}</code> · 原账户{' '}
                {record.source.connectionId.slice(0, 8)} · 目标 {record.destinationId}
                <p>
                  {record.status === 'CREATED'
                    ? '已创建（提交记录）'
                    : record.status === 'REJECTED'
                      ? '创建已被拒绝（未创建任务）'
                      : record.status === 'PENDING'
                        ? '创建请求正在确认'
                        : '创建结果待确认'}{' '}
                  · 尝试 {record.attempts} 次 · 原策略{' '}
                  {record.request.publicationPolicy ?? record.plan.plannedPolicy}
                </p>
                {record.error === null ? null : <p role="alert">{record.error}</p>}
                {record.status === 'CREATED' && record.pipelineId ? (
                  <Link
                    className="ghost-button"
                    to={`/imports?view=groups&pipeline=${record.pipelineId}`}
                  >
                    查看分组流水线
                  </Link>
                ) : null}
                {record.status === 'CREATED' && record.jobId ? (
                  <Link className="ghost-button" to={`/imports?job=${record.jobId}`}>
                    查看已创建任务
                  </Link>
                ) : null}
                {record.status !== 'UNKNOWN' ? null : (
                  <button
                    type="button"
                    className="ghost-button"
                    aria-label={`用原请求重试 ${record.source.path}`}
                    disabled={createPending || !writable}
                    onClick={() => void submitRequest(record.request, record)}
                  >
                    用原请求与幂等键重试
                  </button>
                )}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="ghost-button"
            disabled={
              createPending ||
              Object.values(submissions).some(
                (record) => record.status === 'PENDING' || record.status === 'UNKNOWN',
              )
            }
            onClick={() => {
              submissionsRef.current = {};
              setSubmissions({});
              setSourceDirectories([]);
              setSourceFile(null);
              setSourcePath('');
              invalidatePlan('开始新批次');
            }}
          >
            开始新批次（保留已创建任务）
          </button>
        </section>
      )}
    </div>
  );
}
