import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pin, PinOff, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';

import type { MediaCatalogEntry } from '@ptvault/contracts';

import { ApiError } from '../../api/client.js';
import { mediaCatalogQueryKey, setPin } from './mediaApi.js';

export type PinDialogProps = {
  entry: MediaCatalogEntry;
  onClose: () => void;
};

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return '会话已过期，请重新登录。';
    if (error.status === 403) return '验证码不正确或已被使用，请用当前的新码重试。';
    if (error.status === 409) return '本站运行在 SHADOW 模式，固定不会生效。';
    return error.message;
  }
  return '修改固定状态失败。';
}

/**
 * Pins or unpins one title against cache eviction.
 *
 * This is the one thing rclone's own cache cleaner cannot decide. It evicts by
 * least-recently-used and skips whatever is open, which handles "clean up after
 * watching" on its own; what it has no way to know is that the operator wants a
 * particular title kept regardless of how long ago it was last read. The pin is
 * that statement, and until now it had no way into the UI at all — the restore
 * dialog even tells the operator to "unpin some cache entries" when space is
 * short, against a screen that offered no way to do it.
 *
 * Behind a verification code like every other write: a pin decides what a later
 * eviction may not reclaim, so on a small cache disk enough of them is a decision
 * about whether anything can be cached at all.
 */
export function PinDialog({ entry, onClose }: PinDialogProps) {
  const codeId = useId();
  const queryClient = useQueryClient();
  const [mfaCode, setMfaCode] = useState('');
  const nextPinned = !entry.pinned;

  const mutation = useMutation({
    mutationFn: () =>
      setPin({
        logicalPath: entry.logicalPath,
        instanceId: entry.instanceId,
        torrentHash: entry.torrentHash,
        pinned: nextPinned,
        mfaCode,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: mediaCatalogQueryKey });
      onClose();
    },
  });

  const canSubmit = /^[0-9]{6}$/.test(mfaCode) && !mutation.isPending;

  return (
    <section className="offload-conflict" aria-labelledby={`${codeId}-title`}>
      <h3 id={`${codeId}-title`}>{nextPinned ? '固定该标题' : '取消固定'}</h3>
      <p className="inline-message" role="note">
        {nextPinned ? (
          <>
            <Pin size={14} strokeWidth={1.8} aria-hidden="true" /> 记下{' '}
            <strong>{entry.name}</strong> 要保留，本系统自己的缓存清理不会回收它。
            缓存盘容量有限，固定太多会让其他影片没有空间可用。
          </>
        ) : (
          <>
            <PinOff size={14} strokeWidth={1.8} aria-hidden="true" /> 取消保留{' '}
            <strong>{entry.name}</strong>。本地文件与云端副本都不受影响，
            只是下次观看可能需要重新拉取。
          </>
        )}
      </p>
      {/*
        Said plainly rather than implied. rclone runs its own LRU eviction against
        the cache disk and has no notion of a pin, so today this records an intent
        the system's own cleanup will honour once that cleanup is wired — it does
        not override rclone. Promising otherwise would be the same mistake as a step
        named EVICTING_CACHE that never evicted anything.
      */}
      <p className="field-hint">
        注意：rclone 自己也会按最久未使用回收缓存，它不认识这里的固定。
        固定当前只对本系统的缓存清理生效。
      </p>

      <form
        className="instance-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) mutation.mutate();
        }}
      >
        <label className="field" htmlFor={codeId}>
          <span>两步验证码</span>
          <input
            id={codeId}
            aria-label="两步验证码"
            type="text"
            value={mfaCode}
            onChange={(event) => setMfaCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
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
            {mutation.isPending ? '正在保存……' : nextPinned ? '固定' : '取消固定'}
          </button>
        </div>
      </form>
    </section>
  );
}
