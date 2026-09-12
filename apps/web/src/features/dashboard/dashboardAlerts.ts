import type {
  DisksResponse,
  MountHealth,
  OffloadSnapshot,
  RehydrateSnapshot,
  StorageAccount,
} from '@ptvault/contracts';

export type AlertTone = 'error' | 'warn' | 'info';

export type DashboardAlert = {
  tone: AlertTone;
  message: string;
  /** Where the operator can act on it. */
  href: string;
};

export type AlertInput = {
  disks: DisksResponse | undefined;
  mounts: readonly MountHealth[];
  accounts: readonly StorageAccount[];
  offloads: readonly OffloadSnapshot[];
  rehydrates: readonly RehydrateSnapshot[];
  recoveryUnlocked: boolean | undefined;
  now: number;
};

/**
 * Turns the dashboard's raw readings into things worth telling the operator.
 *
 * A pure function rather than logic inside the page, because these are the
 * judgements the page exists to make and they need to be assertable one at a time.
 *
 * Two rules the ordering encodes:
 *
 * - **An outage is never reported as missing data.** A dead mount says the library
 *   cannot be read right now; it never says a file is gone. That distinction is
 *   what stops an operator from "recovering" data that was never lost.
 * - **Nothing is inferred from absent data.** A query that has not resolved yet
 *   produces no alert at all, rather than a green "all clear" — an empty reading
 *   and a healthy reading are different facts, and only one of them is reassuring.
 */
export function deriveAlerts(input: AlertInput): DashboardAlert[] {
  const alerts: DashboardAlert[] = [];

  for (const mount of input.mounts) {
    if (!mount.mounted) {
      alerts.push({
        tone: 'error',
        message: `挂载离线：账户 ${short(mount.accountId)} 的云端媒体暂时读不到。本地文件不受影响。`,
        href: '/media',
      });
    } else if (!mount.rcReachable) {
      // Distinct from an outage: the mount still serves reads, we just cannot ask
      // it about cache. Reporting this as an outage would overstate the damage.
      alerts.push({
        tone: 'warn',
        message: `账户 ${short(mount.accountId)} 的 rclone 控制端口无响应：读不到缓存用量，播放不受影响。`,
        href: '/media',
      });
    }

    if (mount.pressure === 'CRITICAL') {
      alerts.push({
        tone: 'error',
        message: `账户 ${short(mount.accountId)} 缓存盘已触及保护线，新的预取与回迁暂停放行。`,
        href: '/media',
      });
    } else if (mount.pressure === 'EVICTING') {
      alerts.push({
        tone: 'warn',
        message: `账户 ${short(mount.accountId)} 正在腾出缓存，播放不受影响。`,
        href: '/media',
      });
    }
  }

  // Checked per pool, because they are different disks with different consequences:
  // the hot root running out stalls the torrents, the cache disk running out only
  // costs playback speed.
  if (input.disks) {
    if (input.disks.hot.freeBytes <= input.disks.hot.reserveBytes) {
      alerts.push({
        tone: 'error',
        message: '数据盘剩余空间已触及 15% 保护线，回迁将被拒绝，qB 下载也可能受影响。',
        href: '/media',
      });
    }
    if (input.disks.cache.freeBytes <= input.disks.cache.reserveBytes) {
      alerts.push({
        tone: 'error',
        message: '缓存盘剩余空间已触及保护线，云端播放会退化为每次重新拉取。',
        href: '/media',
      });
    }
  }

  for (const account of input.accounts) {
    if (account.health !== 'HEALTHY') {
      alerts.push({
        tone: 'error',
        message: `存储账户 ${account.label} 状态为 ${account.health}。`,
        href: '/storage-accounts',
      });
      // Epoch milliseconds, not seconds: the backend writes `Date.now()` and
      // compares it raw (storage/selector.ts). Scaling it here would push every
      // breaker ~55 000 years into the future and report a permanent outage.
    } else if (account.circuitOpenUntil !== null && account.circuitOpenUntil > input.now) {
      alerts.push({
        tone: 'warn',
        message: `存储账户 ${account.label} 已被熔断，暂时不参与账户选择。`,
        href: '/storage-accounts',
      });
    }
  }

  const stuckOffloads = input.offloads.filter(
    (offload) =>
      offload.cancelledAt === null &&
      (offload.jobState === 'FAILED_SAFE' || offload.jobState === 'BLOCKED'),
  );
  if (stuckOffloads.length > 0) {
    alerts.push({
      tone: 'error',
      message: `${stuckOffloads.length} 个迁移已安全停止，本地文件未被删除，可重试或取消。`,
      href: '/transfers?group=FAILED',
    });
  }

  const stuckRehydrates = input.rehydrates.filter(
    (job) =>
      job.cancelledAt === null && (job.jobState === 'FAILED_SAFE' || job.jobState === 'BLOCKED'),
  );
  if (stuckRehydrates.length > 0) {
    alerts.push({
      tone: 'error',
      message: `${stuckRehydrates.length} 个回迁已停止，已下载的字节保留在本地。`,
      href: '/media',
    });
  }

  // Explicitly `=== false`: undefined means the query has not answered yet, and
  // "recovery gate unknown" must not render as "recovery gate closed".
  if (input.recoveryUnlocked === false) {
    alerts.push({
      tone: 'warn',
      message: '恢复材料尚未就绪，删除本地文件的操作会被拒绝。',
      href: '/recovery',
    });
  }

  const awaiting = input.offloads.filter(
    (offload) =>
      offload.currentStep === 'CLOUD_COMMITTED' &&
      offload.cleanupCompletedAt === null &&
      offload.cancelledAt === null,
  );
  if (awaiting.length > 0) {
    // Informational, not a warning: bytes verified in the cloud with the local copy
    // still present is the safe resting state, and deleting is the operator's call.
    alerts.push({
      tone: 'info',
      message: `${awaiting.length} 个种子已在云端验证通过，本地副本仍保留，等待你批准删除。`,
      href: '/transfers?group=AWAITING_CLEANUP',
    });
  }

  return alerts;
}

function short(accountId: string): string {
  return accountId.slice(0, 8);
}
