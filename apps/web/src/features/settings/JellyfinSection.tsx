import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, Cloud, HardDrive, Plug, TriangleAlert } from 'lucide-react';

import type { JellyfinLibrary } from '@ptvault/contracts';

import { formatAge } from '../../ui/format.js';
import { getJellyfinInfo, jellyfinInfoQueryKey, testJellyfin } from './settingsApi.js';

const CONNECTION_ERRORS: Record<string, string> = {
  NOT_CONFIGURED: '这台机器上没有配置 Jellyfin。',
  AUTH_FAILED: '地址是通的，但令牌被拒了。检查令牌文件里的那串是否还有效。',
  UNREACHABLE: '连不上这个地址。检查 Jellyfin 是否在跑、端口对不对。',
  BAD_RESPONSE: '那个地址上有服务在答话，但答的不是 Jellyfin。',
  NOTIFICATION_REJECTED: '能连上、也认令牌，但刷新媒体库的调用被拒——回迁完成后它不会自动出现。',
};

/** Configuration evidence only: roots and content types do not prove playback. */
function LibraryRow({ library }: { library: JellyfinLibrary }) {
  const verdict =
    (library.typeConflicts?.length ?? 0) > 0
      ? {
          tone: 'warn' as const,
          text: '存在跨媒体库路径重叠与内容类型冲突，分类列表可能遗漏已索引条目',
        }
      : library.covered
        ? { tone: 'ok' as const, text: '本地与云端根路径配置对应；尚未验证发布完整度或实际播放' }
        : library.hasLocal
          ? {
              tone: 'warn' as const,
              text: '本地路径未找到对应的云端根路径覆盖；迁移后列表与播放待验证',
            }
          : library.hasCloud
            ? { tone: 'ok' as const, text: '只挂了云端路径' }
            : { tone: 'muted' as const, text: '这个库的路径不在本站管辖的两棵树里' };

  return (
    <li className="library-row" data-tone={verdict.tone}>
      <div className="library-head">
        <span className="library-name">{library.name}</span>
        <span className="library-tags">
          {library.hasLocal ? (
            <span className="library-tag">
              <HardDrive size={12} strokeWidth={2} aria-hidden="true" /> 本地
            </span>
          ) : null}
          {library.hasCloud ? (
            <span className="library-tag">
              <Cloud size={12} strokeWidth={2} aria-hidden="true" /> 云端
            </span>
          ) : null}
          {library.collectionType === null ? null : (
            <span className="library-tag is-plain">{library.collectionType}</span>
          )}
        </span>
      </div>
      <p className="library-verdict">{verdict.text}</p>
      {library.typeConflicts?.map((conflict, index) => (
        <p className="field-hint" key={index}>
          与「{conflict.libraryName}」（{conflict.collectionType ?? '混合'}）重叠：
          <code>{conflict.path}</code> / <code>{conflict.otherPath}</code>。
          需先备份并确认调整方案；此诊断不会改库、扫描或修改观看记录。
        </p>
      ))}
      <ul className="library-paths">
        {library.locations.map((location) => (
          <li key={location.path}>
            <code>{location.path}</code>
          </li>
        ))}
      </ul>
    </li>
  );
}

/**
 * The Jellyfin connection, read-only.
 *
 * Read-only because it genuinely is: the address, the token file and the path
 * maps come from the API's environment, and the endpoint offers no way to write
 * them. Drawing an editable form over values that can only be changed by editing
 * a systemd unit would be a form that silently does nothing.
 */
