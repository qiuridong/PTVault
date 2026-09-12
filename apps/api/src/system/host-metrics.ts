import { readFile } from 'node:fs/promises';

import type { HostDisk, HostInterface, HostSample, SystemMetrics } from '@ptvault/contracts';

import {
  parseDefaultRouteInterface,
  parseDiskStats,
  parseLoadAvg,
  parseMemInfo,
  parseNetDev,
  parseProcStat,
  parseUptime,
  type CpuCounters,
  type DiskCounters,
  type InterfaceCounters,
} from './proc.js';

export type ProcReader = (path: string) => Promise<string>;
export type HostMetricsSleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export const DEFAULT_SAMPLE_INTERVAL_MS = 10_000;
/** 180 samples × 10 s = 30 minutes, which is the window the panel draws. */
export const DEFAULT_HISTORY_LENGTH = 180;
/**
 * How many interfaces the response carries.
 *
 * This host runs Docker, so it has one `veth` per container plus a bridge. All
 * of them are real interfaces, but listing thirty of them would bury the uplink
 * — the only one whose number means anything for "can I start an upload now".
 * The uplink is always kept; the rest are the busiest by traffic, and whatever
 * is dropped is reported as a count rather than silently disappearing.
 */
export const MAX_REPORTED_INTERFACES = 6;

export type HostMetricsOptions = {
  readProcFile?: ProcReader;
  intervalMs?: number;
  historyLength?: number;
  now?: () => number;
  sleep?: HostMetricsSleep;
  onError?: (error: unknown) => void;
  /** Enqueue optional history work; never await it on the host sampler loop. */
  onSample?: (snapshot: HostSnapshot, extra: { cpuStealPercent: number | null }) => void;
};

type Counters = {
  at: number;
  cpu: CpuCounters;
  interfaces: InterfaceCounters[];
  disks: DiskCounters[];
};

/** Host view assembled from the last sample; `throughput` is added by the route. */
export type HostSnapshot = Omit<SystemMetrics, 'throughput'>;

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * A rate from two counter readings, or `null` when one cannot be derived.
 *
 * Returns `null` — never 0 — when the counter went backwards. That happens on
 * reboot and on interface re-creation, and the alternative readings are both
 * wrong in a way an operator would act on: a huge spike, or a report of "idle"
 * for a link that is saturated.
 */
function rate(current: number, previous: number, elapsedSeconds: number): number | null {
  if (elapsedSeconds <= 0) return null;
  const delta = current - previous;
  if (delta < 0) return null;
  return delta / elapsedSeconds;
}

/**
 * Samples `/proc` on a timer and keeps a short rolling history.
 *
 * The history lives here rather than in the browser because the numbers that
 * matter are rates, and a rate needs two readings separated by a known interval.
 * A client polling an instantaneous endpoint would derive them from its own
 * refresh timing, so two tabs would disagree, and a backgrounded tab — where
 * browsers throttle timers — would quietly report throughput that never happened.
 */
export class HostMetricsSampler {
  private readonly readProcFile: ProcReader;
  private readonly intervalMs: number;
  private readonly historyLength: number;
  private readonly now: () => number;
  private readonly sleep: HostMetricsSleep;
  private readonly onError: HostMetricsOptions['onError'];
  private readonly onSample: HostMetricsOptions['onSample'];

  private previous: Counters | undefined;
  private latest: HostSnapshot;
  private history: HostSample[] = [];
  private controller: AbortController | undefined;
  private loop: Promise<void> | undefined;

