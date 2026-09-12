import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  SetupConfigView,
  SetupPathCheckResult,
  SetupSecretPatch,
  SetupUseCase,
  SetupValues,
} from '@ptvault/contracts';
import { ArrowRight, Check, Download, FolderOpen, RefreshCw, Save } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, newIdempotencyKey } from '../../api/client.js';
import { formatBytes } from '../../ui/format.js';
import { getStorageAccounts, storageAccountsQueryKey } from '../storage/accountApi.js';
import {
  applySetup,
  checkSetupPath,
  getSetupOverview,
  saveSetup,
  setupOverviewKey,
} from './setupApi.js';

const USE_CASES: { id: SetupUseCase; title: string; description: string }[] = [
  {
    id: 'NETDISK',
    title: '网盘文件归档',
    description: '从百度下载、按需解压，再保存到加密网盘。不需要 qBittorrent 或 Jellyfin。',
  },
  {
    id: 'PT_OFFLOAD',
    title: '本地 PT 文件迁移',
    description: '管理 qBittorrent 的本地文件。保留播放占用检查，需要接入 Jellyfin。',
  },
  {
    id: 'JELLYFIN',
    title: '在 Jellyfin 中观看',
    description: '让 Jellyfin 看到归档后的媒体。只归档、不播放时可以不选。',
  },
];
const PATH_RESULTS: Record<SetupPathCheckResult['outcome'], string> = {
  READABLE: '可以读取这个文件',
  WRITABLE: '可以写入临时目录',
  NOT_CONFIGURED: '尚未配置目录',
  NOT_FOUND: '服务账户看不到这个位置',
  PERMISSION_DENIED: '服务账户没有所需权限',
  OUTSIDE_ALLOWED_ROOT: '不在已保存的允许目录内',
  SYMLINK_ESCAPE: '文件链接指向允许范围外',
  NOT_FILE: '请选择普通文件，而不是目录或设备',
  NOT_DIRECTORY: '临时位置不是目录',
  SIZE_CHANGED: '文件大小已变化，请重新选择',
  PATH_CHANGED: '检查期间文件身份改变，请重试',
  IO_ERROR: '读取或写入失败，请检查磁盘状态',
  PATH_OVERLAP: '目录与来源或私密数据范围重叠',
};
const lines = (value: string) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
const nullable = (value: string) => value.trim() || null;

function LineListInput({ value, onChange, placeholder }: { value: string[]; onChange: (value: string[]) => void; placeholder: string }) {
  const canonical = value.join('\n');
  const [text, setText] = useState(canonical);
  const emitted = useRef(canonical);
  useEffect(() => {
    if (canonical !== emitted.current) { emitted.current = canonical; setText(canonical); }
  }, [canonical]);
  return <textarea rows={3} placeholder={placeholder} value={text} onChange={(event) => {
    const next = event.target.value; setText(next);
    const parsed = lines(next); emitted.current = parsed.join('\n'); onChange(parsed);
  }} />;
}

