import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, ShieldAlert, TriangleAlert, X } from 'lucide-react';
import { useId, useState } from 'react';

import type { MediaCatalogEntry } from '@ptvault/contracts';

import { ApiError } from '../../api/client.js';
import {
  getRehydratePreview,
  mediaCatalogQueryKey,
  mediaPreviewQueryKey,
  mediaRehydratesQueryKey,
  startRehydrate,
} from './mediaApi.js';

export type RehydrateDialogProps = {
  entry: MediaCatalogEntry;
  onClose: () => void;
};

function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return '会话已过期，请重新登录。';
    if (error.status === 403) return '验证码不正确或已被使用，请用当前的新码重试。';
    if (error.status === 409) return '该种子已有回迁任务在进行，或本站运行在 SHADOW 模式。';
    return error.message;
  }
  return '发起回迁失败。';
}

/**
 * Confirms a restore, showing what it costs before it starts.
 *
 * The preview is the point: a restore writes the whole torrent back to the hot
 * disk, and the operator should see the resulting free space — and whether it eats
 * into the protected reserve — before committing, not after.
 */
export function RehydrateDialog({ entry, onClose }: RehydrateDialogProps) {
  const titleId = useId();
  const codeId = useId();
  const queryClient = useQueryClient();
  const [mfaCode, setMfaCode] = useState('');
  const [autoResume, setAutoResume] = useState(true);

  const previewQuery = useQuery({
    queryKey: mediaPreviewQueryKey(entry.totalBytes),
    queryFn: () => getRehydratePreview(entry.totalBytes),
  });

  const mutation = useMutation({
    mutationFn: () =>
      startRehydrate({
        instanceId: entry.instanceId,
        torrentHash: entry.torrentHash,
        autoResume,
        mfaCode,
      }),
    onSuccess: async () => {
      setMfaCode('');
      await queryClient.invalidateQueries({ queryKey: mediaRehydratesQueryKey });
      await queryClient.invalidateQueries({ queryKey: mediaCatalogQueryKey });
      onClose();
    },
  });

  const preview = previewQuery.data;
  const canSubmit =
    /^[0-9]{6}$/.test(mfaCode) && preview?.admissible === true && !mutation.isPending;

  return (
    <section className="preflight-panel" aria-labelledby={titleId}>
      <header className="preflight-header">
        <div>
          <h2 id={titleId}>回迁 {entry.name}</h2>
          <p className="preflight-identity">
            {formatBytes(entry.totalBytes)} · {entry.logicalPath}
          </p>
        </div>
        <button type="button" className="inventory-inspect" onClick={onClose} aria-label="关闭">
          <X size={15} strokeWidth={1.9} aria-hidden="true" />
        </button>
      </header>

      <p className="inline-message" role="note">
        <ShieldAlert size={14} strokeWidth={1.8} aria-hidden="true" />{' '}
        回迁会先把全部文件下载到临时目录、<strong>逐个校验 SHA-256</strong>，通过后才移入
        qB 的原位置；随后由 qB 复检到 100%，<strong>确认无误才恢复做种</strong>。
      </p>

      {previewQuery.isPending ? <p>正在计算所需空间…</p> : null}
      {previewQuery.isError ? (
        <p className="inline-message error-message" role="alert">
          <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" /> 无法计算所需空间。
        </p>
      ) : null}

      {preview ? (
        <dl className="recovery-facts">
          <div>
            <dt>需要空间</dt>
            <dd>{formatBytes(preview.requestedBytes)}</dd>
          </div>
          <div>
            <dt>当前可用</dt>
            <dd>{formatBytes(preview.availableBytes)}</dd>
          </div>
          <div>
            <dt>回迁后剩余</dt>
            <dd>{formatBytes(preview.freeBytesAfter)}</dd>
          </div>
          <div>
            <dt>磁盘保护线</dt>
            <dd>{formatBytes(preview.reserveBytes)}</dd>
          </div>
        </dl>
      ) : null}

      {preview && !preview.admissible ? (
        <p className="inline-message error-message" role="alert">
          <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" /> 空间不足，还差{' '}
          <strong>{formatBytes(preview.missingBytes)}</strong>。可以先取消固定一些缓存条目，
          或等正在进行的任务释放预留。
        </p>
      ) : null}

      {preview?.admissible && preview.wouldBreachReserve ? (
        <p className="inline-message" role="note">
          <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />{' '}
          这次回迁会占用到 15% 磁盘保护区。仍可继续，但之后新的回迁会被拒绝。
        </p>
      ) : null}

      <form
        className="instance-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) mutation.mutate();
        }}
      >
        <label className="instance-form-checkbox">
          <input
            type="checkbox"
            aria-label="回迁完成后自动恢复做种"
            checked={autoResume}
            onChange={(event) => setAutoResume(event.target.checked)}
          />
          <span>校验通过后自动恢复做种</span>
        </label>
        <p className="field-hint">
          取消勾选则只把文件放回本地、qB 保持暂停 —— 适合只想看一次、不打算重新做种的情况。
        </p>

        <label className="field" htmlFor={codeId}>
          <span>两步验证码</span>
          <input
            id={codeId}
            aria-label="两步验证码"
            type="text"
            value={mfaCode}
            onChange={(event) => setMfaCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
          />
        </label>

        {mutation.isError ? (
          <p className="inline-message error-message" role="alert">
            <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />{' '}
            {errorMessage(mutation.error)}
          </p>
        ) : null}

        <div className="instance-form-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary-action" disabled={!canSubmit}>
            {mutation.isPending ? '正在发起……' : '开始回迁'}
          </button>
        </div>
      </form>
    </section>
  );
}

/** Shown once a restore is queued, so the operator knows nothing else is needed. */
export function RehydrateQueuedNotice({ onDismiss }: { onDismiss: () => void }) {
  return (
    <p className="inline-message" role="status">
      <CircleCheck size={14} strokeWidth={1.8} aria-hidden="true" /> 回迁任务已排队，
      可在下方查看进度。
      <button type="button" onClick={onDismiss}>
        知道了
      </button>
    </p>
  );
}
