import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ArchiveProcessingOptionsSchema, type ArchiveProcessingOptions } from '@ptvault/contracts';

import { importInvariant } from './errors.js';
import type { BaiduTransferredObject } from './data-plane/baidu-source.js';
import { inspectArchiveGroups } from './archive/inspection.js';
import { importGroupKey } from './groups/identity.js';

const decimal = z.string().regex(/^(?:0|[1-9][0-9]{0,39})$/);
const cloudPath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      value.startsWith('/') &&
      !value.includes('\\') &&
      !Array.from(value).some((character) => character.charCodeAt(0) < 0x20) &&
      (value === '/' ||
        value
          .split('/')
          .slice(1)
          .every((part) => part !== '' && part !== '.' && part !== '..')),
  );
const DirectorySchema = z.object({ fsid: decimal, path: cloudPath, mtime: decimal }).strict();
const ObjectSchema = DirectorySchema.extend({
  relativePath: z.string().min(1).max(4096),
  size: decimal,
  md5: z
    .string()
    .regex(/^[0-9a-f]{32}$/)
    .optional(),
}).strict();
const DirectoryManifestSchema = z
  .object({
    version: z.literal(1),
    sourceKind: z.enum(['BAIDU_APP_DIR', 'BAIDU_SHARE']),
    rootPath: cloudPath,
    sourceIdentity: z.string().min(1).max(256),
    directories: z.array(DirectorySchema).max(100_000),
    objects: z.array(ObjectSchema).min(1).max(1_000_000),
  })
  .strict();
const FileManifestSchema = z
  .object({
    version: z.literal(2),
    sourceKind: z.literal('BAIDU_APP_DIR'),
    sourceScope: z.literal('FILE'),
    rootPath: cloudPath,
    sourceIdentity: decimal,
    directories: z.array(DirectorySchema).length(0),
    objects: z.array(ObjectSchema).length(1),
  })
  .strict();
const ManifestSchema = z.discriminatedUnion('version', [
  DirectoryManifestSchema,
  FileManifestSchema,
  z
    .object({
      version: z.literal(4),
      sourceKind: z.literal('BAIDU_APP_DIR'),
      sourceScope: z.literal('GROUP'),
      rootPath: cloudPath,
      sourceIdentity: decimal,
      directories: z.array(DirectorySchema).max(100000),
      objects: z.array(ObjectSchema).min(1).max(10000),
      archive: ArchiveProcessingOptionsSchema,
      group: z
        .object({
          key: z.string().regex(/^[a-f0-9]{64}$/),
          parentManifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      version: z.literal(3),
      sourceKind: z.literal('BAIDU_APP_DIR'),
      rootPath: cloudPath,
      sourceIdentity: decimal,
      directories: z.array(DirectorySchema).max(100000),
      objects: z.array(ObjectSchema).min(1).max(100000),
      archive: ArchiveProcessingOptionsSchema.extend({
        baseVersion: z.union([z.literal(1), z.literal(2)]),
      }).strict(),
    })
    .strict(),
]);

export type SourceDirectoryIdentity = z.infer<typeof DirectorySchema>;
export type ImportSourceManifest = z.infer<typeof ManifestSchema>;
export type GroupSourceManifest = Extract<ImportSourceManifest, { version: 4 }>;
export type ArchiveSourceManifest = Extract<ImportSourceManifest, { version: 3 | 4 }>;
export function isArchiveSourceManifest(
  manifest: ImportSourceManifest | null | undefined,
): manifest is ArchiveSourceManifest {
  return manifest?.version === 3 || manifest?.version === 4;
}
export type BaiduDirectorySnapshot = {
  directories: SourceDirectoryIdentity[];
  objects: BaiduTransferredObject[];
};

function order(a: { path: string; fsid: string }, b: { path: string; fsid: string }): number {
  const left = `${a.path}\0${a.fsid}`;
  const right = `${b.path}\0${b.fsid}`;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalSourceManifest(value: unknown): ImportSourceManifest {
  const parsed = ManifestSchema.safeParse(value);
  importInvariant(parsed.success, 'IMPORT_SOURCE_MANIFEST_INVALID', 409);
  const manifest = parsed.data;
  if (manifest.version === 4) {
    const base = canonicalSourceManifest({
      version: 1,
      sourceKind: manifest.sourceKind,
      rootPath: manifest.rootPath,
      sourceIdentity: manifest.sourceIdentity,
      directories: manifest.directories,
      objects: manifest.objects,
    });
    const groups = inspectArchiveGroups(base.objects.map((x) => x.relativePath));
    importInvariant(
      groups.length === 1 &&
        groups[0]!.issue === null &&
        importGroupKey(groups[0]!.kind, base.objects) === manifest.group.key,
      'IMPORT_SOURCE_MANIFEST_INVALID',
      409,
    );
    return { ...manifest, directories: base.directories, objects: base.objects };
  }
  if (manifest.version === 3) {
    const base = archiveBaseManifest(manifest);
    return {
      version: 3,
      sourceKind: 'BAIDU_APP_DIR',
      rootPath: base.rootPath,
      sourceIdentity: base.sourceIdentity,
      directories: base.directories,
      objects: base.objects,
      archive: manifest.archive,
    };
  }
  if (manifest.version === 2) {
    const object = manifest.objects[0]!;
    importInvariant(
      manifest.rootPath !== '/' &&
        object.path === manifest.rootPath &&
        object.fsid === manifest.sourceIdentity &&
        object.relativePath === manifest.rootPath.slice(manifest.rootPath.lastIndexOf('/') + 1),
      'IMPORT_SOURCE_MANIFEST_INVALID',
      409,
    );
    return manifest;
  }
  const prefix = manifest.rootPath === '/' ? '/' : `${manifest.rootPath}/`;
  const identities = new Set<string>();
  const paths = new Set<string>();
  for (const entry of [...manifest.directories, ...manifest.objects]) {
    importInvariant(
      !identities.has(entry.fsid) && !paths.has(entry.path),
      'IMPORT_SOURCE_MANIFEST_INVALID',
      409,
    );
    identities.add(entry.fsid);
    paths.add(entry.path);
    importInvariant(
      entry.path === manifest.rootPath || entry.path.startsWith(prefix),
      'IMPORT_SOURCE_MANIFEST_INVALID',
      409,
    );
  }
  for (const object of manifest.objects) {
    importInvariant(
      object.path === `${prefix}${object.relativePath}` && object.path !== manifest.rootPath,
      'IMPORT_SOURCE_MANIFEST_INVALID',
      409,
    );
  }
  if (manifest.sourceKind === 'BAIDU_APP_DIR') {
    importInvariant(
      manifest.directories.some(
        (entry) => entry.path === manifest.rootPath && entry.fsid === manifest.sourceIdentity,
      ),
      'IMPORT_SOURCE_MANIFEST_INVALID',
      409,
    );
  }
  return {
    ...manifest,
    directories: manifest.directories.sort(order),
    objects: manifest.objects.sort(order),
  };
}

export function buildSourceManifest(
  sourceKind: ImportSourceManifest['sourceKind'],
  rootPath: string,
  sourceIdentity: string,
  snapshot: BaiduDirectorySnapshot,
): ImportSourceManifest {
  const prefix = rootPath === '/' ? '/' : `${rootPath}/`;
  return canonicalSourceManifest({
    version: 1,
    sourceKind,
    rootPath,
    sourceIdentity,
    directories: snapshot.directories,
    objects: snapshot.objects.map((object) => ({
      fsid: object.fsid,
      path: `${prefix}${object.relativePath}`,
      relativePath: object.relativePath,
      size: object.size,
      mtime: object.mtime,
      ...(object.md5 === undefined ? {} : { md5: object.md5.toLowerCase() }),
    })),
  });
}

export function sourceManifestDigest(manifest: ImportSourceManifest): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalSourceManifest(manifest)))
    .digest('hex');
}

