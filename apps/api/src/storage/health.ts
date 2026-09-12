import type { StorageHealth } from '@ptvault/contracts';

export type QuotaSnapshot = {
  total: number | null;
  free: number | null;
};

/**
 * Derive a health state from a raw `rclone about` quota snapshot.
 * Known free capacity is HEALTHY; missing quota fields degrade the account
 * (it stays usable for reads but the selector treats unknown free as unusable).
 */
export function classifyHealth(quota: QuotaSnapshot): StorageHealth {
  if (quota.free === null) return 'DEGRADED';
  return 'HEALTHY';
}
