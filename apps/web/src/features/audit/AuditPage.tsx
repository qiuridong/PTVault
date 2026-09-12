import { useQuery } from '@tanstack/react-query';
import { CircleDashed, ScrollText, Search, TriangleAlert } from 'lucide-react';
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import type { AuditEvent, AuditOutcome } from '@ptvault/contracts';

import { ApiError } from '../../api/client.js';
import { ChipGroup, FilterBar, SegmentedTabs, type ChipOption } from '../../ui/FilterBar.js';
import { auditQueryKey, getAuditEvents } from './auditApi.js';
import { applyAuditFilters, parseSubject, type AuditGroup } from './auditFilters.js';

const LIMITS = [100, 500] as const;
const DEFAULT_LIMIT = 100;

/**
 * Chinese labels for the actions recorded today.
 *
 * A lookup with a fallback rather than an exhaustive map: an action shipped by a
 * newer API must still appear, as its raw code. Hiding an event because this
 * build predates it would defeat the point of an audit trail.
 */
const ACTION_LABELS: Record<string, string> = {
  AUTH_LOGIN: '登录',
  AUTH_MFA: '两步验证',
  AUTH_LOGOUT: '登出',
  SESSION_REVOKE: '撤销会话',
  RECOVERY_RECIPIENT_SET: '设置恢复收件人',
  RECOVERY_ESCROW_UPLOADED: '上传口令托管',
  RECOVERY_BUNDLE_GENERATED: '生成恢复包',
  RECOVERY_COMPUTER_CONFIRMED: '确认电脑已留存',
  RECOVERY_DRILL_ATTESTED: '口令演练通过',
  OFFLOAD_TRIGGER: '发起迁移',
  OFFLOAD_CANCELLED: '取消迁移',
  OFFLOAD_RETRIED: '重试迁移',
  OFFLOAD_CLEANUP: '删除本地副本',
  MEDIA_PIN_SET: '固定/取消固定',
  MEDIA_REHYDRATE_STARTED: '发起回迁',
  MEDIA_REHYDRATE_RETRIED: '重试回迁',
  MEDIA_REHYDRATE_CANCELLED: '取消回迁',
};

/**
 * The two actions worth spotting at a glance.
 *
 * Deleting the last local copy and pulling hundreds of gigabytes back down are
 * the entries an administrator scans this page for; everything else is context.
 */
const HIGHLIGHTED = new Set(['OFFLOAD_CLEANUP', 'MEDIA_REHYDRATE_STARTED']);

const OUTCOME_LABELS: Record<AuditOutcome, string> = {
  SUCCESS: '成功',
  DENIED: '被拒',
  ERROR: '出错',
};

const GROUP_LABELS: Record<AuditGroup, string> = {
  ALL: '全部',
  AUTH: '登录与会话',
  DATA: '迁移 · 删除 · 回迁',
  RECOVERY: '恢复材料',
  OTHER: '其它',
};

const GROUPS = Object.keys(GROUP_LABELS) as AuditGroup[];
const OUTCOMES = Object.keys(OUTCOME_LABELS) as AuditOutcome[];

const GROUP_OPTIONS: ReadonlyArray<ChipOption<AuditGroup>> = GROUPS.map((group) => ({
  value: group,
  label: GROUP_LABELS[group],
}));
const OUTCOME_OPTIONS: ReadonlyArray<ChipOption<AuditOutcome>> = OUTCOMES.map((outcome) => ({
  value: outcome,
  label: OUTCOME_LABELS[outcome],
}));

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

function formatTime(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status === 401 ? '会话已过期，请重新登录以查看审计记录。' : error.message;
  }
  return '无法加载审计记录。';
}

/** Renders `subject`, linking it to the torrent when it names one. */
function Subject({ subject }: { subject: string }) {
  const parsed = parseSubject(subject);
  if (parsed.kind === 'PLAIN') {
    return <code className="audit-subject">{parsed.value}</code>;
  }
  return (
    <Link className="audit-subject" to={`/torrents?q=${encodeURIComponent(parsed.hash)}`}>
      <span className="audit-subject-instance">{parsed.instanceId}</span>
      <code>{parsed.hash.slice(0, 12)}…</code>
    </Link>
  );
}

function DetailCell({ detail }: { detail: AuditEvent['detail'] }) {
  const keys = Object.keys(detail);
  if (keys.length === 0) return <span className="audit-detail-empty">—</span>;

  return (
    <details className="audit-detail">
      <summary>{keys.length} 个字段</summary>
      {/* Rendered as stored. It was redacted at write time by key name, and a
          second pass here would hide exactly what an administrator opened this
          page to read. */}
      <pre>{JSON.stringify(detail, null, 2)}</pre>
    </details>
  );
}

