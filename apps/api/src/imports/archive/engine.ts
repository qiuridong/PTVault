import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm, statfs } from 'node:fs/promises';
import path from 'node:path';
import {
  ArchiveError,
  archiveAssert,
  archiveGroups,
  archiveMagic,
  normalizeArchiveMember,
  type ArchiveMember,
} from './inspection.js';

export type ArchiveCodecInput = {
  entry: string;
  inputRoot: string;
  password: string;
  signal?: AbortSignal;
};
export interface ArchiveCodec {
  list(input: ArchiveCodecInput): Promise<ArchiveMember[]>;
  extract(
    input: ArchiveCodecInput & {
      outputRoot: string;
      members: readonly ArchiveMember[];
      maxBytes: string;
      reserveBytes: string;
      maxFiles: number;
      onProgress?: (expandedBytes: string) => void | Promise<void>;
    },
  ): Promise<void>;
}
export type ArchiveLimits = {
  maxDepth: number;
  maxFiles: number;
  /** Sum of every newly expanded file, including intermediate inner archives. */
  maxExpandedBytes: string;
  reserveBytes: string;
};
export type ArchiveProgress = {
  phase: 'INSPECTING' | 'EXTRACTING' | 'VERIFYING_VIDEO' | 'COMPLETE';
  depth: number;
  archiveCount: number;
  videoCount: number;
  expandedBytes: string;
  archiveAlias?: string;
  candidateIndex?: number;
  renamedMember?: { originalPath: string; localPath: string };
};
export type ExtractedVideo = { absolutePath: string; relativePath: string; size: string };
export type ArchiveExtractionResult = {
  videos: ExtractedVideo[];
  archiveCount: number;
  maxDepth: number;
  expandedBytes: string;
};
export type ArchiveExtractionInput = {
  inputRoot: string;
  workRoot: string;
  passwords: readonly string[];
  limits: ArchiveLimits;
  signal?: AbortSignal;
  videoProbe: (absolutePath: string, signal?: AbortSignal) => Promise<boolean>;
  onProgress?: (event: ArchiveProgress) => void | Promise<void>;
};

export const VIDEO_SUFFIX =
  /\.(?:mp4|mkv|avi|mov|wmv|flv|rm|rmvb|m4v|ts|m2ts|mts|mpg|mpeg|webm|vob|3gp|ogv|asf|divx)$/i;
const ARCHIVE_SUFFIX = /\.(?:zip|zipx|rar|7z|tar|gz|bz2|xz|zst|zstd|tgz|tbz2|txz|cab)$/i;

export async function assertArchiveRoot(root: string): Promise<string> {
  archiveAssert(path.isAbsolute(root), 'ARCHIVE_ROOT_INVALID');
  const resolved = path.resolve(root),
    info = await lstat(resolved);
  archiveAssert(info.isDirectory() && !info.isSymbolicLink(), 'ARCHIVE_ROOT_INVALID');
  return realpath(resolved);
}

/** Only returns ordinary files, never follows a link or special device. */
export async function scanArchiveTree(root: string, maxFiles: number): Promise<ArchiveMember[]> {
  const members: ArchiveMember[] = [];
  async function walk(relative: string): Promise<void> {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const name = normalizeArchiveMember(relative ? `${relative}/${entry.name}` : entry.name);
      const info = await lstat(path.join(root, name), { bigint: true });
      archiveAssert(
        !info.isSymbolicLink() && (info.isFile() || info.isDirectory()),
        'ARCHIVE_MEMBER_UNSAFE',
      );
      if (info.isFile()) archiveAssert(info.nlink === 1n, 'ARCHIVE_MEMBER_UNSAFE');
      members.push({
        path: name,
        size: info.isFile() ? info.size.toString() : '0',
        directory: info.isDirectory(),
        encrypted: false,
      });
      archiveAssert(members.length <= maxFiles, 'ARCHIVE_LIST_LIMIT');
      if (info.isDirectory()) await walk(name);
    }
  }
  await walk('');
  return members;
}

export async function assertArchiveFreeSpace(
  root: string,
  needed: bigint,
  reserve: bigint,
): Promise<void> {
  const info = await statfs(root, { bigint: true });
  archiveAssert(info.bavail * info.bsize >= needed + reserve, 'ARCHIVE_DISK_SPACE_LOW');
}

