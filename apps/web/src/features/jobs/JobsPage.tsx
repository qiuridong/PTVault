import { useQuery } from '@tanstack/react-query';
import { CircleDashed, Radio, RadioTower, Search, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

import type { OffloadSnapshot } from '@ptvault/contracts';

import { ApiError } from '../../api/client.js';
import { useServerEvents } from '../../api/useServerEvents.js';
import { FilterBar, SegmentedTabs, type ChipOption } from '../../ui/FilterBar.js';
import type { TorrentSummary } from '@ptvault/contracts';

import { getTorrents, qbTorrentsQueryKey } from '../torrents/qbApi.js';
import { getOffloads, offloadsQueryKey } from './jobApi.js';
import { JobTimeline } from './JobTimeline.js';
import { ResourceWaitStatus } from './ResourceWait.js';
import { TransferActions } from './TransferActions.js';
import { TransferBytesCell, TransferEtaCell, TransferRateCell } from './TransferProgress.js';
import { TransferSchedulerPanel } from './TransferSchedulerPanel.js';
import { groupOf, type OffloadGroup } from './offloadGroups.js';

/**
 * Where the torrent stands **now**, which is not what a finished transfer records.
 *
 * A completed cleanup is a fact about the past: it says the local copy was deleted
 * that day. If the title was later restored, the transfer still says so, and an
 * operator reading this page concluded the file was gone while it sat on disk.
 * Same wording as the torrents page, so one state has one name.
 */
const cloudStateLabels: Record<TorrentSummary['cloudState'], string> = {
  LOCAL: '本地',
  MIGRATING: '迁移中',
  CLOUD_COMMITTED: '云端已验证（本地保留）',
  CLOUD: '云端',
  REHYDRATING: '回取中',
  BLOCKED: '受阻',
};

const stepLabels: Record<OffloadSnapshot['currentStep'], string> = {
  PREFLIGHT: '预检',
  PAUSING: '暂停中',
  SNAPSHOTTING: '快照中',
  HASHING: '哈希中',
  UPLOADING_STAGING: '上传中',
  VERIFYING: '校验中',
  FINALIZING_REMOTE: '定稿中',
  CLOUD_COMMITTED: '云端已提交',
  LOCAL_CLEANUP: '本地清理',
  COMPLETED: '已完成',
};

const GROUP_LABELS: Record<OffloadGroup, string> = {
  ACTIVE: '进行中',
  AWAITING_CLEANUP: '待删除',
  COMPLETED: '已完成',
  FAILED: '失败或受阻',
  CANCELLED: '已取消',
};

const GROUPS = Object.keys(GROUP_LABELS) as OffloadGroup[];

function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status === 401 ? '会话已过期，请重新登录以查看传输任务。' : error.message;
  }
  return '无法加载传输任务。';
}

