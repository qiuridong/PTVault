import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleDashed,
  CircleSlash,
  FolderSync,
  Plus,
  Radio,
  RadioTower,
  Search,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import type { ImportJobSummary, ImportSourceKind, PublicationPolicy } from '@ptvault/contracts';

import { useServerEvents } from '../../api/useServerEvents.js';
import { isDemoSessionActive } from '../../demo/demoSession.js';
import { ChipGroup, FilterBar, SegmentedTabs, type ChipOption } from '../../ui/FilterBar.js';
import {
  getImportDestinations,
  getImports,
  actOnImport,
  importDestinationsQueryKey,
  importDetailQueryKey,
  importErrorMessage,
  importsQueryKey,
} from './importApi.js';
import { ImportCreatePanel, type ReadOnlyReason } from './ImportCreatePanel.js';
import { ImportJobDetail } from './ImportJobDetail.js';
import { ImportJobsTable } from './ImportJobsTable.js';
import { PUBLICATION_POLICY_SHORT } from './importLabels.js';
import { GroupPipelinesPanel } from './GroupPipelinesPanel.js';
import { GroupSettingsPanel } from './GroupSettingsPanel.js';
import { GroupObservationsPanel } from './GroupObservationsPanel.js';

/**
 * How long the list waits between refetches while the event stream is down.
 *
 * Exported so the fallback is one value rather than a literal repeated in the two
 * places that poll. Five seconds is a compromise: fast enough that a stalled-
 * looking page is not stale for long, slow enough to leave open for a multi-hour
 * transfer.
 */
export const IMPORT_POLL_INTERVAL_MS = 5_000;

/**
 * Keeps age-based rate/ETA decisions moving even while a healthy SSE stream is
 * quiet. Without this clock, the last fresh sample could remain on screen
 * indefinitely after a worker stopped because no query or event caused another
 * render at the freshness boundary.
 */
export const IMPORT_TELEMETRY_CLOCK_INTERVAL_MS = 5_000;

/** `false` while the stream is live: polling on top of it is pure load. */
export function importRefetchInterval(live: 'connecting' | 'live' | 'offline'): number | false {
  return live === 'live' ? false : IMPORT_POLL_INTERVAL_MS;
}

/** The status partition, as an operator thinks about it. */
type StatusGroup = 'ACTIVE' | 'WAITING' | 'FAILED' | 'COMPLETED' | 'CANCELLED';

const STATUS_LABELS: Record<StatusGroup, string> = {
  ACTIVE: '进行中',
  WAITING: '等待或限速',
  FAILED: '失败或受阻',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
};

const STATUS_GROUPS = Object.keys(STATUS_LABELS) as StatusGroup[];

function groupOf(job: ImportJobSummary): StatusGroup {
  if (job.progress.state === 'COMPLETED') return 'COMPLETED';
  if (job.progress.state === 'CANCELLED_SAFE') return 'CANCELLED';
  if (
    job.progress.resourceWait !== undefined ||
    job.progress.currentCondition === 'RATE_LIMITED' ||
    job.sourceRateLimit !== undefined
  ) {
    return 'WAITING';
  }
  switch (job.progress.state) {
    case 'RUNNING':
      return 'ACTIVE';
    case 'QUEUED':
    case 'RETRY_WAIT':
      return 'WAITING';
    case 'BLOCKED':
    case 'FAILED_SAFE':
      return 'FAILED';
  }
}

const POLICIES: readonly PublicationPolicy[] = ['ARCHIVE_ONLY', 'PUBLISH_TO_JELLYFIN'];

/**
 * Netdisk imports: create one, watch the ones running, read what a finished one
 * actually proved.
 *
 * A page of its own rather than more rows on `/transfers`. That surface and its
 * `OffloadSnapshot` are torrent-shaped throughout — `(instanceId, torrentHash)`
 * identity, qB recheck, seeding state — and an import has none of those. Sharing
 * the table would have meant either faking a torrent hash for every import or
 * making half of every row inapplicable, and both make the page harder to read
 * than two pages are.
 *
 * Everything selectable lives in the URL: which view, which job, which filters.
 * So a link to a running job is a link to that job, Back closes the panel it
 * opened, and a refresh two hours into a transfer comes back to the same place.
 */
