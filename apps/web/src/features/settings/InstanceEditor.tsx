import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Plug, Plus, TriangleAlert, X } from 'lucide-react';
import { useId, useState } from 'react';

import { ApiError } from '../../api/client.js';
import {
  qbInstancesQueryKey,
  saveInstance,
  testInstance,
  type QbInstanceConfigInput,
  type QbInstanceSummary,
} from '../torrents/qbApi.js';

export type InstanceEditorProps = {
  /** Null opens the form in "add a new instance" mode. */
  instance: QbInstanceSummary | null;
  /**
   * Whether the API this browser is talking to stores per-instance path
   * mappings. False hides the editor instead of drawing an empty one: an old API
   * strips the unknown key, so the operator would fill the field, save
   * successfully, and get nothing.
   */
  supportsPathMaps: boolean;
  onClose: () => void;
};

type PathMapRow = { from: string; to: string };

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'QB_CREDENTIAL_TARGET_CHANGED') return error.message;
    if (error.status === 401) return '会话已过期，请重新登录后再保存。';
    if (error.status === 400) return `${error.message}（路径映射需写成 /容器内路径=/宿主机路径）`;
    return error.message;
  }
  return '保存实例配置失败。';
}

/** Splits stored `"/a=/b"` entries into the two fields the form edits. */
function toRows(pathMaps: readonly string[] | undefined): PathMapRow[] {
  if (pathMaps === undefined) return [];
  return pathMaps.map((entry) => {
    const separator = entry.indexOf('=');
    if (separator <= 0) return { from: entry, to: '' };
    return { from: entry.slice(0, separator), to: entry.slice(separator + 1) };
  });
}

/**
 * Why a row cannot be stored, in the operator's terms, or null when it is fine.
 *
 * Checked here as well as on the server because the server's answer is one 400
 * for the whole request: the form knows *which* row is wrong and can say so next
 * to it. The comma rule is the one that needs explaining — a comma is a perfectly
 * legal character in a POSIX path, and it is refused for a reason that lives in
 * the storage column rather than in anything the operator can see.
 */
function rowProblem(row: PathMapRow): string | null {
  const from = row.from.trim();
  const to = row.to.trim();
  if (from === '' && to === '') return null;
  if (from === '' || to === '') return '两侧都要填，只填一侧不会生效。';
  if (!from.startsWith('/') || !to.startsWith('/')) return '两侧都必须是以 / 开头的绝对路径。';
  if (from.includes(',') || to.includes(','))
    return '不能含英文逗号——这一列是逗号分隔存的，收下会被拆成两条错规则。';
  if (`${from}=${to}`.length > 512) return '这一条太长了（两侧加起来上限 512 字符）。';
  return null;
}

function isBlank(row: PathMapRow): boolean {
  return row.from.trim() === '' && row.to.trim() === '';
}

/**
 * The one form for a qB instance: which qB to poll, the credentials to poll it
 * with, and how its paths map onto this machine's.
 *
 * It lives on the settings page rather than on the torrents page because there
 * were two ways to reach it and only one of them could grow the path-mapping
 * editor without the two drifting apart.
 *
 * Everything here writes *our own* config. It touches no torrent and no media
 * file, which is why it is not behind a verification code the way the migrate
 * and delete paths are.
 */
