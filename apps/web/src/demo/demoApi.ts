import type {
  AuditEvent,
  DisksResponse,
  ImportCapabilities,
  ImportDestination,
  ImportDetail,
  ImportJobSummary,
  JellyfinInfo,
  MediaCatalogEntry,
  MountHealth,
  OffloadSnapshot,
  RecoveryCloudCopy,
  RecoveryExport,
  RecoveryStatus,
  RehydrateSnapshot,
  StorageAccount,
  SystemInfo,
  SystemMetrics,
  TorrentPreflight,
  TorrentSummary,
  TransferSettingsStatus,
} from '@ptvault/contracts';

import { clearDemoSession, currentDemoSession, demoSessionState } from './demoSession.js';

const GiB = 1024 ** 3;
const TiB = 1024 ** 4;
const bytes = (value: number): number => Math.round(value);

const ACCOUNT_A = '10000000-0000-4000-8000-00000000000a';
const ACCOUNT_B = '10000000-0000-4000-8000-00000000000b';
const ADMIN_ID = '10000000-0000-4000-8000-000000000099';

const HASH_LOCAL = '1'.repeat(40);
const HASH_CLOUD = '2'.repeat(40);
const HASH_COMMITTED = '3'.repeat(40);
const HASH_DOWNLOADING = '4'.repeat(40);
const HASH_BLOCKED = '5'.repeat(40);
const HASH_MIGRATING = '6'.repeat(40);

const JOB_RUNNING = '20000000-0000-4000-8000-000000000001';
const JOB_COMPLETED = '20000000-0000-4000-8000-000000000002';
const JOB_FAILED = '20000000-0000-4000-8000-000000000003';
const REHYDRATE_RUNNING = '30000000-0000-4000-8000-000000000001';
const REHYDRATE_FAILED = '30000000-0000-4000-8000-000000000002';

const IMPORT_DOWNLOADING = '40000000-0000-4000-8000-000000000001';
const IMPORT_UPLOADING = '40000000-0000-4000-8000-000000000002';
const IMPORT_RATE_LIMITED = '40000000-0000-4000-8000-000000000003';
const IMPORT_PUBLISHED = '40000000-0000-4000-8000-000000000004';
const IMPORT_FAILED = '40000000-0000-4000-8000-000000000005';
const IMPORT_PUBLISH_FAILED = '40000000-0000-4000-8000-000000000006';
const PUBLICATION_OK = '41000000-0000-4000-8000-000000000001';
const PUBLICATION_FAILED = '41000000-0000-4000-8000-000000000002';

const LIBRARY_MOVIES = '42000000-0000-4000-8000-00000000000a';
const LIBRARY_SHOWS = '42000000-0000-4000-8000-00000000000b';

type DemoQbInstance = {
  id: string;
  displayName: string;
  enabled: boolean;
  baseUrl: string;
  username: string;
  hasCredential: boolean;
  pathMaps: string[];
  lastSyncAt: number | null;
  lastSyncError: string | null;
};

type DemoJobEvent = {
  id: string;
  jobId: string;
  eventType: string;
  detail: { from?: OffloadSnapshot['jobState']; to?: OffloadSnapshot['jobState'] };
  createdAt: number;
};

function accounts(now: number): StorageAccount[] {
  return [
    {
      id: ACCOUNT_A,
      revision: 3,
      label: '演示云盘 A',
      rawRemote: 'demo-raw-a:',
      cryptRemote: 'demo-crypt-a:',
      health: 'HEALTHY',
      totalBytes: 5 * TiB,
      freeBytes: bytes(3.72 * TiB),
      reserveBytes: 100 * GiB,
      circuitOpenUntil: null,
      lastCheckedAt: now - 42_000,
    },
    {
      id: ACCOUNT_B,
      revision: 5,
      label: '演示云盘 B',
      rawRemote: 'demo-raw-b:',
      cryptRemote: 'demo-crypt-b:',
      health: 'THROTTLED',
      totalBytes: 5 * TiB,
      freeBytes: bytes(2.94 * TiB),
      reserveBytes: 100 * GiB,
      circuitOpenUntil: now + 12 * 60_000,
      lastCheckedAt: now - 67_000,
    },
  ];
}

function instances(now: number): DemoQbInstance[] {
  return [
    {
      id: 'main',
      displayName: '演示 qB · 主库',
      enabled: true,
      baseUrl: 'http://demo-qb-main.invalid:8080',
      username: 'demo-main',
      hasCredential: true,
      pathMaps: ['/downloads=/demo/library/main'],
      lastSyncAt: now - 75_000,
      lastSyncError: null,
    },
    {
      id: 'bt',
      displayName: '演示 qB · 副库',
      enabled: true,
      baseUrl: 'http://demo-qb-bt.invalid:8080',
      username: 'demo-bt',
      hasCredential: true,
      pathMaps: ['/media=/demo/library/bt'],
      lastSyncAt: now - 118_000,
      lastSyncError: null,
    },
  ];
}

function torrents(now: number): TorrentSummary[] {
  return [
    {
      instanceId: 'main',
      hash: HASH_LOCAL,
      name: '演示纪录片：云端巡航',
      progress: 1,
      state: 'SEEDING',
      totalSize: 48 * GiB,
      amountLeft: 0,
      contentPath: '/demo/library/main/cloud-voyage',
      savePath: '/demo/library/main',
      ratio: 4.82,
      seedingSeconds: 31 * 24 * 3600,
      completedAt: now - 31 * 24 * 3600_000,
      cloudState: 'LOCAL',
    },
    {
      instanceId: 'bt',
      hash: HASH_CLOUD,
      name: '演示剧集：星河档案 S01',
      progress: 1,
      state: 'PAUSED',
      totalSize: 128 * GiB,
      amountLeft: 0,
      contentPath: '/demo/library/bt/star-archive-s01',
      savePath: '/demo/library/bt',
      ratio: 3.14,
      seedingSeconds: 62 * 24 * 3600,
      completedAt: now - 68 * 24 * 3600_000,
      cloudState: 'CLOUD',
    },
    {
      instanceId: 'main',
      hash: HASH_COMMITTED,
      name: '演示电影：恢复测试片',
      progress: 1,
      state: 'PAUSED',
      totalSize: 24 * GiB,
      amountLeft: 0,
      contentPath: '/demo/library/main/restore-check',
      savePath: '/demo/library/main',
      ratio: 2.06,
      seedingSeconds: 15 * 24 * 3600,
      completedAt: now - 18 * 24 * 3600_000,
      cloudState: 'CLOUD_COMMITTED',
    },
    {
      instanceId: 'bt',
      hash: HASH_DOWNLOADING,
      name: '演示下载：公开样例镜像',
      progress: 0.68,
      state: 'DOWNLOADING',
      totalSize: 12 * GiB,
      amountLeft: Math.round(3.84 * GiB),
      contentPath: '/demo/library/bt/sample-image',
      savePath: '/demo/library/bt',
      ratio: 0.12,
      seedingSeconds: 0,
      completedAt: null,
      cloudState: 'LOCAL',
    },
    {
      instanceId: 'main',
      hash: HASH_BLOCKED,
      name: '演示异常：共享文件待确认',
      progress: 1,
      state: 'ERROR',
      totalSize: 9 * GiB,
      amountLeft: 0,
      contentPath: '/demo/library/main/shared-sample',
      savePath: '/demo/library/main',
      ratio: 1.03,
      seedingSeconds: 7 * 24 * 3600,
      completedAt: now - 8 * 24 * 3600_000,
      cloudState: 'BLOCKED',
    },
    {
      instanceId: 'bt',
      hash: HASH_MIGRATING,
      name: '演示演唱会：现场样片',
      progress: 1,
      state: 'PAUSED',
      totalSize: 76 * GiB,
      amountLeft: 0,
      contentPath: '/demo/library/bt/live-sample',
      savePath: '/demo/library/bt',
      ratio: 5.77,
      seedingSeconds: 90 * 24 * 3600,
      completedAt: now - 93 * 24 * 3600_000,
      cloudState: 'MIGRATING',
    },
  ];
}