export function ImportsPage() {
  const queryClient = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedView = searchParams.get('view');
  const view =
    requestedView === 'create' ||
    requestedView === 'groups' ||
    requestedView === 'group-settings' ||
    requestedView === 'observations'
      ? requestedView
      : 'jobs';
  const selectedPipelineId = searchParams.get('pipeline');
  const requestedSourceKind = searchParams.get('sourceKind');
  const initialSourceKind: ImportSourceKind | undefined =
    requestedSourceKind === 'BAIDU_SHARE' ||
    requestedSourceKind === 'BAIDU_APP_DIR' ||
    requestedSourceKind === 'OTHER'
      ? requestedSourceKind
      : undefined;
  const initialSourceConnectionId = searchParams.get('sourceConnection') ?? undefined;
  const selectedJobId = searchParams.get('job');
  const query = searchParams.get('q') ?? '';
  const requestedGroup = searchParams.get('group');
  const activeGroup = STATUS_GROUPS.includes(requestedGroup as StatusGroup)
    ? (requestedGroup as StatusGroup)
    : null;
  const policyFilter = searchParams
    .getAll('policy')
    .filter((value): value is PublicationPolicy => POLICIES.includes(value as PublicationPolicy));
  const direction = searchParams.get('dir') === 'asc' ? 'asc' : 'desc';

  const updateParams = (updates: Record<string, string | string[] | null>): void => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) {
      next.delete(key);
      if (value === null || value === '') continue;
      if (Array.isArray(value)) for (const item of value) next.append(key, item);
      else next.set(key, value);
    }
    setSearchParams(next, { replace: true });
  };

  const setSelectedJobId = (jobId: string | null): void => {
    const next = new URLSearchParams(searchParams);
    if (jobId === null) next.delete('job');
    else next.set('job', jobId);
    // Closing replaces, so Back does not walk through every panel that was
    // dismissed on the way here.
    setSearchParams(next, { replace: jobId === null });
  };

  const live = useServerEvents();
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), IMPORT_TELEMETRY_CLOCK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);
  const destinationsQuery = useQuery({
    queryKey: importDestinationsQueryKey,
    queryFn: getImportDestinations,
  });
  const jobsQuery = useQuery({
    queryKey: importsQueryKey,
    queryFn: getImports,
    refetchInterval: importRefetchInterval(live),
  });

  const capabilityProbe = destinationsQuery.data;
  const capabilities =
    capabilityProbe?.supported === true ? capabilityProbe.data.capabilities : null;
  const destinations = capabilityProbe?.supported === true ? capabilityProbe.data.destinations : [];
  const jobsProbe = jobsQuery.data;
  const jobs = useMemo(() => (jobsProbe?.supported === true ? jobsProbe.data : []), [jobsProbe]);
  /*
   * Why writes are refused, in the order that decides what the page says.
   *
   * The demo check comes first because it is a fact about this browser, not about
   * the deployment: the demo layer answers every mutation locally, so naming any
   * server-side reason would be describing a machine this session never reaches.
   */
  const readOnlyReason: ReadOnlyReason = isDemoSessionActive()
    ? 'DEMO'
    : capabilities === null
      ? 'FEATURE_DISABLED'
      : capabilities.mode === 'SHADOW'
        ? 'SHADOW'
        : capabilities.createEnabled
          ? null
          : 'FEATURE_DISABLED';

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const baseFiltered = jobs.filter((job) => {
    if (policyFilter.length > 0 && !policyFilter.includes(job.progress.publicationPolicy)) {
      return false;
    }
    if (normalizedQuery === '') return true;
    return (
      job.sourceAlias.toLocaleLowerCase().includes(normalizedQuery) ||
      job.destination.displayName.toLocaleLowerCase().includes(normalizedQuery) ||
      job.jobId.startsWith(normalizedQuery)
    );
  });
  const groupCounts = Object.fromEntries(
    STATUS_GROUPS.map((group) => [
      group,
      baseFiltered.filter((job) => groupOf(job) === group).length,
    ]),
  ) as Record<StatusGroup, number>;
  const visibleJobs = baseFiltered
    .filter((job) => activeGroup === null || groupOf(job) === activeGroup)
    .sort((left, right) =>
      direction === 'asc'
        ? Date.parse(left.createdAt) - Date.parse(right.createdAt)
        : Date.parse(right.createdAt) - Date.parse(left.createdAt),
    );
  const selected = jobs.find((job) => job.jobId === selectedJobId) ?? null;

  const runInlineAction = async (
    jobId: string,
    action: 'PAUSE' | 'RESUME' | 'CANCEL',
  ): Promise<void> => {
    const route = { PAUSE: 'pause', RESUME: 'resume', CANCEL: 'cancel' } as const;
    const result = await actOnImport(jobId, route[action]);
    if (!result.supported) throw new Error('IMPORT_ACTION_ROUTE_MISSING');

    const detailIds = new Set([jobId]);
    if (selectedJobId !== null) detailIds.add(selectedJobId);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: importsQueryKey, exact: true }),
      ...[...detailIds].map((id) =>
        queryClient.invalidateQueries({ queryKey: importDetailQueryKey(id), exact: true }),
      ),
    ]);
  };

  const groupOptions: ReadonlyArray<ChipOption<StatusGroup | 'ALL'>> = [
    { value: 'ALL', label: '全部', suffix: String(baseFiltered.length) },
    ...STATUS_GROUPS.map((group) => ({
      value: group,
      label: STATUS_LABELS[group],
      suffix: String(groupCounts[group]),
    })),
  ];

  const filtersApplied =
    query !== '' || activeGroup !== null || policyFilter.length > 0 || direction !== 'desc';

  return (
    <section className="content-page imports-page" aria-labelledby="imports-title">
      <header className="page-header">
        <div>
          <p className="page-kicker">运维</p>
          <h1 id="imports-title">网盘迁移</h1>
          <p className="page-lede">
            从网盘搬到 OneDrive，逐文件哈希、staging 回读、committed 最终回读之后才算完成。 任务跑在
            VPS 上：关掉这个网页、断开 SSH 都不会中断它。
            <strong>默认只备份</strong>
            ；只有显式选择时才会发布到 Jellyfin，而发布失败也不会把已验证的备份判成失败。
          </p>
        </div>
        <div className="import-header-actions">
          <span
            className="connection-state"
            title={
              live === 'live'
                ? '已连接事件流，状态实时更新'
                : live === 'connecting'
                  ? '正在连接事件流'
                  : `事件流断开，已降级为每 ${IMPORT_POLL_INTERVAL_MS / 1000} 秒轮询`
            }
          >
            {live === 'live' ? (
              <Radio size={15} strokeWidth={1.8} aria-hidden="true" />
            ) : (
              <RadioTower size={15} strokeWidth={1.8} aria-hidden="true" />
            )}
            {live === 'live' ? '实时更新' : live === 'connecting' ? '连接中…' : '轮询中'}
          </span>
          {view === 'create' ? (
            <button
              type="button"
              className="ghost-button"
              onClick={() => updateParams({ view: null })}
            >
              <FolderSync size={15} strokeWidth={1.9} aria-hidden="true" />
              返回迁移任务
            </button>
          ) : (
            <button
              type="button"
              className="primary-button"
              onClick={() => updateParams({ view: 'create', job: null })}
            >
              <Plus size={15} strokeWidth={1.9} aria-hidden="true" />
              新建迁移
            </button>
          )}
        </div>
      </header>

      {/*
       * Five states, five renderings. Collapsing any pair of them answers a
       * question nobody asked: "no route here" sends someone to deploy the API,
       * "no jobs" sends them to create one, and a failed request sends them to
       * look at the server — three different next moves.
       */}
      {destinationsQuery.isPending ? (
        <div className="route-status">
          <CircleDashed size={16} strokeWidth={1.8} aria-hidden="true" />
          正在加载网盘迁移…
        </div>
      ) : destinationsQuery.isError ? (
        <div className="route-status route-status-error" role="alert">
          <TriangleAlert size={16} strokeWidth={1.8} aria-hidden="true" />
          {importErrorMessage(destinationsQuery.error)}
        </div>
      ) : capabilityProbe?.supported === false ? (
        <div className="settings-notbuilt">
          <span className="settings-notbuilt-glyph" aria-hidden="true">
            <CircleSlash size={18} strokeWidth={1.7} />
          </span>
          <div>
            <p>这台机器上的 API 版本还没有网盘迁移接口。</p>
            <p>
              这不是「没有任务」，也不是请求失败：<strong>这几条路由根本不存在</strong>
              。下一步是部署带网盘迁移的 API，而不是在这一页找任务。 已经上线的迁移面在
              <Link to="/transfers">传输</Link>，那一条走的是 qB 种子，与网盘导入是两条链路。
            </p>
          </div>
        </div>
      ) : capabilities === null ? null : (
        <>
          {capabilities.groupedPipelinesEnabled !== undefined ? (
            <nav className="group-view-nav" aria-label="迁移工作区">
              {(
                [
                  ['jobs', '普通任务'],
                  ['groups', '分组流水线'],
                  ['observations', '多日观测'],
                  ['group-settings', '分组设置'],
                ] as const
              ).map(([key, label]) => (
                <button
                  className="ghost-button"
                  type="button"
                  key={key}
                  aria-current={view === key ? 'page' : undefined}
                  onClick={() => updateParams({ view: key === 'jobs' ? null : key, job: null })}
                >
                  {label}
                </button>
              ))}
            </nav>
          ) : null}
          {capabilities.mode === 'SHADOW' ? (
            <p className="inline-message import-shadow-note" role="note">
              <CircleSlash size={14} strokeWidth={1.8} aria-hidden="true" />
              <span>
                <strong>接口已就绪，但这台机器仍是只读影子模式。</strong>
                下面看到的一切都是真实接口返回的，但不会真的创建任务、也不会写入任何云端目标。
              </span>
            </p>
          ) : null}

          {view === 'create' ? (
            <ImportCreatePanel
              capabilities={capabilities}
              destinations={destinations}
              readOnlyReason={readOnlyReason}
              {...(initialSourceKind === undefined ? {} : { initialSourceKind })}
              {...(initialSourceConnectionId === undefined ? {} : { initialSourceConnectionId })}
              onCreated={(job) => updateParams({ view: null, job: job.jobId })}
              onPipelineCreated={(pipeline) =>
                updateParams({ view: 'groups', pipeline: pipeline.pipelineId, job: null })
              }
            />
          ) : view === 'groups' ? (
            <>
              <GroupPipelinesPanel
                now={now}
                selectedPipelineId={selectedPipelineId}
                onSelectPipeline={(id) => updateParams({ pipeline: id, job: null })}
                onSelectJob={setSelectedJobId}
                readOnly={isDemoSessionActive() || capabilities.mode === 'SHADOW'}
              />
              {selectedJobId === null ? null : (
                <ImportJobDetail
                  jobId={selectedJobId}
                  summary={selected}
                  supportedActions={capabilities.supportedActions}
                  readOnlyReason={readOnlyReason}
                  live={live}
                  now={now}
                  onClose={() => setSelectedJobId(null)}
                />
              )}
            </>
          ) : view === 'group-settings' ? (
            <GroupSettingsPanel
              readOnly={isDemoSessionActive() || capabilities.mode === 'SHADOW'}
            />
          ) : view === 'observations' ? (
            <GroupObservationsPanel />
          ) : (
            <>
              <FilterBar
                label="网盘迁移筛选"
                views={
                  <SegmentedTabs
                    label="分组"
                    options={groupOptions}
                    value={activeGroup ?? 'ALL'}
                    onSelect={(group) => updateParams({ group: group === 'ALL' ? null : group })}
                  />
                }
                meta={
                  <p className="inventory-count" aria-live="polite">
                    {jobsProbe?.supported === true
                      ? `显示 ${visibleJobs.length} / 共 ${jobs.length}`
                      : ''}
                  </p>
                }
                panel={
                  <ChipGroup
                    label="发布策略"
                    options={POLICIES.map((policy) => ({
                      value: policy,
                      label: PUBLICATION_POLICY_SHORT[policy],
                      suffix: String(
                        jobs.filter((job) => job.progress.publicationPolicy === policy).length,
                      ),
                    }))}
                    selected={policyFilter}
                    onToggle={(policy) =>
                      updateParams({
                        policy: policyFilter.includes(policy)
                          ? policyFilter.filter((value) => value !== policy)
                          : [...policyFilter, policy],
                      })
                    }
                  />
                }
                tokens={policyFilter.map((policy) => ({
                  key: policy,
                  group: '发布策略',
                  label: PUBLICATION_POLICY_SHORT[policy],
                  onRemove: () =>
                    updateParams({ policy: policyFilter.filter((value) => value !== policy) }),
                }))}
                onClear={
                  filtersApplied
                    ? () => updateParams({ q: null, group: null, policy: null, dir: null })
                    : undefined
                }
                note="筛选只影响这一页的显示，不改变任何任务的状态。"
              >
                <label className="inventory-search">
                  <Search size={15} strokeWidth={1.8} aria-hidden="true" />
                  <span className="visually-hidden">搜索迁移任务</span>
                  <input
                    type="search"
                    value={query}
                    placeholder="搜索来源别名或目标"
                    onChange={(event) => updateParams({ q: event.target.value })}
                  />
                </label>
                <label className="inventory-filter">
                  <span>创建时间</span>
                  <select
                    aria-label="创建时间排序"
                    value={direction}
                    onChange={(event) =>
                      updateParams({ dir: event.target.value === 'asc' ? 'asc' : null })
                    }
                  >
                    <option value="desc">最新在前</option>
                    <option value="asc">最早在前</option>
                  </select>
                </label>
              </FilterBar>

              {jobsQuery.isPending ? (
                <div className="route-status">
                  <CircleDashed size={16} strokeWidth={1.8} aria-hidden="true" />
                  正在加载迁移任务…
                </div>
              ) : jobsQuery.isError ? (
                <div className="route-status route-status-error" role="alert">
                  <TriangleAlert size={16} strokeWidth={1.8} aria-hidden="true" />
                  {importErrorMessage(jobsQuery.error)}
                </div>
              ) : jobsProbe?.supported === false ? (
                <div className="settings-notbuilt">
                  <span className="settings-notbuilt-glyph" aria-hidden="true">
                    <CircleSlash size={18} strokeWidth={1.7} />
                  </span>
                  <div>
                    <p>这台机器上的 API 版本还没有迁移任务列表接口。</p>
                  </div>
                </div>
              ) : jobs.length === 0 ? (
                <div className="neutral-empty-state">
                  <p>还没有任何网盘迁移任务。</p>
                </div>
              ) : visibleJobs.length === 0 ? (
                <div className="neutral-empty-state">
                  <p>当前筛选条件下没有迁移任务。</p>
                </div>
              ) : (
                <div className="imports-layout">
                  <ImportJobsTable
                    jobs={visibleJobs}
                    selectedJobId={selectedJobId}
                    onSelect={setSelectedJobId}
                    supportedActions={capabilities.supportedActions}
                    readOnlyReason={readOnlyReason}
                    onAction={runInlineAction}
                    now={now}
                  />
                  {selectedJobId === null ? null : (
                    <ImportJobDetail
                      jobId={selectedJobId}
                      summary={selected}
                      supportedActions={capabilities.supportedActions}
                      readOnlyReason={readOnlyReason}
                      live={live}
                      now={now}
                      onClose={() => setSelectedJobId(null)}
                    />
                  )}
                </div>
              )}
              {jobs.length === 0 && selectedJobId !== null ? (
                <ImportJobDetail
                  jobId={selectedJobId}
                  summary={null}
                  supportedActions={capabilities.supportedActions}
                  readOnlyReason={readOnlyReason}
                  live={live}
                  now={now}
                  onClose={() => setSelectedJobId(null)}
                />
              ) : null}
            </>
          )}
        </>
      )}
    </section>
  );
}
