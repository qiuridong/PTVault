import type { JobHandler, JobHandlers } from '../jobs/worker.js';
import type { AppConfig } from '../config/env.js';
import type { AppDatabase } from '../db/database.js';
import type { QbControlRegistry } from '../qb/types.js';
import type { QbRepository } from '../qb/repository.js';
import type { DisksResponse } from '@ptvault/contracts';

import type { MountRefresh } from '../storage/cleanup.js';
import type { CatalogRecorder } from '../storage/offload-handler.js';
import { createBlobResolver } from './blob-resolver.js';
import { CacheGovernor } from './cache.js';
import { MediaCatalog } from './catalog.js';
import { createCatalogRecorder } from './catalog-recorder.js';
import { calculateDiskPolicy, isSameFilesystem, readDiskUsage, type DiskPolicy } from './disk.js';
import { perMountCacheMaxBytes } from './mount-layout.js';
import { MountSupervisor, type SupervisedMount } from './mount-supervisor.js';
import { PrefetchHandler, type PrefetchReader } from './prefetch.js';
import { createFarmPublisher, type MountDirectoryCache } from './publish.js';
import { RehydrateHandler, type RehydrateHandlerOptions } from './rehydrate-handler.js';
import { RehydrateMachine } from './rehydrate-machine.js';
import { planFarm, SymlinkFarm, type FarmPlanEntry, type FarmSyncResult } from './symlink-farm.js';

export type MediaServices = {
  catalog: MediaCatalog;
  governor: CacheGovernor;
  supervisor: MountSupervisor;
  replaceMounts?: (mounts: readonly Omit<SupervisedMount, 'cacheMaxBytes'>[], directoryCaches: readonly MountDirectoryCache[]) => void;
  rehydrateMachine: RehydrateMachine;
  rehydrateHandler: RehydrateHandler;
  prefetchHandler: PrefetchHandler;
  farm: SymlinkFarm;
  /** Torrent catalog only; used when another independent catalog composes a plan. */
  buildBaseFarmPlan: () => FarmPlanEntry[];
  /**
   * Builds the farm plan from the current catalog.
   *
   * A function rather than a value: the plan depends on catalog rows and per-account
   * mount health, both of which change while the process runs.
   */
  buildFarmPlan: () => FarmPlanEntry[];
  /**
   * Makes a newly cloud-only title readable through the farm, and proves it.
   *
   * Handed to cleanup as its follow-up step. Separate from the periodic reconciler
   * because it invalidates the mounts' directory caches, which is a per-account
   * listing walk against OneDrive — correct once after a deletion, wasteful every
   * sixty seconds.
   */
  publisher: MountRefresh;
  catalogRecorder: CatalogRecorder;
  policy: DiskPolicy;
  readFreeBytes: () => Promise<number>;
  /**
   * Both pools' capacity plus the SQL-aggregated savings, for the dashboard.
   *
   * Assembled here because this is the only place that already knows which path
   * each pool lives on and which policy line applies to it.
   */
  readDisks: () => Promise<DisksResponse>;
};

export type CreateMediaServicesOptions = {
  db: AppDatabase;
  readOnly?: boolean;
  /** Non-null here, unlike on `AppConfig`: the caller only builds this when set. */
  config: Pick<AppConfig, 'rcloneBin'> & {
    mediaHotRoot: string;
    /** Parent of the per-account mount points, e.g. `/mnt/ptvault-cloud`. */
    mediaMountRoot: string;
    importMountRoot?: string;
    /** Where the symlink farm is built, e.g. `/mnt/ptvault-farm`. */
    mediaFarmRoot: string;
    /**
     * rclone's VFS cache directory, when one is configured.
     *
     * Needed to answer whether evicting cache could free space where a restore
     * lands — it can only do that when both sit on the same filesystem.
     */
    mediaCacheDir?: string | null;
  };
  registry: QbControlRegistry;
  torrentRepository: Pick<QbRepository, 'setCloudState'>;
  /** The `GROUP BY` behind the dashboard's savings figure. */
  readSavings: QbRepository['storageSavings'];
  /**
   * One mount per storage account, in a stable order.
   *
   * `cacheMaxBytes` is filled in here rather than by the caller: the ceiling is a
   * property of the policy, and splitting it is arithmetic the caller should not
   * have to repeat correctly.
   */
  mounts: readonly Omit<SupervisedMount, 'cacheMaxBytes'>[];
  /** Live connection/profile/runtime authority layered over mount health. */
  isAccountEligible?: (accountId: string) => boolean;
  /**
   * One per mount, in any order — the publisher invalidates all of them.
   *
   * Separate from `mounts` rather than a field on them: the supervisor's job is to
   * observe, and an object that can make rclone re-walk an account's blob tree does
   * not belong on the thing whose contract is that it only looks.
   */
  directoryCaches?: readonly MountDirectoryCache[];
  /**
   * Notified after any sync that changed the farm.
   *
   * Optional because the media graph is built whenever the media paths are
   * configured, while Jellyfin credentials are a separate setting — a deployment
   * without them still gets a correct farm, just an uninformed library.
   */
  onFarmChanged?: (result: FarmSyncResult) => void | Promise<void>;
  /** Independent catalog projections (for example verified netdisk imports). */
  additionalFarmPlan?: () => readonly FarmPlanEntry[];
  reader: PrefetchReader;
  rclone: RehydrateHandlerOptions['rclone'];
  loadPlan: RehydrateHandlerOptions['loadPlan'];
  /** Total capacity of the hot filesystem, so its reserve can be derived from it. */
  totalBytes: number;
  /**
   * Total capacity of the cache filesystem.
   *
   * Separate from  because the two are separate disks on the reference
   * machine, and the cache ceiling has to be bounded by the disk the cache is on.
   * Defaults to the hot total for a single-disk layout.
   */
  cacheTotalBytes?: number;
  now?: () => number;
};

