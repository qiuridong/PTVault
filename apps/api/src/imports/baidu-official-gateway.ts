import { createHash, randomUUID } from 'node:crypto';

import {
  BAIDU_NAME_SEARCH_MAX_PAGE,
  BAIDU_NAME_SEARCH_MAX_PAGE_SIZE,
  type BaiduConnectionBrowseEntry,
  type BaiduConnectionSearchQuery,
  type BaiduConnectionSearchResponse,
  type ImportFileIdentity,
} from '@ptvault/contracts';

import { sanitizeBaiduShareReference } from './share-reference.js';
import { parseRetryAfter } from './data-plane/backoff.js';
import type {
  BaiduGateway,
  BaiduObjectSnapshot,
  BaiduTransferredObject,
} from './data-plane/baidu-source.js';
import { ImportDataPlaneError } from './data-plane/errors.js';
import type { DownloadLease } from './data-plane/range-downloader.js';
import type { BaiduAccessTokenProvider, BaiduOAuthSession } from './baidu-oauth.js';
import type {
  ImportSourceCleanupProvider,
  ImportSourceCleanupProviderReceipt,
  ImportSourceSnapshot,
} from './source-cleanup.js';
import { createBoundedRequestSignal } from './request-timeout.js';
import { isCanonicalBaiduPath, isManagedBaiduMutationPath } from './baidu-paths.js';
import {
  buildSourceManifest,
  sourceManifestDigest,
  type BaiduDirectorySnapshot,
  type SourceDirectoryIdentity,
} from './source-manifest.js';

export type { BaiduAccessTokenProvider } from './baidu-oauth.js';

export type BaiduSharePreview = {
  directories?: SourceDirectoryIdentity[];
  sourceRequiresPasscode: boolean;
  objects: BaiduTransferredObject[];
};

export type BaiduFileSnapshotInput = {
  sourcePath: string;
  expectedFile: ImportFileIdentity;
  signal?: AbortSignal;
};

export interface BaiduPlanningGateway {
  snapshotFile?(input: BaiduFileSnapshotInput): Promise<BaiduTransferredObject>;
  snapshotAppDirectory?(input: {
    sourcePath: string;
    signal?: AbortSignal;
  }): Promise<BaiduDirectorySnapshot>;
  previewShare(input: {
    sanitizedShareUrl: string;
    extractionCode: string | null;
    signal?: AbortSignal;
  }): Promise<BaiduSharePreview>;
  listAppDirectory(input: {
    sourcePath: string;
    signal?: AbortSignal;
  }): Promise<BaiduTransferredObject[]>;
}

export type BaiduDirectoryPage = {
  path: string;
  entries: BaiduConnectionBrowseEntry[];
  nextStart: number | null;
};

export type BaiduNameSearchInput = BaiduConnectionSearchQuery & { signal?: AbortSignal };
export type BaiduNameSearchPage = Omit<BaiduConnectionSearchResponse, 'connectionId'>;

export interface BaiduBrowseGateway {
  searchDirectory?(input: BaiduNameSearchInput): Promise<BaiduNameSearchPage>;
  browseDirectory(input: {
    path: string;
    start: number;
    limit: number;
    signal?: AbortSignal;
  }): Promise<BaiduDirectoryPage>;
}

export class BaiduApiError extends ImportDataPlaneError {
  constructor(
    code: string,
    readonly retryAfterMs: number | null,
  ) {
    super(code, 'Baidu API operation failed');
    this.name = 'BaiduApiError';
  }
}

export type OfficialBaiduGatewayOptions = {
  tokens: BaiduAccessTokenProvider;
  fetch?: typeof fetch;
  now?: () => Date;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  taskPollIntervalMs?: number;
  maximumTaskPolls?: number;
  maximumResponseBytes?: number;
  requestTimeoutMs?: number;
  allowedShareHosts?: readonly string[];
};

const LOSSLESS_NUMBER_KEYS = new Set([
  'fs_id',
  'fsid',
  'to_fs_id',
  'task_id',
  'request_id',
  'size',
  'mtime',
  'ctime',
  'server_mtime',
  'server_ctime',
  'local_mtime',
  'local_ctime',
]);

const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const BAIDU_API_ORIGIN = 'https://pan.baidu.com';
const PRODUCT = 'netdisk';

function quoteSelectedNumbers(text: string): string {
  let cursor = 0;
  let index = 0;
  let output = '';
  while (index < text.length) {
    if (text[index] !== '"') {
      index += 1;
      continue;
    }
    const stringStart = index;
    index += 1;
    let escaped = false;
    while (index < text.length) {
      const character = text[index];
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') break;
      index += 1;
    }
    if (index >= text.length) break;
    const stringEnd = index;
    let colon = stringEnd + 1;
    while (/\s/.test(text[colon] ?? '')) colon += 1;
    if (text[colon] !== ':') {
      index = stringEnd + 1;
      continue;
    }
    let valueStart = colon + 1;
    while (/\s/.test(text[valueStart] ?? '')) valueStart += 1;
    let key: unknown;
    try {
      key = JSON.parse(text.slice(stringStart, stringEnd + 1)) as unknown;
    } catch {
      index = stringEnd + 1;
      continue;
    }
    if (typeof key !== 'string' || !LOSSLESS_NUMBER_KEYS.has(key)) {
      index = stringEnd + 1;
      continue;
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      text.slice(valueStart),
    );
    if (number === null) {
      index = stringEnd + 1;
      continue;
    }
    const valueEnd = valueStart + number[0].length;
    output += `${text.slice(cursor, valueStart)}"${number[0]}"`;
    cursor = valueEnd;
    index = valueEnd;
  }
  return `${output}${text.slice(cursor)}`;
}

