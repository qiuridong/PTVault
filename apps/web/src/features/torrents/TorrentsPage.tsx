import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  CloudUpload,
  Lock,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { OFFLOAD_BATCH_LIMIT, type TorrentState, type TorrentSummary } from '@ptvault/contracts';

import { ApiError } from '../../api/client.js';
import {
  ChipGroup,
  FilterBar,
  SegmentedTabs,
  type ChipOption,
  type FilterToken,
} from '../../ui/FilterBar.js';
import {
  getInstances,
  getTorrentPage,
  qbInstancesQueryKey,
  qbTorrentPageQueryKey,
  syncInventory,
  type QbSyncResponse,
} from './qbApi.js';
import { useServerEvents } from '../../api/useServerEvents.js';
import { getSession, sessionQueryKey } from '../auth/authApi.js';
import { OffloadConfirmDialog } from './OffloadConfirmDialog.js';
import { PreflightInspector } from './PreflightInspector.js';
import { getOffloads, offloadsQueryKey } from '../jobs/jobApi.js';
import {
  applyTorrentFilters,
  sortTorrents,
  torrentIdentity,
  type SortDirection,
  type TorrentHistoryFilter,
  type TorrentSort,
} from './torrentFilters.js';

const ALL_INSTANCES = 'all' as const;
/** `?instance=` value that opens the settings editor for a not-yet-created instance. */
const NEW_INSTANCE = 'new' as const;
const DEFAULT_PAGE_SIZE = 50;
const PAGE_SIZES = [50, 100, 200] as const;

/** Sync failure codes the server may return, in operator-facing Chinese. */
const syncFailureLabels: Record<string, string> = {
  CREDENTIAL_NOT_FOUND: '尚未配置凭据',
  INSTANCE_NOT_FOUND: '实例不存在',
  INVALID_INSTANCE_ID: '实例 ID 非法',
  INVALID_TORRENT_LIST: 'qB 返回的列表无法解析',
  DUPLICATE_TORRENT_HASH: 'qB 列表存在重复 hash',
  TORRENT_PATH_CONTAINS_NUL: '种子路径含非法字符',
  SYNC_IN_PROGRESS: '同步已在进行中',
  SYNC_FAILED: '无法连接 qB',
};

function syncFailureLabel(code: string): string {
  return syncFailureLabels[code] ?? code;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  const rounded =
    value >= 100 || exponent === 0 || Number.isInteger(value)
      ? Math.round(value)
      : value.toFixed(1);
  return `${rounded} ${units[exponent]}`;
}

const cloudStateLabels: Record<TorrentSummary['cloudState'], string> = {
  LOCAL: '本地',
  MIGRATING: '迁移中',
  CLOUD_COMMITTED: '云端已验证（本地保留）',
  CLOUD: '云端',
  REHYDRATING: '回取中',
  BLOCKED: '受阻',
};

const stateLabels: Record<TorrentSummary['state'], string> = {
  DOWNLOADING: '下载中',
  SEEDING: '做种中',
  PAUSED: '已暂停',
  CHECKING: '校验中',
  MISSING_FILES: '文件缺失',
  ERROR: '错误',
  UNKNOWN: '未知',
};

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status === 401 ? '会话已过期，请重新登录以查看库存。' : error.message;
  }
  return '无法加载种子库存。';
}

function syncErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return '会话已过期，请重新登录后再刷新。';
    if (error.status === 409) return '同步已在进行中，请稍候。';
    return error.message;
  }
  return '刷新库存失败。';
}

/**
 * Reports the outcome of a manual refresh.
 *
 * A fleet-wide refresh returns 200 with per-instance failures in the body, so a
 * partial failure must be surfaced here — showing only "success" when one qB was
 * unreachable would leave the operator with a silently stale inventory.
 */
