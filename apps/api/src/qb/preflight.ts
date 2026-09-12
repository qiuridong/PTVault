import type { BigIntStats, Stats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  TorrentIdentitySchema,
  TorrentPreflightSchema,
  type PreflightIssue,
  type TorrentIdentity,
  type TorrentPreflight,
} from '@ptvault/contracts';

import { canonicalAllowedPath, isPathWithinRoot, PathSafetyError } from '../core/paths.js';
import { canonicalHash, type TorrentFileRecord, type TorrentRecord } from './repository.js';

export type PreflightRepository = {
  getTorrent(instanceId: string, hash: string): TorrentRecord | null;
  listTorrents(instanceId?: string): TorrentRecord[];
  listTorrentFiles?(instanceId: string, hash: string): TorrentFileRecord[];
  listAllTorrentFiles?(): TorrentFileRecord[];
};

export type AllowedRootConfiguration =
  readonly string[] | Readonly<Record<string, readonly string[]>>;

export type TorrentPreflightServiceOptions = {
  repository: PreflightRepository;
  allowedRoots: AllowedRootConfiguration;
};

export type PreflightErrorCode = 'INVALID_IDENTITY' | 'TORRENT_NOT_FOUND';

export class PreflightError extends Error {
  constructor(
    readonly code: PreflightErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PreflightError';
  }
}

type FileObservation = {
  canonicalPath: string;
  displayPath: string;
  inodeKey: string;
  identity: BigIntStats;
  stats: Stats;
  viaSymlink: boolean;
};

type PathStats = {
  identity: BigIntStats;
  stats: Stats;
};

type ContentSnapshot = {
  canonicalRoot: string;
  rootIsDirectory: boolean;
  files: FileObservation[];
};

type TorrentReference = {
  canonicalPath: string;
  isDirectory: boolean;
};

type IssueCollector = {
  add: (code: PreflightIssue['code'], issuePath: string | null, message: string) => void;
  values: () => PreflightIssue[];
};

const ACTIVE_WRITE_STATES = new Set<TorrentRecord['state']>(['DOWNLOADING', 'CHECKING']);
const UNSAFE_COMPLETION_STATES = new Set<TorrentRecord['state']>([
  'MISSING_FILES',
  'ERROR',
  'UNKNOWN',
]);

export class TorrentPreflightService {
  private readonly repository: PreflightRepository;
  private readonly allowedRoots: AllowedRootConfiguration;

  constructor(options: TorrentPreflightServiceOptions);
  constructor(repository: PreflightRepository, allowedRoots: AllowedRootConfiguration);
  constructor(
    optionsOrRepository: TorrentPreflightServiceOptions | PreflightRepository,
    allowedRoots?: AllowedRootConfiguration,
  ) {
    if ('repository' in optionsOrRepository && 'allowedRoots' in optionsOrRepository) {
      this.repository = optionsOrRepository.repository;
      this.allowedRoots = optionsOrRepository.allowedRoots;
      return;
    }
    if (!allowedRoots) throw new Error('allowedRoots are required');
    this.repository = optionsOrRepository;
    this.allowedRoots = allowedRoots;
  }

  async check(identity: TorrentIdentity): Promise<TorrentPreflight> {
    const parsedIdentity = TorrentIdentitySchema.safeParse(identity);
    if (!parsedIdentity.success) {
      throw new PreflightError('INVALID_IDENTITY', 'Torrent identity is invalid');
    }

    const canonicalIdentity = {
      instanceId: parsedIdentity.data.instanceId,
      hash: canonicalHash(parsedIdentity.data.hash),
    };
    const torrent = this.repository.getTorrent(
      canonicalIdentity.instanceId,
      canonicalIdentity.hash,
    );
    if (!torrent) throw new PreflightError('TORRENT_NOT_FOUND', 'Torrent was not found');

    const roots = rootsForInstance(this.allowedRoots, torrent.instanceId);
    const issues = createIssueCollector();
    addStateIssues(torrent, issues);

    const contentCandidate = resolveContentPath(torrent);
    await inspectSavePath(torrent.savePath, roots, issues);
    const snapshot = await inspectContent(contentCandidate, roots, issues);

    if (!snapshot) {
      return makeResult(canonicalIdentity, 0, 0, 0, issues.values());
    }

    const uniqueFiles = uniqueByInode(snapshot.files);
    const logicalBytes = sumSafe(uniqueFiles.map((file) => file.stats.size));
    const allocatedBytes = sumSafe(uniqueFiles.map((file) => allocatedBytesForObservation(file)));

    compareWithStoredSnapshot(
      torrent,
      snapshot,
      this.repository.listTorrentFiles?.(torrent.instanceId, torrent.hash) ?? [],
      issues,
    );

    const references = await this.loadOtherTorrentReferences(torrent);
    const unsafeInodes = markSharedFiles(snapshot, references, issues);
    markExternalHardlinks(snapshot.files, unsafeInodes, issues);

    const allIssues = issues.values();
    const globalBlock = allIssues.some((issue) =>
      [
        'ACTIVE_WRITE',
        'NOT_COMPLETE',
        'OUTSIDE_ALLOWED_ROOT',
        'PATH_CHANGED',
        'PATH_MISSING',
        'SYMLINK_ESCAPE',
      ].includes(issue.code),
    );
    const reclaimableBytes = globalBlock
      ? 0
      : sumSafe(
          uniqueFiles
            .filter((file) => !unsafeInodes.has(file.inodeKey))
            .map((file) => allocatedBytesForObservation(file)),
        );

    return makeResult(canonicalIdentity, logicalBytes, allocatedBytes, reclaimableBytes, allIssues);
  }