/** Parse provider JSON without rounding 64-bit fsids/task ids through JS numbers. */
export function parseBaiduJsonLossless(text: string): unknown {
  return JSON.parse(quoteSelectedNumbers(text)) as unknown;
}

function record(value: unknown, code = 'BAIDU_RESPONSE_INVALID'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BaiduApiError(code, null);
  }
  return value as Record<string, unknown>;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new BaiduApiError('BAIDU_RESPONSE_INVALID', null);
  return value;
}

function stringValue(value: unknown, code = 'BAIDU_RESPONSE_INVALID'): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  throw new BaiduApiError(code, null);
}

function decimalValue(value: unknown): string {
  const result = stringValue(value);
  if (!DECIMAL.test(result)) throw new BaiduApiError('BAIDU_RESPONSE_INVALID', null);
  return result;
}

function optionalMd5(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^[0-9a-z]{32}$/i.test(value)) {
    throw new BaiduApiError('BAIDU_RESPONSE_INVALID', null);
  }
  // Some provider listings return an opaque 32-character ASCII alphanumeric value.
  // It is not a standard MD5: omit this optional metadata, never invent/decode a hash.
  // Identity/manifest fences and actual-byte SHA-256 readbacks remain authoritative.
  return /^[0-9a-f]{32}$/i.test(value) ? value.toLowerCase() : undefined;
}

function normalizedCloudPath(value: unknown): string {
  const result = stringValue(value);
  if (!result.startsWith('/') || result.includes('\0') || result.split('/').includes('..')) {
    throw new BaiduApiError('BAIDU_RESPONSE_INVALID', null);
  }
  return result.replace(/\/{2,}/g, '/');
}

function relativePath(absolutePath: string, root: string | null): string {
  let result: string;
  if (root !== null) {
    const normalizedRoot = root.replace(/\/$/, '');
    if (!absolutePath.startsWith(`${normalizedRoot}/`)) {
      throw new BaiduApiError('BAIDU_RESPONSE_INVALID', null);
    }
    result = absolutePath.slice(normalizedRoot.length + 1);
  } else {
    result = absolutePath.replace(/^\/+/, '');
  }
  if (
    result.length === 0 ||
    result.startsWith('/') ||
    result.includes('\\') ||
    result.includes('\0') ||
    result.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new BaiduApiError('BAIDU_RESPONSE_INVALID', null);
  }
  return result;
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const abort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('aborted');
}

function multipartForm(values: Record<string, string>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  return form;
}

function apiErrorCode(errno: number): string {
  if ([-6, 110, 111].includes(errno)) return 'AUTH_EXPIRED';
  if (errno === 13998) return 'AUTH_SCOPE_INSUFFICIENT';
  if (errno === 13003) return 'AUTH_SHARE_PASSCODE_REQUIRED';
  if ([31034, 31326].includes(errno)) return 'RATE_LIMITED';
  if ([13072, 13073].includes(errno)) return 'API_QUOTA_EXCEEDED';
  if (errno === 13077) return 'BAIDU_QUOTA_EXCEEDED';
  if ([-9, 31066].includes(errno)) return 'SOURCE_CHANGED';
  if (errno === 13071) return 'BAIDU_TRANSFER_ALREADY_RUNNING';
  return 'BAIDU_API_FAILED';
}

type ShareListing = {
  directories: SourceDirectoryIdentity[];
  rootFsids: string[];
  objects: BaiduTransferredObject[];
};

function transferMatchesSource(
  source: readonly BaiduTransferredObject[],
  destination: readonly BaiduTransferredObject[],
): boolean {
  if (source.length !== destination.length) return false;
  const expected = [...source].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  const actual = [...destination].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  return expected.every((object, index) => {
    const transferred = actual[index];
    return (
      transferred !== undefined &&
      object.relativePath === transferred.relativePath &&
      object.size === transferred.size &&
      (object.md5 === undefined || transferred.md5 === undefined || object.md5 === transferred.md5)
    );
  });
}