export function InstanceEditor({ instance, supportsPathMaps, onClose }: InstanceEditorProps) {
  const isNew = instance === null;
  const titleId = useId();
  const queryClient = useQueryClient();

  const [id, setId] = useState(instance?.id ?? '');
  const [displayName, setDisplayName] = useState(instance?.displayName ?? '');
  const [baseUrl, setBaseUrl] = useState(instance?.baseUrl ?? '');
  const [username, setUsername] = useState(instance?.username ?? '');
  const [password, setPassword] = useState('');
  const [enabled, setEnabled] = useState(instance?.enabled ?? true);
  const [rows, setRows] = useState<PathMapRow[]>(() => toRows(instance?.pathMaps));
  /**
   * Whether the mapping list was edited at all.
   *
   * An untouched list must be sent as *no key*, not as the array we happen to be
   * holding: the server keeps what is stored when the key is absent, and a
   * rename posted from this form has no business overwriting a mapping set
   * somewhere else. Only a deliberate edit earns the right to send `[]`.
   */
  const [pathMapsTouched, setPathMapsTouched] = useState(false);

  const mutation = useMutation({
    mutationFn: (input: QbInstanceConfigInput) => saveInstance(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qbInstancesQueryKey });
      onClose();
    },
  });

  const probe = useMutation({
    mutationFn: () =>
      testInstance({ baseUrl: baseUrl.trim(), username: username.trim(), password }),
  });

  const editRows = (next: PathMapRow[]): void => {
    setPathMapsTouched(true);
    setRows(next);
  };

  const credentialTargetChanged = (() => {
    if (instance === null || instance.baseUrl == null) return false;
    try {
      return new URL(baseUrl.trim()).href.replace(/\/+$/, '') !== new URL(instance.baseUrl).href.replace(/\/+$/, '') ||
        username.trim() !== instance.username;
    } catch { return true; }
  })();
  const requiresPassword = isNew || instance.hasCredential !== true || credentialTargetChanged;
  const rowProblems = rows.map(rowProblem);
  const hasRowProblem = rowProblems.some((problem) => problem !== null);
  const canSubmit =
    id.trim() !== '' &&
    displayName.trim() !== '' &&
    baseUrl.trim() !== '' &&
    username.trim() !== '' &&
    (!requiresPassword || password !== '') &&
    !hasRowProblem &&
    !mutation.isPending;
  // The test dials with what is typed and has no stored secret to fall back on,
  // so it needs a password even where saving would not.
  const canTest =
    baseUrl.trim() !== '' && username.trim() !== '' && password !== '' && !probe.isPending;

  return (
    <section className="instance-editor" aria-labelledby={titleId}>
      <header className="instance-editor-head">
        <div>
          <p className="settings-eyebrow">{isNew ? '新建' : id}</p>
          <h3 id={titleId}>{isNew ? '添加 qBittorrent 实例' : '编辑实例'}</h3>
          <p className="settings-lede">仅写入本站轮询配置，不触碰任何种子或媒体文件。</p>
        </div>
        <button type="button" className="inventory-inspect" onClick={onClose} aria-label="关闭">
          <X size={15} strokeWidth={1.9} aria-hidden="true" />
        </button>
      </header>

      <form
        className="instance-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) return;
          const input: QbInstanceConfigInput = {
            id: id.trim(),
            displayName: displayName.trim(),
            enabled,
            baseUrl: baseUrl.trim(),
            username: username.trim(),
          };
          // Omitted rather than sent empty, so the server keeps the stored secret.
          if (password !== '') input.password = password;
          if (supportsPathMaps && pathMapsTouched) {
            input.pathMaps = rows
              .filter((row) => !isBlank(row))
              .map((row) => `${row.from.trim()}=${row.to.trim()}`);
          }
          mutation.mutate(input);
        }}
      >
        <div className="editor-grid">
          <label className="field">
            <span>实例 ID</span>
            <input
              type="text"
              value={id}
              onChange={(event) => setId(event.target.value)}
              // The ID anchors the credential's secret_ref; changing it would
              // orphan the stored password, so it is fixed after creation.
              readOnly={!isNew}
              required
              autoComplete="off"
              placeholder="main"
            />
            <small className="field-hint">
              小写字母、数字、连字符或下划线，最长 32 字符。创建后不可更改。
            </small>
          </label>

          <label className="field">
            <span>显示名称</span>
            <input
              type="text"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
              autoComplete="off"
              placeholder="主 PT 实例"
            />
            <small className="field-hint">只用于界面，随时可改。</small>
          </label>

          <label className="field">
            <span>WebUI 地址</span>
            <input
              type="url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              required
              autoComplete="off"
              placeholder="http://127.0.0.1:8080"
            />
            <small className="field-hint">仅接受 http/https；明文 http 只允许指向本机。</small>
          </label>

          <label className="field">
            <span>用户名</span>
            <input
              type="text"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
              autoComplete="off"
            />
          </label>

          <label className="field editor-span-2">
            <span>密码</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required={requiresPassword}
              autoComplete="new-password"
              placeholder={requiresPassword ? '' : '留空则沿用已保存的密码'}
            />
            <small className="field-hint">
              {credentialTargetChanged ? '连接目标或用户名已更改，请重新输入密码；原密码不会发送给新目标。' : null}
              密码以主密钥加密后落库，绝不明文存储，也不会通过接口返回。
              {requiresPassword ? '' : '留空表示沿用已保存的密码；测试连接则必须重新输入。'}
            </small>
          </label>
        </div>

        {supportsPathMaps ? (
          <fieldset className="pathmap-set">
            <legend>路径映射</legend>
            <p className="field-hint">
              qB 报的是它容器里的路径，本机读的是宿主机路径。两者不一致时，预检会报「文件不存在」
              ——文件其实就在盘上。这里填的映射只对这个实例生效，会<strong>替换</strong>
              全局设置而不是叠加。
            </p>

            {rows.length === 0 ? (
              <p className="pathmap-empty">没有映射，qB 报什么路径就按什么路径读。</p>
            ) : (
              <ul className="pathmap-list">
                {rows.map((row, index) => {
                  const problem = rowProblems[index];
                  return (
                    // Index-keyed on purpose: rows have no identity of their own,
                    // and any content-derived key would remount the input the
                    // operator is typing in on every keystroke.
                    <li key={index} className="pathmap-row" data-invalid={problem !== null}>
                      <div className="pathmap-pair">
                        <input
                          type="text"
                          value={row.from}
                          aria-label={`第 ${index + 1} 条映射的容器内路径`}
                          placeholder="/downloads"
                          autoComplete="off"
                          onChange={(event) =>
                            editRows(
                              rows.map((current, at) =>
                                at === index ? { ...current, from: event.target.value } : current,
                              ),
                            )
                          }
                        />
                        <span className="pathmap-arrow" aria-hidden="true">
                          =
                        </span>
                        <input
                          type="text"
                          value={row.to}
                          aria-label={`第 ${index + 1} 条映射的宿主机路径`}
                          placeholder="/mnt/data/downloads"
                          autoComplete="off"
                          onChange={(event) =>
                            editRows(
                              rows.map((current, at) =>
                                at === index ? { ...current, to: event.target.value } : current,
                              ),
                            )
                          }
                        />
                        <button
                          type="button"
                          className="inventory-inspect"
                          aria-label={`移除第 ${index + 1} 条映射`}
                          onClick={() => editRows(rows.filter((_, at) => at !== index))}
                        >
                          <X size={14} strokeWidth={2} aria-hidden="true" />
                        </button>
                      </div>
                      {problem === null ? null : <p className="pathmap-problem">{problem}</p>}
                    </li>
                  );
                })}
              </ul>
            )}

            <button
              type="button"
              className="ghost-button"
              onClick={() => editRows([...rows, { from: '', to: '' }])}
              disabled={rows.length >= 16}
            >
              <Plus size={14} strokeWidth={2} aria-hidden="true" />
              添加一条映射
            </button>
          </fieldset>
        ) : (
          <p className="inline-message" role="note">
            <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
            这台机器上的 API 版本还没有每实例路径映射，所以这里不显示这个字段——
            显示了也存不进去。路径改写目前走全局设置。
          </p>
        )}

        <label className="instance-form-checkbox">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span>启用（纳入定时库存同步）</span>
        </label>

        <div className="instance-editor-test">
          <button
            type="button"
            className="ghost-button"
            onClick={() => probe.mutate()}
            disabled={!canTest}
          >
            <Plug size={15} strokeWidth={1.9} aria-hidden="true" />
            {probe.isPending ? '正在连接…' : '测试连接'}
          </button>
          <TestOutcome
            state={probe.isPending ? 'pending' : probe.isError ? 'error' : 'idle'}
            data={probe.data}
            error={probe.error}
            needsPassword={password === ''}
          />
        </div>

        {mutation.isError ? (
          <p className="inline-message error-message" role="alert">
            <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />{' '}
            {errorMessage(mutation.error)}
          </p>
        ) : null}

        <div className="instance-form-actions">
          <button type="button" className="ghost-button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary-button" disabled={!canSubmit}>
            {mutation.isPending ? '正在保存…' : '保存'}
          </button>
        </div>
      </form>
    </section>
  );
}