function preflightFor(instanceId: string, hash: string, now: number): TorrentPreflight | null {
  const torrent = torrents(now).find(
    (item) => item.instanceId === instanceId && item.hash === hash,
  );
  if (!torrent) return null;

  const issues: TorrentPreflight['issues'] = [];
  if (torrent.progress < 1) {
    issues.push({
      code: 'NOT_COMPLETE',
      path: torrent.contentPath,
      blocking: true,
      message: '演示数据：下载尚未完成。',
    });
  }
  if (torrent.state === 'DOWNLOADING') {
    issues.push({
      code: 'ACTIVE_WRITE',
      path: torrent.contentPath,
      blocking: true,
      message: '演示数据：文件仍在写入。',
    });
  }
  if (torrent.hash === HASH_BLOCKED) {
    issues.push({
      code: 'SHARED_TORRENT_FILE',
      path: torrent.contentPath,
      blocking: true,
      message: '演示数据：另一个种子共享了这个文件。',
    });
  }

  return {
    instanceId: torrent.instanceId,
    hash: torrent.hash,
    logicalBytes: torrent.totalSize,
    allocatedBytes: torrent.totalSize,
    reclaimableBytes: issues.length === 0 ? torrent.totalSize : 0,
    eligible: issues.length === 0,
    issues,
  };
}

function offloads(now: number): OffloadSnapshot[] {
  return [
    {
      jobId: JOB_RUNNING,
      instanceId: 'bt',
      torrentHash: HASH_MIGRATING,
      importance: 'IMPORTANT',
      currentStep: 'UPLOADING_STAGING',
      jobState: 'RUNNING',
      recoveryVersion: 3,
      cancelledAt: null,
      cleanupCompletedAt: null,
      createdAt: now - 48 * 60_000,
      updatedAt: now - 35_000,
      // Mid-upload, so the demo shows the case the telemetry exists for: a
      // multi-hour transfer that has to be readable as *moving* without opening
      // anything. `verifiedBytes` deliberately trails the staged figure — nothing
      // is verified until the read-back runs, and the gap is the point.
      stepBytesDone: dec(19.4 * GiB),
      stepBytesTotal: dec(41.2 * GiB),
      verifiedBytes: dec(0),
      totalBytes: dec(41.2 * GiB),
      filesDone: 3,
      fileCount: 8,
      currentFileAlias: 'demo-file-04.mkv',
      uploadRateBps: dec(28 * 1024 ** 2),
      hashRateBps: dec(112 * 1024 ** 2),
      etaSeconds: 22 * 60 + 40,
      ratesSampledAt: now - 4_000,
    },
    {
      jobId: JOB_COMPLETED,
      instanceId: 'bt',
      torrentHash: HASH_CLOUD,
      importance: 'STANDARD',
      currentStep: 'COMPLETED',
      jobState: 'COMPLETED',
      recoveryVersion: 3,
      cancelledAt: null,
      cleanupCompletedAt: now - 2 * 24 * 3600_000,
      createdAt: now - 3 * 24 * 3600_000,
      updatedAt: now - 2 * 24 * 3600_000,
      // Verified equals total, and the rates are gone. A finished transfer has no
      // instantaneous rate, and carrying the last sample forward would have the
      // page reporting 28 MiB/s for something that stopped two days ago.
      verifiedBytes: dec(12.7 * GiB),
      totalBytes: dec(12.7 * GiB),
      filesDone: 4,
      fileCount: 4,
    },
    {
      jobId: JOB_FAILED,
      instanceId: 'main',
      torrentHash: HASH_BLOCKED,
      importance: 'STANDARD',
      currentStep: 'PREFLIGHT',
      jobState: 'FAILED_SAFE',
      recoveryVersion: null,
      cancelledAt: null,
      cleanupCompletedAt: null,
      createdAt: now - 5 * 3600_000,
      updatedAt: now - 4 * 3600_000,
    },
  ];
}

function jobEvents(jobId: string, now: number): DemoJobEvent[] {
  const known = offloads(now).find((job) => job.jobId === jobId);
  if (!known) return [];
  if (jobId === JOB_COMPLETED) {
    return [
      {
        id: 'demo-event-completed-1',
        jobId,
        eventType: 'JOB_CLAIMED',
        detail: { from: 'QUEUED', to: 'RUNNING' },
        createdAt: known.createdAt + 5_000,
      },
      {
        id: 'demo-event-completed-2',
        jobId,
        eventType: 'OFFLOAD_CLOUD_COMMITTED',
        detail: { from: 'RUNNING', to: 'RUNNING' },
        createdAt: known.createdAt + 6 * 3600_000,
      },
      {
        id: 'demo-event-completed-3',
        jobId,
        eventType: 'JOB_COMPLETED',
        detail: { from: 'RUNNING', to: 'COMPLETED' },
        createdAt: known.updatedAt,
      },
    ];
  }
  return [
    {
      id: `demo-event-${jobId}-1`,
      jobId,
      eventType: 'JOB_CREATED',
      detail: { to: 'QUEUED' },
      createdAt: known.createdAt,
    },
    {
      id: `demo-event-${jobId}-2`,
      jobId,
      eventType: jobId === JOB_RUNNING ? 'OFFLOAD_UPLOADING' : 'PREFLIGHT_REJECTED',
      detail:
        jobId === JOB_RUNNING
          ? { from: 'QUEUED', to: 'RUNNING' }
          : { from: 'RUNNING', to: 'FAILED_SAFE' },
      createdAt: known.updatedAt,
    },
  ];
}

