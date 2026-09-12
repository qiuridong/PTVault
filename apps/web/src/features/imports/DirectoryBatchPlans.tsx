import { useEffect, useRef, useState } from 'react';
import type { ArchivePlanRequest, ImportPlan } from '@ptvault/contracts';
import { ApiError } from '../../api/client.js';
import { runDirectoryBatch } from './directoryBatch.js';
import { verifyDirectoryPlanIdentity } from './directoryPlanIdentity.js';
import { directorySubmissionKey, type DirectorySubmissions } from './directorySubmissions.js';
import { importErrorMessage, planImport } from './importApi.js';
import { formatDecimalBytes } from './importFormatting.js';
import { sourceDirectoryKey, type SourceDirectory } from './sourceSelection.js';

type Props = {
  takeArchiveRequest?: () => ArchivePlanRequest | undefined;
  archiveRevision?: number;
  grouped?: boolean;
  directories: readonly SourceDirectory[];
  destinationId: string;
  availableBytes?: string | null | undefined;
  onUsePlan: (source: SourceDirectory, plan: ImportPlan) => void;
  createdPlanIds: readonly string[];
  submissions?: DirectorySubmissions;
  disabled: boolean;
};
type Row = {
  source: SourceDirectory;
  status: 'IDLE' | 'PLANNING' | 'READY' | 'FAILED';
  plan?: ImportPlan;
  error?: string;
};

export function DirectoryBatchPlans(props: Props) {
  return (
    <BatchSession
      key={JSON.stringify([
        props.destinationId,
        props.directories,
        props.archiveRevision ?? 0,
        props.grouped ?? false,
      ])}
      {...props}
    />
  );
}

