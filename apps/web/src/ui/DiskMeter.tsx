import type { DiskUsageReport } from '@ptvault/contracts';

import { formatBytes } from './format.js';

/**
 * A disk drawn against its own protection line.
 *
 * The reserve marker is drawn separately from the used bar because they answer
 * different questions: how full the disk is, and how close it is to the point
 * where this service stops admitting work. A single bar would show the first and
 * hide the second — and the second is the one that decides whether a restore is
 * accepted.
 *
 * Shared by the dashboard and the settings page rather than copied: two drawings
 * of the same disk that disagree about where the line sits is worse than either
 * one alone, because the reader has no way to tell which is stale.
 */
export function DiskMeter({ label, disk }: { label: string; disk: DiskUsageReport }) {
  const total = Math.max(disk.totalBytes, 1);
  const used = Math.max(0, disk.totalBytes - disk.freeBytes);
  const usedPercent = Math.min(100, (used / total) * 100);
  const reservePercent = Math.min(100, Math.max(0, ((total - disk.reserveBytes) / total) * 100));
  const breached = disk.freeBytes <= disk.reserveBytes;

  return (
    <div className="disk-meter">
      <div className="disk-meter-head">
        <span className="disk-meter-label">{label}</span>
        <span className="disk-meter-figure">
          剩余 {formatBytes(disk.freeBytes)} / {formatBytes(disk.totalBytes)}
        </span>
      </div>
      <div
        className={`meter-track${breached ? ' is-breached' : ''}`}
        role="img"
        aria-label={`${label}：已用 ${formatBytes(used)}，剩余 ${formatBytes(disk.freeBytes)}，保护线 ${formatBytes(disk.reserveBytes)}`}
      >
        <span className="meter-fill" style={{ width: `${usedPercent}%` }} />
        <span className="meter-reserve" style={{ left: `${reservePercent}%` }} />
      </div>
      <p className="disk-meter-note">
        <code>{disk.path}</code> · 保护线 {formatBytes(disk.reserveBytes)}
        {breached ? ' · 已触及' : ''}
      </p>
    </div>
  );
}
