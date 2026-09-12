import { lstat, mkdir, readdir, readlink, rm, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';

import type { MediaCatalogEntry } from '@ptvault/contracts';

import { assertAccountId, mountPointForAccount } from './mount-layout.js';

/**
 * Builds the tree Jellyfin actually reads.
 *
 * Cloud objects are named by content hash — `blobs/<sha256[:2]>/<sha256>` — so the
 * raw mount is a directory of 64-character hex names with no extensions and no
 * structure. Jellyfin cannot identify a title from that, cannot fetch metadata for
 * it, and would not even recognise it as video. This farm is the missing layer: one
 * symlink per title, named the way the file was named locally, pointing at the blob
 * under the mount.
 *
 * Only symlinks are created. Nothing here reads, copies, or rewrites media, so a
 * farm rebuilt from a wrong catalog costs a rebuild and never a byte.
 */
export type SymlinkFarmOptions = {
  /** Directory the farm is built in. Must be a dedicated path, never the hot root. */
  farmRoot: string;
  /**
   * Root holding one mount per storage account (`<root>/<accountId>`).
   *
   * A root rather than a single mount point: replicas are spread across accounts
   * and each is mounted separately, so a link's target depends on which account
   * currently backs that title.
   */
  mountRoot: string;
  /** Separate read-only mounts rooted at the netdisk destination root, not blobs/. */
  importMountRoot?: string;
  /**
   * Told what changed, after every sync that changed something.
   *
   * Exists so the one place that mutates the farm is also the one place that
   * announces it. Wiring the announcement into each caller instead left the
   * periodic reconciler silent, and that is the path most farm changes actually
   * take — a title published by a cleanup was announced, the same title removed
   * by a later reconcile was not.
   */
  onChanged?: (result: FarmSyncResult) => void | Promise<void>;
};

export type FarmPlanEntry = {
  /** Path inside the farm, e.g. `movie/Some Title.mkv`. */
  linkRelativePath: string;
  /** Account whose mount holds the blob — decides which mount the link points into. */
  accountId: string;
  /** Blob path relative to that account's mount, e.g. `1e/1e31c4…`. */
  blobRelativePath: string;
  namespace?: 'IMPORT';
};

export type FarmSyncResult = {
  created: string[];
  /** Links whose target changed, e.g. after a primary-replica promotion. */
  repointed: string[];
  /** Links removed because the catalog no longer lists them. */
  removed: string[];
  unchanged: string[];
};

export function farmTargetForEntry(options: SymlinkFarmOptions, entry: FarmPlanEntry): string {
  assertRelative(entry.linkRelativePath, 'FARM_LINK');
  assertRelative(entry.blobRelativePath, 'FARM_BLOB');
  assertAccountId(entry.accountId);
  if (entry.namespace !== undefined && entry.namespace !== 'IMPORT')
    throw new Error('FARM_NAMESPACE_INVALID');
  const root = entry.namespace === 'IMPORT' ? options.importMountRoot : options.mountRoot;
  if (root === undefined) throw new Error('FARM_IMPORT_MOUNT_NOT_CONFIGURED');
  return path.posix.join(mountPointForAccount(root, entry.accountId), entry.blobRelativePath);
}

export class SymlinkFarm {
  private syncTail: Promise<void> = Promise.resolve();
  constructor(private readonly options: SymlinkFarmOptions) {
    assertUsableRoot(options.farmRoot, options.mountRoot);
    if (options.importMountRoot !== undefined)
      assertUsableRoot(options.farmRoot, options.importMountRoot);
  }

  /**
   * Makes the farm match the plan exactly.
   *
   * Reconciles rather than rebuilds: deleting and recreating the tree would make
   * every title briefly vanish, and Jellyfin watching that directory would treat a
   * rebuild as a mass deletion and drop watch history.
   */
  sync(plan: readonly FarmPlanEntry[] | (() => readonly FarmPlanEntry[])): Promise<FarmSyncResult> {
    return this.serialize(() => this.apply(typeof plan === 'function' ? plan() : plan));
  }

  /** Import publication has no authority to remove or repoint a PT projection. */
  syncImports(plan: () => readonly FarmPlanEntry[]): Promise<FarmSyncResult> {
    return this.serialize(() => {
      if (this.options.importMountRoot === undefined)
        throw Error('FARM_IMPORT_MOUNT_NOT_CONFIGURED');
      return this.apply(plan(), true);
    });
  }

  private serialize(body: () => Promise<FarmSyncResult>): Promise<FarmSyncResult> {
    const operation = this.syncTail.then(body);
    this.syncTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async apply(
    plan: readonly FarmPlanEntry[],
    importsOnly = false,
  ): Promise<FarmSyncResult> {
    assertFarmPlanUnique(plan);
    const result: FarmSyncResult = { created: [], repointed: [], removed: [], unchanged: [] };
    const wanted = new Map<string, string>();
    for (const entry of plan) {
      if (importsOnly && entry.namespace !== 'IMPORT') continue;
      wanted.set(entry.linkRelativePath, farmTargetForEntry(this.options, entry));
    }

    await mkdir(this.options.farmRoot, { recursive: true });

    for (const [linkRelativePath, target] of wanted) {
      const linkPath = path.posix.join(this.options.farmRoot, linkRelativePath);
      await mkdir(path.posix.dirname(linkPath), { recursive: true });

      const existing = await readLinkTarget(linkPath);
      if (existing === target) {
        result.unchanged.push(linkRelativePath);
        continue;
      }
      if (existing !== null) {
        if (importsOnly && !this.isImportTarget(existing)) throw Error('FARM_SCOPE_CONFLICT');
        // Replaced rather than left alone: a stale target points at the previous
        // account's blob, which may no longer be the verified one.
        await unlink(linkPath);
        await symlink(target, linkPath);
        result.repointed.push(linkRelativePath);
        continue;
      }
      // A non-symlink at this path means something else owns it. Refusing is safer
      // than unlinking a real file that happens to be in the way.
      if (await pathExists(linkPath)) throw new Error('FARM_PATH_OCCUPIED');
      await symlink(target, linkPath);
      result.created.push(linkRelativePath);
    }

    for (const existing of await this.listLinks()) {
      if (wanted.has(existing)) continue;
      if (
        importsOnly &&
        !this.isImportTarget(await readLinkTarget(path.posix.join(this.options.farmRoot, existing)))
      )
        continue;
      await unlink(path.posix.join(this.options.farmRoot, existing));
      result.removed.push(existing);
    }

    await this.announce(result);
    return result;
  }

  private isImportTarget(target: string | null): boolean {
    if (target === null || this.options.importMountRoot === undefined) return false;
    const root = path.posix.normalize(this.options.importMountRoot.replaceAll('\\', '/'));
    return path.posix.normalize(target.replaceAll('\\', '/')).startsWith(root + '/');
  }

  /**
   * Reports the change downstream without letting it affect the farm.
   *
   * Swallowed deliberately, and this is the important half of the contract: the
   * farm is the source of truth and Jellyfin is a consumer of it. A Jellyfin
   * outage must not fail a cleanup's follow-up or stop the reconcile loop —
   * the links are correct either way, and the library catches up on its own next
   * scan.
   */
  private async announce(result: FarmSyncResult): Promise<void> {
    if (!this.options.onChanged) return;
    if (
      result.created.length === 0 &&
      result.repointed.length === 0 &&
      result.removed.length === 0
    ) {
      return;
    }
    try {
      await this.options.onChanged(result);
    } catch {
      // Intentionally ignored; see above.
    }
  }

  /** Every symlink currently in the farm, as farm-relative paths. */
  async listLinks(): Promise<string[]> {
    const links: string[] = [];
    const walk = async (relative: string): Promise<void> => {
      const absolute = path.posix.join(this.options.farmRoot, relative);
      let entries;
      try {
        entries = await readdir(absolute, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
        if (entry.isSymbolicLink()) links.push(childRelative);
        else if (entry.isDirectory()) await walk(childRelative);
      }
    };
    await walk('');
    return links.sort();
  }

  /** Removes the whole farm. Only ever symlinks and directories, never media. */
  async destroy(): Promise<void> {
    await rm(this.options.farmRoot, { recursive: true, force: true });
  }
}

/**
 * Turns catalog entries into a farm plan.
 *
 * Local-first: a title with a local copy is left out entirely. Jellyfin already
 * reads those directly from the hot root, and adding a cloud symlink beside them
 * would give one title two library entries.
 */
export function planFarm(
  entries: readonly MediaCatalogEntry[],
  blobPathFor: (entry: MediaCatalogEntry) => FarmBlobLocation | null,
): FarmPlanEntry[] {
  const plan: FarmPlanEntry[] = [];
  for (const entry of entries) {
    if (entry.availability === 'LOCAL' || entry.availability === 'BOTH') continue;
    const location = blobPathFor(entry);
    // No verified blob means nothing safe to point at; omitting it leaves the title
    // absent from the library rather than present and broken.
    if (location === null) continue;
    if (location.files) {
      assertRelative(entry.logicalPath, 'FARM_LINK');
      for (const file of location.files) {
        assertRelative(file.relativePath, 'FARM_MANIFEST');
        plan.push({
          linkRelativePath: `${entry.logicalPath}/${file.relativePath}`,
          accountId: file.accountId,
          blobRelativePath: file.blobRelativePath,
        });
      }
      continue;
    }
    plan.push({
      linkRelativePath: entry.logicalPath,
      accountId: location.accountId,
      blobRelativePath: location.blobRelativePath,
    });
  }
  assertFarmPlanUnique(plan);
  return plan;
}

/** Reject duplicates and file/directory prefix collisions before any filesystem writes. */
export function assertFarmPlanUnique(plan: readonly FarmPlanEntry[]): void {
  const paths = new Set<string>();
  for (const entry of plan) {
    assertRelative(entry.linkRelativePath, 'FARM_LINK');
    if (paths.has(entry.linkRelativePath)) throw new Error('FARM_PATH_CONFLICT');
    paths.add(entry.linkRelativePath);
  }
  for (const candidate of paths) {
    const parts = candidate.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (paths.has(parts.slice(0, i).join('/'))) throw new Error('FARM_PATH_CONFLICT');
    }
  }
}

/**
 * Which account holds a title's blob, and where under that account's mount.
 *
 * The account travels with the path because a blob's name is content-addressed and
 * therefore identical on every account that holds a copy — the path alone cannot
 * say which mount to read it through.
 *
 * A mount being down is deliberately *not* a reason to omit an entry. The link
 * stays, the read fails while the outage lasts, and availability returns on its own;
 * removing the link would delete the title from Jellyfin's library and take watch
 * history with it, turning a temporary outage into data loss.
 */
export type FarmBlobLocation = {
  accountId: string;
  blobRelativePath: string;
  /** DIRECTORY roots must use every member, never the representative blob above. */
  files?: Array<{ relativePath: string; accountId: string; blobRelativePath: string }>;
};

async function readLinkTarget(linkPath: string): Promise<string | null> {
  try {
    const stats = await lstat(linkPath);
    if (!stats.isSymbolicLink()) return null;
    return await readlink(linkPath);
  } catch {
    return null;
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch {
    return false;
  }
}

function assertRelative(candidate: string, prefix: string): void {
  if (candidate.length === 0) throw new Error(`${prefix}_EMPTY`);
  if (candidate.includes('\0')) throw new Error(`${prefix}_HAS_NUL`);
  if (path.posix.isAbsolute(candidate)) throw new Error(`${prefix}_NOT_RELATIVE`);
  const normalized = path.posix.normalize(candidate);
  if (normalized !== candidate) throw new Error(`${prefix}_NOT_NORMALIZED`);
  if (normalized === '..' || normalized.startsWith('../')) throw new Error(`${prefix}_ESCAPES`);
}

/**
 * The farm must be its own directory, outside both the mount and any media tree.
 *
 * Inside the mount it would be read-only; inside the hot root a stale link would
 * sit among real media, where a cleanup pass could mistake one for the other.
 */
function assertUsableRoot(farmRoot: string, mountRoot: string): void {
  if (!isAbsoluteEitherPlatform(farmRoot)) throw new Error('FARM_ROOT_NOT_ABSOLUTE');
  if (!isAbsoluteEitherPlatform(mountRoot)) throw new Error('FARM_MOUNT_NOT_ABSOLUTE');
  if (farmRoot === mountRoot || farmRoot.startsWith(`${mountRoot}/`)) {
    throw new Error('FARM_ROOT_INSIDE_MOUNT');
  }
}

/**
 * Accepts a POSIX root or a Windows drive-prefixed one.
 *
 * Production is Linux, and every path this module *builds* uses `path.posix` so a
 * separator can never leak into a link target. But the guard runs on a developer's
 * Windows box too, and rejecting `C:/…` there would make the check untestable
 * rather than strict.
 */
function isAbsoluteEitherPlatform(candidate: string): boolean {
  return path.posix.isAbsolute(candidate) || /^[A-Za-z]:[\\/]/.test(candidate);
}