  constructor(options: HostMetricsOptions = {}) {
    this.readProcFile = options.readProcFile ?? ((path) => readFile(path, { encoding: 'utf8' }));
    this.intervalMs = options.intervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    this.historyLength = options.historyLength ?? DEFAULT_HISTORY_LENGTH;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? abortableSleep;
    this.onError = options.onError;
    this.onSample = options.onSample;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs < 1) {
      throw new Error('HOST_METRICS_INVALID_INTERVAL');
    }
    if (!Number.isInteger(this.historyLength) || this.historyLength < 1) {
      throw new Error('HOST_METRICS_INVALID_HISTORY');
    }
    // Starts unavailable rather than empty-but-fine: nothing has been read yet,
    // and a page rendering this before the first sample must say so.
    this.latest = this.unavailable('NOT_SAMPLED_YET');
  }

  start(): void {
    if (this.loop) return;

    const controller = new AbortController();
    this.controller = controller;
    this.loop = this.run(controller.signal).finally(() => {
      if (this.controller === controller) {
        this.loop = undefined;
        this.controller = undefined;
      }
    });
  }

  async stop(): Promise<void> {
    const loop = this.loop;
    this.controller?.abort();
    if (loop) await loop;
  }

  /** The most recent reading. Never throws: an unread host is a reportable state. */
  snapshot(): HostSnapshot {
    return { ...this.latest, history: [...this.history] };
  }

  /**
   * Reads every source once and folds it into the current view.
   *
   * A failure anywhere leaves the sampler reporting `UNAVAILABLE` with a code
   * instead of a half-filled reading. Partial host telemetry is worse than none:
   * "CPU 4%, network blank" reads as an idle machine.
   */
  async tick(): Promise<void> {
    let counters: Counters;
    let memory: SystemMetrics['memory'];
    let cpuLoad: { load1: number; load5: number; load15: number };
    let uptimeSeconds: number;
    let defaultRoute: string | null;
    let cores: number;

    try {
      const [stat, meminfo, netdev, route, diskstats, loadavg, uptime] = await Promise.all([
        this.readProcFile('/proc/stat'),
        this.readProcFile('/proc/meminfo'),
        this.readProcFile('/proc/net/dev'),
        this.readProcFile('/proc/net/route'),
        this.readProcFile('/proc/diskstats'),
        this.readProcFile('/proc/loadavg'),
        this.readProcFile('/proc/uptime'),
      ]);

      counters = {
        at: this.now(),
        cpu: parseProcStat(stat),
        interfaces: parseNetDev(netdev),
        disks: parseDiskStats(diskstats),
      };
      memory = parseMemInfo(meminfo);
      cpuLoad = parseLoadAvg(loadavg);
      uptimeSeconds = parseUptime(uptime);
      defaultRoute = parseDefaultRouteInterface(route);
      cores = countCores(stat);
    } catch (error) {
      this.previous = undefined;
      this.latest = this.unavailable(reasonFor(error));
      this.reportSample(null);
      try {
        this.onError?.(error);
      } catch {
        // A failing reporter must not stop the next sample.
      }
      return;
    }

    const previous = this.previous;
    const elapsedSeconds = previous ? (counters.at - previous.at) / 1000 : 0;

    const cpuPercent = previous ? cpuUsage(counters.cpu, previous.cpu) : null;
    const interfaces = this.foldInterfaces(counters, previous, elapsedSeconds, defaultRoute);
    const disks = foldDisks(counters, previous, elapsedSeconds);

    const uplink = interfaces.reported.find((entry) => entry.isDefaultRoute);
    const sample: HostSample = {
      at: counters.at,
      cpuPercent,
      // The history line is about the uplink, so it follows the default route
      // rather than a sum across bridges that would count container traffic twice.
      rxBytesPerSecond: uplink?.rxBytesPerSecond ?? null,
      txBytesPerSecond: uplink?.txBytesPerSecond ?? null,
      readBytesPerSecond: sumRates(disks, 'readBytesPerSecond'),
      writeBytesPerSecond: sumRates(disks, 'writeBytesPerSecond'),
    };
    this.history = [...this.history, sample].slice(-this.historyLength);

    this.latest = {
      source: 'PROC',
      unavailableReason: null,
      sampledAt: counters.at,
      sampleIntervalMs: this.intervalMs,
      uptimeSeconds,
      cpu: { cores, usagePercent: cpuPercent, ...cpuLoad },
      memory,
      interfaces: interfaces.reported,
      omittedInterfaces: interfaces.omitted,
      disks,
      history: [],
    };
    this.previous = counters;
    const totalDelta = previous ? counters.cpu.totalJiffies - previous.cpu.totalJiffies : 0;
    const stealDelta = previous ? counters.cpu.stealJiffies - previous.cpu.stealJiffies : -1;
    this.reportSample(
      totalDelta > 0 && stealDelta >= 0 ? Math.min(100, (stealDelta / totalDelta) * 100) : null,
    );
  }

  private reportSample(cpuStealPercent: number | null): void {
    try {
      this.onSample?.(this.latest, { cpuStealPercent });
    } catch {
      /* optional history */
    }
  }

  private foldInterfaces(
    counters: Counters,
    previous: Counters | undefined,
    elapsedSeconds: number,
    defaultRoute: string | null,
  ): { reported: HostInterface[]; omitted: number } {
    const all: HostInterface[] = counters.interfaces.map((entry) => {
      const before = previous?.interfaces.find((candidate) => candidate.name === entry.name);
      return {
        name: entry.name,
        isDefaultRoute: entry.name === defaultRoute,
        rxBytesPerSecond: before ? rate(entry.rxBytes, before.rxBytes, elapsedSeconds) : null,
        txBytesPerSecond: before ? rate(entry.txBytes, before.txBytes, elapsedSeconds) : null,
        rxTotalBytes: entry.rxBytes,
        txTotalBytes: entry.txBytes,
      };
    });

    // The uplink is kept whatever its traffic — a quiet uplink is exactly the
    // reading that says "now is a good time to upload".
    const uplink = all.filter((entry) => entry.isDefaultRoute);
    const rest = all
      .filter((entry) => !entry.isDefaultRoute)
      .sort(
        (left, right) =>
          right.rxTotalBytes + right.txTotalBytes - (left.rxTotalBytes + left.txTotalBytes),
      );

    const room = Math.max(0, MAX_REPORTED_INTERFACES - uplink.length);
    return {
      reported: [...uplink, ...rest.slice(0, room)],
      omitted: Math.max(0, rest.length - room),
    };
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.tick();
      if (signal.aborted) return;
      await this.sleep(this.intervalMs, signal);
    }
  }

  private unavailable(reason: string): HostSnapshot {
    return {
      source: 'UNAVAILABLE',
      unavailableReason: reason,
      sampledAt: null,
      sampleIntervalMs: this.intervalMs,
      uptimeSeconds: null,
      cpu: null,
      memory: null,
      interfaces: [],
      omittedInterfaces: 0,
      disks: [],
      history: [],
    };
  }
}