const TEST_FAILURES: Record<'UNREACHABLE' | 'AUTH_FAILED' | 'BAD_RESPONSE', string> = {
  UNREACHABLE: '连不上这个地址。检查 qB 是否在跑、端口对不对、WebUI 有没有开。',
  AUTH_FAILED: '地址是通的，但用户名或密码不对。',
  BAD_RESPONSE: '那个地址上有服务在答话，但答的不是 qBittorrent。',
};

/**
 * The result of a connection test, including the two outcomes that are not
 * "your qB said no".
 *
 * A 404 means this browser's bundle is newer than the API it is talking to —
 * they deploy down separate paths — and is reported as a missing capability
 * rather than a failed test, because telling the operator their instance is
 * unreachable when it is fine sends them to re-check a password that was never
 * wrong.
 */
function TestOutcome({
  state,
  data,
  error,
  needsPassword,
}: {
  state: 'idle' | 'pending' | 'error';
  data:
    | { supported: true; result: { ok: boolean; version: string | null; error: string | null } }
    | { supported: false }
    | undefined;
  error: unknown;
  needsPassword: boolean;
}) {
  if (state === 'pending') return <span className="test-result">正在拨号…</span>;
  if (state === 'error') {
    return (
      <span className="test-result is-bad" role="status">
        <TriangleAlert size={14} strokeWidth={1.9} aria-hidden="true" />
        {error instanceof ApiError && error.status === 401
          ? '会话已过期，请重新登录。'
          : '测试端点本身没能完成，这不代表 qB 有问题。'}
      </span>
    );
  }
  if (data === undefined) {
    return (
      <span className="test-result is-idle">
        {needsPassword ? '测试需要重新输入密码（不会用已存的那份）。' : '不会写入任何一侧。'}
      </span>
    );
  }
  if (!data.supported) {
    return (
      <span className="test-result is-idle" role="status">
        这台机器上的 API 版本还没有测试连接这个能力。保存不受影响。
      </span>
    );
  }
  if (data.result.ok) {
    return (
      <span className="test-result is-good" role="status">
        <CheckCircle2 size={14} strokeWidth={1.9} aria-hidden="true" />
        已连接 · qBittorrent {data.result.version ?? '（未报版本）'}
      </span>
    );
  }
  const code = data.result.error;
  return (
    <span className="test-result is-bad" role="status">
      <TriangleAlert size={14} strokeWidth={1.9} aria-hidden="true" />
      {code !== null && code in TEST_FAILURES
        ? TEST_FAILURES[code as keyof typeof TEST_FAILURES]
        : '没能连上，原因未知。'}
    </span>
  );
}
