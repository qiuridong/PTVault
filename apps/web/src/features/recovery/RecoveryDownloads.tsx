import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../../api/client.js';
import {
  downloadRecoveryFile,
  getRecoveryExports,
  recoveryExportsQueryKey,
  type RecoveryFileKind,
} from './recoveryApi.js';

function downloadError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return '会话已过期，请重新登录后下载。';
    if (error.status === 403) return '当前会话不允许下载真实恢复文件。';
    if (error.code === 'RECOVERY_ESCROW_VERSION_UNAVAILABLE')
      return '现存 escrow 的 SHA 与此版本不一致，未下载其他版本文件。';
    if (
      error.code === 'RECOVERY_FILE_CHECKSUM_MISMATCH' ||
      error.code === 'RECOVERY_DOWNLOAD_CHECKSUM_MISMATCH'
    )
      return '文件 SHA 与该版本记录不一致，已拒绝下载。';
    if (error.status === 429) return '已有恢复文件正在下载，请完成或取消后重试。';
    if (error.status === 413) return '该文件超过网页下载的 256 MiB 上限。';
    if (error.code === 'RECOVERY_FILE_MISSING' || error.code === 'RECOVERY_EXPORT_NOT_FOUND')
      return '该版本的原始文件当前不存在，未生成替代版本。';
    if (error.status === 404) return '当前 API 尚未提供恢复文件下载接口。';
  }
  return '本次下载未完成或文件身份不符，没有自动确认任何恢复记录。';
}

export function RecoveryDownloads({ currentVersion }: { currentVersion: number | null }) {
  const id = useId();
  const query = useQuery({ queryKey: recoveryExportsQueryKey, queryFn: getRecoveryExports });
  const exports = [...(query.data ?? [])].sort((a, b) => a.version - b.version);
  const [version, setVersion] = useState<number | null>(null);
  const selected =
    exports.find((row) => row.version === version) ??
    exports.find((row) => row.completedAt !== null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const active = useRef(false);
  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  const download = async (
    targetVersion: number,
    kind: RecoveryFileKind,
    sha: string,
  ): Promise<void> => {
    if (active.current) return;
    active.current = true;
    const abort = new AbortController();
    controller.current = abort;
    setPending(`${targetVersion}:${kind}`);
    setError(null);
    setNotice(null);
    try {
      const result = await downloadRecoveryFile({
        version: targetVersion,
        kind,
        expectedSha256: sha,
        signal: abort.signal,
      });
      if (!mounted.current || abort.signal.aborted) return;
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = result.filename;
      document.body.append(link);
      link.click();
      link.remove();
      const revoke = URL.revokeObjectURL.bind(URL);
      setTimeout(() => revoke(url), 1000);
      setNotice(
        `已交给浏览器下载 ${result.filename}；不会自动确认或完成演练，请自行离线保存并校验。`,
      );
    } catch (cause) {
      if (mounted.current && !abort.signal.aborted) setError(downloadError(cause));
    } finally {
      active.current = false;
      controller.current = null;
      if (mounted.current) setPending(null);
    }
  };
  return (
    <section className="settings-card" aria-label="下载既有恢复文件">
      <h2>下载既有恢复文件</h2>
      <p>取回服务端已经存在的原始加密文件；下载不会重新生成版本、解密文件或填写人工确认。</p>
      <p className="field-hint">
        {currentVersion === null
          ? '当前尚未选择人工准备基线。'
          : `当前人工准备基线为 v${currentVersion}。`}{' '}
        下载选择不会切换基线或「准备操作版本」。确认或演练前，请单独选择与所下载文件一致的准备版本；恢复包与
        escrow 的 SHA 用途不同，请勿混填。
      </p>
      {query.isPending ? (
        <p role="status">正在读取已有版本…</p>
      ) : query.isError ? (
        <p role="alert">已有版本列表暂不可用，请刷新后重试。</p>
      ) : selected === undefined ? (
        <p>尚无已完成的恢复包；此处不会代替你生成新版本。</p>
      ) : (
        <>
          <label className="field" htmlFor={id}>
            <span>下载文件版本</span>
            <select
              id={id}
              value={selected.version}
              disabled={pending !== null}
              onChange={(event) => {
                setVersion(Number(event.target.value));
                setError(null);
                setNotice(null);
              }}
            >
              {exports.map((row) => (
                <option key={row.version} value={row.version} disabled={row.completedAt === null}>
                  v{row.version}
                  {row.version === currentVersion ? ' · 人工准备基线' : ' · 业务快照原版本'}
                  {row.completedAt === null ? ' · 未完成' : ''}
                </option>
              ))}
            </select>
          </label>
          {(['bundle', 'escrow'] as const).map((kind) => {
            const sha = kind === 'bundle' ? selected.bundleSha256 : selected.escrowSha256;
            const filename =
              kind === 'bundle'
                ? `recovery-v${selected.version}.tar.age`
                : `escrow-v${selected.version}.age`;
            return (
              <section
                className="recovery-step"
                key={kind}
                aria-label={`v${selected.version} ${kind === 'bundle' ? '恢复包' : 'escrow'}`}
              >
                <h3>{filename}</h3>
                <p className="field-hint">
                  {kind === 'bundle'
                    ? '恢复包 SHA：仅用于第 4 步「确认已下载到本机」，不能填 escrow 的摘要。'
                    : 'escrow SHA：仅用于第 5 步「口令演练」，不能填到第 4 步的恢复包确认。'}
                </p>
                {selected.version !== currentVersion ? (
                  <p className="field-hint">
                    下载的是 v{selected.version} 原文件，与人工准备基线 v{currentVersion ?? '?'}{' '}
                    不同。确认或演练此文件前，请把「准备操作版本」明确选为 v{selected.version}
                    ，不要混用其他版本的摘要。
                  </p>
                ) : null}
                <code style={{ display: 'block', overflowWrap: 'anywhere', marginBlock: '8px' }}>
                  {sha ?? '尚未生成摘要'}
                </code>
                <button
                  type="button"
                  className="ghost-button"
                  disabled={pending !== null || sha === null || selected.completedAt === null}
                  onClick={() => {
                    if (sha !== null) void download(selected.version, kind, sha);
                  }}
                >
                  {pending === `${selected.version}:${kind}` ? '正在校验下载…' : `下载 ${filename}`}
                </button>
              </section>
            );
          })}
        </>
      )}
      {error === null ? null : (
        <p className="inline-message error-message" role="alert">
          {error}
        </p>
      )}
      {notice === null ? null : (
        <p className="inline-message" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
