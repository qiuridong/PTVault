// Operational health aggregator.
//
// A PURE function over injected probe results. It never spawns a process, opens
// a socket, or reads the disk itself — the caller supplies already-collected,
// already-redacted facts (see the ops route wiring) and this module classifies
// them into a single OK / WARNING / CRITICAL rollup. Keeping it pure makes the
// whole health surface hermetically testable and guarantees no secret can leak:
// only labels and boolean/number facts ever enter, never a token or key.

export type Severity = 'OK' | 'WARNING' | 'CRITICAL';

export type ServiceReachability = 'REACHABLE' | 'UNREACHABLE';

export type AccountHealthInput = {
  id: string;
  label: string;
  health: 'HEALTHY' | 'DEGRADED' | 'THROTTLED' | 'AUTH_REQUIRED' | 'OFFLINE';
  totalBytes: number | null;
  freeBytes: number | null;
  reserveBytes: number;
  circuitOpenUntil: number | null;
};

export type HealthInputs = {
  now: number;
  services: {
    qbittorrent: ServiceReachability;
    jellyfin: ServiceReachability;
  };
  accounts: AccountHealthInput[];
  rclone: {
    rcReachable: boolean;
    mountSentinelPresent: boolean;
  };
  disk: {
    cacheFilesystemFreeFraction: number;
    cacheFilesystemFreeInodesFraction: number;
  };
  database: {
    quickCheckOk: boolean;
  };
  recovery: {
    version: number | null;
    deletionUnlocked: boolean;
  };
  tls: {
    notAfterMs: number;
    e5RenewalDueMs: number | null;
  };
};

export type HealthCheck = {
  code: string;
  severity: Severity;
  message: string;
};

export type OperationalHealth = {
  status: Severity;
  checkedAt: number;
  checks: HealthCheck[];
};

// Reserve fraction the cache filesystem must keep free (mirrors the renderer's
// CACHE_RESERVE_FRACTION so ops and deploy agree on the same threshold).
const DISK_RESERVE_FRACTION = 0.15;
// Free-inode floor: mechanical disks shared with qB/Jellyfin should not run out
// of inodes from many small VFS cache chunks.
const INODE_RESERVE_FRACTION = 0.05;
const DAY_MS = 86_400_000;
// TLS is a WARNING inside this window and CRITICAL once past notAfter.
const TLS_WARNING_WINDOW_MS = 14 * DAY_MS;
// The E5 developer tenant needs a manual renewal nudge well ahead of time.
const E5_REMINDER_WINDOW_MS = 30 * DAY_MS;

const SEVERITY_RANK: Record<Severity, number> = { OK: 0, WARNING: 1, CRITICAL: 2 };

export function worstSeverity(severities: readonly Severity[]): Severity {
  let worst: Severity = 'OK';
  for (const severity of severities) {
    if (SEVERITY_RANK[severity] > SEVERITY_RANK[worst]) worst = severity;
  }
  return worst;
}

function serviceCheck(code: string, name: string, reachability: ServiceReachability): HealthCheck {
  return reachability === 'REACHABLE'
    ? { code, severity: 'OK', message: `${name} reachable` }
    : { code, severity: 'CRITICAL', message: `${name} unreachable` };
}

function accountsCheck(inputs: HealthInputs): HealthCheck {
  const problems: Array<{ severity: Severity; note: string }> = [];
  for (const account of inputs.accounts) {
    if (account.health === 'OFFLINE' || account.health === 'AUTH_REQUIRED') {
      problems.push({ severity: 'CRITICAL', note: `${account.label} ${account.health}` });
      continue;
    }
    if (account.circuitOpenUntil !== null && account.circuitOpenUntil > inputs.now) {
      problems.push({ severity: 'WARNING', note: `${account.label} circuit open` });
      continue;
    }
    if (account.health === 'DEGRADED' || account.health === 'THROTTLED') {
      problems.push({ severity: 'WARNING', note: `${account.label} ${account.health}` });
      continue;
    }
    if (account.freeBytes === null) {
      // Unknown free space: the selector cannot place data here, so warn.
      problems.push({ severity: 'WARNING', note: `${account.label} free space unknown` });
      continue;
    }
    if (account.freeBytes <= account.reserveBytes) {
      problems.push({ severity: 'WARNING', note: `${account.label} at/under reserve` });
    }
  }

  if (problems.length === 0) {
    return {
      code: 'STORAGE_ACCOUNTS',
      severity: 'OK',
      message: `${inputs.accounts.length} account(s) healthy`,
    };
  }
  return {
    code: 'STORAGE_ACCOUNTS',
    severity: worstSeverity(problems.map((p) => p.severity)),
    message: problems.map((p) => p.note).join('; '),
  };
}