function recoveryStatus(now: number): RecoveryStatus {
  return {
    version: 3,
    publicRecipientConfigured: true,
    computerDownloadConfirmedAt: now - 12 * 24 * 3600_000,
    escrowVerifiedAt: now - 11 * 24 * 3600_000,
    cloudCopyAccountIds: [ACCOUNT_A, ACCOUNT_B],
    deletionUnlocked: true,
  };
}

function recoveryExports(now: number): RecoveryExport[] {
  const recipient = 'age1demonstrationrecipient0000000000000000000000';
  return [
    {
      version: 3,
      recipientGeneration: 2,
      publicRecipient: recipient,
      bundleSha256: 'a'.repeat(64),
      escrowSha256: 'b'.repeat(64),
      computerConfirmedAt: now - 12 * 24 * 3600_000,
      computerConfirmedSha256: 'a'.repeat(64),
      passphraseVerifiedAt: now - 11 * 24 * 3600_000,
      passphraseVerifiedSha256: 'b'.repeat(64),
      createdAt: now - 13 * 24 * 3600_000,
      completedAt: now - 11 * 24 * 3600_000,
    },
    {
      version: 2,
      recipientGeneration: 1,
      publicRecipient: recipient,
      bundleSha256: 'c'.repeat(64),
      escrowSha256: 'd'.repeat(64),
      computerConfirmedAt: now - 42 * 24 * 3600_000,
      computerConfirmedSha256: 'c'.repeat(64),
      passphraseVerifiedAt: now - 41 * 24 * 3600_000,
      passphraseVerifiedSha256: 'd'.repeat(64),
      createdAt: now - 43 * 24 * 3600_000,
      completedAt: now - 41 * 24 * 3600_000,
    },
  ];
}

function recoveryCloudCopies(version: number, now: number): RecoveryCloudCopy[] {
  const current = recoveryExports(now).find((item) => item.version === version);
  if (!current?.bundleSha256 || !current.escrowSha256) return [];
  return [ACCOUNT_A, ACCOUNT_B].map((accountId, index) => ({
    version,
    accountId,
    bundleSha256: current.bundleSha256!,
    escrowSha256: current.escrowSha256!,
    bundleRemotePath: `demo-recovery:v${version}/account-${index + 1}/bundle.age`,
    escrowRemotePath: `demo-recovery:v${version}/account-${index + 1}/escrow.age`,
    verificationStatus: 'VERIFIED' as const,
    verifiedAt: current.completedAt,
    createdAt: current.createdAt,
  }));
}

function mediaCatalog(): MediaCatalogEntry[] {
  return [
    {
      instanceId: 'bt',
      torrentHash: HASH_CLOUD,
      name: '演示剧集：星河档案 S01',
      logicalPath: '/demo/media/series/star-archive-s01',
      activeAccountId: ACCOUNT_A,
      availability: 'CLOUD',
      totalBytes: 128 * GiB,
      cachedBytes: 18 * GiB,
      pinned: true,
      catalogVersion: 8,
    },
    {
      instanceId: 'main',
      torrentHash: HASH_LOCAL,
      name: '演示纪录片：云端巡航',
      logicalPath: '/demo/media/documentary/cloud-voyage',
      activeAccountId: ACCOUNT_B,
      availability: 'BOTH',
      totalBytes: 48 * GiB,
      cachedBytes: 6 * GiB,
      pinned: false,
      catalogVersion: 5,
    },
    {
      instanceId: 'main',
      torrentHash: HASH_COMMITTED,
      name: '演示电影：恢复测试片',
      logicalPath: '/demo/media/movie/restore-check.mkv',
      activeAccountId: ACCOUNT_A,
      availability: 'LOCAL',
      totalBytes: 24 * GiB,
      cachedBytes: null,
      pinned: false,
      catalogVersion: 3,
    },
    {
      instanceId: 'main',
      torrentHash: HASH_BLOCKED,
      name: '演示媒体：挂载异常样片',
      logicalPath: '/demo/media/sample/unavailable.mkv',
      activeAccountId: ACCOUNT_B,
      availability: 'UNAVAILABLE',
      totalBytes: 9 * GiB,
      cachedBytes: null,
      pinned: false,
      catalogVersion: 2,
    },
  ];
}

function mounts(now: number): MountHealth[] {
  return [
    {
      accountId: ACCOUNT_A,
      mountPoint: `/demo/mounts/${ACCOUNT_A}`,
      mounted: true,
      rcReachable: true,
      cacheBytes: 24 * GiB,
      cacheMaxBytes: 128 * GiB,
      diskFreeBytes: 720 * GiB,
      diskReserveBytes: 600 * GiB,
      pressure: 'NORMAL',
      lastError: null,
      checkedAt: now - 30_000,
    },
    {
      accountId: ACCOUNT_B,
      mountPoint: `/demo/mounts/${ACCOUNT_B}`,
      mounted: true,
      rcReachable: true,
      cacheBytes: 61 * GiB,
      cacheMaxBytes: 128 * GiB,
      diskFreeBytes: 665 * GiB,
      diskReserveBytes: 600 * GiB,
      pressure: 'EVICTING',
      lastError: null,
      checkedAt: now - 45_000,
    },
  ];
}

function disks(): DisksResponse {
  return {
    hot: {
      path: '/demo/disks/hot',
      totalBytes: 4 * TiB,
      freeBytes: bytes(1.86 * TiB),
      reserveBytes: 600 * GiB,
    },
    cache: {
      path: '/demo/disks/cache',
      totalBytes: 1 * TiB,
      freeBytes: 665 * GiB,
      reserveBytes: 150 * GiB,
      cacheMaxBytes: 256 * GiB,
    },
    savings: {
      cloudCount: 37,
      cloudBytes: bytes(1.42 * TiB),
      awaitingCount: 3,
      awaitingBytes: 148 * GiB,
    },
  };
}