export function JobsPage() {
  // In the URL (`?job=<id>`) rather than in component state, so opening a
  // timeline, leaving to check something, and coming back returns to that
  // timeline. It also makes a row selection linkable and Back-button aware.
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedJobId = searchParams.get('job');
  const query = searchParams.get('q') ?? '';
  const requestedGroup = searchParams.get('group');
  const activeGroup = GROUPS.includes(requestedGroup as OffloadGroup)
    ? (requestedGroup as OffloadGroup)
    : null;
  const instanceFilter = searchParams.get('instance') ?? 'all';
  const direction = searchParams.get('dir') === 'asc' ? 'asc' : 'desc';

  const updateParams = (updates: Record<string, string | null>): void => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    setSearchParams(next, { replace: true });
  };
  const setSelectedJobId = (jobId: string | null): void => {
    const next = new URLSearchParams(searchParams);
    if (jobId === null) next.delete('job');
    else next.set('job', jobId);
    // Closing replaces, so Back does not walk through every panel the operator
    // dismissed on the way here.
    setSearchParams(next, { replace: jobId === null });
  };

  // Live updates come from the server's event stream; the interval is a fallback
  // for when that stream is down, not the primary mechanism. Polling every few
  // seconds unconditionally would put steady load on a page an operator leaves
  // open for the length of a multi-hour transfer.
  const live = useServerEvents();

  /*
   * Escape closes the open timeline.
   *
   * The button is the discoverable way out; this is the reflex one. Bound on the
   * document rather than the panel because the panel does not hold focus after a
   * click on the table row that opened it, and a shortcut that works only when
   * focus happens to be inside is one an operator learns not to trust.
   *
   * Deliberately not a focus trap: unlike the mobile drawer, this panel sits
   * beside the table rather than over it, and trapping focus in it would take Tab
   * away from the table that is still on screen and still usable.
   */
  /*
   * Held in a ref because `setSelectedJobId` closes over `searchParams` and is
   * therefore a new function every render. Depending on it directly would tear
   * down and rebind the document listener on every keystroke in the search box;
   * capturing it in a ref keeps the listener bound to the panel's lifetime while
   * still calling the current closure, so Escape writes the URL the page has now
   * rather than the one it had when the panel opened.
   */
  /*
   * The row toggle that opened the panel, so closing can hand focus back to it.
   *
   * Keyed by job id rather than held as a single node: the table re-renders on
   * every refetch, and after a close the element that must receive focus is the
   * one belonging to the row that was open — not whichever toggle happens to be
   * last. Entries are dropped when a row leaves the table, so a filter change
   * cannot leave this pointing at a detached node.
   */
  const rowToggleRefs = useRef(new Map<string, HTMLButtonElement>());
  const registerRowToggle = (jobId: string, node: HTMLButtonElement | null): void => {
    if (node === null) rowToggleRefs.current.delete(jobId);
    else rowToggleRefs.current.set(jobId, node);
  };

  /*
   * Where focus goes when the panel closes.
   *
   * Closing unmounts whatever held focus — the close button, or nothing at all
   * when Escape was pressed from the search box — and the browser's fallback is
   * `<body>`, from which Tab restarts at the top of the shell. An operator working
   * a batch by keyboard would re-tab the whole page after every panel they
   * dismissed, so the panel hands focus back to the row it belongs to.
   *
   * Deferred to the next frame because the toggle is only re-labelled after React
   * has committed the state change; focusing before that would target the node as
   * it is being replaced. The id is captured at close time rather than read from
   * `selectedJobId`, which by then is already `null`.
   */
  const restoreRowFocus = (jobId: string | null): void => {
    if (jobId === null) return;
    requestAnimationFrame(() => rowToggleRefs.current.get(jobId)?.focus());
  };

  const closeTimeline = (): void => {
    const closing = selectedJobId;
    setSelectedJobId(null);
    restoreRowFocus(closing);
  };

  const closeTimelineRef = useRef(() => {
    /* replaced below on every render */
  });
  closeTimelineRef.current = closeTimeline;

  useEffect(() => {
    if (selectedJobId === null) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeTimelineRef.current();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedJobId]);

  const offloadsQuery = useQuery({
    queryKey: offloadsQueryKey,
    queryFn: getOffloads,
    refetchInterval: live === 'live' ? false : 5_000,
  });

  // Joined here rather than added to the offload contract: the name belongs to the
  // torrent, not to the transfer, and a snapshot taken hours ago should still show
  // whatever the torrent is called now.
  const torrentsQuery = useQuery({ queryKey: qbTorrentsQueryKey(), queryFn: () => getTorrents() });
  const torrentsByHash = useMemo(
    () =>
      new Map(
        (torrentsQuery.data ?? []).map((torrent) => [
          `${torrent.instanceId}:${torrent.hash}`,
          torrent,
        ]),
      ),
    [torrentsQuery.data],
  );

  const offloads = offloadsQuery.data ?? [];
  const instances = [...new Set(offloads.map((offload) => offload.instanceId))].sort();
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const baseFiltered = offloads.filter((offload) => {
    if (instanceFilter !== 'all' && offload.instanceId !== instanceFilter) return false;
    if (normalizedQuery === '') return true;
    const torrent = torrentsByHash.get(`${offload.instanceId}:${offload.torrentHash}`);
    return (
      torrent?.name.toLocaleLowerCase().includes(normalizedQuery) === true ||
      offload.torrentHash.toLowerCase().startsWith(normalizedQuery)
    );
  });
  const groupCounts = Object.fromEntries(
    GROUPS.map((group) => [
      group,
      baseFiltered.filter((offload) => groupOf(offload) === group).length,
    ]),
  ) as Record<OffloadGroup, number>;
  const visibleOffloads = baseFiltered
    .filter((offload) => activeGroup === null || groupOf(offload) === activeGroup)
    .sort((left, right) =>
      direction === 'asc' ? left.createdAt - right.createdAt : right.createdAt - left.createdAt,
    );
  const selected = offloads.find((offload) => offload.jobId === selectedJobId) ?? null;

  // The counts belong on the switch itself: "失败或受阻 0" is the answer to the
  // question the operator opened this page with, and hiding it behind a click
  // makes them check five groups to learn nothing happened.
  const groupOptions: ReadonlyArray<ChipOption<OffloadGroup | 'ALL'>> = [
    { value: 'ALL', label: '全部', suffix: String(baseFiltered.length) },
    ...GROUPS.map((group) => ({
      value: group,
      label: GROUP_LABELS[group],
      suffix: String(groupCounts[group]),
    })),
  ];

  return (
    <section className="content-page" aria-labelledby="transfers-title">
      <header className="page-header">
        <div>
          <p className="page-kicker">运维</p>
          <h1 id="transfers-title">传输</h1>
          <p className="page-lede">
            每次迁移都是一条独立记录。「阶段」是这条任务走到了哪一步，「当前位置」是数据此刻在哪——一次回迁之后，两者本来就会不一致。
          </p>
        </div>
        {/*
          Reports whether updates are arriving, not the process mode — the mode was
          hardcoded here and read "只读影子模式" even while a migration was running.
          An operator watching a stalled-looking page needs to distinguish "nothing
          has changed" from "we stopped being told about changes".
        */}
        <span
          className="connection-state"
          title={
            live === 'live'
              ? '已连接事件流，状态实时更新'
              : live === 'connecting'
                ? '正在连接事件流'
                : '事件流断开，已降级为每 5 秒轮询'
          }
        >
          {live === 'live' ? (
            <Radio size={15} strokeWidth={1.8} aria-hidden="true" />
          ) : (
            <RadioTower size={15} strokeWidth={1.8} aria-hidden="true" />
          )}
          {live === 'live' ? '实时更新' : live === 'connecting' ? '连接中…' : '轮询中'}
        </span>
      </header>

      {/*
        Above the filters, not below the table. The global gate decides what every
        row's buttons are allowed to be — a job cannot be paused individually while
        the scheduler is itself paused — so reading it after scrolling past a
        hundred transfers is reading it too late. It is also the panel consulted
        before a restart, which is a question asked of the page as a whole rather
        than of any one transfer.
      */}
      <TransferSchedulerPanel />

      <FilterBar
        label="传输筛选"
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
            {offloadsQuery.isSuccess
              ? `显示 ${visibleOffloads.length} / 共 ${offloads.length}`
              : ''}
          </p>
        }
        onClear={
          query !== '' || activeGroup !== null || instanceFilter !== 'all' || direction !== 'desc'
            ? () => updateParams({ q: null, group: null, instance: null, dir: null })
            : undefined
        }
      >
        <label className="inventory-search">
          <Search size={15} strokeWidth={1.8} aria-hidden="true" />
          <span className="visually-hidden">搜索传输</span>
          <input
            type="search"
            value={query}
            placeholder="搜索片名或 hash 前缀"
            onChange={(event) => updateParams({ q: event.target.value })}
          />
        </label>
        <label className="inventory-filter">
          <span>实例</span>
          <select
            aria-label="传输实例"
            value={instanceFilter}
            onChange={(event) =>
              updateParams({ instance: event.target.value === 'all' ? null : event.target.value })
            }
          >
            <option value="all">全部实例</option>
            {instances.map((instance) => (
              <option key={instance} value={instance}>
                {instance}
              </option>
            ))}
          </select>
        </label>
        <label className="inventory-filter">
          <span>发起时间</span>
          <select
            aria-label="发起时间排序"
            value={direction}
            onChange={(event) => updateParams({ dir: event.target.value === 'asc' ? 'asc' : null })}
          >
            <option value="desc">最新在前</option>
            <option value="asc">最早在前</option>
          </select>
        </label>
      </FilterBar>

      {offloadsQuery.isPending ? (
        <div className="route-status">
          <CircleDashed size={16} strokeWidth={1.8} aria-hidden="true" />
          正在加载传输…
        </div>
      ) : offloadsQuery.isError ? (
        <div className="route-status route-status-error" role="alert">
          <TriangleAlert size={16} strokeWidth={1.8} aria-hidden="true" />
          {errorMessage(offloadsQuery.error)}
        </div>
      ) : offloads.length === 0 ? (
        <div className="neutral-empty-state">
          <p>尚未创建任何卸载传输。</p>
        </div>
      ) : visibleOffloads.length === 0 ? (
        <div className="neutral-empty-state">
          <p>当前筛选条件下没有传输记录。</p>
        </div>
      ) : (
        <div className="transfers-layout">
          <div className="inventory-table-wrap">
            <table className="inventory-table">
              <caption className="visually-hidden">卸载传输</caption>
              <thead>
                <tr>
                  <th scope="col">种子</th>
                  <th scope="col">实例</th>
                  <th scope="col">重要级</th>
                  <th scope="col">阶段</th>
                  {/*
                    In the row, not only in the timeline. "Is it moving, and how
                    fast" is the question this page is opened to answer, and
                    answering it only inside a panel meant opening one transfer at
                    a time to find the slow one.
                  */}
                  <th scope="col">进度</th>
                  <th scope="col">速率</th>
                  <th scope="col">预计剩余</th>
                  <th scope="col">当前位置</th>
                  <th scope="col">发起时间</th>
                  <th scope="col">
                    <span className="visually-hidden">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleOffloads.map((offload) => {
                  const isSelected = offload.jobId === selectedJobId;
                  const torrent = torrentsByHash.get(
                    `${offload.instanceId}:${offload.torrentHash}`,
                  );
                  return (
                    <tr
                      key={offload.jobId}
                      aria-selected={isSelected}
                      className={isSelected ? 'is-selected' : undefined}
                    >
                      <td>
                        {/*
                          The name first, hash underneath. A page whose whole job is
                          "which migration is this" showed only a truncated hash, so
                          finding a transfer meant knowing its infohash by sight.
                          Falls back to the hash for a torrent qB no longer lists —
                          a removed torrent still has a transfer worth reading.
                        */}
                        <span className="torrent-name" title={offload.torrentHash}>
                          {torrent?.name ?? shortHash(offload.torrentHash)}
                        </span>
                      </td>
                      <td>{offload.instanceId}</td>
                      <td>{offload.importance}</td>
                      <td>
                        {offload.resourceWait === undefined ? (
                          stepLabels[offload.currentStep]
                        ) : (
                          <ResourceWaitStatus snapshot={offload} compact />
                        )}
                      </td>
                      {/*
                        Progress and rate in the row, not only in the timeline. The
                        step cell said 「上传中」 for hours with nothing beside it, so
                        the one question the page exists to answer — is this moving —
                        required opening a panel per transfer to guess at.
                      */}
                      <td className="is-numeric">
                        <TransferBytesCell snapshot={offload} />
                      </td>
                      <td className="is-numeric">
                        <TransferRateCell snapshot={offload} />
                      </td>
                      <td className="is-numeric">
                        {/*
                          Shares `TransferEtaCell` with the detail panel rather
                          than formatting here: this cell used to read
                          `etaSeconds` directly and so kept quoting a remaining
                          time derived from a rate the neighbouring cell had
                          already withheld as too old.
                        */}
                        <TransferEtaCell snapshot={offload} />
                      </td>
                      <td>
                        {/*
                          Read from the torrent, not from this transfer. The step is
                          where this job ended; the cloud state is where the data is
                          right now, and a restore since then changes only the latter.
                        */}
                        {torrent ? (
                          <span className={`cloud-tag cloud-${torrent.cloudState.toLowerCase()}`}>
                            {cloudStateLabels[torrent.cloudState]}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        {/*
                          A torrent migrated more than once has one row per transfer,
                          which is correct — each is its own record. Without a time
                          they are indistinguishable, and two identical-looking rows
                          read as a duplicate rather than as a history.
                        */}
                        <span className="job-started">
                          {new Date(offload.createdAt).toLocaleString()}
                        </span>
                      </td>
                      <td>
                        {/*
                          A toggle, not a one-way open. The row the operator
                          clicked is where they look to undo it, and `aria-expanded`
                          already promises a control that goes both ways.
                        */}
                        <button
                          type="button"
                          className="inventory-inspect"
                          ref={(node) => registerRowToggle(offload.jobId, node)}
                          onClick={() =>
                            isSelected ? closeTimeline() : setSelectedJobId(offload.jobId)
                          }
                          aria-expanded={isSelected}
                        >
                          {isSelected ? '收起时间线' : '查看时间线'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {selected ? (
            <div className="transfers-detail">
              <JobTimeline snapshot={selected} onClose={closeTimeline} />
              {/*
                Placed with the timeline rather than in the row: deciding what to do
                about a stalled transfer means first reading how far it got and where
                it stopped, and a button in the table invites acting before looking.
              */}
              {/*
                Also closes through `closeTimeline`, so a cancel or a finished
                cleanup hands focus back to the row instead of dropping it on
                `<body>`. The row survives every one of these actions — a cancelled
                or cleaned-up transfer is still a record — so there is something to
                return to.
              */}
              <TransferActions snapshot={selected} onResolved={closeTimeline} />
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
