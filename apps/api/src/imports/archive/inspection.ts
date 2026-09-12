import { createHash } from 'node:crypto';

/** Technical listing data is untrusted; never let it choose an absolute write path. */
export type ArchiveMember = {
  path: string;
  size: string;
  directory: boolean;
  encrypted: boolean;
  /** Present only when a valid archive name needs a shorter local component. */
  sourcePath?: string;
  crc32?: string;
};
export type ArchiveGroup = {
  entry: string;
  members: string[];
  kind: 'SINGLE' | 'NUMERIC' | 'RAR_PART' | 'RAR_LEGACY' | 'ZIP_SPLIT';
};
export type InspectedArchiveGroup = ArchiveGroup & {
  issue: 'ARCHIVE_VOLUME_SET_INVALID' | null;
};

export class ArchiveError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ArchiveError';
  }
}

export function archiveAssert(value: unknown, code: string): asserts value {
  if (!value) throw new ArchiveError(code);
}

export function normalizeArchiveMember(value: string): string {
  return validateMemberPath(value, false);
}

function validateMemberPath(value: string, allowLongComponents: boolean): string {
  const normalized = value.replaceAll('\\', '/');
  archiveAssert(
    normalized.length > 0 &&
      normalized.length <= 4096 &&
      !Array.from(normalized).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === ':',
      ) &&
      normalized
        .split('/')
        .every(
          (part) =>
            part.length > 0 &&
            part !== '.' &&
            part !== '..' &&
            (allowLongComponents || Buffer.byteLength(part, 'utf8') <= 255) &&
            !/[. ]$/.test(part) &&
            !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        ),
    'ARCHIVE_MEMBER_UNSAFE',
  );
  return normalized;
}

/** 7z stores UTF-16 names, while Linux bounds each filename by UTF-8 bytes.
 * Preserve safe names and archive-volume suffixes; only oversized components
 * get a readable prefix plus a stable digest. All other safety rules stay on. */
export function mapArchiveMemberName(value: string): string {
  const normalized = validateMemberPath(value, true);
  return normalizeArchiveMember(
    normalized
      .split('/')
      .map((component) => {
        if (Buffer.byteLength(component, 'utf8') <= 255) return component;
        const suffix =
          /(?:\.part\d{1,4}\.rar|\.(?:7z|zip|tar|gz|bz2|xz)\.\d{2,4}|\.[rz]\d{2,3}|\.[A-Za-z0-9]{1,16})$/i.exec(
            component,
          )?.[0] ?? '';
        const stem = suffix ? component.slice(0, -suffix.length) : component;
        let prefix = '';
        for (const character of stem) {
          if (Buffer.byteLength(prefix + character, 'utf8') > 160) break;
          prefix += character;
        }
        return `${prefix}~${createHash('sha256').update(stem).digest('hex').slice(0, 16)}${suffix}`;
      })
      .join('/'),
  );
}

function nameKey(value: string): string {
  return value.normalize('NFC').toLowerCase();
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A contiguous name sequence is necessary, not proof of the last volume's integrity. */
export function archiveGroups(paths: readonly string[]): ArchiveGroup[] {
  return inspectArchiveGroups(paths).map(({ issue, ...group }) => {
    archiveAssert(issue === null, 'ARCHIVE_VOLUME_SET_INVALID');
    return group;
  });
}

/** A broken set is one non-executable group; unrelated sets remain usable. */
export function inspectArchiveGroups(paths: readonly string[]): InspectedArchiveGroup[] {
  const names = paths.map(normalizeArchiveMember);
  const byKey = new Map<string, string>();
  for (const name of names) {
    archiveAssert(!byKey.has(nameKey(name)), 'ARCHIVE_PATH_COLLISION');
    byKey.set(nameKey(name), name);
  }
  const batches = new Map<
    string,
    {
      kind: ArchiveGroup['kind'];
      base: string;
      parts: { name: string; number: number; width: number }[];
    }
  >();
  const ungrouped = new Set(names);
  for (const name of names) {
    let kind: ArchiveGroup['kind'];
    let base: string;
    let digits: string;
    let match: RegExpMatchArray | null;
    if ((match = name.match(/^(.*)\.part(\d+)\.rar$/i))) {
      kind = 'RAR_PART';
      base = match[1]!;
      digits = match[2]!;
    } else if ((match = name.match(/^(.*)\.r(\d{2,3})$/i))) {
      kind = 'RAR_LEGACY';
      base = match[1]!;
      digits = match[2]!;
    } else if ((match = name.match(/^(.*)\.z(\d{2,3})$/i))) {
      kind = 'ZIP_SPLIT';
      base = match[1]!;
      digits = match[2]!;
    } else if ((match = name.match(/^(.*)\.(\d{2,4})$/))) {
      kind = 'NUMERIC';
      base = match[1]!;
      digits = match[2]!;
    } else {
      continue;
    }
    const key = `${kind}:${nameKey(base)}`;
    const batch = batches.get(key) ?? { kind, base, parts: [] };
    batch.parts.push({ name, number: Number(digits), width: digits.length });
    batches.set(key, batch);
    ungrouped.delete(name);
  }
  const groups: InspectedArchiveGroup[] = [];
  for (const batch of batches.values()) {
    batch.parts.sort((a, b) => a.number - b.number);
    const first = batch.kind === 'RAR_LEGACY' ? 0 : 1;
    let valid =
      batch.parts.length <= 10000 &&
      batch.parts.every(
        (part, i) => part.number === first + i && part.width === batch.parts[0]!.width,
      );
    const members = batch.parts.map((part) => part.name);
    let entry = members[0]!;
    if (batch.kind === 'RAR_LEGACY' || batch.kind === 'ZIP_SPLIT') {
      const suffix = batch.kind === 'RAR_LEGACY' ? '.rar' : '.zip';
      const main = byKey.get(nameKey(batch.base + suffix));
      if (main === undefined || !ungrouped.has(main)) valid = false;
      else {
        ungrouped.delete(main);
        entry = main;
        if (batch.kind === 'RAR_LEGACY') members.unshift(main);
        else members.push(main);
      }
    }
    groups.push({
      entry,
      members,
      kind: batch.kind,
      issue: valid ? null : 'ARCHIVE_VOLUME_SET_INVALID',
    });
  }
  for (const entry of ungrouped)
    groups.push({ entry, members: [entry], kind: 'SINGLE', issue: null });
  return groups.sort((a, b) => compare(a.entry, b.entry));
}

export function archiveMagic(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes);
  for (const [hex, type] of [
    ['377abcaf271c', '7z'],
    ['504b0304', 'zip'],
    ['504b0506', 'zip'],
    ['504b0708', 'zip'],
    ['526172211a0700', 'rar'],
    ['526172211a070100', 'rar'],
    ['1f8b08', 'gzip'],
    ['425a68', 'bzip2'],
    ['fd377a585a00', 'xz'],
    ['28b52ffd', 'zstd'],
    ['4d534346', 'cab'],
  ] as const) {
    const magic = Buffer.from(hex, 'hex');
    if (head.subarray(0, magic.length).equals(magic)) return type;
  }
  if (head.length >= 262 && head.subarray(257, 262).toString('ascii') === 'ustar') return 'tar';
  return null;
}