function rehydrates(now: number): RehydrateSnapshot[] {
  return [
    {
      jobId: REHYDRATE_RUNNING,
      instanceId: 'bt',
      torrentHash: HASH_CLOUD,
      currentStep: 'DOWNLOADING_TEMP',
      jobState: 'RUNNING',
      autoResume: true,
      reservedBytes: 128 * GiB,
      blockedMissingBytes: null,
      installedAt: null,
      cancelledAt: null,
      createdAt: now - 22 * 60_000,
      updatedAt: now - 28_000,
    },
    {
      jobId: REHYDRATE_FAILED,
      instanceId: 'main',
      torrentHash: HASH_BLOCKED,
      currentStep: 'EVICTING_CACHE',
      jobState: 'FAILED_SAFE',
      autoResume: false,
      reservedBytes: 0,
      blockedMissingBytes: 20 * GiB,
      installedAt: null,
      cancelledAt: null,
      createdAt: now - 3 * 3600_000,
      updatedAt: now - 2 * 3600_000,
    },
  ];
}

function systemMetrics(now: number): SystemMetrics {
  const history = Array.from({ length: 12 }, (_, index) => ({
    at: now - (11 - index) * 10_000,
    cpuPercent: 18 + ((index * 7) % 29),
    rxBytesPerSecond: (4 + (index % 4)) * 1024 ** 2,
    txBytesPerSecond: (18 + ((index * 3) % 11)) * 1024 ** 2,
    readBytesPerSecond: (10 + (index % 5)) * 1024 ** 2,
    writeBytesPerSecond: (28 + ((index * 2) % 13)) * 1024 ** 2,
  }));
  return {
    source: 'PROC',
    unavailableReason: null,
    sampledAt: now,
    sampleIntervalMs: 10_000,
    uptimeSeconds: 18 * 24 * 3600 + 4_321,
    cpu: { cores: 8, usagePercent: 31.8, load1: 2.14, load5: 1.87, load15: 1.42 },
    memory: {
      totalBytes: 16 * GiB,
      availableBytes: bytes(10.4 * GiB),
      swapTotalBytes: 4 * GiB,
      swapUsedBytes: 384 * 1024 ** 2,
    },
    interfaces: [
      {
        name: 'demo0',
        isDefaultRoute: true,
        rxBytesPerSecond: 6.2 * 1024 ** 2,
        txBytesPerSecond: 24.8 * 1024 ** 2,
        rxTotalBytes: bytes(2.1 * TiB),
        txTotalBytes: bytes(6.8 * TiB),
      },
    ],
    omittedInterfaces: 5,
    disks: [
      {
        name: 'demo-hot',
        readBytesPerSecond: 12.4 * 1024 ** 2,
        writeBytesPerSecond: 34.6 * 1024 ** 2,
        busyPercent: 38.2,
      },
      {
        name: 'demo-cache',
        readBytesPerSecond: 21.1 * 1024 ** 2,
        writeBytesPerSecond: 8.7 * 1024 ** 2,
        busyPercent: 24.6,
      },
    ],
    history,
    throughput: {
      uploadPhase: {
        jobs: 12,
        bytes: 684 * GiB,
        seconds: 21_600,
        bytesPerSecond: (684 * GiB) / 21_600,
      },
      endToEnd: {
        jobs: 12,
        bytes: 684 * GiB,
        seconds: 58_800,
        bytesPerSecond: (684 * GiB) / 58_800,
      },
      lastCommittedAt: now - 2 * 3600_000,
    },
  };
}

function jellyfinInfo(now: number): JellyfinInfo {
  return {
    configured: true,
    baseUrl: 'https://demo-jellyfin.invalid',
    tokenFile: '/demo/secrets/jellyfin-token',
    pathMaps: ['/demo/library=/media', '/demo/cloud=/cloud'],
    libraries: [
      {
        name: '演示影视库',
        collectionType: 'mixed',
        locations: [
          { path: '/media/demo', kind: 'LOCAL' },
          { path: '/cloud/demo', kind: 'CLOUD' },
        ],
        hasLocal: true,
        hasCloud: true,
        covered: true,
      },
      {
        name: '演示待接入库',
        collectionType: 'movies',
        locations: [{ path: '/media/demo-legacy', kind: 'LOCAL' }],
        hasLocal: true,
        hasCloud: false,
        covered: false,
      },
    ],
    checkedAt: now - 55_000,
    error: null,
  };
}

function systemInfo(now: number): SystemInfo {
  return {
    mode: 'SHADOW',
    version: 'demo-2026.08',
    buildCommit: 'demo-fixture-20260817',
    schemaVersion: 16,
    mounts: { total: 2, healthy: 2 },
    lastReconciledAt: now - 90_000,
  };
}

/**
 * Transfer scheduling as a SHADOW box really reports it.
 *
 * The demo session is SHADOW, and on a SHADOW deployment the service answers
 * `MODE_NOT_ACTIVE` for both tracks — so `provisioned` is false and `effective
 * .creationEnabled` is false no matter what the stored row says. That is the
 * combination worth putting in a fixture: it exercises the one branch that must
 * never be drawn as a working switch, and `offload.configured.creationEnabled`
 * is left `true` so the 「配置希望启用，但运行时未就绪」 disagreement is visible
 * rather than hypothetical.
 *
 * Activity is all zeroes here because a SHADOW box genuinely runs no transfers —
 * and the section does not render these readings at all when `provisioned` is
 * false, precisely so a zero is never mistaken for a measurement.
 */
function transferSettings(now: number): TransferSettingsStatus {
  const offload = {
    creationEnabled: true,
    maxInFlight: 8,
    preflightConcurrency: 8,
    pauseSnapshotConcurrency: 2,
    maxPausedPipelines: 3,
    hashConcurrency: 1,
    uploadConcurrency: 2,
    readbackConcurrency: 1,
  };
  const netdisk = { creationEnabled: true, maxInFlight: 2 };
  const idle = { active: 0, pending: 0, capacity: 1 };
  return {
    revision: 3,
    updatedAt: now - 12 * 60_000,
    offload: {
      provisioned: false,
      provisionReason: 'MODE_NOT_ACTIVE',
      configured: offload,
      effective: { ...offload, creationEnabled: false },
      activity: {
        activeHandlers: 0,
        resources: {
          preflight: { ...idle, capacity: offload.preflightConcurrency },
          pauseSnapshot: { ...idle, capacity: offload.pauseSnapshotConcurrency },
          hash: { ...idle, capacity: offload.hashConcurrency },
          upload: { ...idle, capacity: offload.uploadConcurrency },
          readback: { ...idle, capacity: offload.readbackConcurrency },
        },
      },
    },
    netdisk: {
      provisioned: false,
      provisionReason: 'MODE_NOT_ACTIVE',
      configured: netdisk,
      effective: { ...netdisk, creationEnabled: false },
      activity: { activeJobs: 0 },
    },
  };
}