export function AuditPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const groupParam = searchParams.get('group')?.toUpperCase();
  const group: AuditGroup = GROUPS.includes(groupParam as AuditGroup)
    ? (groupParam as AuditGroup)
    : 'ALL';
  const outcomes = useMemo(() => {
    const raw = searchParams.get('outcome');
    if (!raw) return [] as AuditOutcome[];
    const accepted = new Set(OUTCOMES);
    return [
      ...new Set(
        raw
          .toUpperCase()
          .split(',')
          .filter((entry): entry is AuditOutcome => accepted.has(entry as AuditOutcome)),
      ),
    ];
  }, [searchParams]);
  const query = searchParams.get('q') ?? '';
  const limitParam = Number(searchParams.get('limit'));
  const limit = LIMITS.includes(limitParam as (typeof LIMITS)[number]) ? limitParam : DEFAULT_LIMIT;

  const update = (updates: Record<string, string | null>): void => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    setSearchParams(next, { replace: true });
  };

  const toggleOutcome = (outcome: AuditOutcome): void => {
    const next = outcomes.includes(outcome)
      ? outcomes.filter((value) => value !== outcome)
      : [...outcomes, outcome];
    update({ outcome: next.length === 0 ? null : next.join(',') });
  };

  const auditQuery = useQuery({
    queryKey: auditQueryKey(limit),
    queryFn: () => getAuditEvents(limit),
  });

  const events = useMemo(() => auditQuery.data ?? [], [auditQuery.data]);
  const filtered = useMemo(
    () => applyAuditFilters(events, { group, outcomes, query }),
    [events, group, outcomes, query],
  );

  return (
    <section className="content-page" aria-labelledby="audit-title">
      <header className="page-header">
        <div>
          <p className="page-kicker">运维</p>
          <h1 id="audit-title">审计</h1>
          <p className="page-lede">
            按时间倒序的操作记录，写入时已按键名脱敏。删除本地副本与发起回迁这两类在行首带标记，方便一眼扫到。
          </p>
        </div>
        <span className="connection-state" title="审计记录只读，且写入时已按键名脱敏">
          <ScrollText size={15} strokeWidth={1.8} aria-hidden="true" />
          只读记录
        </span>
      </header>

      <FilterBar
        label="审计筛选"
        views={
          <SegmentedTabs
            label="动作"
            options={GROUP_OPTIONS}
            value={group}
            onSelect={(entry) => update({ group: entry === 'ALL' ? null : entry })}
          />
        }
        meta={
          <p className="inventory-count" aria-live="polite">
            {auditQuery.isSuccess ? `筛出 ${filtered.length} / 读取 ${events.length}` : ''}
          </p>
        }
        tokens={outcomes.map((outcome) => ({
          key: `outcome:${outcome}`,
          group: '结果',
          label: OUTCOME_LABELS[outcome],
          onRemove: () => toggleOutcome(outcome),
        }))}
        onClear={
          query !== '' || group !== 'ALL' || outcomes.length > 0
            ? () => update({ q: null, group: null, outcome: null })
            : undefined
        }
        note="筛选只作用于已读取的这一批记录；要看更早的，先把条数调大。"
        panel={
          <ChipGroup
            label="结果"
            options={OUTCOME_OPTIONS}
            selected={outcomes}
            onToggle={toggleOutcome}
          />
        }
      >
        <label className="inventory-search">
          <Search size={15} strokeWidth={1.8} aria-hidden="true" />
          <span className="visually-hidden">搜索审计记录</span>
          <input
            type="search"
            value={query}
            placeholder="搜索对象、动作或来源 IP"
            onChange={(event) => update({ q: event.target.value })}
          />
        </label>
        <label className="inventory-filter">
          <span>条数</span>
          <select
            aria-label="读取条数"
            value={limit}
            onChange={(event) =>
              update({
                limit: event.target.value === String(DEFAULT_LIMIT) ? null : event.target.value,
              })
            }
          >
            {LIMITS.map((value) => (
              <option key={value} value={value}>
                最近 {value}
              </option>
            ))}
          </select>
        </label>
      </FilterBar>

      {auditQuery.isPending ? (
        <div className="route-status">
          <CircleDashed size={16} strokeWidth={1.8} aria-hidden="true" />
          正在加载审计记录…
        </div>
      ) : auditQuery.isError ? (
        <div className="route-status route-status-error" role="alert">
          <TriangleAlert size={16} strokeWidth={1.8} aria-hidden="true" />
          {errorMessage(auditQuery.error)}
        </div>
      ) : events.length === 0 ? (
        <div className="neutral-empty-state">
          <p>还没有任何审计记录。</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="neutral-empty-state">
          <p>没有符合筛选条件的记录。</p>
        </div>
      ) : (
        <div className="inventory-table-wrap">
          <table className="inventory-table">
            <caption className="visually-hidden">按时间倒序的审计记录</caption>
            <thead>
              <tr>
                <th scope="col">时间</th>
                <th scope="col">动作</th>
                <th scope="col">对象</th>
                <th scope="col">结果</th>
                <th scope="col">来源 IP</th>
                <th scope="col">详情</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((entry) => (
                <tr
                  key={entry.id}
                  className={HIGHLIGHTED.has(entry.action) ? 'audit-row-highlight' : undefined}
                >
                  <td className="audit-time">{formatTime(entry.createdAt)}</td>
                  <td>{actionLabel(entry.action)}</td>
                  <td>
                    <Subject subject={entry.subject} />
                  </td>
                  <td>
                    <span className={`audit-outcome audit-outcome-${entry.outcome.toLowerCase()}`}>
                      {OUTCOME_LABELS[entry.outcome]}
                    </span>
                  </td>
                  <td>
                    <code>{entry.sourceIp}</code>
                  </td>
                  <td>
                    <DetailCell detail={entry.detail} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
