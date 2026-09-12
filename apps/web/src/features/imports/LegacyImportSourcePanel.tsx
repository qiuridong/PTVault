import type { ImportDetail } from '@ptvault/contracts';
import { CircleDashed, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useId } from 'react';
import { Link } from 'react-router-dom';

import type { ReadOnlyReason } from './ImportCreatePanel.js';
import { presentLegacySourceError } from './legacyImportSourceViewModel.js';
import { useLegacyImportSource } from './useLegacyImportSource.js';

const READ_ONLY_LABELS = {
  DEMO: '演示只读',
  SHADOW: '只读影子模式',
  FEATURE_DISABLED: '来源绑定写操作尚未启用',
};

export function LegacyImportSourcePanel({
  detail,
  readOnlyReason,
}: {
  detail: ImportDetail;
  readOnlyReason: ReadOnlyReason;
}) {
  const formId = useId();
  const model = useLegacyImportSource(detail, readOnlyReason);
  if (model.mode === 'NONE') return null;
  const queryError = model.bindingQuery.isError
    ? presentLegacySourceError(model.bindingQuery.error)
    : model.mode === 'SELECT' && model.connectionsQuery.isError
      ? presentLegacySourceError(model.connectionsQuery.error)
      : null;
  const error = model.error ?? queryError;

  return (
    <section className="import-detail-section legacy-source-panel" aria-label="旧任务来源身份">
      <h3>
        <ShieldCheck size={15} strokeWidth={1.9} aria-hidden="true" /> 旧任务来源身份
      </h3>
      {model.bindingQuery.isPending ? (
        <p className="route-status">
          <CircleDashed size={15} aria-hidden="true" /> 正在核对来源绑定…
        </p>
      ) : null}
      {model.bindingQuery.data?.supported === false ? (
        <p className="inline-message" role="note">
          这台 API 尚未提供旧任务来源身份接口；页面不推断绑定或选择默认账户。
        </p>
      ) : null}
      {error === null ? null : (
        <p className="inline-message error-message" role="alert">
          <TriangleAlert size={14} aria-hidden="true" /> {error.message}
        </p>
      )}
      {model.mode === 'VERIFIED' ? (
        <p className="inline-message" role="status">
          来源身份已核实；绑定本身不启动任务。请核对下方最新任务修订与动作，再明确点击服务端允许的失败重试或恢复。
        </p>
      ) : null}
      {model.mutationUnsupported ? (
        <p className="inline-message" role="note">
          来源身份写接口尚未提供；读取状态仍可用，本页不再提交绑定请求。
        </p>
      ) : null}
      {model.mode === 'REPLAN' ? (
        <>
          <p className="inline-message" role="note">
            需要重新规划：保留旧归档、回执与 checkpoint；不会删除或覆盖旧任务，也不会自动替换来源。
          </p>
          <Link className="ghost-button" to="/imports?view=create">
            保留旧任务并重新规划
          </Link>
        </>
      ) : null}
      {model.mode === 'INCONSISTENT' ? (
        <p className="inline-message" role="note">
          绑定状态与下一步指示不一致，请刷新核对；当前不开放身份修改。
        </p>
      ) : null}
      {model.mode === 'SELECT' && !model.mutationUnsupported ? (
        <form
          className="legacy-source-form"
          aria-label="旧任务来源绑定"
          onSubmit={(event) => {
            event.preventDefault();
            void model.submit();
          }}
        >
          <p className="field-hint">
            只核实原百度环境连接与历史完整清单。不按标签猜账户、不切换来源；确认绑定不创建队列或启动迁移。
          </p>
          {readOnlyReason === null ? null : (
            <p className="inline-message" role="note">
              {READ_ONLY_LABELS[readOnlyReason]}：可以核对状态，身份绑定保持禁用。
            </p>
          )}
          <div className="field">
            <label htmlFor={`${formId}-connection`}>原来源环境连接</label>
            <select
              id={`${formId}-connection`}
              value={model.selectedId}
              disabled={model.pending || model.replaying || model.connectionsQuery.isPending}
              onChange={(event) => model.selectConnection(event.target.value)}
            >
              <option value="">请选择原来源账户的环境连接…</option>
              {model.connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.label} · {connection.principalMasked}
                </option>
              ))}
            </select>
          </div>
          {model.connectionsQuery.isPending ? (
            <p className="route-status">正在读取可用环境连接…</p>
          ) : model.connections.length === 0 ? (
            <p className="inline-message" role="note">
              没有可用于核实的百度环境连接；请检查原环境连接的授权和服务端 BROWSE 能力。
            </p>
          ) : null}
          <dl className="instance-meta">
            <div>
              <dt>任务修订（服务端）</dt>
              <dd>{model.expectedRevision}</dd>
            </div>
            {model.selected === null ? null : (
              <>
                <div>
                  <dt>来源账户</dt>
                  <dd>{model.selected.principalMasked}</dd>
                </div>
                <div>
                  <dt>精确连接 ID</dt>
                  <dd>
                    <code>{model.selected.id}</code>
                  </dd>
                </div>
              </>
            )}
          </dl>
          <label className="instance-form-checkbox">
            <input
              type="checkbox"
              checked={model.replaying || model.confirmed}
              disabled={model.pending || model.replaying || model.selected === null}
              onChange={(event) => model.confirm(event.target.checked)}
            />
            <span>我确认所选连接仍属于原来源账户</span>
          </label>
          <div className="field">
            <label htmlFor={`${formId}-mfa`}>来源绑定动态验证码</label>
            <input
              id={`${formId}-mfa`}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={model.stepUpCode}
              disabled={model.pending}
              onChange={(event) =>
                model.setStepUpCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))
              }
            />
          </div>
          {model.replaying ? (
            <p className="field-hint">
              当前请求的连接、修订与确认已锁定；重试沿用同一幂等操作标识，不用新参数覆盖未确认的请求。
            </p>
          ) : null}
          <button type="submit" className="primary-button" disabled={!model.canSubmit}>
            {model.pending ? '正在核实…' : model.replaying ? '重试同一绑定请求' : '确认原来源身份'}
          </button>
        </form>
      ) : null}
      {model.mode === 'SELECT' || error?.authRequired ? (
        <Link to="/storage-accounts">查看原来源连接</Link>
      ) : null}
      <button
        type="button"
        className="ghost-button"
        disabled={model.pending}
        onClick={() => void model.refresh()}
      >
        刷新来源身份与任务
      </button>
    </section>
  );
}