function auditEvents(now: number): AuditEvent[] {
  const base = {
    actorAdminId: ADMIN_ID,
    sourceIp: '192.0.2.10',
  };
  return [
    {
      ...base,
      id: 'demo-audit-1',
      action: 'AUTH_LOGIN',
      subject: 'test',
      outcome: 'SUCCESS',
      correlationId: 'demo-correlation-1',
      detail: { mfaRequired: true, fixture: true },
      createdAt: now - 2 * 60_000,
    },
    {
      ...base,
      id: 'demo-audit-2',
      action: 'QB_SYNC',
      subject: 'all-demo-instances',
      outcome: 'SUCCESS',
      correlationId: 'demo-correlation-2',
      detail: { seen: 6, fixture: true },
      createdAt: now - 18 * 60_000,
    },
    {
      ...base,
      id: 'demo-audit-3',
      action: 'OFFLOAD_TRIGGER',
      subject: `bt:${HASH_MIGRATING}`,
      outcome: 'SUCCESS',
      correlationId: 'demo-correlation-3',
      detail: { importance: 'IMPORTANT', fixture: true },
      createdAt: now - 48 * 60_000,
    },
    {
      ...base,
      id: 'demo-audit-4',
      action: 'OFFLOAD_CLEANUP',
      subject: JOB_COMPLETED,
      outcome: 'SUCCESS',
      correlationId: 'demo-correlation-4',
      detail: { deletedFiles: 24, fixture: true },
      createdAt: now - 2 * 24 * 3600_000,
    },
    {
      ...base,
      id: 'demo-audit-5',
      action: 'RECOVERY_DRILL',
      subject: 'recovery-v3',
      outcome: 'SUCCESS',
      correlationId: 'demo-correlation-5',
      detail: { version: 3, fixture: true },
      createdAt: now - 11 * 24 * 3600_000,
    },
    {
      ...base,
      id: 'demo-audit-6',
      action: 'OFFLOAD_TRIGGER',
      subject: `main:${HASH_BLOCKED}`,
      outcome: 'DENIED',
      correlationId: 'demo-correlation-6',
      detail: { reason: 'PREFLIGHT_INELIGIBLE', fixture: true },
      createdAt: now - 4 * 3600_000,
    },
    {
      ...base,
      id: 'demo-audit-7',
      action: 'MOUNT_RECONCILE',
      subject: ACCOUNT_B,
      outcome: 'ERROR',
      correlationId: 'demo-correlation-7',
      detail: { reason: 'DEMO_TRANSIENT_THROTTLE', fixture: true },
      createdAt: now - 6 * 3600_000,
    },
  ];
}

/*
 * Netdisk import fixtures.
 *
 * Deliberately fictional throughout: `demo-*` aliases, byte counts as decimal
 * strings the way the real contract carries them, and nothing that would need
 * redacting. No real share link, no passcode, no token, no dlink, no real
 * OneDrive remote, no real business path or filename — a public demo carrying any
 * of those would be a leak with a login page in front of it.
 *
 * `sourceRequiresPasscode: true` on three jobs is the point of the demo: a
 * passcode-protected share is a first-class source, and the console reports that
 * fact without ever holding the passcode.
 */
function iso(at: number): string {
  return new Date(at).toISOString();
}

/** Byte figures travel as decimal strings; the fixture builds them the same way. */
function dec(value: number): string {
  return BigInt(Math.round(value)).toString();
}

function importLibraries(): ImportCapabilities['libraries'] {
  return [
    {
      libraryId: LIBRARY_MOVIES,
      libraryKey: 'netdisk-movies',
      displayName: '网盘电影',
      contentType: 'Movies',
      containerPath: '/cloud/imports/movies',
    },
    {
      libraryId: LIBRARY_SHOWS,
      libraryKey: 'netdisk-shows',
      displayName: '网盘剧集',
      contentType: 'Shows',
      containerPath: '/cloud/imports/shows',
    },
  ];
}

/**
 * The demo deployment reports SHADOW with creation off.
 *
 * That is the honest state of the real machine today, and it is what the page
 * should be judged against: the whole read surface renders, the create form
 * renders, and every write is refused with the reason named up front rather than
 * discovered after a click.
 */
function importCapabilities(): ImportCapabilities {
  return {
    mode: 'SHADOW',
    createEnabled: false,
    sources: [
      { kind: 'BAIDU_SHARE', enabled: true, disabledReason: null },
      { kind: 'BAIDU_APP_DIR', enabled: true, disabledReason: null },
      { kind: 'OTHER', enabled: false, disabledReason: 'NOT_CONFIGURED' },
    ],
    publishToJellyfinEnabled: true,
    publishDisabledReason: null,
    libraries: importLibraries(),
    supportedActions: [
      'PAUSE',
      'RESUME',
      'CANCEL',
      'RETRY',
      'PROVIDE_CREDENTIALS',
      'REPUBLISH',
      'UNPUBLISH',
    ],
  };
}

function importDestinations(): ImportDestination[] {
  return [
    {
      destinationId: 'demo-onedrive-raw',
      displayName: '演示 OneDrive · 原样备份',
      kind: 'ONEDRIVE_RAW',
      available: true,
      unavailableReason: null,
      availableBytes: dec(4.62 * TiB),
      allowedRoot: '/demo-imports/raw',
      supportsRestore: true,
      supportsJellyfin: true,
    },
    {
      destinationId: 'demo-standalone-crypt',
      displayName: '演示独立 crypt',
      kind: 'STANDALONE_CRYPT',
      available: true,
      unavailableReason: null,
      availableBytes: dec(4.31 * TiB),
      allowedRoot: '/demo-imports/crypt',
      supportsRestore: true,
      supportsJellyfin: false,
    },
    {
      // Unavailable on purpose, and with `availableBytes` and `supportsJellyfin`
      // absent rather than zero or false: between them these three rows exercise
      // both renderings the design standard demands — a stated reason for a
      // refusal, and 「该 API 版本未报告」 for a field this API does not report.
      destinationId: 'demo-ptvault-import',
      displayName: '演示 PT Vault IMPORT',
      kind: 'PT_VAULT_IMPORT',
      available: false,
      unavailableReason: 'FEATURE_DISABLED',
      allowedRoot: null,
      supportsRestore: false,
    },
  ];
}

const RAW_DESTINATION = {
  destinationId: 'demo-onedrive-raw',
  displayName: '演示 OneDrive · 原样备份',
  kind: 'ONEDRIVE_RAW',
} as const;

