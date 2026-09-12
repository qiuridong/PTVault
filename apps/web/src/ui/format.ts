/**
 * Byte sizes, in the units the operator's other tools use.
 *
 * Binary units (KiB/MiB/GiB), not decimal: every figure this console compares
 * against — `df`, qBittorrent, rclone — is binary, and a 10% discrepancy between
 * two screens showing "the same" disk is the kind of thing that gets debugged
 * for an hour before someone notices the unit.
 *
 * One decimal below 10 and none above, because the second digit of "847 GiB" is
 * noise in every decision this number is used for, while "1.4 GiB" and "1 GiB"
 * are meaningfully different.
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * A past instant as an age, falling back to the absolute time once "ago" stops
 * being the useful framing.
 *
 * Ages answer the question actually being asked of a sync timestamp — *is this
 * current* — which a wall-clock time only answers after the reader does the
 * subtraction. Past a day the absolute date is the better answer, because "37
 * 小时前" is something nobody can place without doing the same arithmetic in
 * reverse.
 */
export function formatAge(at: number, now: number): string {
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 0) return new Date(at).toLocaleString();
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  return new Date(at).toLocaleString();
}
