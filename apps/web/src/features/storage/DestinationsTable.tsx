import type { StorageAccount, StorageHealth } from '@ptvault/contracts';
import { CircleCheck, CircleOff, ShieldAlert, TriangleAlert, Zap } from 'lucide-react';
import { useId } from 'react';

const healthLabels: Record<StorageHealth, string> = {
  HEALTHY: '健康',
  DEGRADED: '降级',
  THROTTLED: '限流',
  AUTH_REQUIRED: '需重新授权',
  OFFLINE: '离线',
};

const ACCOUNT_TELEMETRY_STALE_MS = 10 * 60_000;

function HealthIcon({ health }: { health: StorageHealth }) {
  switch (health) {
    case 'HEALTHY':
      return <CircleCheck size={14} strokeWidth={1.9} aria-hidden="true" />;
    case 'THROTTLED':
      return <Zap size={14} strokeWidth={1.9} aria-hidden="true" />;
    case 'AUTH_REQUIRED':
      return <ShieldAlert size={14} strokeWidth={1.9} aria-hidden="true" />;
    case 'OFFLINE':
      return <CircleOff size={14} strokeWidth={1.9} aria-hidden="true" />;
    default:
      return <TriangleAlert size={14} strokeWidth={1.9} aria-hidden="true" />;
  }
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '未知';
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  const rounded =
    exponent >= 4 ? value.toFixed(2) : exponent >= 2 ? value.toFixed(1) : Math.round(value);
  return `${rounded} ${units[exponent]}`;
}

/**
 * Epoch **milliseconds**, not seconds.
 *
 * The writer is `Date.now()` (`cli/register-account.ts` → `recordHealth`), and
 * `storage/selector.ts` compares the breaker deadline against `Date.now()` with no
 * scaling. This function used to multiply by 1000, which rendered "最近检查" as a
 * date around the year 55 000 and would have held a tripped breaker open forever.
 */
function formatTimestamp(millis: number | null): string {
  if (millis === null) return '从未';
  return new Date(millis).toLocaleString();
}

export type DestinationRowProps = {
  account: StorageAccount;
  /**
   * No cloud connection claims this account, so it predates web login.
   *
   * Worth saying on the row rather than leaving blank: a legacy account was
   * registered by the operations CLI against a pre-existing rclone remote, and its
   * grant cannot be refreshed or revoked from this page. Drawing it identically to
   * a web-authorised account would imply that it can.
   */
  legacy?: boolean;
};

export function DestinationRow({ account, legacy = false }: DestinationRowProps) {
  // The canonical opaque account ID may contain spaces; it is not an HTML IDREF.
  const headingId = useId();
  const circuitOpen = account.circuitOpenUntil !== null && account.circuitOpenUntil > Date.now();
  const telemetryStale =
    account.lastCheckedAt === null ||
    Date.now() - account.lastCheckedAt > ACCOUNT_TELEMETRY_STALE_MS;
  const displayedHealth = telemetryStale ? 'DEGRADED' : account.health;
  const usedBytes =
    account.totalBytes === null || account.freeBytes === null
      ? null
      : Math.max(0, account.totalBytes - account.freeBytes);
  const meterReady = usedBytes !== null && account.totalBytes !== null && account.totalBytes > 0;

  return (
    <article className="ops-row" aria-labelledby={headingId}>
      <div className="ops-row-main destination-row-main">
        <div className="ops-row-identity">
          <div className="ops-row-name">
            <h3 id={headingId}>{account.label}</h3>
            <p className="ops-row-meta">
              {legacy ? <span className="account-legacy-tag">运维登记</span> : null}
              <span className={`health-tag health-${displayedHealth.toLowerCase()}`}>
                <HealthIcon health={displayedHealth} />
                {telemetryStale ? '遥测过期' : healthLabels[account.health]}
              </span>
            </p>
          </div>
        </div>

        <dl className="ops-row-states">
          <div>
            <dt>可用容量</dt>
            <dd>{formatBytes(account.freeBytes)}</dd>
          </div>
          <div>
            <dt>总容量</dt>
            <dd>{formatBytes(account.totalBytes)}</dd>
          </div>
          <div>
            <dt>云盘已用</dt>
            <dd>{formatBytes(usedBytes)}</dd>
          </div>
          <div>
            <dt>预留</dt>
            <dd>{formatBytes(account.reserveBytes)}</dd>
          </div>
          <div>
            <dt>最近检查</dt>
            <dd>{formatTimestamp(account.lastCheckedAt)}</dd>
          </div>
        </dl>

        {/*
          Drawn only when both ends of the fraction are known. A bar with an
          assumed denominator is worse than no bar: it reads as a measurement.
          The reserve mark is the point where this account stops being chosen for
          new uploads, which is not the same as the point where it is full.
        */}
        {meterReady ? (
          <div className="disk-meter destination-row-meter">
            <div className="disk-meter-head">
              <span className="disk-meter-label">云盘占用</span>
              <span className="disk-meter-figure">
                {Math.round((usedBytes / account.totalBytes!) * 100)}%
              </span>
            </div>
            <div
              className="meter-track"
              role="img"
              aria-label={`${account.label}：已用 ${formatBytes(usedBytes)}，共 ${formatBytes(
                account.totalBytes,
              )}`}
            >
              <span
                className="meter-fill"
                style={{ width: `${Math.min(100, (usedBytes / account.totalBytes!) * 100)}%` }}
              />
              <span
                className="meter-reserve"
                style={{
                  left: `${Math.min(
                    100,
                    Math.max(
                      0,
                      ((account.totalBytes! - account.reserveBytes) / account.totalBytes!) * 100,
                    ),
                  )}%`,
                }}
              />
            </div>
            <p className="disk-meter-note">
              预留 {formatBytes(account.reserveBytes)} 之后不再向该账户分配新任务
            </p>
          </div>
        ) : (
          <p className="ops-row-noactions">
            <span className="note-text">容量遥测不完整，不绘制占用条以免被读成实测值。</span>
          </p>
        )}
      </div>

      {legacy ? (
        <p className="ops-row-notice account-legacy-note" role="note">
          <span className="note-text">
            由 rclone 配置与 CLI 登记，不是网页登录的账户；这里不能对它重新授权或断开。
          </span>
        </p>
      ) : null}

      {circuitOpen ? (
        <p className="ops-row-notice" role="status">
          <TriangleAlert size={14} strokeWidth={1.9} aria-hidden="true" />
          <span className="note-text">
            熔断至 {formatTimestamp(account.circuitOpenUntil)} —— 暂时从账户选择中排除。
          </span>
        </p>
      ) : null}
    </article>
  );
}

export type DestinationsTableProps = {
  accounts: readonly StorageAccount[];
  provisionedAccountIds: ReadonlySet<string>;
};

export function DestinationsTable({ accounts, provisionedAccountIds }: DestinationsTableProps) {
  return (
    <div className="ops-rows" role="list">
      {accounts.map((account) => (
        <div key={account.id} role="listitem">
          <DestinationRow account={account} legacy={!provisionedAccountIds.has(account.id)} />
        </div>
      ))}
    </div>
  );
}
