import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleDashed, Lock, LockOpen, TriangleAlert } from 'lucide-react';

import type { RecoveryStatus, RecoveryReadinessProblem } from '@ptvault/contracts';

import { ApiError } from '../../api/client.js';
import { RecoverySetup } from './RecoverySetup.js';
import { RecoveryDownloads } from './RecoveryDownloads.js';
import { getRecoveryStatus, recoveryStatusQueryKey } from './recoveryApi.js';

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status === 401 ? '会话已过期，请重新登录以查看恢复就绪状态。' : error.message;
  }
  return '无法加载恢复状态。';
}

/**
 * Each precondition the deletion gate enforces, rendered as a checklist so the
 * operator can see exactly why local cleanup is locked or unlocked.
 */
function checklist(status: RecoveryStatus): Array<{ label: string; met: boolean; detail: string }> {
  const hasTwoCopies = status.cloudCopyAccountIds.length >= 2;
  return [
    {
      label: '恢复收件人已配置',
      met: status.publicRecipientConfigured,
      detail: status.publicRecipientConfigured
        ? '已登记 age 公钥收件人。'
        : '尚未登记 age 公钥收件人。',
    },
    {
      label: '恢复包电脑确认',
      met: status.computerDownloadConfirmedAt !== null,
      detail:
        status.computerDownloadConfirmedAt !== null
          ? '已在你的电脑上确认下载并校验恢复包。'
          : '等待在你的电脑上确认已下载并校验恢复包。',
    },
    {
      label: '口令演练已验证',
      met: status.escrowVerifiedAt !== null,
      detail:
        status.escrowVerifiedAt !== null
          ? '已用口令短语解密 escrow 中的 crypt 口令并完成演练。'
          : '等待用恢复口令解密 escrow 演练。',
    },
    {
      label: '≥2 份不同云端副本',
      met: hasTwoCopies,
      detail: `当前 ${status.cloudCopyAccountIds.length} 份托管副本（需要 2 份不同账户）。`,
    },
  ];
}

export function RecoveryPage() {
  const statusQuery = useQuery({
    queryKey: recoveryStatusQueryKey,
    queryFn: getRecoveryStatus,
  });
  const deletionUnlocked = statusQuery.data?.deletionUnlocked ?? false;

  return (
    <section className="content-page" aria-labelledby="recovery-title">
      <header className="page-header">
        <div>
          <p className="page-kicker">恢复</p>
          <h1 id="recovery-title">恢复就绪状态</h1>
          <p className="page-lede">
            这一页显示所选人工基线的准备情况与当前密钥材料状态。自动业务快照持续生成，但不会替换你已经准备好的人工基线；每个任务仍须通过独立的数据校验。
          </p>
        </div>
        {/*
          Reflects the deletion gate, not the process mode. This page's own forms
          work in SHADOW by design — they build the material that upload requires
          — so a blanket "read-only" badge here would be false. The wording differs
          from the gate panel below on purpose: two elements saying the identical
          sentence would make the page read as if it were stuttering.
        */}
        <span
          className="connection-state"
          title={deletionUnlocked ? '恢复条件已满足' : '恢复条件未满足前本地清理保持锁定'}
        >
          {deletionUnlocked ? (
            <LockOpen size={15} strokeWidth={1.8} aria-hidden="true" />
          ) : (
            <Lock size={15} strokeWidth={1.8} aria-hidden="true" />
          )}
          {deletionUnlocked ? '恢复材料就绪' : '恢复材料未完成'}
        </span>
      </header>

      {statusQuery.isPending ? (
        <div className="route-status">
          <CircleDashed size={16} strokeWidth={1.8} aria-hidden="true" />
          正在加载恢复状态…
        </div>
      ) : statusQuery.isError ? (
        <div className="route-status route-status-error" role="alert">
          <TriangleAlert size={16} strokeWidth={1.8} aria-hidden="true" />
          {errorMessage(statusQuery.error)}
        </div>
      ) : (
        <>
          <RecoveryReadiness status={statusQuery.data} />
          <RecoveryDownloads currentVersion={statusQuery.data.version} />
          <RecoverySetup status={statusQuery.data} />
        </>
      )}
    </section>
  );
}