function SyncOutcome({
  isError,
  error,
  data,
}: {
  isError: boolean;
  error: unknown;
  data: QbSyncResponse | undefined;
}) {
  if (isError) {
    return (
      <p className="inline-message error-message" role="alert">
        <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" /> {syncErrorMessage(error)}
      </p>
    );
  }
  if (!data) return null;

  const seen = data.synced.reduce((total, entry) => total + entry.seen, 0);
  return (
    <div className="sync-outcome" aria-live="polite">
      {data.synced.length > 0 ? (
        <p className="sync-outcome-line">
          已刷新 {data.synced.length} 个实例，读到 {seen} 个种子。
        </p>
      ) : null}
      {data.failed.length > 0 ? (
        <ul className="sync-outcome-failures">
          {data.failed.map((failure) => (
            <li key={failure.instanceId}>
              <TriangleAlert size={13} strokeWidth={1.9} aria-hidden="true" /> {failure.instanceId}
              ：{syncFailureLabel(failure.code)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Stable identity for a row across instances, since a hash can repeat. */
function rowKey(torrent: { instanceId: string; hash: string }): string {
  return `${torrent.instanceId}:${torrent.hash.toLowerCase()}`;
}

const CLOUD_STATES = Object.keys(cloudStateLabels) as TorrentSummary['cloudState'][];
const TORRENT_STATES = Object.keys(stateLabels) as TorrentState[];

const CLOUD_OPTIONS: ReadonlyArray<ChipOption<TorrentSummary['cloudState']>> = CLOUD_STATES.map(
  (state) => ({ value: state, label: cloudStateLabels[state] }),
);
const STATE_OPTIONS: ReadonlyArray<ChipOption<TorrentState>> = TORRENT_STATES.map((state) => ({
  value: state,
  label: stateLabels[state],
}));

/** A torrent still downloading has nothing complete to upload. */
const MIGRATABLE_STATES = TORRENT_STATES.filter((state) => state !== 'DOWNLOADING');

/**
 * The saved views, in the order an operator works through them: what can go up,
 * what is waiting for a delete decision, what is already gone from local disk.
 */
type QuickView = 'ALL' | 'MIGRATABLE' | 'AWAITING' | 'CLOUD';
/** Not an option — what the switch reads when the preset has been hand-edited. */
type ViewSelection = QuickView | 'CUSTOM';

const QUICK_VIEWS: ReadonlyArray<ChipOption<ViewSelection>> = [
  { value: 'ALL', label: '全部' },
  { value: 'MIGRATABLE', label: '可迁移' },
  { value: 'AWAITING', label: '待删除' },
  { value: 'CLOUD', label: '已上云' },
];

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function listParam<T extends string>(value: string | null, allowed: readonly T[]): T[] {
  if (!value) return [];
  const accepted = new Set(allowed);
  return [...new Set(value.split(',').filter((entry): entry is T => accepted.has(entry as T)))];
}

function positiveIntegerParam(value: string | null, fallback: number): number {
  return value !== null && /^[1-9][0-9]*$/.test(value) ? Number(value) : fallback;
}

function pageNumbers(current: number, total: number): number[] {
  const values = new Set([1, total]);
  for (let page = current - 2; page <= current + 2; page += 1) {
    if (page >= 1 && page <= total) values.add(page);
  }
  return [...values].sort((left, right) => left - right);
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  return days > 0 ? `${days} 天 ${hours} 小时` : `${hours} 小时`;
}

export function TorrentsPage() {
  // `checked` and `confirming` stay in component state on purpose: a pending
  // selection and a half-typed MFA code are not addresses. Putting them in the URL
  // would make a shared or bookmarked link carry someone else's intent to migrate.
  const [selectedByKey, setSelectedByKey] = useState<ReadonlyMap<string, TorrentSummary>>(
    new Map(),
  );
  const [confirming, setConfirming] = useState(false);
  const queryClient = useQueryClient();

  const [searchParams, setSearchParams] = useSearchParams();

  const requestedPage = positiveIntegerParam(searchParams.get('page'), 1);
  const requestedSize = positiveIntegerParam(searchParams.get('size'), DEFAULT_PAGE_SIZE);
  const pageSize = PAGE_SIZES.includes(requestedSize as (typeof PAGE_SIZES)[number])
    ? requestedSize
    : DEFAULT_PAGE_SIZE;
  const query = searchParams.get('q') ?? '';
  const cloudStates = listParam(searchParams.get('cloud'), CLOUD_STATES);
  const torrentStates = listParam(searchParams.get('state'), TORRENT_STATES);
  const historyParam = searchParams.get('history')?.toUpperCase();
  const history: TorrentHistoryFilter =
    historyParam === 'NEVER' || historyParam === 'HAS' ? historyParam : 'ALL';
  const sortParam = searchParams.get('sort')?.toUpperCase();
  const sort: TorrentSort = ['NAME', 'SIZE', 'RATIO', 'SEEDING', 'CLOUD'].includes(sortParam ?? '')
    ? (sortParam as TorrentSort)
    : 'NAME';
  const direction: SortDirection = searchParams.get('dir') === 'desc' ? 'DESC' : 'ASC';

  const updateParams = (
    updates: Record<string, string | null>,
    options: { resetPage?: boolean; replace?: boolean } = {},
  ): void => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    if (options.resetPage) next.delete('page');
    setSearchParams(next, { replace: options.replace ?? true });
  };

  // The filter and the preflight panel are addresses too, for the same reason as
  // the dialog: the operator checks one torrent's verdict, goes to look at storage
  // health, and comes back expecting the same verdict on screen.
  const instanceFilter = searchParams.get('filter') ?? ALL_INSTANCES;
  const setInstanceFilter = (value: string): void => {
    const next = new URLSearchParams(searchParams);
    if (value === ALL_INSTANCES) next.delete('filter');
    else next.set('filter', value);
    // Changing the filter can hide the inspected row, which would otherwise leave
    // a panel describing a torrent no longer in the table.
    next.delete('inspect');
    next.delete('page');
    setSearchParams(next, { replace: true });
  };

  const inspectParam = searchParams.get('inspect');
  const selected = useMemo(() => {
    if (!inspectParam) return null;
    const separator = inspectParam.indexOf(':');
    if (separator <= 0) return null;
    const instanceId = inspectParam.slice(0, separator);
    const hash = inspectParam.slice(separator + 1);
    return /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(hash) ? { instanceId, hash } : null;
  }, [inspectParam]);
  const setSelected = (target: { instanceId: string; hash: string } | null): void => {
    const next = new URLSearchParams(searchParams);
    if (target === null) next.delete('inspect');
    else next.set('inspect', rowKey(target));
    setSearchParams(next, { replace: target === null });
  };

  // Never refetches on mount, which is required rather than merely tidy:
  // `ProtectedRoute` withholds its children whenever the session query is
  // fetching, so that cached session data can never gate protected content on its
  // own. An observer that refetches on mount therefore unmounts this page — mount
  // triggers a refetch, the parent swaps to its status page, this unmounts, then
  // remounts and refetches again. That loop hung the page on "Checking session"
  // in production. The parent has already revalidated the session by the time any
  // child renders, so the cached value is exactly what should be read here.
  const sessionQuery = useQuery({
    queryKey: sessionQueryKey,
    queryFn: getSession,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnMount: false,
  });
  // SHADOW has no offload route registered at all, so offering the control would
  // be offering a 404. The server re-checks the mode regardless.
  const canOffload = sessionQuery.data?.mode === 'ACTIVE';

  const instancesQuery = useQuery({
    queryKey: qbInstancesQueryKey,
    queryFn: getInstances,
  });

  // Subscribed here as well as on the transfers page: a migration reaching
  // CLOUD_COMMITTED flips this table's cloud state, and this is the page the
  // operator comes back to after starting one. The hook invalidates on the
  // event, so no interval is needed while the stream is up.
  const live = useServerEvents();
  const activeInstance = instanceFilter === ALL_INSTANCES ? undefined : instanceFilter;
  const torrentsQuery = useQuery({
    queryKey: qbTorrentPageQueryKey(activeInstance, requestedPage, pageSize),
    queryFn: () =>
      getTorrentPage({ instanceId: activeInstance, page: requestedPage, size: pageSize }),
    // Falls back to polling only when the stream is down, so a dropped connection
    // degrades to "slightly late" instead of "silently frozen".
    refetchInterval: live === 'live' ? false : 10_000,
  });
  const offloadsQuery = useQuery({ queryKey: offloadsQueryKey, queryFn: getOffloads });

  const syncMutation = useMutation({
    mutationFn: () => syncInventory(activeInstance),
    onSuccess: async () => {
      // The refresh rewrote the inventory rows, so every torrent view is stale.
      await queryClient.invalidateQueries({ queryKey: ['qb', 'torrents'] });
    },
  });

  const torrents = useMemo(() => torrentsQuery.data?.torrents ?? [], [torrentsQuery.data]);
  const instances = useMemo(() => instancesQuery.data ?? [], [instancesQuery.data]);
  const offloadKeys = useMemo(
    () =>
      new Set(
        (offloadsQuery.data ?? []).map((offload) =>
          torrentIdentity({ instanceId: offload.instanceId, hash: offload.torrentHash }),
        ),
      ),
    [offloadsQuery.data],
  );
  const filteredTorrents = useMemo(
    () =>
      sortTorrents(
        applyTorrentFilters(torrents, offloadKeys, {
          query,
          cloudStates,
          torrentStates,
          history,
        }),
        sort,
        direction,
      ),
    [torrents, offloadKeys, query, cloudStates, torrentStates, history, sort, direction],
  );
  const actualPage = torrentsQuery.data?.page ?? requestedPage;
  const totalTorrents = torrentsQuery.data?.total ?? torrents.length;
  const totalPages = Math.max(1, Math.ceil(totalTorrents / pageSize));

  useEffect(() => {
    if (torrentsQuery.data && actualPage !== requestedPage) {
      const next = new URLSearchParams(searchParams);
      if (actualPage === 1) next.delete('page');
      else next.set('page', String(actualPage));
      setSearchParams(next, { replace: true });
    }
  }, [actualPage, requestedPage, searchParams, setSearchParams, torrentsQuery.data]);

  /**
   * Only LOCAL rows are selectable: a MIGRATING one is already in flight and a
   * CLOUD one has no local bytes left to move.
   */
  const offloadable = useMemo(
    () => filteredTorrents.filter((torrent) => torrent.cloudState === 'LOCAL'),
    [filteredTorrents],
  );
  const selectedTorrents = useMemo(() => [...selectedByKey.values()], [selectedByKey]);
  const allSelected =
    offloadable.length > 0 && offloadable.every((torrent) => selectedByKey.has(rowKey(torrent)));

  const toggleRow = (torrent: TorrentSummary): void => {
    setSelectedByKey((previous) => {
      const next = new Map(previous);
      const key = rowKey(torrent);
      if (next.has(key)) next.delete(key);
      else if (next.size < OFFLOAD_BATCH_LIMIT) next.set(key, torrent);
      return next;
    });
  };

  const togglePage = (): void => {
    setSelectedByKey((previous) => {
      const next = new Map(previous);
      if (allSelected) {
        for (const torrent of offloadable) next.delete(rowKey(torrent));
      } else {
        for (const torrent of offloadable) {
          if (next.size >= OFFLOAD_BATCH_LIMIT) break;
          next.set(rowKey(torrent), torrent);
        }
      }
      return next;
    });
  };

  const toggleListFilter = (
    key: 'cloud' | 'state',
    value: string,
    current: readonly string[],
  ): void => {
    const next = current.includes(value)
      ? current.filter((entry) => entry !== value)
      : [...current, value];
    updateParams({ [key]: next.length === 0 ? null : next.join(',') }, { resetPage: true });
  };

  const setSort = (nextSort: TorrentSort): void => {
    const nextDirection: SortDirection = sort === nextSort && direction === 'ASC' ? 'DESC' : 'ASC';
    updateParams({
      sort: nextSort === 'NAME' ? null : nextSort.toLowerCase(),
      dir: nextDirection === 'DESC' ? 'desc' : null,
    });
  };

  const applyQuickView = (view: QuickView): void => {
    if (view === 'ALL') {
      updateParams({ cloud: null, state: null, history: null }, { resetPage: true });
      return;
    }
    if (view === 'MIGRATABLE') {
      updateParams(
        {
          cloud: 'LOCAL',
          state: MIGRATABLE_STATES.join(','),
          history: 'never',
        },
        { resetPage: true },
      );
      return;
    }
    updateParams(
      {
        cloud: view === 'AWAITING' ? 'CLOUD_COMMITTED' : 'CLOUD',
        state: null,
        history: null,
      },
      { resetPage: true },
    );
  };

  /**
   * Which saved view the current URL amounts to.
   *
   * Derived rather than stored, so a link pasted from elsewhere lights up the
   * matching view, and so editing one chip out of a preset honestly drops the
   * switch to "none of these" instead of leaving a lie highlighted.
   */
  const quickView: ViewSelection =
    cloudStates.length === 0 && torrentStates.length === 0 && history === 'ALL'
      ? 'ALL'
      : sameSet(cloudStates, ['LOCAL']) &&
          sameSet(torrentStates, MIGRATABLE_STATES) &&
          history === 'NEVER'
        ? 'MIGRATABLE'
        : torrentStates.length === 0 &&
            history === 'ALL' &&
            sameSet(cloudStates, ['CLOUD_COMMITTED'])
          ? 'AWAITING'
          : torrentStates.length === 0 && history === 'ALL' && sameSet(cloudStates, ['CLOUD'])
            ? 'CLOUD'
            : 'CUSTOM';

  /**
   * What the collapsed panel is currently doing, echoed onto the bar.
   *
   * Only the panel's own filters: search and 迁移记录 stay visible on row one, so
   * repeating them here would be noise rather than disclosure.
   */
  const filterTokens: FilterToken[] = [
    ...cloudStates.map((state) => ({
      key: `cloud:${state}`,
      group: '云端状态',
      label: cloudStateLabels[state],
      onRemove: () => toggleListFilter('cloud', state, cloudStates),
    })),
    ...torrentStates.map((state) => ({
      key: `state:${state}`,
      group: 'qB 状态',
      label: stateLabels[state],
      onRemove: () => toggleListFilter('state', state, torrentStates),
    })),
  ];
  const anyFilterApplied =
    query !== '' ||
    history !== 'ALL' ||
    cloudStates.length > 0 ||
    torrentStates.length > 0 ||
    sort !== 'NAME' ||
    direction !== 'ASC';

  const filterTarget =
    activeInstance === undefined
      ? null
      : (instances.find((instance) => instance.id === activeInstance) ?? null);

  return (
    <section className="content-page" aria-labelledby="torrents-title">
      <header className="page-header">
        <div>
          <p className="page-kicker">运维</p>
          <h1 id="torrents-title">种子</h1>
          <p className="page-lede">
            两个 qBittorrent
            实例的已完成种子。勾选后发起迁移：先暂停、加密上传，解密回读校验通过之前，本地一个字节都不会动。
          </p>
        </div>
        <span className="connection-state" title={canOffload ? '可发起迁移' : '影子模式为只读'}>
          <Lock size={15} strokeWidth={1.8} aria-hidden="true" />
          {canOffload ? '迁移就绪' : '只读影子模式'}
        </span>
      </header>

      <div className="inventory-toolbar">
        <label className="inventory-filter">
          <span>实例</span>
          <select
            aria-label="实例"
            value={instanceFilter}
            onChange={(event) => setInstanceFilter(event.target.value)}
            disabled={instancesQuery.isPending || instancesQuery.isError}
          >
            <option value={ALL_INSTANCES}>全部实例</option>
            {instances.map((instance) => (
              <option key={instance.id} value={instance.id}>
                {instance.displayName}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="ghost-button"
          onClick={() => syncMutation.mutate()}
          disabled={syncMutation.isPending || instances.length === 0}
          // Names the read-only nature so it is never mistaken for a migrate button.
          title="从 qB 重新读取库存（只读）"
        >
          <RefreshCw size={15} strokeWidth={1.9} aria-hidden="true" />
          {syncMutation.isPending ? '正在刷新…' : '刷新库存'}
        </button>

        {/*
          Navigates instead of opening a form here. This page used to carry its
          own copy of the instance form; the settings page carries the one that
          can edit path mappings and test a connection, and two forms writing the
          same row is how one of them quietly stops being the real one.
        */}
        <Link
          className="ghost-button"
          to={`/settings?instance=${encodeURIComponent(filterTarget === null ? NEW_INSTANCE : filterTarget.id)}`}
        >
          {filterTarget === null ? (
            <>
              <Plus size={15} strokeWidth={1.9} aria-hidden="true" />
              添加实例
            </>
          ) : (
            <>
              <Settings size={15} strokeWidth={1.9} aria-hidden="true" />
              配置实例
            </>
          )}
        </Link>

        {canOffload ? (
          <button
            type="button"
            className="primary-action"
            onClick={() => setConfirming(true)}
            disabled={selectedTorrents.length === 0}
            title="上传到云端，校验通过后释放本地空间"
          >
            <CloudUpload size={15} strokeWidth={1.9} aria-hidden="true" />
            迁移所选
            {selectedTorrents.length > 0 ? `（${selectedTorrents.length}）` : ''}
          </button>
        ) : null}

        <p className="inventory-count" aria-live="polite">
          {torrentsQuery.isSuccess
            ? `本页 ${torrents.length} · 当前页筛出 ${filteredTorrents.length} · 共 ${totalTorrents}`
            : ''}
        </p>
      </div>

      <FilterBar
        label="当前页种子筛选"
        views={
          <SegmentedTabs
            label="快捷视图"
            options={QUICK_VIEWS}
            value={quickView}
            onSelect={(view) => {
              if (view !== 'CUSTOM') applyQuickView(view);
            }}
          />
        }
        tokens={filterTokens}
        onClear={
          anyFilterApplied
            ? () =>
                updateParams(
                  { q: null, cloud: null, state: null, history: null, sort: null, dir: null },
                  { resetPage: true },
                )
            : undefined
        }
        note="搜索、状态筛选和排序只作用于当前页；实例与页码由服务端查询，避免一次渲染数千行。"
        panel={
          <>
            <ChipGroup
              label="云端状态"
              options={CLOUD_OPTIONS}
              selected={cloudStates}
              onToggle={(state) => toggleListFilter('cloud', state, cloudStates)}
            />
            <ChipGroup
              label="qB 状态"
              options={STATE_OPTIONS}
              selected={torrentStates}
              onToggle={(state) => toggleListFilter('state', state, torrentStates)}
            />
          </>
        }
      >
        <label className="inventory-search">
          <Search size={15} strokeWidth={1.8} aria-hidden="true" />
          <span className="visually-hidden">搜索当前页种子</span>
          <input
            type="search"
            value={query}
            placeholder="搜索当前页名称或 hash 前缀"
            onChange={(event) => updateParams({ q: event.target.value }, { resetPage: true })}
          />
        </label>
        <label className="inventory-filter">
          <span>迁移记录</span>
          <select
            aria-label="迁移记录"
            value={history}
            onChange={(event) =>
              updateParams(
                {
                  history: event.target.value === 'ALL' ? null : event.target.value.toLowerCase(),
                },
                { resetPage: true },
              )
            }
          >
            <option value="ALL">全部</option>
            <option value="NEVER">从未迁移</option>
            <option value="HAS">有记录</option>
          </select>
        </label>
      </FilterBar>

      <SyncOutcome
        isError={syncMutation.isError}
        error={syncMutation.error}
        data={syncMutation.data}
      />

      {confirming ? (
        <OffloadConfirmDialog
          selected={selectedTorrents}
          // Cleared the moment the batch is accepted, not when the panel is
          // dismissed: the result view stays up to report rejections, and rows
          // left checked behind it are how the same torrents get submitted twice.
          onSubmitted={() => setSelectedByKey(new Map())}
          onClose={() => {
            setConfirming(false);
            setSelectedByKey(new Map());
          }}
        />
      ) : null}

      {torrentsQuery.isPending ? (
        <div className="route-status">
          <CircleDashed size={16} strokeWidth={1.8} aria-hidden="true" />
          正在加载种子库存…
        </div>
      ) : torrentsQuery.isError ? (
        <div className="route-status route-status-error" role="alert">
          <TriangleAlert size={16} strokeWidth={1.8} aria-hidden="true" />
          {errorMessage(torrentsQuery.error)}
        </div>
      ) : torrents.length === 0 ? (
        <div className="neutral-empty-state">
          <p>影子库存中暂无已完成的种子。</p>
        </div>
      ) : (
        <>
          {history !== 'ALL' && !offloadsQuery.isSuccess ? (
            <div className="route-status">
              <CircleDashed size={16} strokeWidth={1.8} aria-hidden="true" />
              正在读取迁移记录，暂不对历史作结论…
            </div>
          ) : filteredTorrents.length === 0 ? (
            <div className="neutral-empty-state">
              <p>当前页没有匹配筛选条件的种子。</p>
            </div>
          ) : (
            <div className="inventory-table-wrap">
              <table className="inventory-table">
                <caption className="visually-hidden">跨 qBittorrent 实例的已完成种子库存</caption>
                <thead>
                  <tr>
                    {canOffload ? (
                      <th scope="col" className="inventory-check-cell">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          disabled={offloadable.length === 0}
                          aria-label={allSelected ? '取消选择当前页' : '选择当前页筛选结果'}
                          onChange={togglePage}
                        />
                      </th>
                    ) : null}
                    <th scope="col">
                      <button
                        type="button"
                        className="sortable-header"
                        onClick={() => setSort('NAME')}
                      >
                        名称{sort === 'NAME' ? (direction === 'ASC' ? ' ↑' : ' ↓') : ''}
                      </button>
                    </th>
                    <th scope="col">实例</th>
                    <th scope="col">状态</th>
                    <th scope="col">
                      <button
                        type="button"
                        className="sortable-header"
                        onClick={() => setSort('SIZE')}
                      >
                        大小{sort === 'SIZE' ? (direction === 'ASC' ? ' ↑' : ' ↓') : ''}
                      </button>
                    </th>
                    <th scope="col">
                      <button
                        type="button"
                        className="sortable-header"
                        onClick={() => setSort('RATIO')}
                      >
                        分享率{sort === 'RATIO' ? (direction === 'ASC' ? ' ↑' : ' ↓') : ''}
                      </button>
                    </th>
                    <th scope="col">
                      <button
                        type="button"
                        className="sortable-header"
                        onClick={() => setSort('SEEDING')}
                      >
                        做种时长{sort === 'SEEDING' ? (direction === 'ASC' ? ' ↑' : ' ↓') : ''}
                      </button>
                    </th>
                    <th scope="col">
                      <button
                        type="button"
                        className="sortable-header"
                        onClick={() => setSort('CLOUD')}
                      >
                        云端状态{sort === 'CLOUD' ? (direction === 'ASC' ? ' ↑' : ' ↓') : ''}
                      </button>
                    </th>
                    <th scope="col">
                      <span className="visually-hidden">操作</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTorrents.map((torrent) => {
                    const isSelected =
                      selected?.instanceId === torrent.instanceId &&
                      selected?.hash === torrent.hash;
                    const isChecked = selectedByKey.has(rowKey(torrent));
                    const selectable = canOffload && torrent.cloudState === 'LOCAL';
                    return (
                      <tr
                        key={rowKey(torrent)}
                        aria-selected={isSelected || isChecked}
                        className={isSelected || isChecked ? 'is-selected' : undefined}
                      >
                        {canOffload ? (
                          <td className="inventory-check-cell">
                            <input
                              type="checkbox"
                              checked={isChecked}
                              disabled={
                                !selectable ||
                                (!isChecked && selectedByKey.size >= OFFLOAD_BATCH_LIMIT)
                              }
                              aria-label={`迁移 ${torrent.name}`}
                              onChange={() => toggleRow(torrent)}
                            />
                          </td>
                        ) : null}
                        <td>
                          <span className="torrent-name" title={torrent.contentPath}>
                            {torrent.name}
                          </span>
                        </td>
                        <td>{torrent.instanceId}</td>
                        <td>{stateLabels[torrent.state]}</td>
                        <td>{formatBytes(torrent.totalSize)}</td>
                        <td>{torrent.ratio.toFixed(2)}</td>
                        <td>{formatDuration(torrent.seedingSeconds)}</td>
                        <td>
                          <span className={`cloud-tag cloud-${torrent.cloudState.toLowerCase()}`}>
                            {torrent.cloudState === 'CLOUD' ? (
                              <ShieldCheck size={13} strokeWidth={1.9} aria-hidden="true" />
                            ) : null}
                            {cloudStateLabels[torrent.cloudState]}
                          </span>
                        </td>
                        <td>
                          <div className="inventory-row-actions">
                            <button
                              type="button"
                              className="inventory-inspect"
                              onClick={() =>
                                setSelected({ instanceId: torrent.instanceId, hash: torrent.hash })
                              }
                              aria-expanded={isSelected}
                            >
                              检查
                            </button>
                            <Link
                              className="inventory-inspect"
                              to={`/transfers?q=${encodeURIComponent(torrent.hash)}`}
                            >
                              传输记录
                            </Link>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <footer className="inventory-pagination">
            <p>
              已选 {selectedByKey.size} 项（可跨页），共{' '}
              {formatBytes(selectedTorrents.reduce((sum, torrent) => sum + torrent.totalSize, 0))}
              {selectedByKey.size >= OFFLOAD_BATCH_LIMIT
                ? ` · 已达 ${OFFLOAD_BATCH_LIMIT} 项上限`
                : ''}
            </p>
            <label className="inventory-filter">
              <span>每页</span>
              <select
                aria-label="每页数量"
                value={pageSize}
                onChange={(event) =>
                  updateParams(
                    {
                      size:
                        event.target.value === String(DEFAULT_PAGE_SIZE)
                          ? null
                          : event.target.value,
                    },
                    { resetPage: true },
                  )
                }
              >
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
            <nav className="page-buttons" aria-label="种子分页">
              <button
                type="button"
                aria-label="上一页"
                disabled={actualPage <= 1}
                onClick={() => updateParams({ page: String(actualPage - 1) })}
              >
                <ChevronLeft size={15} aria-hidden="true" />
              </button>
              {pageNumbers(actualPage, totalPages).map((page, index, pages) => (
                <span key={page} className="page-number-slot">
                  {index > 0 && page - (pages[index - 1] ?? page) > 1 ? (
                    <span aria-hidden="true">…</span>
                  ) : null}
                  <button
                    type="button"
                    aria-label={`第 ${page} 页`}
                    aria-current={page === actualPage ? 'page' : undefined}
                    onClick={() => updateParams({ page: page === 1 ? null : String(page) })}
                  >
                    {page}
                  </button>
                </span>
              ))}
              <button
                type="button"
                aria-label="下一页"
                disabled={actualPage >= totalPages}
                onClick={() => updateParams({ page: String(actualPage + 1) })}
              >
                <ChevronRight size={15} aria-hidden="true" />
              </button>
            </nav>
          </footer>
        </>
      )}

      {selected ? (
        <PreflightInspector
          instanceId={selected.instanceId}
          hash={selected.hash}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </section>
  );
}