export function SetupPage() {
  const client = useQueryClient();
  const overview = useQuery({
    queryKey: setupOverviewKey,
    queryFn: getSetupOverview,
    refetchInterval: (query) => (query.state.data?.applying ? 2000 : false),
  });
  const [base, setBase] = useState<SetupConfigView | null>(null);
  const [values, setValues] = useState<SetupValues | null>(null);
  const [secrets, setSecrets] = useState<SetupSecretPatch>({});
  const [mfa, setMfa] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [pathResult, setPathResult] = useState<SetupPathCheckResult | null>(null);
  const [samplePath, setSamplePath] = useState('');
  const [sampleMaps, setSampleMaps] = useState('');
  const intent = useRef<{ signature: string; key: string } | null>(null);
  const netdisk = values?.useCases.includes('NETDISK') ?? false;
  const pt = values?.useCases.includes('PT_OFFLOAD') ?? false;
  const media = pt || (values?.useCases.includes('JELLYFIN') ?? false);
  const accounts = useQuery({
    queryKey: storageAccountsQueryKey,
    queryFn: getStorageAccounts,
    enabled: netdisk || pt,
  });
  const dirty =
    base !== null &&
    (JSON.stringify(base.values) !== JSON.stringify(values) || Object.keys(secrets).length > 0);
  const live = overview.data?.configuration;
  useEffect(() => {
    if (live && !busy && (base === null || (!dirty && live.revision > base.revision))) {
      setBase(live); setValues(live.values); setSecrets({}); intent.current = null;
    }
  }, [base, live, dirty, busy]);
  const view = live?.revision === base?.revision ? live : base;
  useEffect(() => {
    if (notice && live && base && !dirty && !overview.data?.applying && !live.pendingChanges && live.appliedRevision === base.revision) {
      setNotice('这一版安装设置已经生效。账户、目录权限和首次任务仍需按下方状态完成检查。');
    }
  }, [notice, live, base, dirty, overview.data?.applying]);

  function patch(update: Partial<SetupValues>) {
    setValues((current) => (current ? { ...current, ...update } : current));
    setNotice('');
    setError('');
  }
  function toggle(id: SetupUseCase) {
    if (values)
      patch({
        useCases: values.useCases.includes(id)
          ? values.useCases.filter((item) => item !== id)
          : [...values.useCases, id],
      });
  }
  function secret(key: keyof SetupSecretPatch, value: string) {
    setSecrets((current) => {
      const next = { ...current };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });
  }
  async function save(apply: boolean) {
    if (!base || !values || busy) return;
    if (!/^[0-9]{6}$/.test(mfa)) {
      setError('请填写验证器中当前的6位数字。');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const signature = JSON.stringify({ revision: base.revision, values, secrets, apply });
      if (intent.current?.signature !== signature)
        intent.current = { signature, key: newIdempotencyKey() };
      const result = dirty
        ? await saveSetup(
            { revision: base.revision, values, secrets, mfaCode: mfa, apply },
            intent.current.key,
          )
        : await applySetup(base.revision, mfa);
      setBase(result.configuration);
      setValues(result.configuration.values);
      setSecrets({});
      setMfa('');
      intent.current = null;
      setNotice(
        result.activation === 'WAITING_FOR_IDLE'
          ? '设置已保存，正在等待任务和数据操作结束；当前配置继续工作，不会暂停任务或清除断点。'
          : result.activation === 'APPLYING'
            ? '设置已保存，正在应用。页面会自动重新连接；不需要再次提交。'
            : result.activation === 'SAVED'
              ? '草稿已保存，还没有替换当前运行配置。可以稍后返回继续。'
              : '这一版设置已经生效。',
      );
      client.setQueryData(
        setupOverviewKey,
        (previous: Awaited<ReturnType<typeof getSetupOverview>> | undefined) =>
          previous
            ? {
                ...previous,
                configuration: result.configuration,
                applying:
                  result.activation === 'APPLYING' || result.activation === 'WAITING_FOR_IDLE',
              }
            : previous,
      );
      if (result.activation !== 'APPLYING' && result.activation !== 'WAITING_FOR_IDLE')
        void client.invalidateQueries({ queryKey: setupOverviewKey });
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'SETUP_REVISION_CONFLICT') void overview.refetch();
      setError(
        failure instanceof ApiError
          ? failure.message
          : '没有收到保存结果，草稿仍在页面上。可用相同内容重试；不要据此认为服务器没有保存。',
      );
    } finally {
      setBusy(false);
    }
  }
  async function probe(kind: 'SPOOL' | 'SOURCE') {
    if (dirty) {
      setError('请先保存目录草稿，再以服务账户检查已保存的位置。');
      return;
    }
    setChecking(true);
    setError('');
    try {
      setPathResult(
        await checkSetupPath(
          kind === 'SPOOL' ? { kind } : { kind, path: samplePath, pathMaps: lines(sampleMaps) },
        ),
      );
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : '检查没有完成，请稍后重试。');
    } finally {
      setChecking(false);
    }
  }
  const diagnostic = JSON.stringify(
    {
      format: 'PTVault setup summary v1',
      generatedAt: new Date().toISOString(),
      source: overview.data?.configurationSource ?? 'UNAVAILABLE',
      selectedUseCases: values?.useCases ?? overview.data?.useCases ?? [],
      savedRevision: view?.revision ?? null,
      appliedRevision: view?.appliedRevision ?? null,
      runtime: overview.data?.runtime ?? null,
      checks: overview.data?.checks.map(({ id, state }) => ({ id, state })) ?? [],
      lastFileCheck: pathResult
        ? {
            kind: pathResult.kind,
            outcome: pathResult.outcome,
            availableBytes: pathResult.availableBytes,
          }
        : null,
    },
    null,
    2,
  );
  function download() {
    const url = URL.createObjectURL(new Blob([diagnostic], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'ptvault-setup-summary.json';
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="content-page setup-page" aria-labelledby="setup-title">
      <header className="page-header">
        <div>
          <p className="page-kicker">开始使用 · 随时可以返回</p>
          <h1 id="setup-title">首次设置</h1>
          <p className="page-lede">
            先选用途，再接入需要的账户与目录。没有选的功能不会变成必填项；已有任务策略仍在原设置页管理。
          </p>
        </div>
        <Link className="ghost-button" to="/settings">
          全部设置 <ArrowRight size={16} />
        </Link>
      </header>
      {overview.isPending && <p>正在读取这台服务器的真实配置…</p>}
      {overview.isError && (
        <div role="alert">
          暂时无法读取设置；当前任务不会因此改变。
          <button className="ghost-button" onClick={() => void overview.refetch()}>
            重新连接
          </button>
        </div>
      )}
      {overview.data?.configurationSource === 'SERVER_ENVIRONMENT' && (
        <div className="setup-notice">
          此安装由服务器配置管理，网页不会覆盖原环境文件。下面仍可查看各项是否就绪；普通任务策略请使用原设置页。
        </div>
      )}
      {values && (
        <fieldset className="setup-editor" disabled={busy} aria-label="安装设置">
          <section className="setup-section" aria-labelledby="use-cases-title">
            <div className="setup-section-heading">
              <span>01</span>
              <div>
                <h2 id="use-cases-title">选择要使用的功能</h2>
                <p>可以组合使用。勾选只保存你的用途，不会自动迁移文件。</p>
              </div>
            </div>
            <div className="setup-choices">
              {USE_CASES.map((item) => (
                <label
                  className={`setup-choice${values.useCases.includes(item.id) ? ' selected' : ''}`}
                  key={item.id}
                >
                  <input
                    type="checkbox"
                    checked={values.useCases.includes(item.id)}
                    onChange={() => toggle(item.id)}
                  />
                  <strong>{item.title}</strong>
                  <span>{item.description}</span>
                </label>
              ))}
            </div>
          </section>
          {(netdisk || pt) && (
            <section className="setup-section">
              <div className="setup-section-heading">
                <span>02</span>
                <div>
                  <h2>连接存储账户</h2>
                  <p>
                    账户授权、加密目标和健康检查使用同一份存储账户列表。先保存用途，再前往连接。
                  </p>
                </div>
              </div>
              <Link className="primary-button" to="/storage-accounts?from=setup">
                前往连接账户 <ArrowRight size={16} />
              </Link>
              {dirty && <p className="setup-hint">当前有未保存修改，离开前请在下方保存草稿。</p>}
              {netdisk && (
                <div className="setup-fields">
                  <label>
                    百度授权客户端
                    <select
                      value={values.baiduClient}
                      onChange={(event) =>
                        patch({ baiduClient: event.target.value as SetupValues['baiduClient'] })
                      }
                    >
                      <option value="DEFAULT">内置公开客户端（无需自行创建应用）</option>
                      <option value="CUSTOM">使用自己的百度应用</option>
                      <option value="NONE">暂不配置</option>
                    </select>
                  </label>
                  <p className="setup-hint">
                    内置客户端只用于授权，不会把网盘密码交给
                    PTVault；授权页面上的应用名称以百度显示为准。
                  </p>
                  {values.baiduClient === 'CUSTOM' && (
                    <>
                      <label>
                        百度 Client ID
                        <input
                          value={values.baiduClientId ?? ''}
                          onChange={(event) =>
                            patch({ baiduClientId: nullable(event.target.value) })
                          }
                        />
                      </label>
                      <label>
                        百度 App ID
                        <input
                          value={values.baiduAppId ?? ''}
                          onChange={(event) => patch({ baiduAppId: nullable(event.target.value) })}
                        />
                      </label>
                      <label>
                        百度应用密钥
                        <input
                          type="password"
                          autoComplete="new-password"
                          placeholder={
                            base?.credentials.baiduClientSecret
                              ? '已保存；留空保留'
                              : '填写应用密钥'
                          }
                          value={secrets.baiduClientSecret ?? ''}
                          onChange={(event) => secret('baiduClientSecret', event.target.value)}
                        />
                      </label>
                    </>
                  )}
                </div>
              )}
              <details className="setup-advanced">
                <summary>高级：自有 OneDrive OAuth 应用</summary>
                <p>
                  已有 rclone 配置可直接导入，不必填写这里。只在使用自己注册的 OAuth
                  应用时设置回调。
                </p>
                <div className="setup-fields">
                  <label>
                    OneDrive Client ID
                    <input
                      value={values.oneDriveClientId ?? ''}
                      onChange={(event) =>
                        patch({ oneDriveClientId: nullable(event.target.value) })
                      }
                    />
                  </label>
                  <label>
                    OneDrive 租户
                    <input
                      value={values.oneDriveTenant}
                      onChange={(event) => patch({ oneDriveTenant: event.target.value })}
                    />
                  </label>
                  <label>
                    OneDrive 应用密钥（如有）
                    <input
                      type="password"
                      autoComplete="new-password"
                      placeholder={base?.credentials.oneDriveClientSecret ? '已保存；留空保留' : ''}
                      value={secrets.oneDriveClientSecret ?? ''}
                      onChange={(event) => secret('oneDriveClientSecret', event.target.value)}
                    />
                  </label>
                  <label>
                    公网 HTTPS 回调站点
                    <input
                      type="url"
                      placeholder="https://vault.example.com"
                      value={values.oauthCallbackOrigin ?? ''}
                      onChange={(event) =>
                        patch({ oauthCallbackOrigin: nullable(event.target.value) })
                      }
                    />
                  </label>
                </div>
              </details>
            </section>
          )}
          {(netdisk || pt) && (
            <section className="setup-section" id="file-locations">
              <div className="setup-section-heading">
                <span>03</span>
                <div>
                  <h2>确认文件在服务器上的位置</h2>
                  <p>
                    这里填服务器路径，不是当前电脑的路径。不会修改 qBittorrent
                    的下载目录，也不会递归更改媒体权限。
                  </p>
                </div>
              </div>
              <div className="setup-fields">
                {netdisk && (
                  <label>
                    临时文件目录
                    <input
                      aria-label="临时文件目录"
                      aria-describedby="setup-spool-help"
                      value={values.spoolRoot}
                      onChange={(event) => patch({ spoolRoot: event.target.value })}
                    />
                    <small id="setup-spool-help">
                      下载、解压与校验在这里进行。更换目录会等待已有任务与保留断点处理完毕。
                    </small>
                  </label>
                )}
                {pt && (
                  <label>
                    允许读取的来源目录
                    <LineListInput
                      placeholder="每行一个绝对目录"
                      value={values.sourceRoots}
                      onChange={(sourceRoots) => patch({ sourceRoots })}
                    />
                  </label>
                )}
              </div>
              <div className="setup-actions">
                {netdisk && (
                  <button
                    className="ghost-button"
                    disabled={checking || busy || dirty}
                    onClick={() => void probe('SPOOL')}
                  >
                    <FolderOpen size={16} />
                    {checking ? '检查中…' : '检查临时目录'}
                  </button>
                )}
              </div>
              {dirty && <p className="setup-hint">路径检查使用已保存的草稿。请先在下方选择“仅保存草稿”，检查通过后再应用；保存草稿不会改变当前运行设置。</p>}
              {pt && (
                <details className="setup-advanced">
                  <summary>检查一个实际文件与容器路径映射</summary>
                  <div className="setup-fields">
                    <label>
                      qBittorrent 报告的文件位置
                      <input
                        value={samplePath}
                        onChange={(event) => setSamplePath(event.target.value)}
                      />
                    </label>
                    <label>
                      检查使用的路径映射
                      <textarea
                        rows={2}
                        placeholder="/downloads=/srv/downloads，每行一项"
                        value={sampleMaps}
                        onChange={(event) => setSampleMaps(event.target.value)}
                      />
                    </label>
                  </div>
                  <p className="setup-hint">
                    只读取所选普通文件的1字节，不上传内容。正式实例映射仍在 qBittorrent
                    连接设置中保存。
                  </p>
                  <button
                    className="ghost-button"
                    disabled={checking || busy || dirty || !samplePath}
                    onClick={() => void probe('SOURCE')}
                  >
                    检查文件可读性
                  </button>
                </details>
              )}
              {pathResult && (
                <div className="setup-check-result">
                  <strong>{PATH_RESULTS[pathResult.outcome]}</strong>
                  <p>
                    服务账户：{pathResult.serviceUser}
                    {pathResult.serviceUid === null ? '' : `（UID ${pathResult.serviceUid}）`}
                  </p>
                  {pathResult.hostPath && (
                    <p>
                      服务器位置：<code>{pathResult.hostPath}</code>
                    </p>
                  )}
                  {pathResult.availableBytes && (
                    <p>此账户可用空间：{formatBytes(Number(pathResult.availableBytes))}</p>
                  )}
                  {pathResult.suggestedBudget && (
                    <p>
                      建议暂存预算 {formatBytes(Number(pathResult.suggestedBudget.maxBytes))}，预留{' '}
                      {formatBytes(Number(pathResult.suggestedBudget.reserveBytes))}
                      。这是本次检查的建议，不会覆盖你保存的预算。
                      <Link to="/settings/netdisk?from=setup#netdisk-spool">查看与调整预算</Link>
                    </p>
                  )}
                </div>
              )}
            </section>
          )}
          {(netdisk || pt) && (
            <section className="setup-section" id="recovery-accounts">
              <div className="setup-section-heading">
                <span>04</span>
                <div>
                  <h2>准备恢复资料</h2>
                  <p>
                    媒体的默认目标和恢复资料副本是两件事。请选择两个不同的已接入账户，然后到恢复页保存恢复资料并完成检查。
                  </p>
                </div>
              </div>
              {accounts.isPending ? (
                <p>正在读取账户…</p>
              ) : accounts.isError ? (
                <p>账户列表暂时不可用，可稍后返回。</p>
              ) : accounts.data?.length ? (
                <div className="setup-account-choices">
                  {accounts.data.map((account) => (
                    <label key={account.id}>
                      <input
                        type="checkbox"
                        checked={values.recoveryAccountIds.includes(account.id)}
                        onChange={() =>
                          patch({
                            recoveryAccountIds: values.recoveryAccountIds.includes(account.id)
                              ? values.recoveryAccountIds.filter((id) => id !== account.id)
                              : [...values.recoveryAccountIds, account.id],
                          })
                        }
                      />
                      {account.label}
                      <small>
                        {account.health === 'HEALTHY' ? '最近检查可用' : '仍需账户检查'}
                      </small>
                    </label>
                  ))}
                </div>
              ) : (
                <p>还没有存储账户。先到上一步接入；不用手填内部账户 ID。</p>
              )}
              <Link className="ghost-button" to="/recovery?from=setup">
                前往恢复资料与检查 <ArrowRight size={16} />
              </Link>
            </section>
          )}
          {media && (
            <section className="setup-section">
              <div className="setup-section-heading">
                <span>05</span>
                <div>
                  <h2>接入 Jellyfin</h2>
                  <p>
                    {pt
                      ? '本地 PT 迁移会核对正在播放的内容，不会为了简化设置移除这项保护。'
                      : 'Jellyfin 只读取独立发布目录，不需要访问 PTVault 的数据库或密钥目录。'}
                  </p>
                </div>
              </div>
              <div className="setup-fields">
                <label>
                  Jellyfin 地址
                  <input
                    type="url"
                    placeholder="http://127.0.0.1:8096"
                    value={values.jellyfinUrl ?? ''}
                    onChange={(event) => patch({ jellyfinUrl: nullable(event.target.value) })}
                  />
                </label>
                <label>
                  Jellyfin API 密钥
                  <input
                    type="password"
                    autoComplete="new-password"
                    placeholder={
                      base?.credentials.jellyfinToken
                        ? '已保存；留空保留'
                        : '填写 Jellyfin API 密钥'
                    }
                    value={secrets.jellyfinToken ?? ''}
                    onChange={(event) => secret('jellyfinToken', event.target.value)}
                  />
                </label>
                <label>
                  {pt ? '本地媒体所在的热存储目录' : '本地媒体目录（可选）'}
                  <input
                    value={values.mediaHotRoot ?? ''}
                    onChange={(event) => patch({ mediaHotRoot: nullable(event.target.value) })}
                  />
                  {!pt && <small>只看云端时可留空，使用安装器提供的空目录；不会要求你另建一份本地媒体。</small>}
                </label>
                <label>
                  Jellyfin 容器到服务器的路径映射
                  <LineListInput
                    placeholder="/srv/ptvault-public=/srv/ptvault-public，每行一项"
                    value={values.jellyfinPathMaps}
                    onChange={(jellyfinPathMaps) => patch({ jellyfinPathMaps })}
                  />
                </label>
              </div>
              <p className="setup-hint">
                接入后，仍需在 Jellyfin 中添加可读的媒体路径；这里不会删除、移动或重组已有媒体库。
              </p>
              <p className="setup-hint">容器部署请把整个 <code>/srv/ptvault-public</code> 按同一绝对路径只读挂入 Jellyfin，并使用 <code>rslave</code> 传播；库目录再选其中的 <code>library</code>。只把 library 改名挂成 /cloud，会让绝对链接找不到云端文件。</p>
            </section>
          )}
          <section className="setup-save" aria-labelledby="setup-save-title">
            <div>
              <h2 id="setup-save-title">保存与生效</h2>
              <p>
                {dirty
                  ? '有未保存的修改。保存草稿后可离开并继续其他设置。'
                  : view?.pendingChanges
                    ? '草稿已保存，仍有尚未应用的设置。'
                    : '这一版安装设置已生效；账户和任务的缺项见下面。'}
              </p>
              <p className="setup-hint">
                只在任务和数据操作空闲时应用，不会强停下载、清理断点或重置已有策略。若还保留失败任务的缓存，更换目录会继续等待。
              </p>
              {view?.lastError && (
                <p role="alert">上次应用失败。最后可用的配置继续保留，请核对填写内容后重试。</p>
              )}
            </div>
            <label>
              验证器中的6位数字
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={mfa}
                onChange={(event) => setMfa(event.target.value.replace(/\D/g, ''))}
              />
            </label>
            <div className="setup-actions">
              <button
                className="ghost-button"
                disabled={busy || !dirty}
                onClick={() => void save(false)}
              >
                <Save size={16} />
                仅保存草稿
              </button>
              <button
                className="primary-button"
                disabled={
                  busy || (!dirty && !view?.pendingChanges) || (overview.data?.applying ?? false)
                }
                onClick={() => void save(true)}
              >
                <Check size={16} />
                {busy ? '正在保存…' : dirty ? '保存并应用' : '应用已保存设置'}
              </button>
            </div>
            {notice && <p role="status">{notice}</p>}
            {error && <p role="alert">{error}</p>}
            {live && base && live.revision !== base.revision && dirty && <div className="setup-notice"><p>服务器已有另一版设置。本页修改仍保留；请先核对，再选择是否用服务器版本重新开始。</p><button className="ghost-button" onClick={() => { setBase(live); setValues(live.values); setSecrets({}); setMfa(''); setError(''); setPathResult(null); intent.current = null; }}>载入服务器版本并放弃本页修改</button></div>}
            {overview.data?.applying && (
              <p className="setup-hint">正在等待或应用这次设置。页面会自动检查新状态。</p>
            )}
          </section>
        </fieldset>
      )}
      {overview.data && (
        <section className="setup-section">
          <div className="setup-section-heading">
            <span>
              <Check size={18} />
            </span>
            <div>
              <h2>现在还需要做什么</h2>
              <p>状态来自当前运行组件，不把“配置已填写”当成整个流程已经验通。</p>
            </div>
          </div>
          <ul className="setup-checks">
            {overview.data.checks
              .filter((item) => item.state !== 'NOT_SELECTED')
              .map((item) => (
                <li key={item.id}>
                  <span className={`setup-state ${item.state === 'READY' ? 'ready' : ''}`}>
                    {item.state === 'READY' ? '已就绪' : '待设置'}
                  </span>
                  <div>
                    <strong>{item.label}</strong>
                    <p>{item.detail}</p>
                  </div>
                  <Link to={item.href}>
                    查看 <ArrowRight size={14} />
                  </Link>
                </li>
              ))}
          </ul>
          <button className="ghost-button" onClick={() => void overview.refetch()}>
            <RefreshCw size={15} />
            刷新真实状态
          </button>
          <p className="setup-hint">
            准备好后，在网盘设置中手动开启新建任务，再主动选择一份小文件试用。不会自动扫描并迁移所有来源。
          </p>
        </section>
      )}
      <details className="setup-section setup-diagnostics">
        <summary>查看脱敏诊断摘要</summary>
        <p>
          下载前可先检查内容。摘要不包含访问令牌、应用密钥、用户名、网盘文件名、服务器路径或原始日志。
        </p>
        <pre aria-label="诊断摘要预览">{diagnostic}</pre>
        <button className="ghost-button" onClick={download}>
          <Download size={16} />
          下载这份摘要
        </button>
      </details>
    </section>
  );
}
