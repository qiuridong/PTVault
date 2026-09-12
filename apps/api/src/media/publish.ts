import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { MountRefresh } from '../storage/cleanup.js';
import type { RcloneRcClient } from './probe.js';
import type { FarmPlanEntry } from './symlink-farm.js';

/**
 * Invalidates one mount's cached directory listing.
 *
 * The mounts are started with `--dir-cache-time 72h --poll-interval 0`, and that
 * was always paired with a promise: the comment on those flags in `mount.ts` says
 * the listings can be cached aggressively *because* "the API pokes the RC on
 * catalog changes". Nothing ever poked. A blob uploaded under a hash prefix the
 * mount has never listed therefore stays invisible for up to three days, and the
 * first production cleanup published a farm link whose target answered ENOENT
 * while the deletion reported itself complete.
 */
export type MountDirectoryCache = {
  accountId: string;
  invalidate(cloudLogicalPaths?: readonly string[]): Promise<void>;
};

// A production 4 TB mount measured 7.587 seconds for this recursive walk. The
// generic RC client's four-second default is intentionally a health-probe bound,
// not a deadline for enumerating a whole cloud-backed tree.
export const MOUNT_DIRECTORY_REFRESH_TIMEOUT_MS = 30_000;

export function createMountDirectoryCache(input: {
  accountId: string;
  rc: RcloneRcClient;
}): MountDirectoryCache {
  return {
    accountId: input.accountId,
    async invalidate(cloudLogicalPaths: readonly string[] = []): Promise<void> {
      await input.rc.call(
        'vfs/refresh',
        {
          // `recursive` as the string "true", not the boolean: this is what the
          // deployed rclone accepts, measured against it rather than read off the
          // docs. A boolean is rejected, and the rejection surfaces as a refresh
          // that reports success while nothing was refreshed.
          recursive: 'true',
          // No `dir`. Refreshing a *named* directory has to resolve that name
          // through the cached root first, so `dir=26` cannot discover a top-level
          // prefix the stale root does not know exists — which is the only case
          // that actually matters here, since a brand-new blob prefix is exactly
          // what a first-of-its-kind digest creates. Omitting it refreshes the root
          // itself, and `recursive` then carries the listing down to the blob.
        },
        { timeoutMs: MOUNT_DIRECTORY_REFRESH_TIMEOUT_MS },
      );
      // The root refresh above makes a brand-new top-level prefix discoverable.
      // Once it is visible, refresh the exact committed parents as well so the
      // publication probe is not relying on an unrelated recursive listing to
      // reach the objects it is about to expose.
      const directories = [
        ...new Set(
          cloudLogicalPaths
            .map((value) => value.replaceAll('\\', '/').split('/').slice(0, -1).join('/'))
            .filter((value) => value !== ''),
        ),
      ].sort();
      for (const directory of directories) {
        await input.rc.call(
          'vfs/refresh',
          { recursive: 'true', dir: directory },
          { timeoutMs: MOUNT_DIRECTORY_REFRESH_TIMEOUT_MS },
        );
      }
    },
  };
}

export type FarmPublisherOptions = {
  /** One per supervised mount. Empty is a valid state on an install with no accounts. */
  directoryCaches: readonly MountDirectoryCache[];
  /** Probes mount health, then makes the farm match the catalog. */
  reconcile: () => Promise<unknown>;
  buildFarmPlan: () => FarmPlanEntry[];
  /** Farm-relative path a title is published at, or null when it has no catalog row. */
  logicalPathFor: (torrent: { instanceId: string; torrentHash: string }) => string | null;
  farmRoot: string;
  /**
   * Reads the published link the way Jellyfin will.
   *
   * Injected so a test can exercise the unreadable case without a FUSE mount; the
   * default is the real read, and it follows the symlink deliberately.
   */
  assertReadable?: (absolutePath: string) => Promise<void>;
};

/**
 * Publishes the cloud view of a title whose local copy has just been deleted, and
 * refuses to report success until what it published can actually be read.
 *
 * The order is load-bearing. Caches are invalidated *before* the farm is
 * reconciled, so the link is created against a mount that can already see the
 * blob; and the link is read *after*, because a symlink is created successfully
 * whether or not its target exists. Skipping the last step is how a deletion
 * reports COMPLETED while Jellyfin gets ENOENT — the link is present, the bytes
 * are in the cloud, and the mount alone disagrees.
 *
 * Verification is keyed by torrent rather than by "the links this sync created".
 * The periodic reconciler runs on its own timer and may well have created the link
 * already, between cleanup marking the catalog cloud-only and cleanup reaching
 * this call. That sync did not refresh any cache, so treating "someone else
 * created it, so there is nothing to check" as success reproduces the original bug
 * through a race.
 */
export function createFarmPublisher(options: FarmPublisherOptions): MountRefresh {
  const assertReadable = options.assertReadable ?? assertReadableThroughLink;

  return {
    async refresh(torrent): Promise<void> {
      const linkRelativePath = options.logicalPathFor(torrent);
      const plan = options.buildFarmPlan();
      const planned =
        linkRelativePath === null
          ? []
          : plan.filter(
              (entry) =>
                entry.linkRelativePath === linkRelativePath ||
                entry.linkRelativePath.startsWith(`${linkRelativePath}/`),
            );

      for (const accountId of new Set(planned.map((entry) => entry.accountId))) {
        // Refresh only the mount the link will actually point into. Walking every
        // account's blob tree made an unrelated slow mount prevent a multi-account
        // install from completing cleanup, even though that mount held none of the
        // title's bytes.
        const cache = options.directoryCaches.find(
          (candidate) => candidate.accountId === accountId,
        );
        if (cache === undefined) throw new Error('MOUNT_DIRECTORY_CACHE_NOT_FOUND');
        await cache.invalidate();
      }

      await options.reconcile();

      // No catalog row means nothing was ever published for this title, so there is
      // no link to stand behind.
      if (linkRelativePath === null) return;

      // A catalog title without a complete verified plan is a pending follow-up,
      // not a successful publication. This never authorizes any source deletion.
      if (planned.length === 0) throw new Error('FARM_PUBLISH_PLAN_MISSING');

      for (const entry of planned) {
        await assertReadable(path.posix.join(options.farmRoot, entry.linkRelativePath));
      }
    },
  };
}

/**
 * Follows the link and requires a real file behind it.
 *
 * `stat` rather than `lstat`: the question is not whether the link exists — the
 * farm just created it — but whether the mount resolves it, which is the half that
 * was broken.
 */
async function assertReadableThroughLink(absolutePath: string): Promise<void> {
  let stats;
  try {
    stats = await stat(absolutePath);
  } catch (error: unknown) {
    throw new Error('FARM_PUBLISH_TARGET_UNREADABLE', { cause: error });
  }
  if (!stats.isFile()) throw new Error('FARM_PUBLISH_TARGET_NOT_A_FILE');
}