  private async loadOtherTorrentReferences(current: TorrentRecord): Promise<TorrentReference[]> {
    const references: TorrentReference[] = [];
    for (const torrent of this.repository.listTorrents()) {
      if (
        torrent.absentSince !== null ||
        (torrent.instanceId === current.instanceId && torrent.hash === current.hash)
      ) {
        continue;
      }

      const roots = rootsForInstance(this.allowedRoots, torrent.instanceId);
      if (roots.length === 0) continue;
      try {
        const canonicalPath = await canonicalAllowedPath(resolveContentPath(torrent), roots);
        const stats = await lstat(canonicalPath);
        references.push({ canonicalPath, isDirectory: stats.isDirectory() });

        for (const snapshot of this.repository.listTorrentFiles?.(
          torrent.instanceId,
          torrent.hash,
        ) ?? []) {
          const snapshotPath = resolveStoredFilePath(canonicalPath, stats.isDirectory(), snapshot);
          if (!snapshotPath) continue;
          try {
            const canonicalSnapshotPath = await canonicalAllowedPath(snapshotPath, roots);
            references.push({ canonicalPath: canonicalSnapshotPath, isDirectory: false });
          } catch {
            // An invalid reference cannot make the selected torrent safer.
          }
        }
      } catch {
        // Missing or out-of-root peer torrents do not grant reclaimability.
      }
    }

    return references;
  }
}

function rootsForInstance(
  configuration: AllowedRootConfiguration,
  instanceId: string,
): readonly string[] {
  return isRootList(configuration) ? configuration : (configuration[instanceId] ?? []);
}

function isRootList(configuration: AllowedRootConfiguration): configuration is readonly string[] {
  return Array.isArray(configuration);
}

function resolveContentPath(torrent: TorrentRecord): string {
  return path.isAbsolute(torrent.contentPath)
    ? path.resolve(torrent.contentPath)
    : path.resolve(torrent.savePath, torrent.contentPath);
}

function addStateIssues(torrent: TorrentRecord, issues: IssueCollector): void {
  if (
    torrent.progress < 1 ||
    torrent.amountLeft > 0 ||
    UNSAFE_COMPLETION_STATES.has(torrent.state)
  ) {
    issues.add('NOT_COMPLETE', torrent.contentPath, 'Torrent content is not complete');
  }
  if (ACTIVE_WRITE_STATES.has(torrent.state)) {
    issues.add('ACTIVE_WRITE', torrent.contentPath, 'Torrent state may write content');
  }
}

async function inspectSavePath(
  savePath: string,
  roots: readonly string[],
  issues: IssueCollector,
): Promise<void> {
  try {
    await canonicalAllowedPath(savePath, roots);
  } catch (error: unknown) {
    addPathError(error, savePath, issues);
  }
}

async function inspectContent(
  contentPath: string,
  roots: readonly string[],
  issues: IssueCollector,
): Promise<ContentSnapshot | null> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await canonicalAllowedPath(contentPath, roots);
  } catch (error: unknown) {
    addPathError(error, contentPath, issues);
    return null;
  }

  let rootStats: PathStats;
  try {
    rootStats = await readPathStats(canonicalRoot);
  } catch (error: unknown) {
    addPathError(error, contentPath, issues);
    return null;
  }

  if (!rootStats.stats.isFile() && !rootStats.stats.isDirectory()) {
    issues.add('PATH_CHANGED', contentPath, 'Content path is not a regular file or directory');
    return null;
  }

  const files: FileObservation[] = [];
  const visitedDirectories = new Set<string>();
  await walkContent(
    contentPath,
    canonicalRoot,
    rootStats,
    false,
    roots,
    files,
    visitedDirectories,
    issues,
  );
  return { canonicalRoot, rootIsDirectory: rootStats.stats.isDirectory(), files };
}

