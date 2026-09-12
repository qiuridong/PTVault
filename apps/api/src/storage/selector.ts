import type { StorageAccount } from '@ptvault/contracts';

export class NoAccountCapacityError extends Error {
  readonly code = 'NO_ACCOUNT_CAPACITY';

  constructor() {
    super('NO_ACCOUNT_CAPACITY');
    this.name = 'NoAccountCapacityError';
  }
}

export type SelectAccountOptions = {
  excludeAccountIds?: readonly string[];
};

/**
 * Usable capacity is free space minus the account's protective reserve. An
 * account with unknown free space (`null`) is treated as unusable — we never
 * upload against a quota we cannot measure.
 */
function usableBytes(account: StorageAccount): number | null {
  if (account.freeBytes === null) return null;
  return account.freeBytes - account.reserveBytes;
}

/**
 * Choose the account best able to accept `requiredBytes`. An account is a
 * candidate only when it is HEALTHY, its circuit breaker is closed at `now`,
 * it is not explicitly excluded, and its post-reserve capacity covers the
 * requirement. Among candidates the one with the most post-reserve capacity
 * wins so uploads spread toward the emptiest account. Throws
 * `NoAccountCapacityError` when no account qualifies.
 */
export function selectAccount(
  accounts: readonly StorageAccount[],
  requiredBytes: number,
  now: number,
  options: SelectAccountOptions = {},
): StorageAccount {
  const excluded = new Set(options.excludeAccountIds ?? []);

  let best: StorageAccount | undefined;
  let bestUsable = -1;

  for (const account of accounts) {
    if (excluded.has(account.id)) continue;
    if (account.health !== 'HEALTHY') continue;
    if (account.circuitOpenUntil !== null && account.circuitOpenUntil > now) continue;

    const usable = usableBytes(account);
    if (usable === null) continue;
    if (usable < requiredBytes) continue;

    if (usable > bestUsable) {
      best = account;
      bestUsable = usable;
    }
  }

  if (!best) throw new NoAccountCapacityError();
  return best;
}