/** In-process adapter for Baidu's official share and xpan OpenAPI surfaces. */
export class OfficialBaiduGateway
  implements BaiduGateway, BaiduPlanningGateway, BaiduBrowseGateway, ImportSourceCleanupProvider
{
  private readonly tokens: BaiduAccessTokenProvider;
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly taskPollIntervalMs: number;
  private readonly maximumTaskPolls: number;
  private readonly maximumResponseBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly allowedShareHosts: readonly string[];

  constructor(options: OfficialBaiduGatewayOptions) {
    this.tokens = options.tokens;
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? abortableSleep;
    this.taskPollIntervalMs = options.taskPollIntervalMs ?? 2_000;
    this.maximumTaskPolls = options.maximumTaskPolls ?? 900;
    this.maximumResponseBytes = options.maximumResponseBytes ?? 8 * 1024 * 1024;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.allowedShareHosts = options.allowedShareHosts ?? ['pan.baidu.com'];
    if (
      !Number.isSafeInteger(this.taskPollIntervalMs) ||
      this.taskPollIntervalMs < 1 ||
      !Number.isSafeInteger(this.maximumTaskPolls) ||
      this.maximumTaskPolls < 1 ||
      !Number.isSafeInteger(this.maximumResponseBytes) ||
      this.maximumResponseBytes < 1 ||
      !Number.isSafeInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs < 1
    ) {
      throw new BaiduApiError('BAIDU_GATEWAY_CONFIG_INVALID', null);
    }
  }

  async previewShare(input: {
    sanitizedShareUrl: string;
    extractionCode: string | null;
    signal?: AbortSignal;
  }): Promise<BaiduSharePreview> {
    const shortUrl = this.shortUrl(input.sanitizedShareUrl);
    const spwd = await this.sharePassword(shortUrl, input.extractionCode, input.signal);
    const listing = await this.listShare(shortUrl, spwd, input.signal);
    return {
      sourceRequiresPasscode: input.extractionCode !== null,
      directories: listing.directories,
      objects: listing.objects,
    };
  }

  async transferShare(input: {
    sourceManifestDigest?: string;
    jobId: string;
    sanitizedShareUrl: string;
    extractionCode: string | null;
    destinationRoot: string;
    signal?: AbortSignal;
  }): Promise<{ transferId: string }> {
    if (!/^[0-9a-f-]{36}$/i.test(input.jobId)) {
      throw new BaiduApiError('BAIDU_JOB_ID_INVALID', null);
    }
    this.validateAppPath(input.destinationRoot);
    const shortUrl = this.shortUrl(input.sanitizedShareUrl);
    const spwd = await this.sharePassword(shortUrl, input.extractionCode, input.signal);
    const listing = await this.listShare(shortUrl, spwd, input.signal);
    if (listing.rootFsids.length === 0) throw new BaiduApiError('BAIDU_SHARE_EMPTY', null);
    if (
      input.sourceManifestDigest !== undefined &&
      sourceManifestDigest(
        buildSourceManifest(
          'BAIDU_SHARE',
          '/',
          createHash('sha256').update(input.sanitizedShareUrl).digest('hex'),
          listing,
        ),
      ) !== input.sourceManifestDigest
    )
      throw new BaiduApiError('SOURCE_CHANGED', null);
    await this.ensureDestinationDirectories(input.destinationRoot, input.signal);
    // A crash can land after Baidu finished the transfer but before SQLite
    // received the provider task id. The job UUID makes this directory unique;
    // finding files there is therefore durable completion evidence, and avoids
    // submitting a duplicate mutation. The source validates count/bytes against
    // the immutable plan before accepting these objects.
    const existing = await this.listOwnDirectory(input.destinationRoot, input.signal);
    if (existing.length > 0) {
      if (transferMatchesSource(listing.objects, existing)) return { transferId: '0' };
      throw new BaiduApiError('BAIDU_TRANSFER_ALREADY_RUNNING', null);
    }
    const session = await this.tokens.getSession(input.signal);
    const url = this.shareUrl('/apaas/1.0/share/transfer', session, shortUrl, true);
    const body = multipartForm({
      fsid_list: `[${listing.rootFsids.map((fsid) => `"${fsid}"`).join(',')}]`,
      to_path: input.destinationRoot,
      spwd,
      async: '2',
      ondup: 'fail',
    });
    const decoded = record(
      await this.requestJson(
        url,
        {
          method: 'POST',
          body,
        },
        input.signal,
      ),
    );
    const data = record(decoded.data);
    return { transferId: decimalValue(data.task_id) };
  }

  async confirmShareTransfer(input: {
    transferId: string;
    destinationRoot: string;
    signal?: AbortSignal;
  }): Promise<BaiduTransferredObject[]> {
    if (!DECIMAL.test(input.transferId)) throw new BaiduApiError('BAIDU_TASK_ID_INVALID', null);
    this.validateAppPath(input.destinationRoot);
    if (input.transferId !== '0') {
      for (let poll = 0; poll < this.maximumTaskPolls; poll += 1) {
        const session = await this.tokens.getSession(input.signal);
        const url = this.shareUrl('/apaas/1.0/share/taskquery', session, null, false);
        url.searchParams.set('task_id', input.transferId);
        const decoded = record(await this.requestJson(url, { method: 'GET' }, input.signal));
        const data = record(decoded.data);
        const status = data.status;
        if (status === 'success' || status === 2 || status === '2') break;
        if (status === 'fail' || status === 'failed' || status === -1 || status === '-1') {
          throw new BaiduApiError('BAIDU_TRANSFER_FAILED', null);
        }
        if (poll === this.maximumTaskPolls - 1) {
          throw new BaiduApiError('BAIDU_TRANSFER_TIMEOUT', null);
        }
        await this.sleep(this.taskPollIntervalMs, input.signal);
      }
    }
    return this.listAppDirectory({
      sourcePath: input.destinationRoot,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  listAppDirectory(input: {
    sourcePath: string;
    signal?: AbortSignal;
  }): Promise<BaiduTransferredObject[]> {
    this.validateReadSelection(input.sourcePath);
    return this.listOwnDirectory(input.sourcePath, input.signal);
  }

  async snapshotAppDirectory(input: {
    sourcePath: string;
    signal?: AbortSignal;
  }): Promise<BaiduDirectorySnapshot> {
    this.validateReadSelection(input.sourcePath);
    const parent = input.sourcePath.slice(0, input.sourcePath.lastIndexOf('/')) || '/';
    let start: number | null = 0;
    let root: SourceDirectoryIdentity | undefined;
    do {
      const page: BaiduDirectoryPage = await this.browseDirectory({
        path: parent,
        start,
        limit: 1000,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      for (const entry of page.entries) {
        if (entry.path === input.sourcePath) {
          if (!entry.isDirectory || root !== undefined)
            throw new BaiduApiError('SOURCE_CHANGED', null);
          root = { fsid: entry.fsid, path: entry.path, mtime: entry.mtime };
        }
      }
      start = page.nextStart;
    } while (start !== null);
    if (root === undefined) throw new BaiduApiError('SOURCE_CHANGED', null);
    const directories = [root];
    const objects = await this.listOwnDirectory(input.sourcePath, input.signal, directories);
    // Recheck the selected root after the walk, rather than fabricating its identity from its path.
    const { metadata } = await this.fileMetadata(root.fsid, input.signal);
    if (
      normalizedCloudPath(metadata.path) !== root.path ||
      Number(metadata.isdir) !== 1 ||
      decimalValue(metadata.server_mtime ?? metadata.mtime) !== root.mtime
    )
      throw new BaiduApiError('SOURCE_CHANGED', null);
    return { directories, objects };
  }

  async browseDirectory(input: {
    path: string;
    start: number;
    limit: number;
    signal?: AbortSignal;
  }): Promise<BaiduDirectoryPage> {
    const directory = this.validateBrowsePath(input.path);
    if (
      !Number.isSafeInteger(input.start) ||
      input.start < 0 ||
      input.start > 1_000_000 ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 1_000
    ) {
      throw new BaiduApiError('BAIDU_BROWSE_PAGE_INVALID', null);
    }
    const session = await this.tokens.getSession(input.signal);
    const url = this.xpanUrl('/rest/2.0/xpan/file', session, {
      method: 'list',
      dir: directory,
      start: String(input.start),
      limit: String(input.limit),
      order: 'name',
      desc: '0',
    });
    const decoded = record(await this.requestJson(url, { method: 'GET' }, input.signal));
    const rawEntries = list(decoded.list);
    if (rawEntries.length > input.limit) throw new BaiduApiError('BAIDU_RESPONSE_INVALID', null);
    const entries = rawEntries.map((raw): BaiduConnectionBrowseEntry => {
      const entry = record(raw);
      const entryPath = normalizedCloudPath(entry.path);
      const separator = entryPath.lastIndexOf('/');
      const parent = separator === 0 ? '/' : entryPath.slice(0, separator);
      if (parent !== directory) throw new BaiduApiError('BAIDU_RESPONSE_INVALID', null);
      const isDirectoryValue = Number(entry.isdir);
      if (isDirectoryValue !== 0 && isDirectoryValue !== 1) {
        throw new BaiduApiError('BAIDU_RESPONSE_INVALID', null);
      }
      const name = stringValue(entry.server_filename ?? entryPath.slice(separator + 1));
      if (name.includes('/') || name.includes('\\') || name.includes('\0') || name.length > 1024) {
        throw new BaiduApiError('BAIDU_RESPONSE_INVALID', null);
      }
      return {
        fsid: decimalValue(entry.fs_id ?? entry.fsid),
        name,
        path: entryPath,
        isDirectory: isDirectoryValue === 1,
        size: decimalValue(entry.size ?? 0),
        mtime: decimalValue(entry.mtime ?? entry.server_mtime),
      };
    });
    const hasMore = browseHasMore(decoded.has_more, entries.length, input.limit);
    if (hasMore && entries.length === 0) throw new BaiduApiError('BAIDU_RESPONSE_INVALID', null);
    return {
      path: directory,
      entries,
      nextStart: hasMore ? input.start + entries.length : null,
    };
  }

  async searchDirectory(input: BaiduNameSearchInput): Promise<BaiduNameSearchPage> {
    if (input.signal?.aborted) throw abortError(input.signal);
    const directory = this.validateBrowsePath(input.path);
    const query = input.query.trim();
    if (
      query.length === 0 ||
      query.length > 256 ||
      Array.from(query).some(
        (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
      ) ||
      !Number.isSafeInteger(input.page) ||
      input.page < 1 ||
      input.page > BAIDU_NAME_SEARCH_MAX_PAGE ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > BAIDU_NAME_SEARCH_MAX_PAGE_SIZE
    )
      throw new BaiduApiError('BAIDU_SEARCH_QUERY_INVALID', null);
    const session = await this.tokens.getSession(input.signal);
    // Official SDK: baidu-netdisk/mcp openapi_client/api/fileinfo_api.py, xpanfilesearch.
    const url = this.xpanUrl('/rest/2.0/xpan/file', session, {
      method: 'search',
      dir: directory,
      key: query,
      recursion: '1',
      page: String(input.page),
      num: String(input.limit),
    });
    const decoded = record(await this.requestJson(url, { method: 'GET' }, input.signal));
    const rawEntries = list(decoded.list);
    if (
      rawEntries.length > input.limit ||
      decoded.has_more === undefined ||
      decoded.has_more === null
    )
      throw new BaiduApiError('BAIDU_RESPONSE_INVALID', null);
    const hasMore = browseHasMore(decoded.has_more, rawEntries.length, input.limit);
    if (hasMore && rawEntries.length === 0) throw new BaiduApiError('BAIDU_RESPONSE_INVALID', null);
    const byId = new Map<string, BaiduConnectionBrowseEntry>();
    const byPath = new Map<string, string>();
    for (const raw of rawEntries) {
      const row = record(raw);
      const entryPath = stringValue(row.path);
      const name = stringValue(row.server_filename ?? row.filename);
      if (row.isdir !== 0 && row.isdir !== 1 && row.isdir !== '0' && row.isdir !== '1')
        throw new BaiduApiError('BAIDU_RESPONSE_INVALID', null);
      const isDirectory = Number(row.isdir);
      if (
        !isCanonicalBaiduPath(entryPath, false) ||
        !entryPath.startsWith(directory === '/' ? '/' : `${directory}/`) ||
        name !== entryPath.slice(entryPath.lastIndexOf('/') + 1) ||
        name.length > 1024 ||
        (isDirectory !== 0 && isDirectory !== 1)
      )
        throw new BaiduApiError('BAIDU_RESPONSE_INVALID', null);
      const entry: BaiduConnectionBrowseEntry = {
        fsid: decimalValue(row.fs_id ?? row.fsid),
        name,
        path: entryPath,
        isDirectory: isDirectory === 1,
        size: decimalValue(row.size),
        mtime: decimalValue(row.server_mtime ?? row.mtime),
      };
      const previous = byId.get(entry.fsid);
      if (
        (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(entry)) ||
        (byPath.has(entry.path) && byPath.get(entry.path) !== entry.fsid)
      )
        throw new BaiduApiError('BAIDU_RESPONSE_INVALID', null);
      byId.set(entry.fsid, entry);
      byPath.set(entry.path, entry.fsid);
    }
    const limitReached = hasMore && input.page === BAIDU_NAME_SEARCH_MAX_PAGE;
    return {
      path: directory,
      query,
      page: input.page,
      limit: input.limit,
      entries: [...byId.values()],
      nextPage: hasMore && !limitReached ? input.page + 1 : null,
      limitReached,
    };
  }

  async snapshotFile(input: BaiduFileSnapshotInput): Promise<BaiduTransferredObject> {
    if (!isCanonicalBaiduPath(input.sourcePath) || input.sourcePath === '/') {
      throw new BaiduApiError('SOURCE_CHANGED', null);
    }
    const { metadata } = await this.fileMetadata(input.expectedFile.fsid, input.signal);
    return this.exactFileObject(input, metadata);
  }

  private exactFileObject(
    input: BaiduFileSnapshotInput,
    metadata: Record<string, unknown>,
  ): BaiduTransferredObject {
    if (
      !isCanonicalBaiduPath(input.sourcePath) ||
      input.sourcePath === '/' ||
      (metadata.isdir !== 0 && metadata.isdir !== '0') ||
      metadata.path !== input.sourcePath ||
      decimalValue(metadata.size) !== input.expectedFile.size ||
      decimalValue(metadata.server_mtime) !== input.expectedFile.mtime
    )
      throw new BaiduApiError('SOURCE_CHANGED', null);
    const md5 = optionalMd5(metadata.md5);
    return {
      fsid: decimalValue(metadata.fs_id ?? metadata.fsid),
      size: decimalValue(metadata.size),
      mtime: decimalValue(metadata.server_mtime),
      relativePath: input.sourcePath.slice(input.sourcePath.lastIndexOf('/') + 1),
      ...(md5 === undefined ? {} : { md5 }),
    };
  }

  async statObject(fsid: string, signal?: AbortSignal): Promise<BaiduObjectSnapshot> {
    const { metadata } = await this.fileMetadata(fsid, signal);
    return {
      fsid: decimalValue(metadata.fs_id),
      size: decimalValue(metadata.size),
      mtime: decimalValue(metadata.server_mtime),
      ...(metadata.isdir === 0 || metadata.isdir === '0'
        ? { isDirectory: false }
        : metadata.isdir === 1 || metadata.isdir === '1'
          ? { isDirectory: true }
          : {}),
      ...(metadata.path === undefined ? {} : { path: normalizedCloudPath(metadata.path) }),
    };
  }

  async statSourceObject(fsid: string, signal?: AbortSignal): Promise<ImportSourceSnapshot | null> {
    try {
      const { metadata } = await this.fileMetadata(fsid, signal);
      return {
        fsid: decimalValue(metadata.fs_id ?? metadata.fsid),
        path: normalizedCloudPath(metadata.path),
        size: decimalValue(metadata.size),
        mtime: decimalValue(metadata.server_mtime ?? metadata.mtime),
      };
    } catch (error) {
      // Absence is not a deletion receipt: callers must keep an ambiguous
      // outcome pending until actual provider success evidence is available.
      if (error instanceof BaiduApiError && error.code === 'SOURCE_CHANGED') return null;
      throw error;
    }
  }

  async deleteToRecycleBin(input: {
    fsid: string;
    path: string;
    idempotencyKey: string;
    signal?: AbortSignal;
    beforeDelete?: () => void;
    expectedSource?: ImportSourceSnapshot;
  }): Promise<ImportSourceCleanupProviderReceipt> {
    this.validateAppPath(input.path);
    // Complete token awaits before the final object stat. The provider accepts
    // paths, not an atomic FSID/etag condition, so keep this window minimal.
    const session = await this.tokens.getSession(input.signal);
    const current = await this.statSourceObject(input.fsid, input.signal);
    if (
      current === null ||
      current.fsid !== input.fsid ||
      current.path !== input.path ||
      (input.expectedSource !== undefined &&
        (current.fsid !== input.expectedSource.fsid ||
          current.path !== input.expectedSource.path ||
          current.size !== input.expectedSource.size ||
          current.mtime !== input.expectedSource.mtime))
    ) {
      throw new BaiduApiError('SOURCE_CHANGED', null);
    }
    const url = this.xpanUrl('/rest/2.0/xpan/file', session, {
      method: 'filemanager',
      opera: 'delete',
    });
    const body = new URLSearchParams({ async: '0', filelist: JSON.stringify([input.path]) });
    input.beforeDelete?.();
    const decoded = record(await this.requestJson(url, { method: 'POST', body }, input.signal));
    const requestId = stringValue(decoded.request_id);
    const results = list(decoded.info);
    if (results.length !== 1) throw new BaiduApiError('BAIDU_DELETE_RESULT_INVALID', null);
    const result = record(results[0]);
    if (result.path !== input.path || (result.errno !== 0 && result.errno !== '0'))
      throw new BaiduApiError('BAIDU_DELETE_RESULT_INVALID', null);
    return {
      providerRequestId: requestId,
      semantics: 'RECYCLE_BIN',
    };
  }

  async createDownloadLease(fsid: string, signal?: AbortSignal): Promise<DownloadLease> {
    const { metadata, session } = await this.fileMetadata(fsid, signal);
    return this.downloadLease(metadata, session);
  }

  async createFileDownloadLease(input: BaiduFileSnapshotInput): Promise<DownloadLease> {
    const { metadata, session } = await this.fileMetadata(input.expectedFile.fsid, input.signal);
    this.exactFileObject(input, metadata);
    return this.downloadLease(metadata, session);
  }

  private downloadLease(
    metadata: Record<string, unknown>,
    session: BaiduOAuthSession,
  ): DownloadLease {
    if (metadata.isdir !== 0 && metadata.isdir !== '0')
      throw new BaiduApiError('BAIDU_SOURCE_NOT_FILE', null);
    const dlink = new URL(stringValue(metadata.dlink));
    if (dlink.protocol !== 'https:' || dlink.username !== '' || dlink.password !== '') {
      throw new BaiduApiError('BAIDU_DLINK_INVALID', null);
    }
    if (!dlink.searchParams.has('access_token')) {
      dlink.searchParams.set('access_token', session.accessToken);
    }
    return {
      leaseId: randomUUID(),
      url: dlink.toString(),
      expiresAt: new Date(this.now().getTime() + (7 * 60 + 50) * 60_000).toISOString(),
      expectedSize: decimalValue(metadata.size),
      requestHeaders: { 'user-agent': 'pan.baidu.com' },
    };
  }

  private shortUrl(sanitizedShareUrl: string): string {
    const reference = sanitizeBaiduShareReference(sanitizedShareUrl, this.allowedShareHosts);
    if (
      reference.inlinePasscode !== null ||
      reference.sanitizedUrl !== sanitizedShareUrl ||
      new URL(reference.sanitizedUrl).hash !== ''
    ) {
      throw new BaiduApiError('BAIDU_SHARE_NOT_SANITIZED', null);
    }
    const url = new URL(reference.sanitizedUrl);
    const pathMatch = /^\/s\/([^/]+)\/?$/.exec(url.pathname);
    let value = pathMatch?.[1] ?? url.searchParams.get('surl') ?? '';
    if (value.startsWith('1')) value = value.slice(1);
    if (!/^[A-Za-z0-9_-]{22}$/.test(value)) {
      throw new BaiduApiError('BAIDU_SHARE_REFERENCE_INVALID', null);
    }
    return value;
  }

  private async sharePassword(
    shortUrl: string,
    extractionCode: string | null,
    signal?: AbortSignal,
  ): Promise<string> {
    if (extractionCode === null) return '';
    if (!/^[A-Za-z0-9]{4}$/.test(extractionCode)) {
      throw new BaiduApiError('AUTH_SHARE_PASSCODE_REQUIRED', null);
    }
    const session = await this.tokens.getSession(signal);
    const url = this.shareUrl('/apaas/1.0/share/verify', session, shortUrl, true);
    const decoded = record(
      await this.requestJson(
        url,
        {
          method: 'POST',
          body: multipartForm({ pwd: extractionCode }),
        },
        signal,
      ),
    );
    return stringValue(record(decoded.data).spwd);
  }

  private async listShare(
    shortUrl: string,
    spwd: string,
    signal?: AbortSignal,
  ): Promise<ShareListing> {
    const queue = ['/'];
    const visited = new Set<string>();
    const rootFsids: string[] = [];
    const directories: SourceDirectoryIdentity[] = [];
    const objects: BaiduTransferredObject[] = [];
    while (queue.length > 0) {
      const directory = queue.shift()!;
      if (visited.has(directory)) throw new BaiduApiError('BAIDU_SHARE_TREE_INVALID', null);
      visited.add(directory);
      for (let page = 1; ; page += 1) {
        if (page > 10_000 || visited.size > 100_000 || objects.length > 1_000_000) {
          throw new BaiduApiError('BAIDU_SHARE_TREE_LIMIT', null);
        }
        const session = await this.tokens.getSession(signal);
        const url = this.shareUrl('/apaas/1.0/share/list', session, shortUrl, true);
        const body = multipartForm({
          spwd,
          dir: directory === '/' ? '' : directory,
          page: String(page),
          page_size: '100',
          order_by: 'name',
          desc_order: '0',
        });
        const decoded = record(
          await this.requestJson(
            url,
            {
              method: 'POST',
              body,
            },
            signal,
          ),
        );
        const entries = list(record(decoded.data).list);
        for (const raw of entries) {
          const entry = record(raw);
          const fsid = decimalValue(entry.fsid ?? entry.fs_id);
          const absolutePath = normalizedCloudPath(entry.path);
          if (directory === '/') rootFsids.push(fsid);
          if (Number(entry.isdir) === 1) {
            directories.push({
              fsid,
              path: absolutePath,
              mtime: decimalValue(entry.mtime ?? entry.server_mtime),
            });
            queue.push(absolutePath);
          } else {
            objects.push(this.fileObject(entry, fsid, relativePath(absolutePath, null)));
          }
        }
        if (entries.length < 100) break;
      }
    }
    return { rootFsids: [...new Set(rootFsids)], objects, directories };
  }

  private async ensureDestinationDirectories(destinationRoot: string, signal?: AbortSignal) {
    const segments = destinationRoot.split('/').filter(Boolean);
    for (let index = 3; index <= segments.length; index += 1) {
      const directory = `/${segments.slice(0, index).join('/')}`;
      const session = await this.tokens.getSession(signal);
      const url = this.xpanUrl('/rest/2.0/xpan/file', session, { method: 'create' });
      await this.requestJson(
        url,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ path: directory, isdir: '1', rtype: '0' }),
        },
        signal,
        new Set([-8]),
      );
    }
  }

  private async listOwnDirectory(
    sourcePath: string,
    signal?: AbortSignal,
    directories?: SourceDirectoryIdentity[],
  ): Promise<BaiduTransferredObject[]> {
    const queue = [sourcePath.replace(/\/$/, '')];
    const visited = new Set<string>();
    const objects: BaiduTransferredObject[] = [];
    while (queue.length > 0) {
      const directory = queue.shift()!;
      if (visited.has(directory)) throw new BaiduApiError('BAIDU_DIRECTORY_TREE_INVALID', null);
      visited.add(directory);
      for (let start = 0; ; start += 1_000) {
        if (visited.size > 100_000 || objects.length > 1_000_000) {
          throw new BaiduApiError('BAIDU_DIRECTORY_TREE_LIMIT', null);
        }
        const session = await this.tokens.getSession(signal);
        const url = this.xpanUrl('/rest/2.0/xpan/file', session, {
          method: 'list',
          dir: directory,
          start: String(start),
          limit: '1000',
          order: 'name',
          desc: '0',
        });
        const decoded = record(await this.requestJson(url, { method: 'GET' }, signal));
        const entries = list(decoded.list);
        for (const raw of entries) {
          const entry = record(raw);
          const fsid = decimalValue(entry.fs_id ?? entry.fsid);
          const absolutePath = normalizedCloudPath(entry.path);
          const isDirectory = Number(entry.isdir);
          if (
            absolutePath.slice(0, absolutePath.lastIndexOf('/')) !== directory ||
            (isDirectory !== 0 && isDirectory !== 1)
          )
            throw new BaiduApiError('SOURCE_CHANGED', null);
          if (isDirectory === 1) {
            directories?.push({
              fsid,
              path: absolutePath,
              mtime: decimalValue(entry.mtime ?? entry.server_mtime),
            });
            queue.push(absolutePath);
          } else {
            objects.push(this.fileObject(entry, fsid, relativePath(absolutePath, sourcePath)));
          }
        }
        if (entries.length < 1_000) break;
      }
    }
    return objects;
  }

  private fileObject(
    entry: Record<string, unknown>,
    fsid: string,
    objectPath: string,
  ): BaiduTransferredObject {
    const result: BaiduTransferredObject = {
      fsid,
      relativePath: objectPath,
      size: decimalValue(entry.size),
      mtime: decimalValue(entry.mtime ?? entry.server_mtime),
    };
    const md5 = optionalMd5(entry.md5);
    if (md5 !== undefined) result.md5 = md5;
    return result;
  }

  private async fileMetadata(
    fsid: string,
    signal?: AbortSignal,
  ): Promise<{ metadata: Record<string, unknown>; session: BaiduOAuthSession }> {
    if (!DECIMAL.test(fsid)) throw new BaiduApiError('BAIDU_FSID_INVALID', null);
    const session = await this.tokens.getSession(signal);
    const url = this.xpanUrl('/rest/2.0/xpan/multimedia', session, {
      method: 'filemetas',
      dlink: '1',
      fsids: `[${fsid}]`,
    });
    const decoded = record(await this.requestJson(url, { method: 'GET' }, signal));
    const entries = list(decoded.list);
    if (entries.length !== 1) throw new BaiduApiError('SOURCE_CHANGED', null);
    const metadata = record(entries[0]);
    if (decimalValue(metadata.fs_id ?? metadata.fsid) !== fsid) {
      throw new BaiduApiError('SOURCE_CHANGED', null);
    }
    return { metadata, session };
  }

  private shareUrl(
    pathname: string,
    session: BaiduOAuthSession,
    shortUrl: string | null,
    includeProduct: boolean,
  ): URL {
    if (session.appId === null) throw new BaiduApiError('BAIDU_SHARE_CAPABILITY_UNAVAILABLE', null);
    const url = new URL(pathname, BAIDU_API_ORIGIN);
    url.searchParams.set('appid', session.appId);
    url.searchParams.set('access_token', session.accessToken);
    if (shortUrl !== null) url.searchParams.set('short_url', shortUrl);
    if (includeProduct) url.searchParams.set('product', PRODUCT);
    return url;
  }

  private xpanUrl(
    pathname: string,
    session: BaiduOAuthSession,
    query: Record<string, string>,
  ): URL {
    const url = new URL(pathname, BAIDU_API_ORIGIN);
    url.searchParams.set('access_token', session.accessToken);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url;
  }

  private async requestJson(
    url: URL,
    init: RequestInit,
    signal?: AbortSignal,
    allowedErrnos: ReadonlySet<number> = new Set(),
  ): Promise<unknown> {
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'pan.baidu.com' ||
      url.username !== '' ||
      url.password !== ''
    ) {
      throw new BaiduApiError('BAIDU_API_URL_REJECTED', null);
    }
    const requestSignal = createBoundedRequestSignal(signal, this.requestTimeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await this.fetcher(url, {
        ...init,
        redirect: 'error',
        signal: requestSignal.signal,
      });
      text = await this.readBounded(response);
    } catch (error) {
      if (error instanceof BaiduApiError) throw error;
      if (signal?.aborted) throw error;
      throw new BaiduApiError('NETWORK_RESET', null);
    } finally {
      requestSignal.dispose();
    }
    if (response.status === 429) {
      throw new BaiduApiError(
        'RATE_LIMITED',
        parseRetryAfter(response.headers.get('retry-after'), this.now()),
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new BaiduApiError('AUTH_EXPIRED', null);
    }
    if (!response.ok) {
      throw new BaiduApiError(response.status >= 500 ? 'NETWORK_RESET' : 'BAIDU_API_FAILED', null);
    }
    let decoded: unknown;
    try {
      decoded = parseBaiduJsonLossless(text);
    } catch {
      throw new BaiduApiError('BAIDU_RESPONSE_INVALID', null);
    }
    const envelope = record(decoded);
    const rawErrno = envelope.errno;
    const errno = typeof rawErrno === 'string' ? Number(rawErrno) : rawErrno;
    if (!Number.isSafeInteger(errno)) throw new BaiduApiError('BAIDU_RESPONSE_INVALID', null);
    if (errno !== 0 && !allowedErrnos.has(errno as number)) {
      throw new BaiduApiError(apiErrorCode(errno as number), null);
    }
    return decoded;
  }

  private async readBounded(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (reader === undefined) return '';
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > this.maximumResponseBytes) {
          throw new BaiduApiError('BAIDU_RESPONSE_TOO_LARGE', null);
        }
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  }

  private validateAppPath(value: string): void {
    const normalized = value.replace(/\/{2,}/g, '/');
    if (
      normalized !== value ||
      !isManagedBaiduMutationPath(normalized) ||
      normalized.endsWith('/') ||
      normalized.includes('\\') ||
      normalized.includes('\0') ||
      normalized.split('/').some((segment) => segment === '.' || segment === '..') ||
      normalized.length > 4096
    ) {
      throw new BaiduApiError('BAIDU_APP_PATH_INVALID', null);
    }
  }

  private validateBrowsePath(value: string): string {
    const normalized = value;
    if (!isCanonicalBaiduPath(normalized, true)) {
      throw new BaiduApiError('BAIDU_APP_PATH_INVALID', null);
    }
    return normalized;
  }
  private validateReadSelection(value: string): void {
    if (!isCanonicalBaiduPath(value, false))
      throw new BaiduApiError('BAIDU_SOURCE_PATH_INVALID', null);
  }
}

function browseHasMore(value: unknown, count: number, limit: number): boolean {
  if (value === undefined || value === null) return count === limit;
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  throw new BaiduApiError('BAIDU_RESPONSE_INVALID', null);
}