function RecoveryReadiness({ status }: { status: RecoveryStatus }) {
  const items = checklist(status);
  return (
    <div className="recovery-layout">
      <div
        className={`recovery-gate recovery-gate-${status.deletionUnlocked ? 'unlocked' : 'locked'}`}
        role="status"
      >
        {status.deletionUnlocked ? (
          <LockOpen size={18} strokeWidth={1.8} aria-hidden="true" />
        ) : (
          <Lock size={18} strokeWidth={1.8} aria-hidden="true" />
        )}
        <div>
          <strong>{status.deletionUnlocked ? '本地清理已解锁' : '本地清理已锁定'}</strong>
          <p>
            {status.deletionUnlocked
              ? '全部恢复前置条件已满足，本地清理按钮可用。'
              : '任一前置条件未满足前，本地清理保持锁定——绝不会删除唯一未验证副本。'}
          </p>
        </div>
      </div>

      {status.readinessProblems && status.readinessProblems.length > 0 ? (
        <ul className="recovery-checklist" aria-label="当前锁定原因">
          {status.readinessProblems.map((problem) => (
            <li key={problem} className="recovery-check">
              <TriangleAlert size={16} aria-hidden="true" />
              <span>{readinessProblemText[problem]}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <ul className="recovery-checklist">
        {items.map((item) => (
          <li
            key={item.label}
            className={`recovery-check${item.met ? ' is-met' : ''}`}
            data-met={item.met}
          >
            {item.met ? (
              <CircleCheck size={16} strokeWidth={1.9} aria-hidden="true" />
            ) : (
              <CircleDashed size={16} strokeWidth={1.9} aria-hidden="true" />
            )}
            <span className="recovery-check-label">{item.label}</span>
            <span className="recovery-check-detail">{item.detail}</span>
          </li>
        ))}
      </ul>

      <dl className="recovery-facts">
        <div>
          <dt>当前人工准备基线</dt>
          <dd>{status.version === null ? '尚未选择' : `v${status.version}`}</dd>
        </div>
        <div>
          <dt>最新业务快照</dt>
          <dd>
            {(status.latestSnapshotVersion ?? status.version) === null
              ? '尚未生成'
              : `v${status.latestSnapshotVersion ?? status.version}`}
          </dd>
        </div>
        <div>
          <dt>云端托管副本账户</dt>
          <dd>
            {status.cloudCopyAccountIds.length > 0
              ? `${status.cloudCopyAccountIds.length} 个账户`
              : '无'}
          </dd>
        </div>
      </dl>
    </div>
  );
}

const readinessProblemText: Record<RecoveryReadinessProblem, string> = {
  NO_BASELINE: '尚未明确选择人工准备基线。',
  RECIPIENT_CHANGED: '当前 age 收件人与所选基线不一致。',
  GENERATION_CHANGED: '密钥代次已改变，旧基线的个人准备证明不再代表当前密钥。',
  ESCROW_UNAVAILABLE: '当前 escrow 缺席、不安全或未完成登记，请核对原始加密文件。',
  ESCROW_CHANGED: '当前 escrow 的实际摘要与登记身份或所选基线不一致。',
  MATERIAL_UPDATE_IN_PROGRESS: '恢复材料正在更换或使用，暂不发放清理许可。',
  MATERIAL_UNRESOLVED: '材料更换尚未完成一致性恢复，保持锁定。',
  COMPUTER_NOT_CONFIRMED: '所选基线尚未完成对应恢复包的电脑保存确认。',
  DRILL_NOT_CONFIRMED: '所选基线尚未完成对应 escrow 的口令演练。',
  CLOUD_COPY_QUORUM: '所选基线不足两份摘要一致且账户健康的已验证云副本。',
  STATE_CHANGED: '读取期间准备身份发生变化，请刷新后重新核对。',
  COMPATIBILITY_READ_ONLY: '当前为兼容回滚只读模式，不发放删除许可。',
};
