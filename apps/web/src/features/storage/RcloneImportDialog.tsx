import type {
  RcloneImportPending,
  RcloneImportPreview,
  RcloneImportRequest,
  RcloneImportResult,
} from '@ptvault/contracts';
import { useEffect, useRef, useState } from 'react';
import { ApiError, newIdempotencyKey } from '../../api/client.js';
import {
  commitRcloneImport,
  getPendingRcloneImports,
  previewRcloneImport,
} from './rcloneImportApi.js';

const ERRORS: Record<string, string> = {
  RCLONE_IMPORT_PREPARE_FAILED:
    '私密副本尚未准备完成，也没有开始账户检查。请检查服务器磁盘空间后，使用下一枚验证码重试。',
  RCLONE_IMPORT_CONFIG_TOO_LARGE:
    '合并后的配置将超过受支持的大小，原配置未替换。请先清理不需要的配置注释或联系管理员检查。',
  RCLONE_IMPORT_SELECTION_INVALID: '所选账户组合无效，请重新选择一至两个受支持的账户。',
  RCLONE_IMPORT_SOURCE_UNSUPPORTED:
    '无法读取这个配置。请使用服务账户可读的普通明文 rclone 配置文件；目前支持英文别名的 OneDrive 与直接包装它的 crypt，不支持加密配置文件或间接组合。',
  RCLONE_IMPORT_PREVIEW_EXPIRED: '这份只读预览已过期，请重新查看配置并选择账户。',
  RCLONE_IMPORT_DUPLICATE_DRIVE:
    '所选账户与另一项指向同一个 OneDrive，不能把同一份容量算作两个独立账户。请选择不同账户。',
  RCLONE_IMPORT_PROBE_FAILED:
    '账户检查未完成，可能需要重新授权或检查服务器网络。私密副本和已刷新的令牌已保留，可继续这次导入；不会重新覆盖为原文件里的旧令牌。',
  RCLONE_IMPORT_SAVE_RETRYABLE:
    '检查已完成，但本机登记尚未完成。请继续这次导入，系统会核对原结果，不会重复登记。',
  RCLONE_IMPORT_CONFIG_CONFLICT:
    '检测到这次导入的配置已有不同版本。两份都已保留，没有覆盖；请先检查服务器配置变化。',
  RCLONE_IMPORT_INTENT_CONFLICT:
    '这次请求与已保存的导入意图不同，没有覆盖原记录。请重新打开并继续未完成的导入。',
  RCLONE_IMPORT_BUSY: '另一项导入仍在进行，请稍后继续。',
  RCLONE_IMPORT_RECOVERY_REQUIRED:
    '存在需要恢复的私密副本。请先继续未完成的导入，不要重复创建副本。',
  SETUP_MFA_REQUIRED: '请使用验证器中下一枚未使用的6位验证码。',
};
export function RcloneImportDialog({
  onClose,
  onCompleted,
}: {
  onClose: () => void;
  onCompleted: () => void;
}) {
  const [filename, setFilename] = useState('');
  const [preview, setPreview] = useState<RcloneImportPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [mfa, setMfa] = useState('');
  const [pending, setPending] = useState<RcloneImportPending>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<RcloneImportResult | null>(null);
  const intent = useRef<{ body: RcloneImportRequest; key: string } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (busy) panel.current?.focus();
  }, [busy]);
  useEffect(() => {
    let closed = false;
    const previous = document.activeElement;
    panel.current?.querySelector<HTMLElement>('input, button')?.focus();
    void getPendingRcloneImports()
      .then((value) => {
        if (!closed) setPending(value);
      })
      .catch(() => {
        if (!closed) setError('未完成导入的记录暂时无法读取，请重新打开后再试。');
      });
    return () => {
      closed = true;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  const fail = (value: unknown) => {
    const code = value instanceof ApiError ? value.code : undefined;
    setError(
      (code && ERRORS[code]) ||
        '暂时无法确认结果。可继续同一次导入；重新打开窗口也能找到服务器上已保存的未完成记录。',
    );
    if (code === 'SETUP_MFA_REQUIRED') {
      intent.current = null;
      setMfa('');
    }
    if (
      code === 'RCLONE_IMPORT_DUPLICATE_DRIVE' ||
      code === 'RCLONE_IMPORT_SELECTION_INVALID' ||
      code === 'RCLONE_IMPORT_PREPARE_FAILED'
    ) {
      intent.current = null;
      setMfa('');
    }
    if (code === 'RCLONE_IMPORT_PREVIEW_EXPIRED') {
      intent.current = null;
      setPreview(null);
      setSelected([]);
      setMfa('');
    }
  };
  const inspect = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      setPreview(await previewRcloneImport(filename.trim()));
      setSelected([]);
      intent.current = null;
      setMfa('');
    } catch (value) {
      fail(value);
    } finally {
      setBusy(false);
    }
  };
  const commit = async (resume?: RcloneImportPending[number]) => {
    if (busy) return;
    if (resume)
      intent.current = {
        key: resume.idempotencyKey,
        body: { previewId: resume.previewId, pairIds: resume.pairIds },
      };
    if (!intent.current) {
      if (!preview || !selected.length || !/^\d{6}$/.test(mfa)) return;
      intent.current = {
        key: newIdempotencyKey(),
        body: { previewId: preview.previewId, pairIds: selected, mfaCode: mfa },
      };
    }
    setBusy(true);
    setError('');
    try {
      const imported = await commitRcloneImport(intent.current.body, intent.current.key);
      setResult(imported);
      setMfa('');
      onCompleted();
    } catch (value) {
      fail(value);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="command-overlay connection-flow-overlay" role="presentation">
      <div
        className="connection-flow-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rclone-import-title"
        ref={panel}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (!busy) onClose();
          }
          if (event.key === 'Tab') {
            const controls = [
              ...(panel.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), a[href]',
              ) ?? []),
            ];
            const first = controls[0],
              last = controls.at(-1);
            if (!first) {
              event.preventDefault();
              panel.current?.focus();
              return;
            }
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header className="connection-flow-head">
          <h2 id="rclone-import-title">导入已有 rclone 配置</h2>
          <p>
            只复制你选择的 OneDrive 与 crypt 配置。原文件不修改，也不会用它运行 rclone 或写入令牌。
          </p>
          <p>
            原加密密码、盐与云端目录保持不变，不上传、删除或移动云端文件。复制的授权仍属于同一服务商授权关系，撤销授权可能同时影响原应用。
          </p>
        </header>
        {error ? (
          <p role="alert" className="connection-flow-note">
            {error}
          </p>
        ) : null}
        {result ? (
          <div className="connection-flow-state connection-flow-good" role="status">
            已导入 {result.accountIds.length}{' '}
            个存储目的地。已检查配额响应和加密根目录可访问；未知配额仍会标为待检查。尚未迁移任何文件，请返回首次设置选择恢复副本账户。
          </div>
        ) : (
          <>
            {pending.length > 0 && !intent.current ? (
              <section className="connection-flow-note">
                <h3>继续未完成的导入</h3>
                <p>沿用已核准的私密副本，不重复消耗验证码。</p>
                {pending.map((item) => (
                  <div key={item.idempotencyKey}>
                    <p id={`pending-${item.previewId}`}>
                      {item.stage === 'READY_TO_SAVE' ? '检查完成，待登记' : '账户检查未完成'} ·
                      本次标识 {item.idempotencyKey.slice(-8)}
                    </p>
                    <button
                      className="ghost-button"
                      aria-describedby={`pending-${item.previewId}`}
                      disabled={busy}
                      onClick={() => void commit(item)}
                    >
                      继续导入 {item.pairIds.join('、')}
                    </button>
                  </div>
                ))}
              </section>
            ) : null}
            {!intent.current ? (
              <>
                <label className="field">
                  <span>服务器上的 rclone 配置文件</span>
                  <input
                    value={filename}
                    onChange={(event) => {
                      setFilename(event.target.value);
                      setPreview(null);
                      setSelected([]);
                    }}
                    placeholder="/home/USER/.config/rclone/rclone.conf"
                    disabled={busy}
                    autoComplete="off"
                  />
                </label>
                <button
                  className="ghost-button"
                  disabled={busy || !filename.trim()}
                  onClick={() => void inspect()}
                >
                  只读查看可导入账户
                </button>
                {preview ? (
                  <fieldset className="rclone-import-pairs" disabled={busy}>
                    <legend>选择一至两个不同的 OneDrive</legend>
                    {preview.pairs.length === 0 ? (
                      <p>
                        未找到支持的 OneDrive + crypt 组合。请检查已有配置；系统不会把普通 OneDrive
                        当作加密目的地。
                      </p>
                    ) : (
                      preview.pairs.map((pair) => (
                        <label className="rclone-import-pair" key={pair.id}>
                          <input
                            type="checkbox"
                            checked={selected.includes(pair.id)}
                            disabled={!selected.includes(pair.id) && selected.length >= 2}
                            onChange={(event) =>
                              setSelected((old) =>
                                event.target.checked
                                  ? [...old, pair.id]
                                  : old.filter((id) => id !== pair.id),
                              )
                            }
                          />
                          <span>
                            <strong>{pair.cryptName}</strong>
                            <br />
                            {pair.rawName} · {pair.driveType} · {pair.driveHint}
                          </span>
                        </label>
                      ))
                    )}
                    {preview.skippedCount > 0 ? (
                      <p>另有 {preview.skippedCount} 项 crypt 不在支持范围内，未复制。</p>
                    ) : null}
                    {selected.length > 0 ? (
                      <label className="field">
                        <span>动态验证码</span>
                        <input
                          value={mfa}
                          onChange={(event) =>
                            setMfa(event.target.value.replace(/\D/g, '').slice(0, 6))
                          }
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          maxLength={6}
                        />
                      </label>
                    ) : null}
                  </fieldset>
                ) : null}
              </>
            ) : (
              <p className="connection-flow-note">
                本次所选账户：{intent.current.body.pairIds.join('、')}
                。关闭后可从未完成记录继续，关闭窗口不代表撤销服务器上的导入。
              </p>
            )}
            {intent.current || selected.length > 0 ? (
              <button
                className="primary-button"
                disabled={busy || (!intent.current && !/^\d{6}$/.test(mfa))}
                onClick={() => void commit()}
              >
                {busy ? '正在检查并保存…' : intent.current ? '继续这次导入' : '复制并检查所选账户'}
              </button>
            ) : null}
            {busy ? (
              <p role="status">
                正在处理所选账户，检查通常在两分钟内结束；无需重复点击或重新授权。
              </p>
            ) : null}
          </>
        )}
        <footer className="connection-flow-actions">
          <button className="ghost-button" disabled={busy} onClick={onClose}>
            {result ? '完成并关闭' : '关闭'}
          </button>
        </footer>
      </div>
    </div>
  );
}
