/**
 * Parsers for the `/proc` files behind the host metrics panel.
 *
 * Split out as pure string → value functions so they can be tested against real
 * captured output rather than against a mock of themselves. Every one of them
 * returns counters exactly as the kernel reports them: cumulative since boot.
 * Turning counters into rates needs two readings and belongs to the sampler,
 * not here.
 *
 * All of these are Linux-only by construction. The caller decides what to do
 * when the files are absent; these functions only refuse to invent numbers.
 */

/** Raised when a file exists but does not have the shape this parser requires. */
export class ProcParseError extends Error {
  constructor(readonly file: string) {
    super(`PROC_PARSE_FAILED:${file}`);
    this.name = 'ProcParseError';
  }
}

export type CpuCounters = {
  /** user through steal; guest/guest_nice are already included in user/nice. */
  totalJiffies: number;
  stealJiffies: number;
  /** Idle + iowait. Both mean "not doing work", and separating them here would
   *  make a busy-waiting disk look like CPU load. */
  idleJiffies: number;
};

/**
 * Reads the aggregate CPU line from `/proc/stat`.
 *
 * Only the first line is used. The per-core lines below it would let the panel
 * show a per-core breakdown, but four bars that always move together tell an
 * operator less than one number does, and this machine has four cores.
 */
export function parseProcStat(text: string): CpuCounters {
  const line = text.split('\n').find((entry) => entry.startsWith('cpu '));
  if (!line) throw new ProcParseError('stat');

  const fields = line.slice(4).trim().split(/\s+/).map(Number);
  // guest and guest_nice must not be added again to user and nice.
  if (fields.length < 5 || fields.some((value) => !Number.isFinite(value))) {
    throw new ProcParseError('stat');
  }

  const idle = fields[3] ?? 0;
  const iowait = fields[4] ?? 0;
  return {
    totalJiffies: fields.slice(0, 8).reduce((sum, value) => sum + value, 0),
    idleJiffies: idle + iowait,
    stealJiffies: fields[7] ?? 0,
  };
}

export type MemoryReading = {
  totalBytes: number;
  availableBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
};

/**
 * Reads `/proc/meminfo`.
 *
 * `MemAvailable` is used rather than `MemFree` and is required, not optional:
 * on a machine whose whole job is moving files, the page cache holds everything
 * spare, so `MemFree` sits near zero at perfect health. A panel driven by it
 * would show a permanent emergency. `MemAvailable` has been in Linux since 3.14;
 * a kernel without it is old enough that guessing is worse than saying so.
 */
export function parseMemInfo(text: string): MemoryReading {
  const values = new Map<string, number>();
  for (const line of text.split('\n')) {
    const match = /^(\w+):\s+(\d+)(?:\s+kB)?$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      // Every field this file reports in kB is reported in *kibibytes*.
      values.set(match[1], Number(match[2]) * 1024);
    }
  }

  const total = values.get('MemTotal');
  const available = values.get('MemAvailable');
  if (total === undefined || available === undefined) throw new ProcParseError('meminfo');

  const swapTotal = values.get('SwapTotal') ?? 0;
  const swapFree = values.get('SwapFree') ?? 0;
  return {
    totalBytes: total,
    availableBytes: available,
    swapTotalBytes: swapTotal,
    // Clamped: SwapFree is read a few microseconds after SwapTotal, and a
    // negative "used" is a worse answer than a zero.
    swapUsedBytes: Math.max(0, swapTotal - swapFree),
  };
}

export type InterfaceCounters = {
  name: string;
  rxBytes: number;
  txBytes: number;
};

/**
 * Reads per-interface byte counters from `/proc/net/dev`.
 *
 * Loopback is dropped here rather than in the caller: it is not a link with
 * capacity, and including it would make local API traffic look like uplink use.
 */
export function parseNetDev(text: string): InterfaceCounters[] {
  const interfaces: InterfaceCounters[] = [];
  for (const line of text.split('\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;

    const name = line.slice(0, separator).trim();
    if (name === '' || name === 'lo') continue;

    const fields = line
      .slice(separator + 1)
      .trim()
      .split(/\s+/)
      .map(Number);
    // Receive occupies the first 8 columns, transmit starts at the 9th.
    const rxBytes = fields[0];
    const txBytes = fields[8];
    if (rxBytes === undefined || txBytes === undefined) continue;
    if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue;

    interfaces.push({ name, rxBytes, txBytes });
  }
  return interfaces;
}

/**
 * Names the interface holding the default route, from `/proc/net/route`.
 *
 * This is the one number an operator needs when asking "how much of my uplink is
 * already in use". Without it the panel would have to guess between `eth0`,
 * `docker0` and a dozen `veth`s — and on this host container traffic crosses a
 * bridge, so guessing wrong double-counts it.
 *
 * Returns `null` rather than a guess when there is no default route.
 */
export function parseDefaultRouteInterface(text: string): string | null {
  for (const line of text.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    const name = fields[0];
    // Destination is a little-endian hex address; all zeroes is 0.0.0.0/0.
    if (name !== undefined && fields[1] === '00000000') return name;
  }
  return null;
}

export type DiskCounters = {
  name: string;
  readBytes: number;
  writeBytes: number;
  /** Milliseconds with at least one request in flight, cumulative. */
  busyMs: number;
};

/**
 * Whole block devices worth charting.
 *
 * Partitions are excluded because their counters are already inside the parent
 * device's, and charting both would show the same I/O twice. `loop*` and `dm-*`
 * are excluded as views onto storage counted elsewhere.
 */
const WHOLE_DISK = /^(?:sd[a-z]+|nvme\d+n\d+|vd[a-z]+|xvd[a-z]+|hd[a-z]+)$/;

/**
 * Reads `/proc/diskstats`.
 *
 * Sector counts are converted with a fixed 512 bytes. That is not an assumption
 * about the hardware: this file reports in 512-byte units by definition,
 * whatever the drive's physical sector size.
 */
export function parseDiskStats(text: string): DiskCounters[] {
  const disks: DiskCounters[] = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    const name = fields[2];
    if (name === undefined || !WHOLE_DISK.test(name)) continue;

    const sectorsRead = Number(fields[5]);
    const sectorsWritten = Number(fields[9]);
    const busyMs = Number(fields[12]);
    if (![sectorsRead, sectorsWritten, busyMs].every(Number.isFinite)) continue;

    disks.push({
      name,
      readBytes: sectorsRead * 512,
      writeBytes: sectorsWritten * 512,
      busyMs,
    });
  }
  return disks;
}

export type LoadAverage = { load1: number; load5: number; load15: number };

export function parseLoadAvg(text: string): LoadAverage {
  const fields = text.trim().split(/\s+/).slice(0, 3).map(Number);
  if (fields.length < 3 || fields.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new ProcParseError('loadavg');
  }
  return { load1: fields[0] as number, load5: fields[1] as number, load15: fields[2] as number };
}

/** Seconds since boot, from the first field of `/proc/uptime`. */
export function parseUptime(text: string): number {
  const field = text.trim().split(/\s+/)[0];
  // The empty check is not redundant: `Number('')` is 0, so an empty or truncated
  // read would otherwise parse cleanly into "this machine just booted" — a claim,
  // where the truth is that nothing was read.
  if (field === undefined || field === '') throw new ProcParseError('uptime');

  const seconds = Number(field);
  if (!Number.isFinite(seconds) || seconds < 0) throw new ProcParseError('uptime');
  return seconds;
}