const CRYPT_DESTINATION = {
  destinationId: 'demo-standalone-crypt',
  displayName: '演示独立 crypt',
  kind: 'STANDALONE_CRYPT',
} as const;

function publishedPublication(now: number): ImportJobSummary['publication'] {
  return {
    publicationId: PUBLICATION_OK,
    revision: 1,
    objectCount: 1,
    state: 'PUBLISHED',
    mediaType: 'MOVIE',
    libraryId: LIBRARY_MOVIES,
    libraryDisplayName: '网盘电影',
    containerPath: '/cloud/imports/movies',
    logicalPath: '/cloud/imports/movies/demo-feature-01',
    mountAccountLabel: '演示云盘 A',
    readProbe: 'PASSED',
    jellyfinNotified: true,
    error: null,
    updatedAt: iso(now - 40 * 60_000),
  };
}

function failedPublication(now: number): ImportJobSummary['publication'] {
  return {
    publicationId: PUBLICATION_FAILED,
    revision: 2,
    objectCount: 12,
    state: 'FAILED_SAFE',
    mediaType: 'SERIES',
    libraryId: LIBRARY_SHOWS,
    libraryDisplayName: '网盘剧集',
    containerPath: '/cloud/imports/shows',
    logicalPath: '/cloud/imports/shows/demo-series-04',
    mountAccountLabel: '演示云盘 B',
    readProbe: 'PASSED',
    jellyfinNotified: false,
    // The case worth showing: the backup is verified and the projection is
    // correct; only the refresh call was refused. The import is not a failure.
    error: 'NOTIFICATION_REJECTED',
    updatedAt: iso(now - 9 * 60_000),
  };
}

function importJobs(now: number): ImportJobSummary[] {
  return [
    {
      jobId: IMPORT_DOWNLOADING,
      sourceKind: 'BAIDU_SHARE',
      sourceAlias: 'demo-share-01 · 带提取码',
      sourceRequiresPasscode: true,
      destination: RAW_DESTINATION,
      createdAt: iso(now - 26 * 60_000),
      progress: {
        jobId: IMPORT_DOWNLOADING,
        revision: 41,
        state: 'RUNNING',
        currentStep: 'DOWNLOADING',
        objectIndex: 3,
        objectCount: 12,
        currentObjectAlias: 'demo-object-003',
        objectBytesDone: dec(2.4 * GiB),
        objectBytesTotal: dec(6.1 * GiB),
        jobBytesVerified: dec(11.2 * GiB),
        jobBytesTotal: dec(74.6 * GiB),
        downloadRateBps: dec(23 * 1024 ** 2),
        // Upload and verify rates are absent, not zero: nothing has reached
        // OneDrive yet, so there is no reading to report for those two legs.
        etaSeconds: 47 * 60,
        ratesSampledAt: now - 4_000,
        lastCheckpointAt: iso(now - 12_000),
        publicationPolicy: 'ARCHIVE_ONLY',
        publicationState: 'NOT_REQUESTED',
      },
      publication: null,
      availableActions: ['PAUSE', 'CANCEL'],
    },
    {
      jobId: IMPORT_UPLOADING,
      sourceKind: 'BAIDU_SHARE',
      sourceAlias: 'demo-share-02 · 带提取码',
      sourceRequiresPasscode: true,
      destination: CRYPT_DESTINATION,
      createdAt: iso(now - 3 * 3600_000),
      progress: {
        jobId: IMPORT_UPLOADING,
        revision: 188,
        state: 'RUNNING',
        currentStep: 'UPLOADING_STAGING',
        objectIndex: 9,
        objectCount: 12,
        currentObjectAlias: 'demo-object-009',
        objectBytesDone: dec(4.8 * GiB),
        objectBytesTotal: dec(5.2 * GiB),
        jobBytesVerified: dec(48.3 * GiB),
        jobBytesTotal: dec(74.6 * GiB),
        uploadRateBps: dec(31 * 1024 ** 2),
        verifyRateBps: dec(96 * 1024 ** 2),
        etaSeconds: 18 * 60,
        ratesSampledAt: now - 3_000,
        lastCheckpointAt: iso(now - 8_000),
        publicationPolicy: 'ARCHIVE_ONLY',
        publicationState: 'NOT_REQUESTED',
      },
      publication: null,
      availableActions: ['PAUSE', 'CANCEL'],
    },
    {
      jobId: IMPORT_RATE_LIMITED,
      sourceKind: 'BAIDU_APP_DIR',
      sourceAlias: 'demo-appdir-01',
      sourceRequiresPasscode: false,
      destination: RAW_DESTINATION,
      createdAt: iso(now - 5 * 3600_000),
      progress: {
        jobId: IMPORT_RATE_LIMITED,
        revision: 96,
        state: 'RETRY_WAIT',
        currentStep: 'DOWNLOADING',
        currentCondition: 'RATE_LIMITED',
        objectIndex: 5,
        objectCount: 31,
        currentObjectAlias: 'demo-object-005',
        objectBytesDone: dec(0.9 * GiB),
        objectBytesTotal: dec(3.3 * GiB),
        jobBytesVerified: dec(14.7 * GiB),
        jobBytesTotal: dec(120.4 * GiB),
        // No rates at all while parked. A throttled job is not moving, and the
        // console must say 「未报告」 rather than draw 0 B/s beside a countdown
        // that implies work is happening.
        retryAt: iso(now + 4 * 60_000 + 12_000),
        lastCheckpointAt: iso(now - 6 * 60_000),
        publicationPolicy: 'ARCHIVE_ONLY',
        publicationState: 'NOT_REQUESTED',
      },
      publication: null,
      sourceRateLimit: {
        connectionId: '30000000-0000-4000-8000-000000000003',
        retryAt: iso(now + 4 * 60_000 + 12_000),
        code: 'BAIDU_RATE_LIMITED',
        updatedAt: iso(now - 20_000),
        affectedActiveJobs: 3,
      },
      availableActions: ['RESUME', 'CANCEL'],
    },
    {
      jobId: IMPORT_PUBLISHED,
      sourceKind: 'BAIDU_SHARE',
      sourceAlias: 'demo-share-03',
      sourceRequiresPasscode: false,
      destination: RAW_DESTINATION,
      createdAt: iso(now - 2 * 24 * 3600_000),
      progress: {
        jobId: IMPORT_PUBLISHED,
        revision: 512,
        state: 'COMPLETED',
        currentStep: 'COMPLETED',
        objectIndex: 4,
        objectCount: 4,
        objectBytesDone: dec(18.2 * GiB),
        objectBytesTotal: dec(18.2 * GiB),
        jobBytesVerified: dec(18.2 * GiB),
        jobBytesTotal: dec(18.2 * GiB),
        lastCheckpointAt: iso(now - 40 * 60_000),
        publicationPolicy: 'PUBLISH_TO_JELLYFIN',
        publicationState: 'PUBLISHED',
      },
      publication: publishedPublication(now),
      availableActions: ['UNPUBLISH'],
    },
    {
      jobId: IMPORT_PUBLISH_FAILED,
      sourceKind: 'BAIDU_SHARE',
      sourceAlias: 'demo-share-04',
      sourceRequiresPasscode: false,
      destination: RAW_DESTINATION,
      createdAt: iso(now - 26 * 3600_000),
      progress: {
        jobId: IMPORT_PUBLISH_FAILED,
        revision: 377,
        state: 'COMPLETED',
        currentStep: 'COMPLETED',
        objectIndex: 24,
        objectCount: 24,
        objectBytesDone: dec(61.5 * GiB),
        objectBytesTotal: dec(61.5 * GiB),
        jobBytesVerified: dec(61.5 * GiB),
        jobBytesTotal: dec(61.5 * GiB),
        lastCheckpointAt: iso(now - 9 * 60_000),
        // The decoupling, made visible: the import is COMPLETED while its
        // publication is FAILED_SAFE. A verified backup is never rolled back
        // because Jellyfin refused a notification.
        publicationPolicy: 'PUBLISH_TO_JELLYFIN',
        publicationState: 'FAILED_SAFE',
      },
      publication: failedPublication(now),
      availableActions: ['REPUBLISH'],
    },
    {
      jobId: IMPORT_FAILED,
      sourceKind: 'BAIDU_SHARE',
      sourceAlias: 'demo-share-05',
      sourceRequiresPasscode: true,
      destination: CRYPT_DESTINATION,
      createdAt: iso(now - 8 * 3600_000),
      progress: {
        jobId: IMPORT_FAILED,
        revision: 63,
        state: 'FAILED_SAFE',
        currentStep: 'STAGING_READBACK',
        currentCondition: 'SOURCE_CHANGED',
        objectIndex: 2,
        objectCount: 7,
        currentObjectAlias: 'demo-object-002',
        objectBytesDone: dec(1.1 * GiB),
        objectBytesTotal: dec(2.8 * GiB),
        jobBytesVerified: dec(3.4 * GiB),
        jobBytesTotal: dec(29.9 * GiB),
        lastCheckpointAt: iso(now - 7 * 3600_000),
        publicationPolicy: 'ARCHIVE_ONLY',
        publicationState: 'NOT_REQUESTED',
      },
      publication: null,
      availableActions: ['RETRY', 'CANCEL'],
    },
  ];
}