function tlsCheck(inputs: HealthInputs): HealthCheck {
  const remaining = inputs.tls.notAfterMs - inputs.now;
  if (remaining <= 0) {
    return { code: 'TLS_EXPIRY', severity: 'CRITICAL', message: 'TLS certificate expired' };
  }
  if (remaining <= TLS_WARNING_WINDOW_MS) {
    const days = Math.floor(remaining / DAY_MS);
    return {
      code: 'TLS_EXPIRY',
      severity: 'WARNING',
      message: `TLS certificate expires in ${days} day(s)`,
    };
  }
  return { code: 'TLS_EXPIRY', severity: 'OK', message: 'TLS certificate valid' };
}

function e5Check(inputs: HealthInputs): HealthCheck {
  const due = inputs.tls.e5RenewalDueMs;
  if (due === null) {
    return { code: 'E5_RENEWAL', severity: 'OK', message: 'no E5 renewal tracked' };
  }
  const remaining = due - inputs.now;
  // A reminder only — never CRITICAL, so it cannot block operations on its own.
  if (remaining <= E5_REMINDER_WINDOW_MS) {
    const days = Math.max(0, Math.floor(remaining / DAY_MS));
    return {
      code: 'E5_RENEWAL',
      severity: 'WARNING',
      message: `E5 developer tenant renewal due in ${days} day(s)`,
    };
  }
  return { code: 'E5_RENEWAL', severity: 'OK', message: 'E5 renewal not yet due' };
}

export function buildOperationalHealth(inputs: HealthInputs): OperationalHealth {
  const checks: HealthCheck[] = [
    serviceCheck('QBITTORRENT', 'qBittorrent', inputs.services.qbittorrent),
    serviceCheck('JELLYFIN', 'Jellyfin', inputs.services.jellyfin),
    accountsCheck(inputs),
    inputs.rclone.rcReachable
      ? { code: 'RCLONE_RC', severity: 'OK', message: 'rclone RC reachable' }
      : { code: 'RCLONE_RC', severity: 'CRITICAL', message: 'rclone RC unreachable' },
    inputs.rclone.mountSentinelPresent
      ? { code: 'MOUNT_SENTINEL', severity: 'OK', message: 'library mount present' }
      : { code: 'MOUNT_SENTINEL', severity: 'CRITICAL', message: 'library mount missing' },
    inputs.disk.cacheFilesystemFreeFraction >= DISK_RESERVE_FRACTION
      ? { code: 'DISK_RESERVE', severity: 'OK', message: 'cache filesystem above reserve' }
      : {
          code: 'DISK_RESERVE',
          severity: 'WARNING',
          message: `cache filesystem free ${(inputs.disk.cacheFilesystemFreeFraction * 100).toFixed(0)}% below ${DISK_RESERVE_FRACTION * 100}% reserve`,
        },
    inputs.disk.cacheFilesystemFreeInodesFraction >= INODE_RESERVE_FRACTION
      ? { code: 'INODE_RESERVE', severity: 'OK', message: 'free inodes above reserve' }
      : { code: 'INODE_RESERVE', severity: 'WARNING', message: 'free inodes below reserve' },
    inputs.database.quickCheckOk
      ? { code: 'DATABASE_INTEGRITY', severity: 'OK', message: 'SQLite quick_check ok' }
      : { code: 'DATABASE_INTEGRITY', severity: 'CRITICAL', message: 'SQLite quick_check failed' },
    inputs.recovery.version === null
      ? {
          code: 'RECOVERY_READINESS',
          severity: 'WARNING',
          message: 'no completed recovery version yet',
        }
      : {
          code: 'RECOVERY_READINESS',
          severity: 'OK',
          message: `recovery version ${inputs.recovery.version} present${
            inputs.recovery.deletionUnlocked ? ' (deletion unlocked)' : ''
          }`,
        },
    tlsCheck(inputs),
    e5Check(inputs),
  ];

  return {
    status: worstSeverity(checks.map((c) => c.severity)),
    checkedAt: inputs.now,
    checks,
  };
}
