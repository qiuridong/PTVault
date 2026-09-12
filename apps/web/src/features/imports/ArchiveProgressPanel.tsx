import type { ArchiveJobStatus, ArchivePlanSummary } from '@ptvault/contracts';
import { formatDecimalBytes } from './importFormatting.js';
export const ARCHIVE_PHASE_LABELS: Record<ArchiveJobStatus['phase'], string> = {
  PENDING: '等待解压准备',
  DOWNLOADING_INPUTS: '下载全部压缩分卷',
  EXTRACTING: '逐层尝试密码并解压',
  WAITING_PASSWORD: '等待补充候选密码',
  PREPARING_VIDEOS: '校验与准备视频',
  READY: '视频已准备，后续上传与校验见任务进度',
  CLEANED: '原始分卷暂存已清理',
};
export function ArchiveProgressPanel({ status }: { status: ArchiveJobStatus }) {
  return (
    <section className="import-plan" aria-label="解压处理进度">
      <h3>{ARCHIVE_PHASE_LABELS[status.phase]}</h3>
      <dl className="import-plan-figures">
        <div>
          <dt>原始分卷下载</dt>
          <dd>
            {formatDecimalBytes(status.inputBytesDone)} / {formatDecimalBytes(status.inputBytes)} ·{' '}
            {status.inputCount} 文件
          </dd>
        </div>
        <div>
          <dt>解压层次</dt>
          <dd>
            当前 {status.depth} / 最多 {status.maxDepth} 层 · 已解开 {status.archiveCount} 包
          </dd>
        </div>
        <div>
          <dt>累计展开字节</dt>
          <dd>
            {formatDecimalBytes(status.expandedBytes)} /{' '}
            {formatDecimalBytes(status.maxExpandedBytes)}
          </dd>
        </div>
        <div>
          <dt>本包密码尝试</dt>
          <dd>
            {status.candidateIndex === null
              ? '—'
              : status.candidateIndex === 0
                ? '无密码'
                : `候选 ${status.candidateIndex} / ${status.candidateCount}`}
          </dd>
        </div>
        <div>
          <dt>视频结果</dt>
          <dd>
            {status.videoCount} 个 · {formatDecimalBytes(status.videoBytes)}
          </dd>
        </div>
      </dl>
      <p className="field-hint">分卷下载数字是处理记录，不代表这些字节当前仍保留在磁盘；重试代价以操作区的检查点估算为准。</p>
      {status.lastErrorCode === null ? null : (
        <p role="status">
          处理状态码：<code>{status.lastErrorCode}</code>
        </p>
      )}
      <p className="field-hint">每个压缩分支都处理完成后才上传视频；百度原压缩分卷始终保留。</p>
    </section>
  );
}
export function ArchivePlanPanel({ plan }: { plan: ArchivePlanSummary }) {
  return (
    <section aria-label="解压计划">
      <h4>递归解压视频 · 百度原件保留</h4>
      <p>
        {plan.inputCount} 个输入文件，{plan.candidateCount} 个候选密码；每层分别尝试，最多{' '}
        {plan.maxDepth} 层。视频数量和上传字节需实际解压后确认。
      </p>
      <p>
        VPS 预留：{formatDecimalBytes(plan.requiredSpoolBytes)}（完整输入 +{' '}
        {formatDecimalBytes(plan.maxExpandedBytes)} 累计展开上限，含中间压缩包）。
      </p>
      <details>
        <summary>查看分卷分组（同组完整到齐后解压）</summary>
        <ul>
          {plan.groups.map((group) => (
            <li key={group.entry}>
              <code style={{ overflowWrap: 'anywhere' }}>{group.entry}</code> ·{' '}
              {group.members.length} 文件{group.kind === 'SINGLE' ? '' : '（分卷）'}
            </li>
          ))}
        </ul>
        {plan.groupsTruncated ? <p>仅显示前 500 组。</p> : null}
      </details>
    </section>
  );
}
