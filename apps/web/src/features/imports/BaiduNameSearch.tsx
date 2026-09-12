import type { BaiduConnectionBrowseEntry, BaiduConnectionSearchResponse } from '@ptvault/contracts';
import { File, Folder, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, ContractError } from '../../api/client.js';
import { searchConnection } from '../storage/connectionApi.js';
import { formatDecimalBytes } from './importFormatting.js';
import type { SourceDirectory } from './sourceSelection.js';

type Props = {
  connectionId: string;
  path: string;
  draft: readonly SourceDirectory[];
  canSelectFile: boolean;
  onToggleDirectory?: (entry: BaiduConnectionBrowseEntry) => void;
  onSelectEntry: (entry: BaiduConnectionBrowseEntry) => void;
  onOpenDirectory: (path: string) => void;
  onReturn: () => void;
};

function searchError(error: unknown): string {
  if (error instanceof ContractError) return '网页与服务端的名称搜索契约不一致；没有选中任何来源。';
  if (error instanceof ApiError) {
    if (error.status === 429 || error.code === 'RATE_LIMITED')
      return '这个百度连接正在被服务商限速；请等待后再搜索，不会转用其他账户。';
    if (error.status === 401) return '会话已过期，请重新登录。';
    if (
      [
        'AUTH_EXPIRED',
        'AUTH_SCOPE_INSUFFICIENT',
        'AUTH_IDENTITY_DRIFT',
        'BAIDU_CONNECTION_NOT_BROWSABLE',
      ].includes(error.code ?? '')
    )
      return '这个连接的授权或身份已变化，请在存储账户页核对后重试。';
    if (error.code === 'BAIDU_CONNECTION_NOT_FOUND')
      return '这个百度连接已不存在，请刷新账户列表。';
  }
  return '名称搜索未完成；没有选中任何来源，可重新搜索或返回目录浏览。';
}

function mergedEntries(
  previous: readonly BaiduConnectionBrowseEntry[],
  next: readonly BaiduConnectionBrowseEntry[],
): BaiduConnectionBrowseEntry[] {
  const ids = new Map<string, BaiduConnectionBrowseEntry>();
  const paths = new Map<string, string>();
  for (const entry of [...previous, ...next]) {
    const old = ids.get(entry.fsid);
    if (
      (old !== undefined && JSON.stringify(old) !== JSON.stringify(entry)) ||
      (paths.has(entry.path) && paths.get(entry.path) !== entry.fsid)
    )
      throw new ContractError(
        '/api/storage/connections/:id/search',
        'result identity changed between pages',
      );
    ids.set(entry.fsid, entry);
    paths.set(entry.path, entry.fsid);
  }
  return [...ids.values()];
}