function importReceipts(job: ImportJobSummary, now: number): ImportDetail['receipts'] {
  const digestPreview = 'demo1a2b3c4d…9f80';
  if (job.progress.state !== 'COMPLETED') {
    // Receipts are reached in order, so a job in flight legitimately has one or
    // none. A job still downloading has produced nothing to attest to yet.
    const reachedStaging = job.progress.currentStep !== 'DOWNLOADING';
    return {
      staging: reachedStaging
        ? {
            at: iso(now - 20 * 60_000),
            objectCount: job.progress.objectIndex,
            bytes: job.progress.jobBytesVerified,
            digestPreview,
          }
        : null,
      committed: null,
      verify: null,
    };
  }
  return {
    staging: {
      at: iso(now - 90 * 60_000),
      objectCount: job.progress.objectCount,
      bytes: job.progress.jobBytesTotal,
      digestPreview,
    },
    committed: {
      at: iso(now - 70 * 60_000),
      objectCount: job.progress.objectCount,
      bytes: job.progress.jobBytesTotal,
      digestPreview,
    },
    verify: {
      at: iso(now - 55 * 60_000),
      objectCount: job.progress.objectCount,
      bytes: job.progress.jobBytesTotal,
      digestPreview,
    },
  };
}

/**
 * The timeline, already redacted — which in a fixture means never containing
 * anything that would need redacting.
 */
function importEvents(job: ImportJobSummary, now: number): ImportDetail['events'] {
  const created = Date.parse(job.createdAt);
  const events: ImportDetail['events'] = [
    { id: `${job.jobId}-e1`, at: iso(created), code: 'IMPORT_CREATED', step: null, detail: null },
    {
      id: `${job.jobId}-e2`,
      at: iso(created + 30_000),
      code: 'SHARE_TRANSFER_OK',
      step: 'SHARE_TRANSFER',
      detail: job.sourceRequiresPasscode ? '演示数据：提取码在进程内使用后已销毁。' : null,
    },
    {
      id: `${job.jobId}-e3`,
      at: iso(created + 90_000),
      code: 'MANIFEST_READY',
      step: 'DISCOVERING',
      detail: `演示数据：清单共 ${job.progress.objectCount} 个对象。`,
    },
  ];

  if (job.progress.state === 'RETRY_WAIT') {
    events.push({
      id: `${job.jobId}-e4`,
      at: iso(now - 6 * 60_000),
      code: 'SOURCE_RATE_LIMITED',
      step: 'DOWNLOADING',
      detail: '演示数据：来源侧限速，已安排重试。',
    });
  }
  if (job.progress.state === 'FAILED_SAFE') {
    events.push({
      id: `${job.jobId}-e4`,
      at: iso(now - 7 * 3600_000),
      code: 'SOURCE_CHANGED',
      step: 'STAGING_READBACK',
      detail: '演示数据：来源清单在传输过程中变化，已安全停止，未删除任何副本。',
    });
  }
  if (job.progress.state === 'COMPLETED') {
    events.push({
      id: `${job.jobId}-e4`,
      at: iso(now - 70 * 60_000),
      code: 'COMMITTED_VERIFIED',
      step: 'COMMITTED_READBACK',
      detail: '演示数据：committed 明文回读与本地一致。',
    });
    if (job.publication?.state === 'FAILED_SAFE') {
      events.push({
        id: `${job.jobId}-e5`,
        at: iso(now - 9 * 60_000),
        code: 'PUBLICATION_NOTIFICATION_REJECTED',
        step: 'MEDIA_PUBLISH',
        detail: '演示数据：备份已验证，仅媒体库刷新调用被拒。',
      });
    }
  }
  return events;
}

function importDetail(jobId: string, now: number): ImportDetail | null {
  const job = importJobs(now).find((candidate) => candidate.jobId === jobId);
  if (!job) return null;
  return {
    ...job,
    receipts: importReceipts(job, now),
    events: importEvents(job, now),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
  });
}