/** `7zz l -slt -ba` only. Any malformed or duplicate field fails closed. */
export function parseArchiveListing(text: string, maxEntries = 100000): ArchiveMember[] {
  archiveAssert(Buffer.byteLength(text, 'utf8') <= 32 * 1024 * 1024, 'ARCHIVE_LIST_LIMIT');
  const members: ArchiveMember[] = [];
  const names = new Map<string, ArchiveMember>();
  const originalNames = new Set<string>();
  const cleaned = text
    .replaceAll('\r\n', '\n')
    .replace(/^Enter password(?: \(will not be echoed\))?:\s*$/gm, '')
    // Empty technical values such as a directory's final `Block = ` are valid.
    // Trim framing newlines, not the space that belongs to the field delimiter.
    .replace(/^\n+|\n+$/g, '');
  for (const block of cleaned.split(/\n\s*\n/).filter(Boolean)) {
    const fields = new Map<string, string>();
    for (const line of block.split('\n')) {
      const separator = line.indexOf(' = ');
      archiveAssert(separator > 0 && !line.includes('\r'), 'ARCHIVE_LIST_INVALID');
      const key = line.slice(0, separator),
        value = line.slice(separator + 3);
      archiveAssert(!fields.has(key), 'ARCHIVE_LIST_INVALID');
      fields.set(key, value);
    }
    const rawPath = fields.get('Path'),
      size = fields.get('Size');
    archiveAssert(
      rawPath !== undefined && size !== undefined && /^(0|[1-9]\d{0,29})$/.test(size),
      'ARCHIVE_LIST_INVALID',
    );
    archiveAssert(
      ![...fields.keys()].some((key) => /link|alternate stream|reparse/i.test(key)) &&
        !/(?:^|\s)[lpcbs][rwxstST-]{9}(?:\s|$)/.test(fields.get('Attributes') ?? ''),
      'ARCHIVE_MEMBER_UNSAFE',
    );
    const normalized = validateMemberPath(rawPath, true),
      localPath = mapArchiveMemberName(rawPath);
    const originalKey = nameKey(normalized);
    archiveAssert(!originalNames.has(originalKey), 'ARCHIVE_PATH_COLLISION');
    originalNames.add(originalKey);
    const crc = fields.get('CRC');
    archiveAssert(!crc || /^[a-fA-F0-9]{8}$/.test(crc), 'ARCHIVE_LIST_INVALID');
    const member: ArchiveMember = {
      path: localPath,
      size,
      directory:
        fields.get('Folder') === '+' ||
        /^D(?:\s|$)/.test(fields.get('Attributes') ?? '') ||
        /(?:^|\s)d[rwxstST-]{9}(?:\s|$)/.test(fields.get('Attributes') ?? ''),
      encrypted: fields.get('Encrypted') === '+',
      ...(localPath === normalized ? {} : { sourcePath: normalized }),
      ...(!crc ? {} : { crc32: crc.toLowerCase() }),
    };
    const key = nameKey(member.path);
    archiveAssert(!names.has(key), 'ARCHIVE_PATH_COLLISION');
    names.set(key, member);
    members.push(member);
    archiveAssert(members.length <= maxEntries, 'ARCHIVE_LIST_LIMIT');
  }
  for (const member of members) {
    const segments = nameKey(member.path).split('/');
    for (let i = 1; i < segments.length; i++) {
      const parent = names.get(segments.slice(0, i).join('/'));
      archiveAssert(parent === undefined || parent.directory, 'ARCHIVE_PATH_COLLISION');
    }
  }
  return members;
}
