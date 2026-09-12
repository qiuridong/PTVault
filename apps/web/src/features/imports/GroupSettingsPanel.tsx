import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { GroupSettingsValuesSchema, type GroupSettingsValues } from '@ptvault/contracts';
import {
  getGroupSettings,
  groupErrorMessage,
  groupSettingsQueryKey,
  saveGroupSettings,
} from './groupApi.js';
import { formatDecimalBytes } from './importFormatting.js';

const FIELDS = {
  maxResidentGroups: '同时驻盘执行组数',
  downloadConcurrency: '同时下载组数',
  extractionConcurrency: '同时解压组数',
  uploadConcurrency: '同时上传校验组数',
} as const;
export function GroupSettingsPanel({ readOnly }: { readOnly: boolean }) {
  const id = useId(),
    client = useQueryClient(),
    query = useQuery({
      queryKey: groupSettingsQueryKey,
      queryFn: getGroupSettings,
      refetchInterval: 10000,
    });
  const [draft, setDraft] = useState<GroupSettingsValues | null>(null),
    [revision, setRevision] = useState(0),
    [dirty, setDirty] = useState(false),
    [mfa, setMfa] = useState(''),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null),
    [saved, setSaved] = useState(false);
  const intent = useRef<{ fingerprint: string; key: string } | null>(null);
  const editing = useRef(false);
  useEffect(() => {
    if (query.data && !dirty && !editing.current && !pending && query.data.revision >= revision) {
      setDraft(query.data.configured);
      setRevision(query.data.revision);
    }
  }, [query.data, dirty, pending, revision]);
  const change = (next: GroupSettingsValues) => {
    editing.current = true;
    setDraft(next);
    setDirty(true);
    setSaved(false);
    setError(null);
  };
  const valid = draft !== null && GroupSettingsValuesSchema.safeParse(draft).success;
  const save = async () => {
    if (!draft || !valid || !dirty || pending || readOnly || !/^\d{6}$/.test(mfa)) return;
    const code = mfa;
    setMfa('');
    setPending(true);
    setError(null);
    setSaved(false);
    const fingerprint = JSON.stringify({ revision, draft });
    if (intent.current?.fingerprint !== fingerprint)
      intent.current = { fingerprint, key: crypto.randomUUID() };
    try {
      await client.cancelQueries({ queryKey: groupSettingsQueryKey, exact: true });
      const result = await saveGroupSettings(
        { revision, mfaCode: code, settings: draft },
        intent.current.key,
      );
      client.setQueryData(groupSettingsQueryKey, result);
      setDraft(result.configured);
      setRevision(result.revision);
      setDirty(false);
      editing.current = false;
      setSaved(true);
      intent.current = null;
    } catch (cause) {
      setError(groupErrorMessage(cause));
    } finally {
      setPending(false);
      setMfa('');
    }
  };
  return (
    <section className="settings-card" aria-label="分组运行设置">
      <h3>分组运行设置</h3>
      <p className="field-hint">
        默认最多 3 组驻盘，下载 / 解压 / 上传校验各 1 组，每个文件默认 5
        条下载连接。不同阶段可以交叠；调整组数只影响新准入和后续名额，不终止正在工作的组，也不改变原有迁移设置。
      </p>
      {query.isPending ? <p role="status">正在读取分组配置…</p> : null}
      {query.isError ? <p role="alert">{groupErrorMessage(query.error)}</p> : null}
      {query.data ? (
        <>
          <p>
            全局可用暂存预算：<strong>{formatDecimalBytes(query.data.residentBudgetBytes)}</strong>{' '}
            · 生效缓存预算 {formatDecimalBytes(query.data.effective.waitingCacheMaxBytes)}
          </p>
          <p className="field-hint">
            全局预算沿用网盘迁移设置中的“最大暂存 −
            保留空间”。缓存回收只针对已核对来源仍可读的未完成输入，唯一视频输出保留。修改后活跃数短暂超过新上限时，让已有组自然结束。
          </p>
          {!query.data.provisioned ? (
            <p role="status">
              分组运行时尚未就绪。配置可以保存，实际执行仍由运行时与创建开关共同控制。
            </p>
          ) : null}
          {draft ? (
            <fieldset disabled={readOnly || pending} className="group-settings-fields">
              <div className="import-field-grid">
                {(Object.keys(FIELDS) as Array<keyof typeof FIELDS>).map((key) => (
                  <div className="field" key={key}>
                    <label htmlFor={`${id}-${key}`}>{FIELDS[key]}</label>
                    <input
                      id={`${id}-${key}`}
                      type="number"
                      min={1}
                      max={8}
                      step={1}
                      value={draft[key] || ''}
                      onChange={(event) => {
                        const value = Math.max(
                          0,
                          Math.min(8, Math.floor(Number(event.target.value))),
                        );
                        change(
                          key === 'maxResidentGroups'
                            ? {
                                ...draft,
                                maxResidentGroups: value,
                                downloadConcurrency: Math.min(draft.downloadConcurrency, value),
                                extractionConcurrency: Math.min(draft.extractionConcurrency, value),
                                uploadConcurrency: Math.min(draft.uploadConcurrency, value),
                              }
                            : { ...draft, [key]: value },
                        );
                      }}
                    />
                  </div>
                ))}
                <div className="field">
                  <label htmlFor={`${id}-file-connections`}>单文件下载连接数</label>
                  <input
                    id={`${id}-file-connections`}
                    type="number"
                    min={1}
                    max={16}
                    step={1}
                    value={
                      Number.isNaN(draft.fileDownloadConnections)
                        ? ''
                        : draft.fileDownloadConnections
                    }
                    onChange={(event) =>
                      change({
                        ...draft,
                        fileDownloadConnections:
                          event.target.value === '' ? NaN : Number(event.target.value),
                      })
                    }
                    aria-describedby={`${id}-file-connections-hint`}
                  />
                  <p className="field-hint" id={`${id}-file-connections-hint`}>
                    可自定义 1–16
                    条，与同时下载组数分别设置。保存后从下一批分段请求生效，不打断在途请求或清除断点；小文件、文件尾段或来源不支持分段时，实际连接可能更少。
                  </p>
                </div>
              </div>
              <label className="import-radio">
                <input
                  type="checkbox"
                  checked={draft.waitingCacheMaxBytes === null}
                  onChange={(event) =>
                    change({
                      ...draft,
                      waitingCacheMaxBytes: event.target.checked
                        ? null
                        : query.data.effective.waitingCacheMaxBytes,
                    })
                  }
                />
                自动设置等待输入缓存（最多 64 GiB，且不超过全局可用预算的四分之一）
              </label>
              {draft.waitingCacheMaxBytes !== null ? (
                <div className="field">
                  <label htmlFor={`${id}-cache`}>等待输入缓存上限（GiB）</label>
                  <input
                    id={`${id}-cache`}
                    type="number"
                    min={0}
                    step={1}
                    value={Number(BigInt(draft.waitingCacheMaxBytes) / 1024n ** 3n)}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (Number.isSafeInteger(value) && value >= 0)
                        change({
                          ...draft,
                          waitingCacheMaxBytes: (BigInt(value) * 1024n ** 3n).toString(),
                        });
                    }}
                  />
                </div>
              ) : null}
              {!valid ? (
                <p role="alert">
                  各阶段并发应为 1–8，且不超过同时驻盘组数；单文件连接数应为 1–16 的整数。
                </p>
              ) : null}
              <div className="field">
                <label htmlFor={`${id}-mfa`}>六位验证码</label>
                <input
                  id={`${id}-mfa`}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={mfa}
                  onChange={(event) => setMfa(event.target.value.replace(/\D/g, ''))}
                />
              </div>
              <div className="baidu-browser-actions">
                <button
                  className="primary-button"
                  type="button"
                  disabled={!valid || !dirty || pending || readOnly || !/^\d{6}$/.test(mfa)}
                  onClick={() => void save()}
                >
                  {pending ? '正在验证并保存…' : '验证并保存分组设置'}
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    setDirty(false);
                    editing.current = false;
                    setDraft(query.data.configured);
                    setRevision(query.data.revision);
                    setMfa('');
                    setError(null);
                    setSaved(false);
                    intent.current = null;
                    void query.refetch();
                  }}
                >
                  加载最新配置
                </button>
              </div>
            </fieldset>
          ) : null}
          <p className="field-hint">
            已生效单文件连接上限 {query.data.effective.fileDownloadConnections}{' '}
            条；按当前同时下载组数，分段请求总上限{' '}
            {query.data.effective.fileDownloadConnections *
              query.data.effective.downloadConcurrency}{' '}
            条（不是当前活跃连接数）。
          </p>
          <p className="field-hint">
            当前活跃 / 等待：下载 {query.data.resources.download.active}/
            {query.data.resources.download.pending} · 解压 {query.data.resources.extraction.active}/
            {query.data.resources.extraction.pending} · 上传及双回读{' '}
            {query.data.resources.upload.active}/{query.data.resources.upload.pending}
          </p>
        </>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {saved ? (
        <p role="status">
          分组设置已保存，组数生效于后续名额，单文件连接数生效于下一批分段请求；验证码已清空。
        </p>
      ) : null}
    </section>
  );
}