async function walkContent(
  displayPath: string,
  canonicalPath: string,
  pathStats: PathStats,
  viaSymlink: boolean,
  roots: readonly string[],
  files: FileObservation[],
  visitedDirectories: Set<string>,
  issues: IssueCollector,
): Promise<void> {
  const { identity, stats } = pathStats;
  if (stats.isFile()) {
    files.push({
      canonicalPath,
      displayPath,
      inodeKey: inodeKey(identity, canonicalPath),
      identity,
      stats,
      viaSymlink,
    });
    return;
  }
  if (!stats.isDirectory()) {
    issues.add('PATH_CHANGED', displayPath, 'Content entry is not a regular file or directory');
    return;
  }

  const directoryKey = inodeKey(identity, canonicalPath);
  if (visitedDirectories.has(directoryKey)) return;
  visitedDirectories.add(directoryKey);

  let entries;
  try {
    entries = await readdir(canonicalPath, { withFileTypes: true });
  } catch (error: unknown) {
    addPathError(error, displayPath, issues);
    return;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const childDisplayPath = path.join(displayPath, entry.name);
    let childCanonicalPath: string;
    try {
      childCanonicalPath = await canonicalAllowedPath(childDisplayPath, roots);
    } catch (error: unknown) {
      addPathError(error, childDisplayPath, issues);
      continue;
    }

    try {
      const linkStats = await readPathStats(childDisplayPath);
      const targetStats = linkStats.stats.isSymbolicLink()
        ? await readPathStats(childCanonicalPath)
        : linkStats;
      await walkContent(
        childDisplayPath,
        childCanonicalPath,
        targetStats,
        viaSymlink || linkStats.stats.isSymbolicLink(),
        roots,
        files,
        visitedDirectories,
        issues,
      );
    } catch (error: unknown) {
      addPathError(error, childDisplayPath, issues);
    }
  }
}

function compareWithStoredSnapshot(
  torrent: TorrentRecord,
  content: ContentSnapshot,
  snapshots: readonly TorrentFileRecord[],
  issues: IssueCollector,
): void {
  if (snapshots.length === 0) return;

  const observations = new Map(
    content.files.map((file) => [normalizeForComparison(file.canonicalPath), file]),
  );
  for (const snapshot of snapshots) {
    const expectedPath = resolveStoredFilePath(
      content.canonicalRoot,
      content.rootIsDirectory,
      snapshot,
    );
    if (!expectedPath) {
      issues.add('PATH_CHANGED', snapshot.relativePath, 'Stored file path is no longer valid');
      continue;
    }

    const observation = observations.get(normalizeForComparison(expectedPath));
    if (!observation) {
      issues.add('PATH_MISSING', expectedPath, 'Snapshotted torrent file is missing');
      continue;
    }

    const currentAllocated = allocatedBytesForObservation(observation);
    if (
      observation.stats.size !== snapshot.size ||
      (snapshot.device !== null && observation.stats.dev !== snapshot.device) ||
      (snapshot.inode !== null && observation.stats.ino !== snapshot.inode) ||
      (snapshot.linkCount !== null && observation.stats.nlink !== snapshot.linkCount) ||
      (snapshot.allocatedBytes !== null && currentAllocated !== snapshot.allocatedBytes)
    ) {
      issues.add('PATH_CHANGED', observation.displayPath, 'Torrent file changed after snapshot');
    }
  }
}

function resolveStoredFilePath(
  canonicalRoot: string,
  rootIsDirectory: boolean,
  snapshot: TorrentFileRecord,
): string | null {
  if (
    snapshot.relativePath.includes('\0') ||
    path.isAbsolute(snapshot.relativePath) ||
    snapshot.relativePath === ''
  ) {
    return null;
  }

  if (!rootIsDirectory) {
    const normalized = path.normalize(snapshot.relativePath);
    return normalized === path.basename(canonicalRoot) || normalized === '.' ? canonicalRoot : null;
  }

  const expected = path.resolve(canonicalRoot, snapshot.relativePath);
  return isPathWithinRoot(expected, canonicalRoot) ? expected : null;
}

