import type { HostInterface, MigrationThroughput, StorageAccount } from '@ptvault/contracts';

export type UploadAdvice = {
  /**
   * The largest single torrent that could be migrated right now.
   *
   * Bounded by the *largest single account*, not the total: a job picks one
   * account and writes every blob of that torrent there, so two accounts with
   * 300 GiB each cannot take a 500 GiB film between them. Reporting the sum here
   * would invite starting a migration that runs for hours and then fails on a
   * full remote.
   */
  largestJobBytes: number | null;
  /** Sum across healthy accounts — what could be migrated over several jobs. */
  totalHeadroomBytes: number | null;
  /** Label of the account backing `largestJobBytes`, so the number is checkable. */
  largestAccountLabel: string | null;
  /** Accounts left out because their quota could not be read or they are unhealthy. */
  unusableAccounts: number;
  /** Bytes per second over the wire, measured from past uploads. */
  uploadRate: number | null;
  /** Bytes per second including hashing and decrypt-readback verification. */
  endToEndRate: number | null;
  uplinkTxBytesPerSecond: number | null;
  /**
   * Whether the uplink is already carrying most of what a migration would need.
   *
   * `UNKNOWN` when either number is missing — with no measured upload rate there
   * is nothing to compare against, and a guess here is what would make an
   * operator start a 600 GiB upload on a saturated link.
   */
  uplinkPressure: 'IDLE' | 'BUSY' | 'UNKNOWN';
};

export type UploadAdviceInput = {
  throughput: MigrationThroughput | undefined;
  accounts: readonly StorageAccount[] | undefined;
  interfaces: readonly HostInterface[] | undefined;
};

/**
 * Share of the measured upload rate already in use before the link counts as busy.
 *
 * 0.5 rather than something near 1: seeding traffic and a migration compete for
 * the same uplink, so by the time the link is fully used the migration has
 * already been slowed for a while.
 */
const BUSY_FRACTION = 0.5;

/**
 * Turns telemetry into the two answers an operator actually wants before
 * starting a migration: how big a title can go now, and how long it will take.
 *
 * Kept as a pure function so each judgement can be asserted on its own — these
 * are the claims the panel makes, and a wrong one leads to a migration that
 * fails hours in.
 */
export function deriveUploadAdvice(input: UploadAdviceInput): UploadAdvice {
  const accounts = input.accounts;
  const usable = (accounts ?? []).filter(
    (account) => account.health === 'HEALTHY' && account.freeBytes !== null,
  );
  const headrooms = usable.map((account) => ({
    label: account.label,
    // The reserve is not free space. Spending into it is what the reserve exists
    // to prevent, so it is subtracted before anything is promised to the operator.
    bytes: Math.max(0, (account.freeBytes ?? 0) - account.reserveBytes),
  }));
  const largest = headrooms.reduce<{ label: string; bytes: number } | null>(
    (best, entry) => (best === null || entry.bytes > best.bytes ? entry : best),
    null,
  );

  const uplink = (input.interfaces ?? []).find((entry) => entry.isDefaultRoute);
  const uploadRate = input.throughput?.uploadPhase.bytesPerSecond ?? null;
  const txNow = uplink?.txBytesPerSecond ?? null;

  return {
    largestJobBytes: largest?.bytes ?? null,
    totalHeadroomBytes:
      headrooms.length === 0 ? null : headrooms.reduce((sum, entry) => sum + entry.bytes, 0),
    largestAccountLabel: largest?.label ?? null,
    unusableAccounts: (accounts ?? []).length - usable.length,
    uploadRate,
    endToEndRate: input.throughput?.endToEnd.bytesPerSecond ?? null,
    uplinkTxBytesPerSecond: txNow,
    uplinkPressure:
      txNow === null || uploadRate === null
        ? 'UNKNOWN'
        : txNow >= uploadRate * BUSY_FRACTION
          ? 'BUSY'
          : 'IDLE',
  };
}

/**
 * How long `bytes` would take at a measured rate.
 *
 * `null` for a missing or non-positive rate rather than `Infinity` or 0: both of
 * those render as a number an operator would plan around, and "we have never
 * measured a migration on this machine" is not a duration.
 */
export function estimateSeconds(bytes: number, bytesPerSecond: number | null): number | null {
  if (bytesPerSecond === null || bytesPerSecond <= 0 || bytes <= 0) return null;
  return bytes / bytesPerSecond;
}