/**
 * Assembles the media playback graph.
 *
 * Shares one `CacheGovernor` and one `MountSupervisor` across every caller for the
 * same reason the qB graph is shared: space reservations and health hysteresis are
 * per-object state, and two instances would each keep their own count. Two
 * governors would both hand out the same free bytes; two supervisors would each
 * need their own three failures before either noticed an outage.
 *
 * The supervisor watches one mount per storage account. Health is therefore a
 * per-account fact, and everything downstream asks about a specific account rather
 * than "the mount" — a title backed by a healthy account must keep playing while
 * another account is down.
 */
export function createMediaServices(options: CreateMediaServicesOptions): MediaServices {
  const now = options.now ?? (() => Date.now());
  const policy = calculateDiskPolicy({
    hotTotalBytes: options.totalBytes,
    cacheTotalBytes: options.cacheTotalBytes ?? options.totalBytes,
  });
  const hotRoot = options.config.mediaHotRoot;
  const readFreeBytes = async (): Promise<number> => (await readDiskUsage(hotRoot)).freeBytes;
  // Falls back to the hot root only when no cache directory is configured, which is
  // the single-disk shape. Where they differ, asking the wrong one is the bug.
  const cacheRoot = options.config.mediaCacheDir ?? hotRoot;
  const readCacheFreeBytes = async (): Promise<number> =>
    (await readDiskUsage(cacheRoot)).freeBytes;

  // Guarded rather than passed straight through: no accounts registered yet is a
  // real state on a fresh install, and splitting a budget zero ways throws.
  const mounts: SupervisedMount[] =
    options.mounts.length === 0
      ? []
      : options.mounts.map((mount) => ({
          ...mount,
          cacheMaxBytes: perMountCacheMaxBytes(policy.cacheMaxBytes, options.mounts.length),
        }));

  const catalog = new MediaCatalog({ db: options.db, hotRoot, now });
  const governor = new CacheGovernor({ db: options.db, policy, now });
  const supervisor = new MountSupervisor({
    db: options.db,
    ...(options.readOnly ? { readOnly: true } : {}),
    mounts,
    policy,
    ...(options.isAccountEligible ? { isAccountEligible: options.isAccountEligible } : {}),
    readCacheFreeBytes,
    now,
  });
  const isAccountEligible = options.isAccountEligible ?? (() => true);
  const isAccountReadable = (accountId: string): boolean =>
    isAccountEligible(accountId) && supervisor.isHealthy(accountId);
  const farm = new SymlinkFarm({
    farmRoot: options.config.mediaFarmRoot,
    mountRoot: options.config.mediaMountRoot,
    ...(options.config.importMountRoot === undefined
      ? {}
      : { importMountRoot: options.config.importMountRoot }),
    // Attached here rather than at each caller so publish, restore, and the
    // periodic reconcile all announce their changes by construction.
    ...(options.onFarmChanged ? { onChanged: options.onFarmChanged } : {}),
  });
  const resolveBlob = createBlobResolver({
    db: options.db,
    isAccountEligible,
    isAccountHealthy: isAccountReadable,
  });
  const buildBaseFarmPlan = (): FarmPlanEntry[] =>
    planFarm(catalog.list(isAccountReadable), resolveBlob);
  const buildFarmPlan = (): FarmPlanEntry[] => [
    ...buildBaseFarmPlan(),
    ...(options.additionalFarmPlan?.() ?? []),
  ];
  const directoryCaches=[...(options.directoryCaches ?? [])];
  const publisher = createFarmPublisher({
    directoryCaches,
    // The same two steps the periodic reconciler runs, in the same order and for
    // the same reason: the plan asks which accounts can serve, so syncing against a
    // stale verdict would point the link at a mount that has been down since the
    // last tick. Composed here rather than borrowed from the reconciler so a
    // deletion's follow-up does not depend on that loop having been started.
    reconcile: async () => {
      await supervisor.check();
      await farm.sync(buildFarmPlan);
    },
    buildFarmPlan,
    logicalPathFor: (torrent) => catalog.logicalPathOf(torrent),
    farmRoot: options.config.mediaFarmRoot,
  });
  const rehydrateMachine = new RehydrateMachine(options.db, now);
  const rehydrateHandler = new RehydrateHandler({
    machine: rehydrateMachine,
    governor,
    rclone: options.rclone,
    registry: options.registry,
    torrentRepository: options.torrentRepository,
    catalog,
    // Filled after the farm is constructed below. The closure is invoked only by
    // a worker after createMediaServices has returned, so `farm` is initialized.
    refreshFarm: () => farm.sync(buildFarmPlan).then(() => undefined),
    hotRoot,
    readFreeBytes,
    // Measured, not assumed, and re-measured per call so a remounted cache is not
    // answered from a verdict taken at boot.
    canEvictForHotRoot: async () => {
      const cacheDir = options.config.mediaCacheDir;
      if (!cacheDir) return false;
      return isSameFilesystem(hotRoot, cacheDir);
    },
    loadPlan: options.loadPlan,
    assertAccountEligible: (accountId) => {
      if (!isAccountEligible(accountId)) throw new Error('STORAGE_ACCOUNT_INELIGIBLE');
    },
    now,
  });
  const prefetchHandler = new PrefetchHandler({
    reader: options.reader,
    admission: {
      // Any healthy mount admits prefetch; which mount a given read needs is
      // decided per title by the link it follows.
      mountHealthy: () => supervisor.list().some((mount) => isAccountReadable(mount.accountId)),
      // Non-reserved headroom, so a prefetch cannot spend space a restore already
      // claimed. Read at call time rather than captured, since both change.
      availableCacheBytes: () => {
        const health = supervisor.list();
        // Summed across mounts: the cache budget and the disk are shared, so the
        // headroom question is about the whole disk, not one account's share.
        const cacheBytes = health.reduce((total, entry) => total + entry.cacheBytes, 0);
        const cacheHeadroom = policy.cacheMaxBytes - cacheBytes;
        // Free space is a property of the filesystem, identical in every row; the
        // minimum is the safe read when rows were written at different moments.
        // These rows describe the **cache** disk, which is what prefetch writes to.
        const diskFreeBytes = health.reduce(
          (lowest, entry) => Math.min(lowest, entry.diskFreeBytes),
          Number.POSITIVE_INFINITY,
        );
        if (!Number.isFinite(diskFreeBytes)) return 0;
        // Reservations are deliberately absent: they claim space on the hot disk for
        // restores, and subtracting them here would charge a prefetch on the cache
        // disk for bytes promised somewhere else entirely.
        const diskHeadroom = diskFreeBytes - policy.cacheReserveBytes;
        return Math.max(0, Math.min(cacheHeadroom, diskHeadroom));
      },
    },
  });

  const readDisks = async (): Promise<DisksResponse> => {
    // Read concurrently: two statfs calls on different disks have no reason to
    // wait for each other, and this runs on every dashboard refresh.
    const [hot, cache] = await Promise.all([readDiskUsage(hotRoot), readDiskUsage(cacheRoot)]);
    return {
      hot: {
        path: hotRoot,
        totalBytes: hot.totalBytes,
        freeBytes: hot.freeBytes,
        reserveBytes: policy.reserveBytes,
      },
      cache: {
        path: cacheRoot,
        totalBytes: cache.totalBytes,
        freeBytes: cache.freeBytes,
        reserveBytes: policy.cacheReserveBytes,
        cacheMaxBytes: policy.cacheMaxBytes,
      },
      savings: options.readSavings(),
    };
  };

  return {
    catalog,
    governor,
    supervisor,
    replaceMounts: (next, caches) => {
      supervisor.replaceMounts(next.map(mount=>({...mount,cacheMaxBytes:perMountCacheMaxBytes(policy.cacheMaxBytes,next.length)})));
      directoryCaches.splice(0,directoryCaches.length,...caches);
    },
    rehydrateMachine,
    rehydrateHandler,
    prefetchHandler,
    farm,
    buildBaseFarmPlan,
    buildFarmPlan,
    publisher,
    catalogRecorder: createCatalogRecorder({ catalog, hotRoot }),
    policy,
    readFreeBytes,
    readDisks,
  };
}

/**
 * Adds the media handlers to the worker table.
 *
 * SHADOW yields nothing, matching the offload handlers: a restore writes to the
 * hot disk and controls qB, so a SHADOW process must hold no object able to do it.
 * A `REHYDRATE` job that somehow reached a SHADOW worker lands in BLOCKED with
 * `HANDLER_NOT_REGISTERED` rather than executing.
 */
export function registerMediaHandlers(input: {
  mode: AppConfig['mode'];
  rehydrateHandler: Pick<RehydrateHandler, 'run'>;
  prefetchHandler: Pick<PrefetchHandler, 'run'>;
}): JobHandlers {
  if (input.mode !== 'ACTIVE') return {};

  const rehydrate: JobHandler = async (job, context) => {
    await input.rehydrateHandler.run(job.payload, context.signal);
  };
  const prefetch: JobHandler = async (job, context) => {
    await input.prefetchHandler.run(job.payload, context.signal);
  };
  return { REHYDRATE: rehydrate, PREFETCH: prefetch };
}
