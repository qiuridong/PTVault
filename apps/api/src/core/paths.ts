import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export type PathSafetyErrorCode =
  'PATH_CONTAINS_NUL' | 'PATH_MISSING' | 'OUTSIDE_ALLOWED_ROOT' | 'SYMLINK_ESCAPE';

export class PathSafetyError extends Error {
  constructor(
    readonly code: PathSafetyErrorCode,
    readonly candidatePath: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PathSafetyError';
  }
}

export async function canonicalAllowedPath(
  candidate: string,
  allowedRoots: readonly string[],
): Promise<string> {
  assertNoNul(candidate);
  if (allowedRoots.length === 0) {
    throw new PathSafetyError(
      'OUTSIDE_ALLOWED_ROOT',
      candidate,
      'Path is outside allowed roots: no allowed roots are configured',
    );
  }

  const resolvedCandidate = path.resolve(candidate);
  const canonicalCandidate = await resolveExistingPath(resolvedCandidate);
  const canonicalRoots = await Promise.all(
    allowedRoots.map(async (root) => {
      assertNoNul(root);
      return resolveExistingPath(path.resolve(root));
    }),
  );

  if (canonicalRoots.some((root) => isPathWithinRoot(canonicalCandidate, root))) {
    return canonicalCandidate;
  }

  const traversesSymlink = await hasSymlinkComponent(resolvedCandidate);
  if (traversesSymlink) {
    throw new PathSafetyError(
      'SYMLINK_ESCAPE',
      candidate,
      'Symlink resolves outside allowed roots',
    );
  }
  throw new PathSafetyError('OUTSIDE_ALLOWED_ROOT', candidate, 'Path is outside allowed roots');
}

export function isPathWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

async function resolveExistingPath(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      throw new PathSafetyError('PATH_MISSING', candidate, 'Path does not exist', {
        cause: error,
      });
    }
    throw error;
  }
}

async function hasSymlinkComponent(candidate: string): Promise<boolean> {
  const parsed = path.parse(candidate);
  const segments = path.relative(parsed.root, candidate).split(path.sep).filter(Boolean);
  let current = parsed.root;

  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) return true;
    } catch (error: unknown) {
      if (isMissingPathError(error)) return false;
      throw error;
    }
  }
  return false;
}

function assertNoNul(candidate: string): void {
  if (candidate.includes('\0')) {
    throw new PathSafetyError('PATH_CONTAINS_NUL', candidate, 'Path contains NUL');
  }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}
