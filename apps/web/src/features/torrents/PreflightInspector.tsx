import { useQuery } from '@tanstack/react-query';
import { CircleDashed, ShieldCheck, ShieldAlert, TriangleAlert, X } from 'lucide-react';

import type { PreflightIssue } from '@ptvault/contracts';

import { ApiError } from '../../api/client.js';
import { getPreflight, qbPreflightQueryKey } from './qbApi.js';

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status === 401 ? '会话已过期，请重新登录以运行预检。' : error.message;
  }
  return '无法完成预检。';
}

type PreflightInspectorProps = {
  instanceId: string;
  hash: string;
  onClose: () => void;
};

export function PreflightInspector({ instanceId, hash, onClose }: PreflightInspectorProps) {
  const preflightQuery = useQuery({
    queryKey: qbPreflightQueryKey(instanceId, hash),
    queryFn: () => getPreflight(instanceId, hash),
  });

  return (
    <aside className="preflight-panel" aria-labelledby="preflight-title">
      <header className="preflight-header">
        <div>
          <h2 id="preflight-title">迁移预检</h2>
          <p className="preflight-identity">
            {instanceId} · {hash.slice(0, 12)}…
          </p>
        </div>
        <button type="button" className="inventory-inspect" onClick={onClose} aria-label="关闭">
          <X size={15} strokeWidth={1.9} aria-hidden="true" />
        </button>
      </header>

      {preflightQuery.isPending ? (
        <p className="preflight-status">
          <CircleDashed size={14} strokeWidth={1.8} aria-hidden="true" />
          正在预检…
        </p>
      ) : preflightQuery.isError ? (
        <p className="preflight-status preflight-status-error" role="alert">
          <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
          {errorMessage(preflightQuery.error)}
        </p>
      ) : (
        <div className="preflight-body">
          <p
            className={`preflight-verdict ${
              preflightQuery.data.eligible ? 'is-eligible' : 'is-blocked'
            }`}
          >
            {preflightQuery.data.eligible ? (
              <>
                <ShieldCheck size={16} strokeWidth={1.8} aria-hidden="true" />
                可迁移
              </>
            ) : (
              <>
                <ShieldAlert size={16} strokeWidth={1.8} aria-hidden="true" />
                受阻
              </>
            )}
          </p>

          <dl className="preflight-metrics">
            <div>
              <dt>逻辑大小</dt>
              <dd>{formatBytes(preflightQuery.data.logicalBytes)}</dd>
            </div>
            <div>
              <dt>已分配</dt>
              <dd>{formatBytes(preflightQuery.data.allocatedBytes)}</dd>
            </div>
            <div>
              <dt>可回收</dt>
              <dd>{formatBytes(preflightQuery.data.reclaimableBytes)}</dd>
            </div>
          </dl>

          {preflightQuery.data.issues.length > 0 ? (
            <ul className="preflight-issues">
              {preflightQuery.data.issues.map((issue: PreflightIssue, index: number) => (
                <li
                  key={`${issue.code}:${index}`}
                  className={issue.blocking ? 'is-blocking' : 'is-warning'}
                >
                  <strong>{issue.code}</strong>
                  {issue.path ? <span className="issue-path"> {issue.path}</span> : null}
                  <span className="issue-message"> {issue.message}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="preflight-detail">未检出阻塞性问题。</p>
          )}
        </div>
      )}
    </aside>
  );
}
