/**
 * Formatting for import telemetry, and the one sanitising step that has to happen
 * before a share link is allowed anywhere else.
 *
 * Kept apart from the components for two reasons. The byte helpers are the only
 * place BigInt arithmetic lives, so there is exactly one answer to "how is a
 * 30-digit figure rendered"; and `splitSharePasscode` is a security-relevant
 * transform that deserves tests of its own rather than being buried in an
 * onChange handler.
 */

/**
 * What the console says when the server did not report a figure.
 *
 * Distinct from a zero on purpose, and the distinction is the point: `0 B/s` is
 * a statement that nothing is moving, which is a different fact from "this API
 * version does not measure that leg". Rendering the second as the first sends an
 * operator to investigate a stall that is not happening.
 */
export const NOT_REPORTED = '未报告';

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

/**
 * A decimal string as a BigInt, or null if it is not one.
 *
 * Deliberately stricter than `BigInt()`, which happily accepts `''`, `'0x10'`
 * and leading whitespace. A figure that does not match the wire contract is
 * withheld rather than guessed at.
 */
function toBigInt(value: string | undefined | null): bigint | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,29})$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Binary units, computed entirely in BigInt.
 *
 * Never widened to `Number` first: a job total is the sum of hundreds of objects
 * and passes 2^53 well inside plausible use, at which point two different totals
 * start formatting identically. The unit choice, the whole part and the single
 * decimal are all derived by integer division so the rendered figure is the one
 * that was sent.
 *
 * One decimal below ten and none above, matching `ui/format.ts` — two size
 * columns on the same screen that round differently read as a discrepancy.
 */
export function formatDecimalBytes(value: string | undefined | null): string {
  const total = toBigInt(value);
  if (total === null) return NOT_REPORTED;

  let unit = 0;
  let scale = 1n;
  while (unit < BYTE_UNITS.length - 1 && total / scale >= 1024n) {
    scale *= 1024n;
    unit += 1;
  }

  const whole = total / scale;
  if (unit === 0 || whole >= 10n) return `${whole} ${BYTE_UNITS[unit]}`;
  const tenths = ((total % scale) * 10n) / scale;
  return `${whole}.${tenths} ${BYTE_UNITS[unit]}`;
}

/** A byte figure that may be absent. Absent renders as 「未报告」, not as 0. */
export function formatOptionalBytes(value: string | undefined | null): string {
  return value === undefined || value === null ? NOT_REPORTED : formatDecimalBytes(value);
}

/** A rate that may be absent, per second. */
export function formatOptionalRate(value: string | undefined | null): string {
  if (value === undefined || value === null) return NOT_REPORTED;
  const formatted = formatDecimalBytes(value);
  return formatted === NOT_REPORTED ? NOT_REPORTED : `${formatted}/s`;
}

/**
 * A remaining duration in the granularity it is actually read at.
 *
 * Seconds under a minute, minutes and seconds under an hour, hours and minutes
 * above — nobody watching a six-hour transfer needs the seconds digit, and a
 * figure that changes every second reads as noise rather than as progress.
 */
export function formatEta(seconds: number | undefined | null): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return NOT_REPORTED;
  }
  const whole = Math.floor(seconds);
  if (whole === 0) return '即将完成';
  if (whole < 60) return `${whole} 秒`;
  if (whole < 3600) return `${Math.floor(whole / 60)} 分 ${whole % 60} 秒`;
  return `${Math.floor(whole / 3600)} 小时 ${Math.floor((whole % 3600) / 60)} 分`;
}

/**
 * Time until a scheduled retry.
 *
 * Floors at 「即将重试」 rather than counting into negatives: a retry whose time
 * has passed is one the worker has not picked up yet, and "-4 秒" invites the
 * reading that something is stuck when the normal case is a poll interval.
 */
export function formatCountdown(at: string | undefined | null, now: number): string {
  if (typeof at !== 'string') return NOT_REPORTED;
  const target = Date.parse(at);
  if (Number.isNaN(target)) return NOT_REPORTED;
  const seconds = Math.round((target - now) / 1000);
  if (seconds <= 0) return '即将重试';
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`;
}

/**
 * A percentage from two decimal strings, or null when there is no answer.
 *
 * Scaled by 10000 in BigInt before the single conversion to `Number`, so the
 * division never runs on a rounded operand. `null` for a zero or unparseable
 * total: a job whose size is not yet known has no percentage, and drawing 0%
 * would claim it has made no progress.
 */
export function percentOfDecimal(
  done: string | undefined | null,
  total: string | undefined | null,
): number | null {
  const doneValue = toBigInt(done);
  const totalValue = toBigInt(total);
  if (doneValue === null || totalValue === null || totalValue === 0n) return null;
  if (doneValue >= totalValue) return 100;
  return Number((doneValue * 10_000n) / totalValue) / 100;
}

/**
 * A percentage as text, truncated rather than rounded.
 *
 * `(99.99).toFixed(1)` is `"100.0"`, so a job with one byte left would report
 * itself finished — on a console whose whole claim is that bytes were verified,
 * that is the one rounding error that must not happen. Truncating means the
 * figure only reads 100% when it is 100%.
 */
export function formatPercent(percent: number | null): string {
  if (percent === null) return NOT_REPORTED;
  if (percent >= 100) return '100.0%';
  return `${(Math.floor(percent * 10) / 10).toFixed(1)}%`;
}

export type SplitShareLink = {
  /** The link with any passcode parameter removed. Safe to send and to log. */
  shareUrl: string;
  /** The extracted passcode, if the link carried one. Never persisted. */
  passcode: string | null;
};

/** Query and fragment keys Baidu has used to smuggle the passcode into the link. */
const PASSCODE_KEYS = ['pwd', 'passwd', 'password'];

function passcodeFromParams(params: URLSearchParams): string | null {
  for (const key of PASSCODE_KEYS) {
    const value = params.get(key);
    if (value !== null && value.trim() !== '') {
      params.delete(key);
      return value.trim();
    }
    if (value !== null) params.delete(key);
  }
  return null;
}

/**
 * Pull the passcode out of a pasted share link.
 *
 * Baidu's share UI hands out `…/s/1AbCdEf?pwd=k3n9`, so the overwhelmingly
 * common paste already contains the secret. Left in the URL it would travel as a
 * query parameter — into request logs, into `Referer`, into the error string of
 * any failed fetch, and into every place a URL is considered safe to record.
 * Moving it to a dedicated field at the entry point removes it from all of those
 * at once.
 *
 * This is a convenience and a first line, **not** the security boundary: the
 * server strips the same parameters again, because a browser cannot be trusted
 * to have done so. It also returns text it could not parse unchanged rather than
 * blanking the field — silently discarding what someone typed is its own bug.
 */
export function splitSharePasscode(input: string): SplitShareLink {
  const trimmed = input.trim();
  if (trimmed === '') return { shareUrl: '', passcode: null };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { shareUrl: trimmed, passcode: null };
  }

  const fromQuery = passcodeFromParams(url.searchParams);

  // Some clients put it after the hash, where it never reaches the server but
  // does reach `location.href`, `history` and anything reading the address bar.
  let fromFragment: string | null = null;
  if (url.hash.startsWith('#')) {
    const fragment = new URLSearchParams(url.hash.slice(1));
    fromFragment = passcodeFromParams(fragment);
    const rest = fragment.toString();
    url.hash = rest === '' ? '' : `#${rest}`;
  }

  return { shareUrl: url.toString().replace(/\?$/, ''), passcode: fromQuery ?? fromFragment };
}