async function digestFiles(files: readonly string[], signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for (const filename of files) {
    signal?.throwIfAborted();
    const input = createReadStream(filename, { signal });
    for await (const chunk of input) hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

async function header(filename: string): Promise<Buffer> {
  const file = await open(filename, 'r');
  try {
    const bytes = Buffer.alloc(560);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

async function removeAttempt(root: string, attempt: string): Promise<void> {
  // Both paths originate here, not from an archive member. Check again at delete.
  archiveAssert(
    path.dirname(attempt) === root && /^layer-[0-9a-f-]{36}$/.test(path.basename(attempt)),
    'ARCHIVE_ROOT_INVALID',
  );
  const info = await lstat(attempt);
  archiveAssert(info.isDirectory() && !info.isSymbolicLink(), 'ARCHIVE_ROOT_INVALID');
  await rm(attempt, { recursive: true, force: false });
}

function verifyExtracted(actual: ArchiveMember[], expected: readonly ArchiveMember[]): void {
  const files = actual.filter((member) => !member.directory);
  const required = new Map(
    expected.filter((member) => !member.directory).map((member) => [member.path, member]),
  );
  archiveAssert(files.length === required.size, 'ARCHIVE_OUTPUT_MISMATCH');
  for (const file of files)
    archiveAssert(required.get(file.path)?.size === file.size, 'ARCHIVE_OUTPUT_MISMATCH');
  // Empty directories and implicit parent directories are harmless, but an
  // unexpected file (including a symlink) is never an accepted extractor result.
}

/** No cloud writes: returns videos only after every selected branch completed. */
export class RecursiveArchiveExtractor {
  constructor(private readonly options: { codec: ArchiveCodec }) {}

  async extract(input: ArchiveExtractionInput): Promise<ArchiveExtractionResult> {
    const { limits, signal } = input;
    archiveAssert(
      Number.isSafeInteger(limits.maxDepth) &&
        limits.maxDepth >= 1 &&
        limits.maxDepth <= 16 &&
        Number.isSafeInteger(limits.maxFiles) &&
        limits.maxFiles >= 1 &&
        limits.maxFiles <= 100000 &&
        /^[1-9]\d{0,29}$/.test(limits.maxExpandedBytes) &&
        /^(?:0|[1-9]\d{0,29})$/.test(limits.reserveBytes),
      'ARCHIVE_LIMIT_INVALID',
    );
    archiveAssert(
      input.passwords.length <= 32 &&
        input.passwords.every(
          (value) =>
            typeof value === 'string' &&
            value.length > 0 &&
            value.length <= 256 &&
            !/[\r\n\0]/.test(value),
        ),
      'ARCHIVE_CREDENTIAL_INVALID',
    );
    signal?.throwIfAborted();
    const inputRoot = await assertArchiveRoot(input.inputRoot),
      workRoot = await assertArchiveRoot(input.workRoot);
    archiveAssert(
      inputRoot !== workRoot &&
        !workRoot.startsWith(inputRoot + path.sep) &&
        !inputRoot.startsWith(workRoot + path.sep),
      'ARCHIVE_ROOT_INVALID',
    );
    const candidates = ['', ...new Set(input.passwords)];
    const budget = BigInt(limits.maxExpandedBytes),
      reserve = BigInt(limits.reserveBytes);
    let expanded = 0n,
      archiveCount = 0,
      maxDepth = 0,
      entryCount = 0;
    const videos: ExtractedVideo[] = [];
    const videoNames = new Set<string>();
    const progress = async (
      phase: ArchiveProgress['phase'],
      depth: number,
      extra: Pick<ArchiveProgress, 'archiveAlias' | 'candidateIndex' | 'renamedMember'> = {},
    ) => {
      signal?.throwIfAborted();
      await input.onProgress?.({
        phase,
        depth,
        archiveCount,
        videoCount: videos.length,
        expandedBytes: expanded.toString(),
        ...extra,
      });
    };
    const visit = async (
      root: string,
      logicalPrefix: string,
      depth: number,
      ancestors: ReadonlySet<string>,
    ) => {
      signal?.throwIfAborted();
      const tree = await scanArchiveTree(root, limits.maxFiles);
      const files = tree.filter((member) => !member.directory);
      entryCount += tree.length;
      archiveAssert(entryCount <= limits.maxFiles, 'ARCHIVE_LIST_LIMIT');
      for (const group of archiveGroups(files.map((file) => file.path))) {
        signal?.throwIfAborted();
        const entry = path.join(root, group.entry);
        const magic = archiveMagic(await header(entry));
        const isArchive =
          group.kind !== 'SINGLE' || magic !== null || ARCHIVE_SUFFIX.test(group.entry);
        if (!isArchive) {
          if (!VIDEO_SUFFIX.test(group.entry)) continue;
          await progress('VERIFYING_VIDEO', depth);
          archiveAssert(await input.videoProbe(entry, signal), 'ARCHIVE_VIDEO_INVALID');
          const videoSize = files.find((file) => file.path === group.entry)!.size;
          if (depth === 0) {
            // Root-level videos are copied out, not moved out of the input set.
            // Their extra local copy consumes the same cumulative expansion budget.
            archiveAssert(expanded + BigInt(videoSize) <= budget, 'ARCHIVE_EXPANSION_LIMIT');
            await assertArchiveFreeSpace(workRoot, BigInt(videoSize), reserve);
            expanded += BigInt(videoSize);
          }
          const relativePath = normalizeArchiveMember(
            logicalPrefix ? `${logicalPrefix}/${group.entry}` : group.entry,
          );
          const key = relativePath.normalize('NFC').toLowerCase();
          archiveAssert(!videoNames.has(key), 'ARCHIVE_PATH_COLLISION');
          videoNames.add(key);
          videos.push({
            absolutePath: entry,
            relativePath,
            size: videoSize,
          });
          continue;
        }
        archiveAssert(depth < limits.maxDepth, 'ARCHIVE_DEPTH_LIMIT');
        const digest = await digestFiles(
          group.members.map((member) => path.join(root, member)),
          signal,
        );
        archiveAssert(!ancestors.has(digest), 'ARCHIVE_CYCLE_DETECTED');
        const nextAncestors = new Set([...ancestors, digest]);
        const archiveAlias = `archive-${digest.slice(0, 12)}`;
        let extracted: string | null = null;
        for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
          await progress('INSPECTING', depth + 1, { archiveAlias, candidateIndex });
          const codecInput: ArchiveCodecInput = {
            entry,
            inputRoot: root,
            password: candidates[candidateIndex]!,
            ...(signal ? { signal } : {}),
          };
          let outputRoot: string | null = null;
          try {
            const members = await this.options.codec.list(codecInput);
            // The codec contract is not permission to trust its field contents.
            archiveAssert(members.length + entryCount <= limits.maxFiles, 'ARCHIVE_LIST_LIMIT');
            const total = members.reduce((sum, member) => {
              normalizeArchiveMember(member.path);
              archiveAssert(/^(?:0|[1-9]\d{0,29})$/.test(member.size), 'ARCHIVE_LIST_INVALID');
              return sum + (member.directory ? 0n : BigInt(member.size));
            }, 0n);
            archiveAssert(expanded + total <= budget, 'ARCHIVE_EXPANSION_LIMIT');
            await assertArchiveFreeSpace(workRoot, total, reserve);
            for (const member of members)
              if (member.sourcePath !== undefined)
                await progress('INSPECTING', depth + 1, {
                  archiveAlias,
                  candidateIndex,
                  renamedMember: { originalPath: member.sourcePath, localPath: member.path },
                });
            outputRoot = path.join(workRoot, `layer-${randomUUID()}`);
            await mkdir(outputRoot, { mode: 0o700 });
            await progress('EXTRACTING', depth + 1, { archiveAlias, candidateIndex });
            await this.options.codec.extract({
              ...codecInput,
              outputRoot,
              members,
              maxBytes: total.toString(),
              reserveBytes: reserve.toString(),
              maxFiles: limits.maxFiles - entryCount,
              onProgress: async (used) => {
                await input.onProgress?.({
                  phase: 'EXTRACTING',
                  depth: depth + 1,
                  archiveCount,
                  videoCount: videos.length,
                  expandedBytes: (expanded + BigInt(used)).toString(),
                  archiveAlias,
                  candidateIndex,
                });
              },
            });
            verifyExtracted(await scanArchiveTree(outputRoot, limits.maxFiles), members);
            expanded += total;
            archiveCount++;
            maxDepth = Math.max(maxDepth, depth + 1);
            extracted = outputRoot;
            break;
          } catch (error) {
            if (outputRoot !== null) await removeAttempt(workRoot, outputRoot);
            if (!(error instanceof ArchiveError) || error.code !== 'ARCHIVE_PASSWORD_REJECTED')
              throw error;
          }
        }
        archiveAssert(extracted !== null, 'ARCHIVE_PASSWORDS_EXHAUSTED');
        const prefix = logicalPrefix ? `${logicalPrefix}/${group.entry}` : group.entry;
        await visit(extracted, prefix, depth + 1, nextAncestors);
      }
    };
    await visit(inputRoot, '', 0, new Set());
    archiveAssert(videos.length > 0, 'ARCHIVE_NO_VIDEO');
    await progress('COMPLETE', maxDepth);
    return { videos, archiveCount, maxDepth, expandedBytes: expanded.toString() };
  }
}