function markSharedFiles(
  content: ContentSnapshot,
  references: readonly TorrentReference[],
  issues: IssueCollector,
): Set<string> {
  const unsafeInodes = new Set<string>();
  for (const file of content.files) {
    const shared = references.some(
      (reference) =>
        normalizeForComparison(reference.canonicalPath) ===
          normalizeForComparison(file.canonicalPath) ||
        (reference.isDirectory && isPathWithinRoot(file.canonicalPath, reference.canonicalPath)),
    );
    if (!shared) continue;
    unsafeInodes.add(file.inodeKey);
    issues.add(
      'SHARED_TORRENT_FILE',
      file.displayPath,
      'Torrent file is referenced by another torrent',
    );
  }
  return unsafeInodes;
}

function markExternalHardlinks(
  files: readonly FileObservation[],
  unsafeInodes: Set<string>,
  issues: IssueCollector,
): void {
  const knownPathsPerInode = new Map<string, Set<string>>();
  for (const file of files) {
    if (file.viaSymlink) continue;
    const paths = knownPathsPerInode.get(file.inodeKey) ?? new Set<string>();
    paths.add(normalizeForComparison(file.canonicalPath));
    knownPathsPerInode.set(file.inodeKey, paths);
  }

  for (const file of uniqueByInode(files)) {
    const knownPathCount = knownPathsPerInode.get(file.inodeKey)?.size ?? 0;
    if (file.identity.nlink <= BigInt(Math.max(1, knownPathCount))) continue;
    unsafeInodes.add(file.inodeKey);
    issues.add(
      'EXTERNAL_HARDLINK',
      file.displayPath,
      'Torrent file has a hardlink outside the snapshotted content',
    );
  }
}

function uniqueByInode(files: readonly FileObservation[]): FileObservation[] {
  const unique = new Map<string, FileObservation>();
  for (const file of files) {
    if (!unique.has(file.inodeKey)) unique.set(file.inodeKey, file);
  }
  return [...unique.values()];
}

function inodeKey(stats: BigIntStats, canonicalPath: string): string {
  if (stats.ino !== 0n) {
    return `${stats.dev}:${stats.ino}`;
  }
  return `path:${normalizeForComparison(canonicalPath)}`;
}

function allocatedBytesForObservation(file: FileObservation): number {
  const allocated = file.identity.blocks * 512n;
  if (allocated < 0n || allocated > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Allocated byte count exceeds JavaScript safe integer range');
  }
  return Number(allocated);
}

async function readPathStats(candidate: string): Promise<PathStats> {
  const [stats, identity] = await Promise.all([
    lstat(candidate),
    lstat(candidate, { bigint: true }),
  ]);
  return { stats, identity };
}

function addPathError(error: unknown, candidate: string, issues: IssueCollector): void {
  if (error instanceof PathSafetyError) {
    if (error.code === 'SYMLINK_ESCAPE') {
      issues.add('SYMLINK_ESCAPE', candidate, error.message);
      return;
    }
    if (error.code === 'OUTSIDE_ALLOWED_ROOT' || error.code === 'PATH_CONTAINS_NUL') {
      issues.add('OUTSIDE_ALLOWED_ROOT', candidate, error.message);
      return;
    }
    issues.add('PATH_MISSING', candidate, error.message);
    return;
  }
  if (isMissingPathError(error)) {
    issues.add('PATH_MISSING', candidate, 'Path does not exist');
    return;
  }
  throw error;
}

function createIssueCollector(): IssueCollector {
  const issues = new Map<string, PreflightIssue>();
  return {
    add: (code, issuePath, message) => {
      const key = `${code}\0${issuePath ?? ''}`;
      if (!issues.has(key)) {
        issues.set(key, { code, path: issuePath, blocking: true, message });
      }
    },
    values: () =>
      [...issues.values()].sort(
        (left, right) =>
          left.code.localeCompare(right.code) || (left.path ?? '').localeCompare(right.path ?? ''),
      ),
  };
}

function makeResult(
  identity: TorrentIdentity,
  logicalBytes: number,
  allocatedBytes: number,
  reclaimableBytes: number,
  issues: readonly PreflightIssue[],
): TorrentPreflight {
  return TorrentPreflightSchema.parse({
    ...identity,
    logicalBytes,
    allocatedBytes,
    reclaimableBytes,
    eligible: !issues.some((issue) => issue.blocking),
    issues,
  });
}

function sumSafe(values: readonly number[]): number {
  return values.reduce((total, value) => {
    const next = total + value;
    if (!Number.isSafeInteger(next) || next < 0) {
      throw new Error('Filesystem byte total exceeds JavaScript safe integer range');
    }
    return next;
  }, 0);
}

function normalizeForComparison(candidate: string): string {
  const resolved = path.resolve(candidate);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}
