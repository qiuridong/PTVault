import {
  addSourceDirectory,
  SOURCE_PLAN_CONCURRENCY,
  type SourceDirectory,
} from './sourceSelection.js';

export type DirectoryBatchResult<T> =
  | { source: SourceDirectory; status: 'SUCCEEDED'; value: T }
  | { source: SourceDirectory; status: 'FAILED'; error: unknown }
  | { source: SourceDirectory; status: 'CANCELLED' };

// Shared across component generations: closing one batch cannot allow its still
// outstanding requests plus a new batch to exceed the two-call browser budget.
let activeCalls = 0;
const waiting: Array<() => void> = [];
function drain(): void {
  while (activeCalls < SOURCE_PLAN_CONCURRENCY && waiting.length > 0) waiting.shift()?.();
}
function acquire(isCurrent: () => boolean): Promise<(() => void) | null> {
  return new Promise((resolve) => {
    waiting.push(() => {
      if (!isCurrent()) {
        resolve(null);
        return;
      }
      activeCalls += 1;
      resolve(() => {
        activeCalls -= 1;
        drain();
      });
    });
    drain();
  });
}

/** Single-directory form requests share the same slots as a superseded batch. */
export async function runDirectoryPlanRequest<T>(
  isCurrent: () => boolean,
  execute: () => Promise<T>,
): Promise<T | undefined> {
  const release = await acquire(isCurrent);
  if (release === null) return undefined;
  try {
    return isCurrent() ? await execute() : undefined;
  } finally {
    release();
  }
}

/** No operation is inferred: callers explicitly provide one single-root request. */
export async function runDirectoryBatch<T>(options: {
  directories: readonly SourceDirectory[];
  isCurrent: () => boolean;
  execute: (source: SourceDirectory) => Promise<T>;
  onStarted?: (source: SourceDirectory) => void;
  onSettled?: (result: DirectoryBatchResult<T>) => void;
}): Promise<Array<DirectoryBatchResult<T>>> {
  let normalized: SourceDirectory[] = [];
  for (const source of options.directories) {
    const next = addSourceDirectory(normalized, source);
    if (next.reason !== 'ADDED') throw new Error('BATCH_SELECTION_NOT_NORMALIZED');
    normalized = next.items;
  }
  const results: Array<DirectoryBatchResult<T>> = normalized.map((source) => ({
    source,
    status: 'CANCELLED',
  }));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (options.isCurrent() && cursor < normalized.length) {
      const index = cursor++;
      const source = normalized[index]!;
      const release = await acquire(options.isCurrent);
      if (release === null) return;
      try {
        if (!options.isCurrent()) return;
        options.onStarted?.(source);
        let result: DirectoryBatchResult<T>;
        try {
          result = { source, status: 'SUCCEEDED', value: await options.execute(source) };
        } catch (error) {
          result = { source, status: 'FAILED', error };
        }
        if (options.isCurrent()) {
          results[index] = result;
          options.onSettled?.(result);
        }
      } finally {
        release();
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SOURCE_PLAN_CONCURRENCY, normalized.length) }, worker),
  );
  return results;
}