export function JellyfinSection({ now }: { now: number }) {
  const infoQuery = useQuery({ queryKey: jellyfinInfoQueryKey, queryFn: getJellyfinInfo });
  const probe = useMutation({ mutationFn: testJellyfin });

  if (infoQuery.isPending) return <p className="settings-loading">正在读取 Jellyfin 配置…</p>;

  if (infoQuery.isError) {
    return (
      <p className="inline-message error-message" role="alert">
        <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
        读不到 Jellyfin 配置。这说的是本站的接口，不是 Jellyfin 本身出了问题。
      </p>
    );
  }

  const probed = infoQuery.data;
  if (probed === undefined || !probed.supported) {
    return (
      <p className="inline-message" role="note">
        <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
        这台机器上的 API 版本还没有 Jellyfin 配置接口，所以这里读不出「现在配的是什么」。
        配置本身仍由服务端环境变量决定。
      </p>
    );
  }

  const info = probed.data;

  if (!info.configured) {
    return (
      <div className="settings-card">
        <p className="settings-empty">
          没有配置
          Jellyfin。回迁完成后不会有人通知媒体库刷新，删本地副本前也不会检查是否有人正在播放。
        </p>
        <p className="field-hint">
          它由服务端环境变量决定（<code>PTVAULT_JELLYFIN_URL</code> 与
          <code>PTVAULT_JELLYFIN_TOKEN_FILE</code> 必须同时给，配了就还要
          <code>PTVAULT_JELLYFIN_PATH_MAPS</code>），要改得登上机器改 systemd 配置再重启，
          这一页只读不写。
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="settings-card">
        <h3>连接</h3>
        <dl className="instance-meta">
          <div>
            <dt>地址</dt>
            <dd>
              <span className="instance-meta-value is-mono">{info.baseUrl}</span>
            </dd>
          </div>
          <div>
            <dt>令牌文件</dt>
            <dd>
              <span className="instance-meta-value is-mono">{info.tokenFile}</span>
            </dd>
          </div>
          <div>
            <dt>路径映射</dt>
            <dd>
              {info.pathMaps.length === 0 ? (
                <span className="instance-meta-value is-unknown">无</span>
              ) : (
                <span className="instance-meta-value is-mono">{info.pathMaps.join(' · ')}</span>
              )}
            </dd>
          </div>
          <div>
            <dt>最近读取</dt>
            <dd>
              {info.error !== null ? (
                <span className="instance-meta-value is-bad">
                  <TriangleAlert size={13} strokeWidth={2} aria-hidden="true" />
                  {CONNECTION_ERRORS[info.error] ?? info.error}
                </span>
              ) : info.checkedAt === null ? (
                <span className="instance-meta-value is-unknown">还没读过</span>
              ) : (
                <span className="instance-meta-value">{formatAge(info.checkedAt, now)}</span>
              )}
            </dd>
          </div>
        </dl>

        <div className="instance-editor-test">
          <button
            type="button"
            className="ghost-button"
            onClick={() => probe.mutate()}
            disabled={probe.isPending}
          >
            <Plug size={15} strokeWidth={1.9} aria-hidden="true" />
            {probe.isPending ? '正在连接…' : '测试连接'}
          </button>
          <JellyfinTestOutcome pending={probe.isPending} failed={probe.isError} data={probe.data} />
        </div>
      </div>

      <div className="settings-card">
        <h3>媒体库</h3>
        <p className="field-hint">
          这里检查根路径配置覆盖和跨库内容类型冲突，不代表文件已完整发布。
          发布完整度、库内列表、具体条目播放及继续观看进度均需另外验收；连接成功或扫描成功不等于播放验证通过。
        </p>
        {info.libraries.length === 0 ? (
          <p className="settings-empty">
            {info.error === null
              ? '这台 Jellyfin 上没有库，或者它们都不在本站管辖的路径里。'
              : '没读到库——上面那条错误说明了原因。'}
          </p>
        ) : (
          <ul className="library-list">
            {info.libraries.map((library) => (
              <LibraryRow key={library.name} library={library} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/**
 * The test result, with `notificationAccepted` reported separately from `ok`.
 *
 * They can differ, and the difference matters: a server that authenticates fine
 * but refuses the library-refresh call will look healthy while quietly failing
 * to show restored titles until someone scans manually.
 */
function JellyfinTestOutcome({
  pending,
  failed,
  data,
}: {
  pending: boolean;
  failed: boolean;
  data: Awaited<ReturnType<typeof testJellyfin>> | undefined;
}) {
  if (pending) return <span className="test-result">正在拨号…</span>;
  if (failed) {
    return (
      <span className="test-result is-bad" role="status">
        <TriangleAlert size={14} strokeWidth={1.9} aria-hidden="true" />
        测试端点本身没能完成，这不代表 Jellyfin 有问题。
      </span>
    );
  }
  if (data === undefined) {
    return <span className="test-result is-idle">会拨一次号，并试一次媒体库刷新调用。</span>;
  }
  if (!data.supported) {
    return (
      <span className="test-result is-idle" role="status">
        这台机器上的 API 版本还没有这个能力。
      </span>
    );
  }
  const result = data.data;
  if (result.ok) {
    return (
      <span className="test-result is-good" role="status">
        <CheckCircle2 size={14} strokeWidth={1.9} aria-hidden="true" />
        已连接 · {result.serverName ?? 'Jellyfin'} {result.version ?? ''}
        {result.notificationAccepted ? ' · 刷新调用已被接受' : ' · 但刷新调用没被接受'}
      </span>
    );
  }
  return (
    <span className="test-result is-bad" role="status">
      <TriangleAlert size={14} strokeWidth={1.9} aria-hidden="true" />
      {result.error === null
        ? '没能连上，原因未知。'
        : (CONNECTION_ERRORS[result.error] ?? result.error)}
    </span>
  );
}