function BatchSession({
  takeArchiveRequest,
  grouped,
  directories,
  destinationId,
  availableBytes,
  onUsePlan,
  createdPlanIds,
  submissions = {},
  disabled,
}: Props) {
  const [rows, setRows] = useState<Row[]>(() =>
    directories.map((source) => {
      const record = submissions[directorySubmissionKey(source, destinationId)];
      return record === undefined
        ? { source, status: 'IDLE' }
        : { source, status: 'READY', plan: record.plan };
    }),
  );
  const [pending, setPending] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [now, setNow] = useState(Date.now);
  const generation = useRef(0);
  const running = useRef(false);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(timer);
      generation.current++;
    };
  }, []);
  const patch = (source: SourceDirectory, next: Row) =>
    setRows((current) =>
      current.map((row) =>
        sourceDirectoryKey(row.source) === sourceDirectoryKey(source) ? next : row,
      ),
    );
  const start = async (failedOnly = false): Promise<void> => {
    if (running.current || disabled || destinationId === '') return;
    const targets = rows
      .filter((row) => submissions[directorySubmissionKey(row.source, destinationId)] === undefined)
      .filter((row) => row.plan === undefined || !createdPlanIds.includes(row.plan.planId))
      .filter((row) =>
        failedOnly
          ? row.status === 'FAILED'
          : row.status !== 'READY' || Date.parse(row.plan!.expiresAt) <= Date.now(),
      )
      .map((row) => row.source);
    if (targets.length === 0) return;
    const archive = takeArchiveRequest?.();
    const revision = ++generation.current;
    running.current = true;
    setPending(true);
    setStopped(false);
    try {
      await runDirectoryBatch({
        directories: targets,
        isCurrent: () => revision === generation.current,
        onStarted: (source) => patch(source, { source, status: 'PLANNING' }),
        execute: async (source) => {
          const answer = await planImport({
            sourceKind: 'BAIDU_APP_DIR',
            ...(archive === undefined ? {} : { archive }),
            ...(grouped && archive !== undefined ? { grouped: true } : {}),
            sourceConnectionId: source.connectionId,
            sourcePath: source.path,
            expectedSourceRootFsid: source.fsid,
            destinationId,
            credential: { kind: 'NONE' },
          });
          if (!answer.supported) throw new Error('DIRECTORY_PLAN_API_UNAVAILABLE');
          verifyDirectoryPlanIdentity(source, destinationId, answer.data);
          return answer.data;
        },
        onSettled: (result) => {
          if (result.status === 'SUCCEEDED')
            patch(result.source, { source: result.source, status: 'READY', plan: result.value });
          else if (result.status === 'FAILED') {
            const cause = result.error;
            const error =
              cause instanceof Error && cause.message === 'DIRECTORY_PLAN_IDENTITY_UNVERIFIED'
                ? '服务端未确认所选目录身份；请升级API或重新浏览选择。'
                : cause instanceof Error && cause.message === 'DIRECTORY_PLAN_API_UNAVAILABLE'
                  ? '这个API还未提供目录计划接口。'
                  : cause instanceof ApiError && cause.code === 'SOURCE_CHANGED'
                    ? '目录身份已变化，请重新浏览并选择。'
                    : importErrorMessage(cause);
            patch(result.source, { source: result.source, status: 'FAILED', error });
          }
        },
      });
    } finally {
      if (revision === generation.current) {
        running.current = false;
        setPending(false);
      }
    }
  };
  const ready = rows.filter(
    (row): row is Row & { plan: ImportPlan } => row.status === 'READY' && row.plan !== undefined,
  );
  const totalBytes = ready.reduce((sum, row) => sum + BigInt(row.plan.totalBytes), 0n);
  const objectCount = ready.reduce((sum, row) => sum + row.plan.objectCount, 0);
  const isCreated = (row: Row & { plan: ImportPlan }) =>
    submissions[directorySubmissionKey(row.source, destinationId)]?.status === 'CREATED' ||
    createdPlanIds.includes(row.plan.planId);
  const remainingBytes = ready
    .filter((row) => !isCreated(row) && Date.parse(row.plan.expiresAt) > now)
    .reduce((sum, row) => sum + BigInt(row.plan.totalBytes), 0n);
  const overCapacity =
    !grouped && availableBytes != null && remainingBytes > BigInt(availableBytes);
  const failed = rows.some((row) => row.status === 'FAILED');
  const canPlan = rows
    .filter((row) => submissions[directorySubmissionKey(row.source, destinationId)] === undefined)
    .some(
      (row) =>
        row.status !== 'READY' ||
        (row.plan !== undefined &&
          !createdPlanIds.includes(row.plan.planId) &&
          Date.parse(row.plan.expiresAt) <= now),
    );
  return (
    <section className="import-plan" aria-label="多目录独立计划">
      <h4>每个目录独立计划、独立任务</h4>
      <p className="field-hint">
        最多20个目录，同一页面最多2个计划请求。勾选不扫描；只有点击生成计划才读取各目录清单。任务创建不是原子批次，成功项不会随失败项重复创建。
      </p>
      <div className="baidu-browser-actions">
        <button
          type="button"
          className="ghost-button"
          disabled={disabled || pending || destinationId === '' || !canPlan}
          onClick={() => void start()}
        >
          生成目录独立计划
        </button>
        <button
          type="button"
          className="ghost-button"
          disabled={disabled || pending || !failed}
          onClick={() => void start(true)}
        >
          重试失败目录
        </button>
        {pending ? (
          <button
            type="button"
            className="ghost-button"
            onClick={() => {
              generation.current++;
              running.current = false;
              setPending(false);
              setStopped(true);
              setRows((current) =>
                current.map((row) =>
                  row.status === 'PLANNING'
                    ? {
                        source: row.source,
                        status: 'FAILED',
                        error: '已停止等待；已发送请求仍在结束，名额释放前不会重发。',
                      }
                    : row,
                ),
              );
            }}
          >
            停止等待本批结果
          </button>
        ) : null}
      </div>
      <p role="status">
        计划成功 {ready.length} / {directories.length}
      </p>
      {pending ? (
        <p role="status">本批正在读取或等待请求名额；本页旧请求结束前不会超额重发。</p>
      ) : null}
      <p className="field-hint">
        已成功计划合计：{objectCount} 个文件 · {formatDecimalBytes(totalBytes.toString())}
        。只有全部计划成功才代表完整批次汇总；容量和路径最终仍由服务端逐任务检查。
      </p>
      {grouped ? (
        <p className="field-hint">
          这里汇总的是来源输入，不是实际云端输出或同时驻盘量。每个目录创建一个分组流水线，空间由全局预算统一准入。
        </p>
      ) : null}
      {overCapacity ? (
        <p role="alert">
          本批尚未创建的有效计划合计超过当前报告的目标可用容量，请减少选择或更换目标。
        </p>
      ) : null}
      {availableBytes == null ? (
        <p className="field-hint">目标未报告可用容量，不能据此认定容量充足。</p>
      ) : null}
      {stopped ? (
        <p role="status">
          仅停止接收旧结果，不代表服务端扫描已取消；实际请求结束前仍占用本页并发名额。
        </p>
      ) : null}
      <ul className="import-blockers">
        {rows.map((row) => {
          const plan = row.plan;
          const submission = submissions[directorySubmissionKey(row.source, destinationId)];
          const created =
            submission?.status === 'CREATED' ||
            (plan !== undefined && createdPlanIds.includes(plan.planId));
          const expired = plan !== undefined && Date.parse(plan.expiresAt) <= now;
          const blocked =
            plan === undefined ||
            expired ||
            plan.mode !== 'ACTIVE' ||
            plan.sourceAuthState !== 'AUTHORIZED' ||
            (plan.pipeline === undefined &&
              (plan.pathConflicts.length > 0 || plan.destinationLimitIssues.length > 0));
          return (
            <li key={sourceDirectoryKey(row.source)}>
              <code style={{ overflowWrap: 'anywhere' }}>{row.source.path}</code>
              {created ? (
                <strong>任务已创建</strong>
              ) : row.status === 'PLANNING' ? (
                <span>正在读取来源清单…</span>
              ) : row.status === 'IDLE' ? (
                <span>等待生成计划</span>
              ) : null}
              {row.error ? <p role="alert">{row.error}</p> : null}
              {plan === undefined ? null : (
                <>
                  <p>
                    {plan.objectCount} 个文件 · {formatDecimalBytes(plan.totalBytes)} ·
                    {plan.pipeline ? '单组预估峰值 ' : '单任务落盘峰值 '}
                    {formatDecimalBytes(plan.requiredSpoolBytes)} · 路径冲突{' '}
                    {plan.pathConflicts.length} · 限制项 {plan.destinationLimitIssues.length}
                  </p>
                  {expired && !created ? <p>计划已过期，请重新生成。</p> : null}
                  {created ? null : (
                    <button
                      type="button"
                      className="ghost-button"
                      aria-label={`查看目录计划 ${row.source.path}`}
                      disabled={disabled || pending || overCapacity || blocked}
                      onClick={() => onUsePlan(row.source, plan)}
                    >
                      查看并确认此目录计划
                    </button>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
