import type { ArchiveProcessingOptions } from '@ptvault/contracts';
import { ArchiveProcessingOptionsSchema } from '@ptvault/contracts';
import { inspectArchiveGroups, archiveAssert, type ArchiveGroup } from '../archive/inspection.js';
import {
  canonicalSourceManifest,
  sourceManifestDigest,
  type ImportSourceManifest,
  type GroupSourceManifest,
} from '../source-manifest.js';
import { importGroupKey } from './identity.js';

export type PlannedImportGroup = ArchiveGroup & {
  key: string;
  inputBytes: string;
  requiredSpoolBytes: string;
  issue: 'ARCHIVE_VOLUME_SET_INVALID' | 'GROUP_EXCEEDS_RESIDENT_BUDGET' | null;
};

/** Byte budget is a simultaneous resident bound, not the sum of all directory inputs. */
export function planImportGroups(
  source: ImportSourceManifest,
  options: ArchiveProcessingOptions,
  residentMaxBytes: string,
): PlannedImportGroup[] {
  const manifest = canonicalSourceManifest(source);
  archiveAssert(
    manifest.version === 1 && manifest.sourceKind === 'BAIDU_APP_DIR',
    'GROUP_DIRECTORY_SOURCE_REQUIRED',
  );
  const processing = ArchiveProcessingOptionsSchema.parse(options);
  archiveAssert(/^[1-9]\d{0,29}$/.test(residentMaxBytes), 'GROUP_RESIDENT_BUDGET_INVALID');
  const byPath = new Map(manifest.objects.map((x) => [x.relativePath, x]));
  return inspectArchiveGroups(manifest.objects.map((x) => x.relativePath)).map((group) => {
    const objects = group.members.map((name) => byPath.get(name)!);
    const inputBytes = objects.reduce((sum, x) => sum + BigInt(x.size), 0n);
    const peak = inputBytes + BigInt(processing.maxExpandedBytes);
    return {
      ...group,
      key: importGroupKey(group.kind, objects),
      inputBytes: inputBytes.toString(),
      requiredSpoolBytes: peak.toString(),
      issue:
        group.issue ?? (peak > BigInt(residentMaxBytes) ? 'GROUP_EXCEEDS_RESIDENT_BUDGET' : null),
    };
  });
}

export function buildGroupSourceManifest(
  source: ImportSourceManifest,
  key: string,
  options: ArchiveProcessingOptions,
  residentMaxBytes: string,
): GroupSourceManifest {
  const base = canonicalSourceManifest(source);
  const groups = planImportGroups(base, options, residentMaxBytes);
  const selected = groups.find((group) => group.key === key);
  archiveAssert(selected !== undefined && selected.issue === null, 'GROUP_NOT_EXECUTABLE');
  return materializer(base, options)(selected);
}

/** Build the directory index once, rather than rewalking every file for every child. */
export function materializeImportGroupSources(
  source: ImportSourceManifest,
  options: ArchiveProcessingOptions,
  residentMaxBytes: string,
): Map<string, GroupSourceManifest> {
  const base = canonicalSourceManifest(source),
    groups = planImportGroups(base, options, residentMaxBytes),
    build = materializer(base, options);
  return new Map(
    groups
      .filter((x) => x.issue !== 'ARCHIVE_VOLUME_SET_INVALID')
      .map((group) => [group.key, build(group)]),
  );
}

function materializer(base: ImportSourceManifest, options: ArchiveProcessingOptions) {
  const byPath = new Map(base.objects.map((x) => [x.relativePath, x])),
    byDirectory = new Map(base.directories.map((x) => [x.path, x]));
  const parentManifestDigest = sourceManifestDigest(base),
    processing = ArchiveProcessingOptionsSchema.parse(options);
  return (group: PlannedImportGroup): GroupSourceManifest => {
    const objects = group.members.map((name) => byPath.get(name)!);
    const ancestors = new Set<string>([base.rootPath]);
    for (const object of objects) {
      let cursor = object.path.slice(0, object.path.lastIndexOf('/')) || '/';
      while (cursor !== base.rootPath && cursor !== '/') {
        ancestors.add(cursor);
        cursor = cursor.slice(0, cursor.lastIndexOf('/')) || '/';
      }
    }
    const directories = [...ancestors].flatMap((name) => {
      const dir = byDirectory.get(name);
      return dir === undefined ? [] : [dir];
    });
    return canonicalSourceManifest({
      version: 4,
      sourceKind: 'BAIDU_APP_DIR',
      sourceScope: 'GROUP',
      rootPath: base.rootPath,
      sourceIdentity: base.sourceIdentity,
      directories,
      objects,
      archive: processing,
      group: { key: group.key, parentManifestDigest },
    }) as GroupSourceManifest;
  };
}