export function buildFileSourceManifest(
  sourcePath: string,
  object: BaiduTransferredObject,
): ImportSourceManifest {
  return canonicalSourceManifest({
    version: 2,
    sourceKind: 'BAIDU_APP_DIR',
    sourceScope: 'FILE',
    rootPath: sourcePath,
    sourceIdentity: object.fsid,
    directories: [],
    objects: [
      {
        fsid: object.fsid,
        path: sourcePath,
        relativePath: object.relativePath,
        size: object.size,
        mtime: object.mtime,
        ...(object.md5 === undefined ? {} : { md5: object.md5.toLowerCase() }),
      },
    ],
  });
}

export function readSourceManifest(
  json: string | null,
  digest: string | null,
): ImportSourceManifest | null {
  if (json === null && digest === null) return null;
  importInvariant(json !== null && digest !== null, 'IMPORT_PLAN_MANIFEST_MISMATCH', 409);
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    importInvariant(false, 'IMPORT_SOURCE_MANIFEST_INVALID', 409);
  }
  const manifest = canonicalSourceManifest(value);
  importInvariant(sourceManifestDigest(manifest) === digest, 'IMPORT_PLAN_MANIFEST_MISMATCH', 409);
  return manifest;
}

/** A v3 source remains an original-source proof, not a synthetic Baidu file list. */
export function archiveBaseManifest(manifest: ImportSourceManifest): ImportSourceManifest {
  if (manifest.version !== 3) return canonicalSourceManifest(manifest);
  return canonicalSourceManifest({
    version: manifest.archive.baseVersion,
    sourceKind: manifest.sourceKind,
    ...(manifest.archive.baseVersion === 2 ? { sourceScope: 'FILE' } : {}),
    rootPath: manifest.rootPath,
    sourceIdentity: manifest.sourceIdentity,
    directories: manifest.directories,
    objects: manifest.objects,
  });
}

/** Old v1/v2 workers reject this version rather than uploading compressed inputs. */
export function buildArchiveSourceManifest(
  base: ImportSourceManifest,
  options: ArchiveProcessingOptions,
): ImportSourceManifest {
  importInvariant(
    (base.version === 1 || base.version === 2) && base.sourceKind === 'BAIDU_APP_DIR',
    'IMPORT_ARCHIVE_SOURCE_UNSUPPORTED',
    409,
  );
  const original = canonicalSourceManifest(base);
  return canonicalSourceManifest({
    version: 3,
    sourceKind: original.sourceKind,
    rootPath: original.rootPath,
    sourceIdentity: original.sourceIdentity,
    directories: original.directories,
    objects: original.objects,
    archive: { ...ArchiveProcessingOptionsSchema.parse(options), baseVersion: original.version },
  });
}