export function BaiduNameSearch({
  connectionId,
  path,
  draft,
  canSelectFile,
  onToggleDirectory,
  onSelectEntry,
  onOpenDirectory,
  onReturn,
}: Props) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'CURRENT' | 'ACCOUNT'>('CURRENT');
  const [type, setType] = useState<'ALL' | 'DIRECTORY' | 'FILE'>('ALL');
  const [result, setResult] = useState<BaiduConnectionSearchResponse | null>(null);
  const resultRef = useRef<BaiduConnectionSearchResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const queryInput = useRef<HTMLInputElement>(null);
  const root = scope === 'ACCOUNT' ? '/' : path;
  const valid =
    query.trim().length > 0 &&
    query.trim().length <= 256 &&
    Array.from(query).every(
      (character) => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f,
    );
  const invalidate = useCallback(() => {
    revision.current += 1;
    abort.current?.abort();
    abort.current = null;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const run = useCallback(
    async (page = 1): Promise<void> => {
      invalidate();
      if (!valid) return;
      const currentRevision = revision.current;
      const controller = new AbortController();
      abort.current = controller;
      setPending(true);
      setError(null);
      if (page === 1) {
        resultRef.current = null;
        setResult(null);
      }
      try {
        const answer = await searchConnection({
          id: connectionId,
          path: root,
          query: query.trim(),
          page,
          limit: 100,
          signal: controller.signal,
        });
        if (currentRevision !== revision.current) return;
        if (!answer.supported) {
          setError(
            answer.reason === 'ROUTE_ABSENT'
              ? '这台机器上的 API 版本还没有名称搜索接口；目录浏览仍可使用。'
              : '这台服务端尚未启用名称搜索；目录浏览仍可使用。',
          );
          return;
        }
        const old = resultRef.current;
        if (
          page > 1 &&
          (old === null || old.nextPage !== page || old.path !== root || old.query !== query.trim())
        )
          throw new ContractError('/api/storage/connections/:id/search', 'page ownership mismatch');
        const next = {
          ...answer.data,
          entries: mergedEntries(page > 1 && old !== null ? old.entries : [], answer.data.entries),
        };
        resultRef.current = next;
        setResult(next);
        if (page === 1 && viewport.current !== null) viewport.current.scrollTop = 0;
      } catch (cause) {
        if (currentRevision === revision.current && !controller.signal.aborted)
          setError(searchError(cause));
      } finally {
        if (currentRevision === revision.current) setPending(false);
      }
    },
    [connectionId, root, query, valid, invalidate],
  );
  useEffect(() => {
    invalidate();
    resultRef.current = null;
    setResult(null);
    setError(null);
    setPending(false);
    if (valid)
      timer.current = setTimeout(() => {
        void run();
      }, 450);
    return invalidate;
  }, [run, valid, invalidate]);
  useEffect(() => {
    queryInput.current?.focus({ preventScroll: true });
  }, []);
  const visible = (result?.entries ?? []).filter(
    (entry) => type === 'ALL' || entry.isDirectory === (type === 'DIRECTORY'),
  );

  return (
    <div className="baidu-name-search">
      <div className="baidu-search-controls" role="search" aria-label="网盘名称搜索">
        <label className="baidu-search-keyword field">
          文件或文件夹名称
          <input
            ref={queryInput}
            value={query}
            maxLength={256}
              placeholder="按名称检索，例如：示例课程"
            onChange={(event) => {
              invalidate();
              setQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                void run();
              }
            }}
          />
        </label>
        <label>
          搜索范围
          <select
            value={scope}
            onChange={(event) => {
              invalidate();
              setScope(event.target.value as 'CURRENT' | 'ACCOUNT');
            }}
          >
            <option value="CURRENT">当前目录及子目录</option>
            <option value="ACCOUNT">整个账户</option>
          </select>
        </label>
        <label>
          结果类型
          <select
            value={type}
            onChange={(event) => setType(event.target.value as 'ALL' | 'DIRECTORY' | 'FILE')}
          >
            <option value="ALL">全部</option>
            <option value="DIRECTORY">文件夹</option>
            <option value="FILE">文件</option>
          </select>
        </label>
        <button type="button" className="ghost-button" disabled={!valid} onClick={() => void run()}>
          <Search size={14} aria-hidden="true" />
          搜索
        </button>
        <button type="button" className="ghost-button" onClick={onReturn}>
          返回目录浏览
        </button>
      </div>
      <p className="field-hint baidu-search-hint">
        百度索引按名称检索所选范围，不是筛选目录当前页；索引与供应商上限可能省略项目。类型筛选只作用于已加载结果。
      </p>
      <div
        ref={viewport}
        className="baidu-browser-viewport"
        role="region"
        aria-label="名称搜索结果"
        tabIndex={0}
      >
        {result === null ? (
          <p className="neutral-empty-state" role="status">
            {pending
              ? '正在搜索…'
              : query.trim() === ''
                ? '输入关键词搜索，不会创建迁移计划。'
                : '等待搜索结果。'}
          </p>
        ) : visible.length === 0 ? (
          <p className="neutral-empty-state">
            {result.entries.length === 0
              ? '百度暂未返回匹配结果；可缩短关键词或更换搜索范围。'
              : '已加载的搜索结果中暂无此类型；如有更多结果，可继续读取。'}
          </p>
        ) : (
          <ul className="baidu-browser-list baidu-search-results">
            {visible.map((entry) => (
              <li key={entry.fsid}>
                {entry.isDirectory && onToggleDirectory !== undefined ? (
                  <label className="baidu-browser-entry-icon">
                    <input
                      type="checkbox"
                      aria-label={`勾选目录 ${entry.path}`}
                      checked={draft.some(
                        (value) => value.connectionId === connectionId && value.fsid === entry.fsid,
                      )}
                      disabled={pending}
                      onChange={() => onToggleDirectory(entry)}
                    />
                  </label>
                ) : (
                  <span className="baidu-browser-entry-icon" aria-hidden="true">
                    {entry.isDirectory ? <Folder size={16} /> : <File size={16} />}
                  </span>
                )}
                <span className="baidu-browser-entry-name">
                  <strong>{entry.name}</strong>
                  <small>{entry.isDirectory ? '文件夹' : formatDecimalBytes(entry.size)}</small>
                  <code>{entry.path}</code>
                </span>
                <span className="baidu-browser-entry-actions">
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={pending}
                    aria-label={`${entry.isDirectory ? '打开目录' : '打开所在目录'} ${entry.path}`}
                    onClick={() =>
                      onOpenDirectory(
                        entry.isDirectory
                          ? entry.path
                          : entry.path.slice(0, entry.path.lastIndexOf('/')) || '/',
                      )
                    }
                  >
                    {entry.isDirectory ? '打开目录' : '所在目录'}
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={pending || (!entry.isDirectory && !canSelectFile)}
                    aria-label={`${entry.isDirectory ? '单选确认目录' : '选择文件'} ${entry.path}`}
                    onClick={() => onSelectEntry(entry)}
                  >
                    {entry.isDirectory ? '单选确认' : '选择文件'}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {result === null ? null : (
        <div className="baidu-browser-actions baidu-search-status">
          <span role="status">
            已加载 {result.entries.length} 项，当前类型显示 {visible.length} 项
            {pending ? ' · 正在读取…' : ''}
          </span>
          {result.nextPage === null ? null : (
            <button
              type="button"
              className="ghost-button"
              disabled={pending}
              onClick={() => void run(result.nextPage!)}
            >
              读取更多搜索结果
            </button>
          )}
          {result.limitReached ? (
            <p role="status">已达到本次搜索的分页上限；结果尚未读完，请缩小目录或关键词后继续。</p>
          ) : null}
        </div>
      )}
      {error === null ? null : (
        <p className="inline-message error-message" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
