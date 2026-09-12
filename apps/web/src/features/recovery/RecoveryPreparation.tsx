import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import type { RecoveryExport, RecoveryStatus } from '@ptvault/contracts';
import { ApiError, newIdempotencyKey } from '../../api/client.js';
import {
  recoveryExportsQueryKey,
  recoveryStatusQueryKey,
  selectRecoveryBaseline,
} from './recoveryApi.js';

/** Live status refresh never changes an uncertain request. Only explicit edits/reset or success do. */
export function useRecoveryIntent<T>() {
  const intent = useRef<{ identity: T; key: string } | null>(null);
  return {
    active: intent.current !== null,
    capture: (identity: () => T) => {
      intent.current ??= { identity: identity(), key: newIdempotencyKey() };
      return intent.current;
    },
    reset: () => {
      intent.current = null;
    },
  };
}

export function RecoveryPreparation({
  status,
  exports,
  selectedVersion,
  onSelect,
}: {
  status: RecoveryStatus;
  exports: RecoveryExport[];
  selectedVersion: number | null;
  onSelect: (version: number | null) => void;
}) {
  const target = exports.find((item) => item.version === selectedVersion);
  const [mfaCode, setMfaCode] = useState('');
  const request = useRecoveryIntent<{
    version: number;
    bundleSha256: string;
    escrowSha256: string;
    expectedBaselineRevision: number;
    expectedMaterialRevision: number;
  }>();
  const client = useQueryClient();
  const id = useId();
  const mutation = useMutation({
    mutationFn: () => {
      const intent = request.capture(() => {
        if (
          !target?.bundleSha256 ||
          !target.escrowSha256 ||
          status.baselineRevision === undefined ||
          status.materialRevision === undefined
        )
          throw new Error('RECOVERY_IDENTITY_REQUIRED');
        return {
          version: target.version,
          bundleSha256: target.bundleSha256,
          escrowSha256: target.escrowSha256,
          expectedBaselineRevision: status.baselineRevision,
          expectedMaterialRevision: status.materialRevision,
        };
      });
      return selectRecoveryBaseline({
        ...intent.identity,
        mfaCode,
        idempotencyKey: intent.key,
      });
    },
    onSuccess: async () => {
      request.reset();
      setMfaCode('');
      await client.invalidateQueries({ queryKey: recoveryStatusQueryKey });
      await client.invalidateQueries({ queryKey: recoveryExportsQueryKey });
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409)
        await client.invalidateQueries({ queryKey: recoveryStatusQueryKey });
    },
  });
  const canSubmit =
    Boolean(target?.completedAt !== null && target?.bundleSha256 && target.escrowSha256) &&
    (selectedVersion !== status.version || request.active) &&
    status.baselineRevision !== undefined &&
    status.materialRevision !== undefined &&
    !status.readinessProblems?.includes('COMPATIBILITY_READ_ONLY') &&
    /^[0-9]{6}$/.test(mfaCode) &&
    !mutation.isPending;
  return (
    <section className="recovery-step" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>选择人工准备版本</h3>
      <p>
        当前人工准备基线：{status.version === null ? '尚未选择' : `v${status.version}`}
        。最新业务快照：
        {status.latestSnapshotVersion == null ? '尚未生成' : `v${status.latestSnapshotVersion}`}。
      </p>
      <p className="field-hint">
        自动快照继续备份新业务，不替换人工基线。下方选择只决定确认与演练的操作对象；下载、查看和填写证明都不会自动切换基线。
      </p>
      <label className="field" htmlFor={`${id}-version`}>
        <span>准备操作版本</span>
        <select
          id={`${id}-version`}
          value={selectedVersion ?? ''}
          disabled={mutation.isPending}
          onChange={(event) => {
            request.reset();
            onSelect(event.target.value === '' ? null : Number(event.target.value));
            setMfaCode('');
            mutation.reset();
          }}
        >
          <option value="">请选择要准备的版本</option>
          {exports
            .filter((item) => item.completedAt !== null && item.bundleSha256 !== null)
            .map((item) => (
              <option key={item.version} value={item.version}>
                v{item.version}
                {item.version === status.version ? ' · 当前人工基线' : ''}
              </option>
            ))}
        </select>
      </label>
      {target ? (
        <>
          <p className="field-hint">
            当前准备操作对象为 v{target.version}。恢复包 SHA-256：
            <code style={{ overflowWrap: 'anywhere' }}>{target.bundleSha256}</code>
            ；escrow SHA-256：
            <code style={{ overflowWrap: 'anywhere' }}>{target.escrowSha256}</code>。
          </p>
          <p className="field-hint">
            请先对这个版本完成电脑保存确认和口令演练，再显式切换。未准备完成或材料失效时，切换后的本地清理仍保持锁定；旧证明不会复制到此版本。
          </p>
        </>
      ) : null}
      <form
        className="instance-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) mutation.mutate();
        }}
      >
        <label className="field" htmlFor={`${id}-mfa`}>
          <span>切换基线验证码</span>
          <input
            id={`${id}-mfa`}
            value={mfaCode}
            onChange={(event) => setMfaCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
            required
          />
        </label>
        {mutation.isError ? (
          <p className="inline-message error-message" role="alert">
            {mutation.error instanceof ApiError && mutation.error.status === 409
              ? '准备状态已变化或正在使用，请核对刷新后的版本与材料再提交。'
              : '切换未确认完成。网络错误可使用同一操作重试；不要重复填写其他版本的证明。'}
          </p>
        ) : null}
        <div className="instance-form-actions">
          {mutation.isError ? (
            <button
              type="button"
              onClick={() => {
                request.reset();
                mutation.reset();
                setMfaCode('');
              }}
            >
              放弃旧请求，按当前状态重来
            </button>
          ) : null}
          <button type="submit" className="primary-action" disabled={!canSubmit}>
            {mutation.isPending ? '正在切换…' : '设为人工准备基线'}
          </button>
        </div>
      </form>
    </section>
  );
}
