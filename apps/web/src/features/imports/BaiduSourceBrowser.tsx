import { ImportFileIdentitySchema, type BaiduConnectionBrowseEntry } from '@ptvault/contracts';
import {
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  File,
  Folder,
  FolderOpen,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { ApiError, ContractError } from '../../api/client.js';
import { browseConnection } from '../storage/connectionApi.js';
import { formatDecimalBytes } from './importFormatting.js';
import { BaiduNameSearch } from './BaiduNameSearch.js';
import {
  addSourceDirectory,
  MAX_SOURCE_DIRECTORIES,
  removeSourceDirectory,
  sourceDirectoryKey,
  type SourceDirectory,
  type SourceFile,
} from './sourceSelection.js';

const ROOT = '/';

function parentPath(path: string): string | null {
  if (path === ROOT) return null;
  const parent = path.slice(0, path.lastIndexOf('/')) || ROOT;
  return parent.startsWith('/') ? parent : ROOT;
}

function browseError(error: unknown): string {
  if (error instanceof ContractError) {
    return '网页与服务端的百度目录契约不一致；没有选中任何来源。';
  }
  if (!(error instanceof ApiError)) return '目录响应中断；没有选中任何来源，可重新读取。';
  switch (error.code) {
    case 'RATE_LIMITED':
      return '这个百度连接正在被服务商限速；同一连接的任务共用等待，其他连接不受影响。';
    case 'BAIDU_CONNECTION_NOT_FOUND':
      return '这个百度连接已经不存在，请刷新账户列表。';
    case 'BAIDU_CONNECTION_NOT_BROWSABLE':
      return '服务端没有授予这个连接来源浏览能力。';
    case 'AUTH_IDENTITY_DRIFT':
      return '连接身份与冻结身份不一致；请先在存储账户页重新授权。';
    case 'AUTH_EXPIRED':
    case 'AUTH_SCOPE_INSUFFICIENT':
      return '百度授权已过期或范围不足；请先在存储账户页重新授权。';
    case 'BAIDU_APP_PATH_INVALID':
    case 'BAIDU_SOURCE_PATH_INVALID':
      return '服务端拒绝了不规范的目录路径；请选择账户中的明确子目录。';
    case 'BAIDU_BROWSE_NOT_CONFIGURED':
      return '这台服务端尚未配置百度目录浏览。';
  }
  if (error.status === 401) return '会话已过期，请重新登录。';
  if (error.status === 429) return '这个百度连接正在被服务商限速，请稍后重试。';
  if (error.status === 404) return '这台机器上的 API 版本还没有百度目录浏览接口。';
  return '服务端没有完成目录读取；没有选中任何来源。';
}

type BrowserProps = {
  connectionId: string;
  selectedPath?: string;
  onSelect: (path: string) => void;
  selectedDirectories?: readonly SourceDirectory[];
  onConfirm?: (directories: SourceDirectory[]) => void;
  selectedFile?: SourceFile | null;
  onSelectFile?: (file: SourceFile) => void;
};

export function BaiduSourceBrowser(props: BrowserProps) {
  // An account owns its browsing history and in-flight requests, never another account.
  return <BaiduBrowserSession key={props.connectionId} {...props} />;
}

function BaiduBrowserSession({
  connectionId,
  selectedPath,
  onSelect,
  selectedDirectories = [],
  onConfirm,
  selectedFile,
  onSelectFile,
}: BrowserProps) {
  const [draft, setDraft] = useState<SourceDirectory[]>([]);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const directoryIdentities = useRef(new Map<string, SourceDirectory>());
  const [open, setOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [path, setPath] = useState(ROOT);
  const [entries, setEntries] = useState<BaiduConnectionBrowseEntry[] | null>(null);
  const [nextStart, setNextStart] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRevision = useRef(0);
  const launchButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const browserRoot = useRef<HTMLElement>(null);
  const listViewport = useRef<HTMLDivElement>(null);
  const pendingScrollTop = useRef<number | null>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (open) {
      browserRoot.current?.scrollIntoView?.({ block: 'start', behavior: 'instant' });
      closeButton.current?.focus({ preventScroll: true });
    } else if (restoreFocus.current) {
      launchButton.current?.focus();
      restoreFocus.current = false;
    }
  }, [open]);
  useLayoutEffect(() => {
    if (entries !== null && listViewport.current !== null && pendingScrollTop.current !== null) {
      listViewport.current.scrollTop = pendingScrollTop.current;
      pendingScrollTop.current = null;
    }
  }, [entries, path]);
  useEffect(
    () => () => {
      requestRevision.current += 1;
    },
    [],
  );

  const close = (): void => {
    requestRevision.current += 1;
    restoreFocus.current = true;
    setOpen(false);
    setSearchOpen(false);
    setEntries(null);
    setNextStart(null);
    setError(null);
    setPending(false);
    pendingScrollTop.current = null;
  };
  const select = (selection: string): void => {
    const identity = directoryIdentities.current.get(selection);
    if (onConfirm !== undefined && identity !== undefined) {
      try {
        addSourceDirectory([], identity);
      } catch {
        setDraftNotice('目录路径或身份不符合规范，请重新读取后再选择。');
        return;
      }
    }
    setPath(selection);
    close();
    if (onConfirm !== undefined && identity !== undefined) onConfirm([identity]);
    else onSelect(selection);
  };
  const toggle = (entry: BaiduConnectionBrowseEntry): void => {
    if (!entry.isDirectory) return;
    const candidate = { connectionId, fsid: entry.fsid, path: entry.path };
    if (draft.some((value) => sourceDirectoryKey(value) === sourceDirectoryKey(candidate))) {
      setDraft(removeSourceDirectory(draft, candidate));
      setDraftNotice(null);
      return;
    }
    let result: ReturnType<typeof addSourceDirectory>;
    try {
      result = addSourceDirectory(draft, candidate);
    } catch {
      setDraftNotice('目录路径或身份不符合规范，请重新读取后再选择。');
      return;
    }
    setDraft(result.items);
    setDraftNotice(
      result.reason === 'COVERED_BY_PARENT'
        ? `已由父目录 ${result.coveringPath} 覆盖，不会重复迁移。`
        : result.reason === 'REPLACED_DESCENDANTS'
          ? `父目录已覆盖并替换 ${result.affectedPaths.length} 个子目录：${result.affectedPaths.join('、')}`
          : result.reason === 'LIMIT_REACHED'
            ? `最多选择 ${MAX_SOURCE_DIRECTORIES} 个目录，请分批处理。`
            : result.reason === 'IDENTITY_CHANGED'
              ? '目录身份或路径已变化，请移除旧选择后重新核对。'
              : null,
    );
  };

  const selectEntry = (entry: BaiduConnectionBrowseEntry): void => {
    if (entry.isDirectory) {
      directoryIdentities.current.set(entry.path, {
        connectionId,
        fsid: entry.fsid,
        path: entry.path,
      });
      select(entry.path);
      return;
    }
    if (onSelectFile === undefined) return;
    const file: SourceFile = {
      connectionId,
      fsid: entry.fsid,
      path: entry.path,
      scope: 'FILE',
      size: entry.size,
      mtime: entry.mtime,
    };
    try {
      addSourceDirectory([], file);
      ImportFileIdentitySchema.parse({ fsid: file.fsid, size: file.size, mtime: file.mtime });
    } catch {
      setDraftNotice('文件身份或路径不完整，请重新读取后选择。');
      return;
    }
    setDraft([]);
    close();
    onSelectFile(file);
  };

  const load = async (nextPath: string, start = 0): Promise<void> => {
    setSearchOpen(false);
    const revision = ++requestRevision.current;
    setPending(true);
    setError(null);
    try {
      const answer = await browseConnection({
        id: connectionId,
        path: nextPath,
        start,
        limit: 200,
      });
      if (revision !== requestRevision.current) return;
      if (!answer.supported) {
        setError(
          answer.reason === 'ROUTE_ABSENT'
            ? '这台机器上的 API 版本还没有百度目录浏览接口。'
            : '这台服务端尚未启用百度目录浏览。',
        );
        return;
      }
      pendingScrollTop.current =
        start > 0 && answer.data.path === path ? (listViewport.current?.scrollTop ?? 0) : 0;
      setPath(answer.data.path);
      for (const entry of answer.data.entries) {
        if (entry.isDirectory)
          directoryIdentities.current.set(entry.path, {
            connectionId,
            fsid: entry.fsid,
            path: entry.path,
          });
      }
      setEntries((current) =>
        start > 0 && current !== null && answer.data.path === path
          ? [
              ...new Map(
                [...current, ...answer.data.entries].map((entry) => [entry.fsid, entry]),
              ).values(),
            ]
          : answer.data.entries,
      );
      setNextStart(answer.data.nextStart);
    } catch (cause) {
      if (revision === requestRevision.current) setError(browseError(cause));
    } finally {
      if (revision === requestRevision.current) setPending(false);
    }
  };

  if (!open) {
    return (
      <div className="baidu-browser-launch">
        <button
          ref={launchButton}
          type="button"
          className="ghost-button"
          disabled={pending}
          onClick={() => {
            setDraft(selectedDirectories.map((value) => ({ ...value })));
            setDraftNotice(null);
            for (const value of selectedDirectories)
              directoryIdentities.current.set(value.path, value);
            setOpen(true);
            const initialPath =
              selectedFile != null
                ? (parentPath(selectedFile.path) ?? ROOT)
                : selectedPath?.startsWith('/')
                  ? selectedPath
                  : path;
            setPath(initialPath);
            void load(initialPath);
          }}
        >
          {pending ? (
            <CircleDashed size={15} strokeWidth={1.8} aria-hidden="true" />
          ) : (
            <FolderOpen size={15} strokeWidth={1.9} aria-hidden="true" />
          )}
          {error === null ? '浏览来源目录' : '重新读取目录'}
        </button>
        {error === null ? null : (
          <p className="inline-message error-message" role="alert">
            <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" /> {error}
          </p>
        )}
      </div>
    );
  }

  const parent = parentPath(path);
  const parts = path.split('/').filter(Boolean);
  return (
    <section
      ref={browserRoot}
      className="baidu-browser"
      data-search-open={searchOpen}
      aria-label="百度来源目录"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <header className="baidu-browser-head">
        <div>
          <p>当前目录</p>
          <code>{path}</code>
          <nav className="baidu-browser-breadcrumbs" aria-label="来源路径">
            <button
              type="button"
              className="ghost-button"
              aria-label="回到账户根目录"
              aria-current={path === ROOT ? 'page' : undefined}
              disabled={pending || path === ROOT}
              onClick={() => void load(ROOT)}
            >
              根目录
            </button>
            {parts.map((part, index) => {
              const ancestor = `/${parts.slice(0, index + 1).join('/')}`;
              return (
                <span className="baidu-browser-crumb" key={ancestor}>
                  <span aria-hidden="true">/</span>
                  {index === parts.length - 1 ? (
                    <span aria-current="page" title={ancestor}>
                      {part}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="ghost-button"
                      title={ancestor}
                      aria-label={`前往 ${ancestor}`}
                      disabled={pending}
                      onClick={() => void load(ancestor)}
                    >
                      {part}
                    </button>
                  )}
                </span>
              );
            })}
          </nav>
          {onConfirm === undefined ? null : (
            <p>
              草稿已选 {draft.length} / {MAX_SOURCE_DIRECTORIES} 个目录
            </p>
          )}
        </div>
        <div className="baidu-browser-actions">
          <button
            ref={closeButton}
            type="button"
            className="ghost-button"
            aria-label="关闭目录浏览器"
            onClick={close}
          >
            关闭
          </button>
          {parent === null ? null : (
            <button
              type="button"
              className="ghost-button"
              disabled={pending}
              onClick={() => void load(parent)}
            >
              <ChevronLeft size={14} aria-hidden="true" /> 上一级
            </button>
          )}
          <button
            type="button"
            className="ghost-button"
            disabled={pending || searchOpen || entries === null || path === ROOT}
            onClick={() => select(path)}
          >
            {onConfirm === undefined ? '选择当前目录' : '单选当前目录'}
          </button>
          {searchOpen ? null : (
            <button
              type="button"
              className="ghost-button"
              disabled={pending}
              onClick={() => {
                setError(null);
                setSearchOpen(true);
              }}
            >
              按名称搜索
            </button>
          )}
        </div>
      </header>

      {searchOpen ? (
        <BaiduNameSearch
          connectionId={connectionId}
          path={path}
          draft={draft}
          canSelectFile={onSelectFile !== undefined}
          {...(onConfirm === undefined ? {} : { onToggleDirectory: toggle })}
          onSelectEntry={selectEntry}
          onOpenDirectory={(nextPath) => {
            void load(nextPath);
          }}
          onReturn={() => {
            void load(path);
          }}
        />
      ) : (
        <div
          ref={listViewport}
          className="baidu-browser-viewport"
          role="region"
          aria-label="文件与文件夹列表"
          tabIndex={0}
        >
          {entries === null ? (
            <p className="neutral-empty-state" role="status">
              {pending ? '正在读取目录…' : '目录尚未读取，可重新尝试。'}
            </p>
          ) : entries.length === 0 ? (
            <p className="neutral-empty-state">这个目录没有直接子项。</p>
          ) : (
            <ul className="baidu-browser-list">
              {entries.map((entry) => (
                <li key={entry.fsid}>
                  {onConfirm === undefined || !entry.isDirectory ? null : (
                    <label className="baidu-browser-entry-icon">
                      <input
                        type="checkbox"
                        aria-label={`勾选目录 ${entry.path}`}
                        checked={draft.some(
                          (value) =>
                            value.fsid === entry.fsid && value.connectionId === connectionId,
                        )}
                        disabled={pending}
                        onChange={() => toggle(entry)}
                      />
                    </label>
                  )}
                  {onConfirm !== undefined && entry.isDirectory ? null : (
                    <span className="baidu-browser-entry-icon" aria-hidden="true">
                      {entry.isDirectory ? <Folder size={16} /> : <File size={16} />}
                    </span>
                  )}
                  <span className="baidu-browser-entry-name">
                    <strong>{entry.name}</strong>
                    <small>{entry.isDirectory ? '目录' : formatDecimalBytes(entry.size)}</small>
                  </span>
                  <span className="baidu-browser-entry-actions">
                    {entry.isDirectory ? (
                      <button
                        type="button"
                        className="ghost-button"
                        disabled={pending}
                        aria-label={`打开 ${entry.name}`}
                        onClick={() => void load(entry.path)}
                      >
                        打开
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="ghost-button"
                      aria-label={`${!entry.isDirectory && onSelectFile !== undefined ? '选择文件' : onConfirm === undefined ? '选择' : '单选确认'} ${entry.name}`}
                      disabled={pending || (!entry.isDirectory && onSelectFile === undefined)}
                      title={
                        entry.isDirectory
                          ? onConfirm === undefined
                            ? undefined
                            : '仅确认此目录并收起，替换已有目录选择。'
                          : onSelectFile === undefined
                            ? '当前目录导入需选择包含此文件的目录，以冻结真实根 FSID。'
                            : '仅选择此文件，不包含父目录或其他文件。'
                      }
                      onClick={() => selectEntry(entry)}
                    >
                      {!entry.isDirectory && onSelectFile !== undefined
                        ? '选择文件'
                        : onConfirm === undefined
                          ? '选择'
                          : '单选确认'}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div
        className="baidu-browser-actions baidu-browser-footer"
        role="group"
        aria-label="来源选择操作"
      >
        {onConfirm === undefined ? null : (
          <button
            type="button"
            className="ghost-button"
            disabled={pending}
            onClick={() => {
              close();
              onConfirm([...draft]);
            }}
          >
            确认选择（{draft.length}个目录）
          </button>
        )}
        {onConfirm === undefined ? (
          <button
            type="button"
            className="ghost-button"
            disabled={pending || searchOpen || entries === null || path === ROOT}
            onClick={() => select(path)}
          >
            完成选择
          </button>
        ) : null}
        <button type="button" className="ghost-button" onClick={close}>
          取消
        </button>
        {searchOpen || nextStart === null ? null : (
          <button
            type="button"
            className="ghost-button"
            disabled={pending}
            onClick={() => void load(path, nextStart)}
          >
            <ChevronRight size={14} aria-hidden="true" />
            {pending ? '正在读取…' : '读取下一页'}
          </button>
        )}
        {error === null ? null : (
          <button
            type="button"
            className="ghost-button"
            disabled={pending}
            onClick={() => void load(path)}
          >
            重新读取目录
          </button>
        )}
      </div>
      {onConfirm === undefined ? null : (
        <section
          className="baidu-browser-draft"
          aria-label="目录选择草稿"
          data-empty={draft.length === 0 && draftNotice === null}
        >
          <p className="field-hint">跨目录/分页保留勾选；确认只更新来源，不生成计划。</p>
          <button
            type="button"
            className="ghost-button"
            disabled={draft.length === 0}
            onClick={() => {
              setDraft([]);
              setDraftNotice(null);
            }}
          >
            清空草稿选择
          </button>
          {draft.length === 0 ? null : (
            <ul className="import-blockers">
              {draft.map((value) => (
                <li key={sourceDirectoryKey(value)}>
                  <code style={{ overflowWrap: 'anywhere' }}>{value.path}</code>
                  <button
                    type="button"
                    className="ghost-button"
                    aria-label={`移除草稿目录 ${value.path}`}
                    onClick={() => setDraft(removeSourceDirectory(draft, value))}
                  >
                    移除
                  </button>
                </li>
              ))}
            </ul>
          )}
          {draftNotice === null ? null : (
            <p className="field-hint" role="status">
              {draftNotice}
            </p>
          )}
        </section>
      )}

      {error === null ? null : (
        <p className="inline-message error-message" role="alert">
          <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" /> {error}
        </p>
      )}
    </section>
  );
}