function forbidden(): Response {
  return json({ error: 'DEMO_READ_ONLY' }, 403);
}

function positiveInteger(value: string | null, fallback: number, max?: number): number {
  const parsed = value === null ? fallback : Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return max === undefined ? parsed : Math.min(parsed, max);
}

/**
 * Resolves every request made while a demo marker exists.
 *
 * Returning `undefined` is reserved for a normal administrator browser. Once a
 * demo session has existed, even an expired or malformed marker is answered
 * locally so a race during expiry can never fall through to production data.
 */
export function resolveDemoRequest(path: string, init: RequestInit): Response | undefined {
  const state = demoSessionState();
  if (state === 'none') return undefined;

  const url = new URL(path, 'https://ptvault.demo.invalid');
  const method = (init.method ?? 'GET').toUpperCase();
  const now = Date.now();

  if (method === 'POST' && url.pathname === '/api/auth/logout') {
    clearDemoSession();
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  }
  if (state !== 'active') return json({ error: 'Unauthorized' }, 401);

  if (method === 'GET' && url.pathname === '/api/auth/csrf') {
    return json({ token: 'demo-csrf-token' });
  }
  if (method === 'GET' && url.pathname === '/api/auth/session') {
    return json(currentDemoSession(now));
  }

  if (method === 'POST' && url.pathname === '/api/qb/sync') {
    return json({
      synced: instances(now).map((instance, index) => ({
        instanceId: instance.id,
        seen: torrents(now).filter((torrent) => torrent.instanceId === instance.id).length,
        inserted: 0,
        updated: index + 1,
        markedAbsent: 0,
        finishedAt: now,
      })),
      failed: [],
    });
  }
  if (method === 'POST' && url.pathname === '/api/qb/instances/test') {
    return json({ ok: true, version: '5.0.4-demo', error: null });
  }
  if (method === 'POST' && url.pathname === '/api/jellyfin/test') {
    return json({
      ok: true,
      serverName: 'PTVault Demo Media',
      version: '10.10.7-demo',
      notificationAccepted: true,
      error: null,
    });
  }

  if (method !== 'GET') return forbidden();

  if (url.pathname === '/api/storage/accounts') return json({ accounts: accounts(now) });
  if (url.pathname === '/api/system/metrics') return json(systemMetrics(now));
  if (url.pathname === '/api/system/info') return json(systemInfo(now));
  // Answered rather than left to `forbidden()`: a 403 here would render as a
  // failed read, and the read genuinely succeeds on a SHADOW box — it just
  // reports a runtime that cannot take work. The PATCH still falls through to
  // `DEMO_READ_ONLY`, which is the honest answer for a write.
  if (url.pathname === '/api/settings/transfers') return json(transferSettings(now));
  if (url.pathname === '/api/qb/instances') return json({ instances: instances(now) });

  const preflightMatch = url.pathname.match(
    /^\/api\/qb\/torrents\/([^/]+)\/([a-fA-F0-9]{40}|[a-fA-F0-9]{64})\/preflight$/,
  );
  if (preflightMatch) {
    const instanceId = decodeURIComponent(preflightMatch[1]!);
    const preflight = preflightFor(instanceId, preflightMatch[2]!.toLowerCase(), now);
    return preflight ? json({ preflight }) : json({ error: 'Not found' }, 404);
  }

  if (url.pathname === '/api/qb/torrents') {
    const instanceId = url.searchParams.get('instanceId');
    const filtered = torrents(now).filter(
      (torrent) => instanceId === null || torrent.instanceId === instanceId,
    );
    const page = positiveInteger(url.searchParams.get('page'), 1);
    const size = positiveInteger(url.searchParams.get('size'), filtered.length || 1, 200);
    const start = (page - 1) * size;
    return json({
      torrents: filtered.slice(start, start + size),
      total: filtered.length,
      page,
      size,
    });
  }

  if (url.pathname === '/api/offloads') return json({ offloads: offloads(now) });
  const eventMatch = url.pathname.match(/^\/api\/offloads\/([^/]+)\/events$/);
  if (eventMatch) return json({ events: jobEvents(decodeURIComponent(eventMatch[1]!), now) });

  if (url.pathname === '/api/recovery/status') return json({ status: recoveryStatus(now) });
  if (url.pathname === '/api/recovery/exports') return json({ exports: recoveryExports(now) });
  const copiesMatch = url.pathname.match(/^\/api\/recovery\/exports\/(\d+)\/cloud-copies$/);
  if (copiesMatch) {
    return json({ cloudCopies: recoveryCloudCopies(Number(copiesMatch[1]), now) });
  }

  if (url.pathname === '/api/media/disks') return json(disks());
  if (url.pathname === '/api/media/health') return json({ mounts: mounts(now) });
  if (url.pathname === '/api/media/rehydrates') return json({ rehydrates: rehydrates(now) });
  if (url.pathname === '/api/media/rehydrate-preview') {
    const requestedBytes = Math.max(0, Number(url.searchParams.get('bytes') ?? 0));
    const freeBytes = bytes(1.86 * TiB);
    const reserveBytes = 600 * GiB;
    const outstandingReservedBytes = 128 * GiB;
    const availableBytes = Math.max(0, freeBytes - reserveBytes - outstandingReservedBytes);
    return json({
      requestedBytes,
      freeBytes,
      reserveBytes,
      outstandingReservedBytes,
      availableBytes,
      freeBytesAfter: Math.max(0, freeBytes - requestedBytes),
      admissible: requestedBytes <= availableBytes,
      missingBytes: Math.max(0, requestedBytes - availableBytes),
      wouldBreachReserve: freeBytes - requestedBytes < reserveBytes,
    });
  }
  if (url.pathname === '/api/media') return json({ entries: mediaCatalog() });

  if (url.pathname === '/api/import-destinations') {
    return json({ capabilities: importCapabilities(), destinations: importDestinations() });
  }
  if (url.pathname === '/api/imports') return json({ jobs: importJobs(now) });
  const importJobMatch = url.pathname.match(/^\/api\/imports\/([^/]+)$/);
  if (importJobMatch) {
    const job = importDetail(decodeURIComponent(importJobMatch[1]!), now);
    return job ? json({ job }) : json({ error: 'Not found' }, 404);
  }

  if (url.pathname === '/api/jellyfin/info') return json(jellyfinInfo(now));
  if (url.pathname === '/api/audit') {
    const limit = positiveInteger(url.searchParams.get('limit'), 100, 500);
    return json({ events: auditEvents(now).slice(0, limit) });
  }

  return forbidden();
}
