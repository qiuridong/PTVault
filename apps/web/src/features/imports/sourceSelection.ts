/** Frontend selection only. Selecting a directory never scans or plans its content. */
export type SourceDirectory = Readonly<{
  connectionId: string;
  fsid: string;
  path: string;
}>;

export type SourceFile = SourceDirectory &
  Readonly<{
    scope: 'FILE';
    size: string;
    mtime: string;
  }>;

export const MAX_SOURCE_DIRECTORIES = 20;
export const SOURCE_PLAN_CONCURRENCY = 2;

export type SourceSelectionResult = {
  items: SourceDirectory[];
  reason:
    | 'ADDED'
    | 'ALREADY_SELECTED'
    | 'COVERED_BY_PARENT'
    | 'REPLACED_DESCENDANTS'
    | 'LIMIT_REACHED'
    | 'IDENTITY_CHANGED';
  affectedPaths: string[];
  coveringPath?: string;
};

export function sourceDirectoryKey(value: Pick<SourceDirectory, 'connectionId' | 'fsid'>): string {
  return JSON.stringify([value.connectionId, value.fsid]);
}

function validate(value: SourceDirectory): void {
  if (
    value.connectionId.length === 0 ||
    !/^(?:0|[1-9][0-9]{0,39})$/.test(value.fsid) ||
    !value.path.startsWith('/') ||
    value.path === '/' ||
    value.path.includes('\\') ||
    Array.from(value.path).some((character) => character.charCodeAt(0) < 0x20) ||
    value.path.length > 4096 ||
    value.path
      .slice(1)
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('SOURCE_DIRECTORY_INVALID');
  }
}

function contains(parent: string, child: string): boolean {
  return child.startsWith(`${parent}/`);
}

export function addSourceDirectory(
  confirmed: readonly SourceDirectory[],
  candidate: SourceDirectory,
): SourceSelectionResult {
  validate(candidate);
  for (const value of confirmed) {
    validate(value);
    if (value.connectionId !== candidate.connectionId) throw new Error('SOURCE_ACCOUNT_MISMATCH');
  }
  const sameIdentity = confirmed.find((value) => value.fsid === candidate.fsid);
  const samePath = confirmed.find((value) => value.path === candidate.path);
  if (
    (sameIdentity !== undefined && sameIdentity.path !== candidate.path) ||
    (samePath !== undefined && samePath.fsid !== candidate.fsid)
  ) {
    return { items: [...confirmed], reason: 'IDENTITY_CHANGED', affectedPaths: [candidate.path] };
  }
  if (sameIdentity !== undefined) {
    return { items: [...confirmed], reason: 'ALREADY_SELECTED', affectedPaths: [] };
  }
  const ancestor = confirmed.find((value) => contains(value.path, candidate.path));
  if (ancestor !== undefined) {
    return {
      items: [...confirmed],
      reason: 'COVERED_BY_PARENT',
      affectedPaths: [candidate.path],
      coveringPath: ancestor.path,
    };
  }
  const descendants = confirmed.filter((value) => contains(candidate.path, value.path));
  const retained = confirmed.filter((value) => !contains(candidate.path, value.path));
  if (retained.length >= MAX_SOURCE_DIRECTORIES) {
    return { items: [...confirmed], reason: 'LIMIT_REACHED', affectedPaths: [candidate.path] };
  }
  return {
    items: [...retained, { ...candidate }],
    reason: descendants.length === 0 ? 'ADDED' : 'REPLACED_DESCENDANTS',
    affectedPaths: descendants.map((value) => value.path),
  };
}

export function removeSourceDirectory(
  items: readonly SourceDirectory[],
  target: Pick<SourceDirectory, 'connectionId' | 'fsid'>,
): SourceDirectory[] {
  const key = sourceDirectoryKey(target);
  return items.filter((value) => sourceDirectoryKey(value) !== key);
}
