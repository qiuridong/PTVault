import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import type { RcloneImportPreview } from '@ptvault/contracts';
import {
  configDigest,
  MAX_RCLONE_CONFIG_BYTES,
  parseRcloneConfig,
  type RcloneSections,
} from '../storage/rclone-config-files.js';
import { nativeToken } from '../storage/rclone-native-config.js';

export class RcloneImportError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export type RcloneImportSource = {
  sections: RcloneSections;
  pairs: RcloneImportPreview['pairs'];
  skippedCount: number;
};
const RAW_KEYS = new Set([
  'type',
  'token',
  'client_id',
  'client_secret',
  'drive_id',
  'drive_type',
  'root_folder_id',
  'region',
  'tenant',
  'auth_url',
  'token_url',
  'access_scopes',
  'disable_site_permission',
  'chunk_size',
  'list_chunk',
  'delta',
  'hash_type',
  'encoding',
  'description',
  'expose_onenote_files',
  'server_side_across_configs',
  'no_versions',
  'link_scope',
  'link_type',
  'link_password',
  'av_override',
  'hard_delete',
]);
const CRYPT_KEYS = new Set([
  'type',
  'remote',
  'password',
  'password2',
  'filename_encryption',
  'directory_name_encryption',
  'filename_encoding',
  'no_data_encryption',
  'pass_bad_blocks',
  'strict_names',
  'show_mapping',
  'suffix',
  'description',
]);
function allowed(fields: Map<string, string>, keys: Set<string>): boolean {
  return [...fields].every(([key, value]) => keys.has(key) && !/[\0\r\n]/.test(value));
}
function endpoint(value: string | undefined, kind: 'authorize' | 'token'): boolean {
  if (!value) return true;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      ['login.microsoftonline.com', 'login.microsoftonline.us', 'login.chinacloudapi.cn'].includes(
        url.hostname,
      ) &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      new RegExp(`^/[A-Za-z0-9._-]+/oauth2/(?:v2\\.0/)?${kind}$`).test(url.pathname)
    );
  } catch {
    return false;
  }
}
function supportedRaw(fields: Map<string, string> | undefined): boolean {
  if (!fields || fields.get('type') !== 'onedrive' || !allowed(fields, RAW_KEYS)) return false;
  if (
    !/^[A-Za-z0-9!._-]{1,200}$/.test(fields.get('drive_id') ?? '') ||
    !['personal', 'business', 'documentLibrary'].includes(fields.get('drive_type') ?? '')
  )
    return false;
  if (fields.has('region') && !['', 'global', 'us', 'de', 'cn'].includes(fields.get('region')!))
    return false;
  if (!endpoint(fields.get('auth_url'), 'authorize') || !endpoint(fields.get('token_url'), 'token'))
    return false;
  try {
    return Boolean(nativeToken(fields.get('token') ?? '').refreshToken);
  } catch {
    return false;
  }
}

/** Exact file, read-only descriptor, no rclone invocation or sidecar on the source. */
export function inspectRcloneImportSource(filename: string): RcloneImportSource {
  try {
    if (!path.isAbsolute(filename) || filename.includes('\0')) throw new Error();
    const before = lstatSync(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_RCLONE_CONFIG_BYTES)
      throw new Error();
    const fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let buffer: Buffer;
    try {
      const actual = fstatSync(fd);
      if (
        !actual.isFile() ||
        actual.ino !== before.ino ||
        actual.dev !== before.dev ||
        actual.size !== before.size
      )
        throw new Error();
      buffer = Buffer.alloc(actual.size + 1);
      let count = 0;
      for (;;) {
        const read = readSync(fd, buffer, count, buffer.length - count, null);
        count += read;
        if (read === 0 || count === buffer.length) break;
      }
      const after = fstatSync(fd);
      if (count !== actual.size || after.size !== actual.size || after.mtimeMs !== actual.mtimeMs)
        throw new Error();
      buffer = buffer.subarray(0, count);
    } finally {
      closeSync(fd);
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    if (text.includes('\0') || text.startsWith('RCLONE_ENCRYPT')) throw new Error();
    const sections = parseRcloneConfig(text);
    if (sections.size > 256 || [...sections.keys()].some((name) => name.length > 128))
      throw new Error();
    const pairs: RcloneImportPreview['pairs'] = [];
    for (const [cryptName, crypt] of sections) {
      if (crypt.get('type') !== 'crypt' || !allowed(crypt, CRYPT_KEYS) || !crypt.get('password'))
        continue;
      const match = /^([A-Za-z0-9_-]+):(.*)$/.exec(crypt.get('remote') ?? '');
      if (!match) continue;
      const raw = sections.get(match[1]!);
      if (!supportedRaw(raw)) continue;
      const drive = raw!.get('drive_id')!;
      pairs.push({
        id: cryptName,
        cryptName,
        rawName: match[1]!,
        driveType: raw!.get('drive_type') as RcloneImportPreview['pairs'][number]['driveType'],
        driveHint: `账户 ${configDigest(drive).slice(0, 10)}`,
      });
    }
    if (pairs.length > 128) throw new Error();
    return {
      sections,
      pairs,
      skippedCount:
        [...sections.values()].filter((fields) => fields.get('type') === 'crypt').length -
        pairs.length,
    };
  } catch {
    throw new RcloneImportError('RCLONE_IMPORT_SOURCE_UNSUPPORTED');
  }
}

export function selectRcloneImportSections(
  source: RcloneImportSource,
  pairIds: readonly string[],
  prefix: string,
): RcloneSections {
  if (
    pairIds.length < 1 ||
    pairIds.length > 2 ||
    new Set(pairIds).size !== pairIds.length ||
    !/^[A-Za-z0-9_-]+$/.test(prefix)
  )
    throw new RcloneImportError('RCLONE_IMPORT_SELECTION_INVALID');
  const output: RcloneSections = new Map();
  const drives = new Set<string>();
  for (const [index, id] of pairIds.entries()) {
    const pair = source.pairs.find((item) => item.id === id);
    if (!pair) throw new RcloneImportError('RCLONE_IMPORT_SELECTION_INVALID');
    const raw = new Map(source.sections.get(pair.rawName));
    const drive = raw.get('drive_id')!;
    if (drives.has(drive)) throw new RcloneImportError('RCLONE_IMPORT_DUPLICATE_DRIVE');
    drives.add(drive);
    const crypt = new Map(source.sections.get(pair.cryptName));
    const rawName = `${prefix}_raw${index}`;
    crypt.set('remote', rawName + crypt.get('remote')!.slice(pair.rawName.length));
    output.set(rawName, raw);
    output.set(`${prefix}_crypt${index}`, crypt);
  }
  return output;
}

export function renderRcloneSections(sections: RcloneSections): string {
  return [...sections]
    .map(
      ([name, values]) =>
        `[${name}]\n${[...values].map(([key, value]) => `${key} = ${value}\n`).join('')}`,
    )
    .join('\n');
}