function countCores(stat: string): number {
  const cores = stat.split('\n').filter((line) => /^cpu\d+\s/.test(line)).length;
  // A kernel that reports only the aggregate line still has at least one core,
  // and reporting 0 would make "load ÷ cores" divide by zero downstream.
  return Math.max(1, cores);
}

function cpuUsage(current: CpuCounters, previous: CpuCounters): number | null {
  const total = current.totalJiffies - previous.totalJiffies;
  const idle = current.idleJiffies - previous.idleJiffies;
  if (total <= 0 || idle < 0) return null;
  return Math.min(100, Math.max(0, ((total - idle) / total) * 100));
}

function foldDisks(
  counters: Counters,
  previous: Counters | undefined,
  elapsedSeconds: number,
): HostDisk[] {
  return counters.disks.map((entry) => {
    const before = previous?.disks.find((candidate) => candidate.name === entry.name);
    const busyDelta = before ? entry.busyMs - before.busyMs : null;
    return {
      name: entry.name,
      readBytesPerSecond: before ? rate(entry.readBytes, before.readBytes, elapsedSeconds) : null,
      writeBytesPerSecond: before
        ? rate(entry.writeBytes, before.writeBytes, elapsedSeconds)
        : null,
      busyPercent:
        busyDelta === null || busyDelta < 0 || elapsedSeconds <= 0
          ? null
          : Math.min(100, (busyDelta / (elapsedSeconds * 1000)) * 100),
    };
  });
}

/** Sums a rate across disks, staying `null` while no disk has a reading yet. */
function sumRates(
  disks: HostDisk[],
  key: 'readBytesPerSecond' | 'writeBytesPerSecond',
): number | null {
  const readings = disks
    .map((disk) => disk[key])
    .filter((value): value is number => value !== null);
  return readings.length === 0 ? null : readings.reduce((sum, value) => sum + value, 0);
}

/**
 * A short code for why the read failed.
 *
 * Deliberately not the error message: those carry paths, and this response is
 * rendered in a browser. `ENOENT` on a dev box means "no /proc here", which is
 * the whole answer.
 */
function reasonFor(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  if (error instanceof Error && error.message.startsWith('PROC_PARSE_FAILED')) {
    return error.message;
  }
  return 'PROC_READ_FAILED';
}
