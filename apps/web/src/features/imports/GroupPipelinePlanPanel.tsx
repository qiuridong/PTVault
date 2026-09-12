import { useState } from 'react';
import type { ImportPipelinePlan } from '@ptvault/contracts';
import { formatDecimalBytes } from './importFormatting.js';

export function GroupPipelinePlanPanel({ plan }: { plan: ImportPipelinePlan }) {
  const [offset, setOffset] = useState(0);
  return (
    <section className="group-plan-panel" aria-label="分组流水线预检">
      <h4>分组流水线 · {plan.groupCount} 组</h4>
      <p>
        {plan.executableCount} 组可执行 · {plan.attentionCount} 组待处理 · 已接收{' '}
        {plan.candidateCount} 个候选密码
      </p>
      <p className="field-hint">
        不需要将整个目录同时下载到
        VPS。按组预留空间，下载、解压、上传可以交叠；缺卷、密码或单组超限不会阻塞其他可执行组。来源固定保留。
      </p>
      <dl className="import-plan-figures">
        <div>
          <dt>单组最大预估峰值</dt>
          <dd>{formatDecimalBytes(plan.largestGroupBytes)}</dd>
        </div>
        <div>
          <dt>全局可用暂存预算</dt>
          <dd>{formatDecimalBytes(plan.options.residentMaxBytes)}</dd>
        </div>
        <div>
          <dt>单组累计展开上限</dt>
          <dd>{formatDecimalBytes(plan.options.processing.maxExpandedBytes)}</dd>
        </div>
        <div>
          <dt>等待输入缓存预算</dt>
          <dd>{formatDecimalBytes(plan.options.waitingCacheMaxBytes)}</dd>
        </div>
      </dl>
      <p className="field-hint">
        峰值 = 该组输入 +
        单组累计展开上限。总上传量需解压并检查视频后确定，云端配额仍逐组核验。已产生的唯一视频输出保留到双回读和恢复材料验证完成。
      </p>
      <div
        key={offset}
        className="group-bounded-list"
        role="region"
        aria-label="分组预检明细"
        tabIndex={0}
      >
        <ul className="import-blockers">
          {plan.groups.slice(offset, offset + 20).map((group) => (
            <li key={group.key} data-testid="group-plan-row">
              <strong>{group.entry}</strong>
              <p>
                {group.members.length} 个输入 · {formatDecimalBytes(group.inputBytes)} · 预估峰值{' '}
                {formatDecimalBytes(group.requiredSpoolBytes)}
              </p>
              <span>
                {group.issue === 'ARCHIVE_VOLUME_SET_INVALID'
                  ? '分卷不完整，等待处理；不下载残缺组'
                  : group.issue === 'GROUP_EXCEEDS_RESIDENT_BUDGET'
                    ? '超出暂存预算，先等待；提高预算后可准入'
                    : '可排队执行'}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="baidu-browser-actions">
        <button
          type="button"
          className="ghost-button"
          disabled={offset === 0}
          aria-label="上一页分组预览"
          onClick={() => setOffset(Math.max(0, offset - 20))}
        >
          上一页
        </button>
        <span aria-live="polite">
          第 {offset + 1}–{Math.min(offset + 20, plan.groups.length)} 组 / 预览 {plan.groups.length}{' '}
          组
        </span>
        <button
          type="button"
          className="ghost-button"
          disabled={offset + 20 >= plan.groups.length}
          aria-label="下一页分组预览"
          onClick={() => setOffset(offset + 20)}
        >
          下一页
        </button>
      </div>
      {plan.groupsTruncated ? (
        <p className="field-hint">
          预检最多预览前 500 组；创建后可逐页查看全部分组。单个目录最多 10,000 组。
        </p>
      ) : null}
    </section>
  );
}
