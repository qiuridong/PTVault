import { readFile } from 'node:fs/promises';
import type { PipelineMetrics } from '@ptvault/contracts';

export function parsePressure(text: string): { some: number | null; full: number | null } {
  const value = (kind: string) => {
    const match = new RegExp(`^${kind}\\s+avg10=(\\d+(?:\\.\\d+)?)\\s`, 'm').exec(text);
    const number = match?.[1] === undefined ? NaN : Number(match[1]);
    return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null;
  };
  return { some: value('some'), full: value('full') };
}
export function parseUnifiedCgroup(text: string): string | null {
  const path = /^0::(\/[^\r\n]*)$/m.exec(text)?.[1];
  if (
    !path ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((x) => x === '..' || x === '.')
  )
    return null;
  return `/sys/fs/cgroup${path === '/' ? '' : path}`;
}
const numberOrNull = (text: string | null) => {
  if (text === null || !/^\d+\s*$/.test(text)) return null;
  const value = Number(text.trim());
  return Number.isSafeInteger(value) ? value : null;
};
const difference = (value: number | null, before: number | null | undefined, seconds: number) =>
  value !== null && before !== null && before !== undefined && seconds > 0 && value >= before
    ? (value - before) / seconds
    : null;

/** Optional exact-file reads. No process argv, environment, path names or tokens are captured. */
export class LinuxPressureSampler {
  private readonly read: (path: string) => Promise<string>;
  private previous:
    | {
        at: number;
        path: string | null;
        cpu: number | null;
        read: number | null;
        write: number | null;
      }
    | undefined;
  constructor(options: { readFile?: (path: string) => Promise<string> } = {}) {
    this.read = options.readFile ?? ((path) => readFile(path, 'utf8'));
  }
  async sample(at: number): Promise<PipelineMetrics> {
    const optional = (path: string) => this.read(path).catch(() => null);
    const [cpu, memory, io, unified] = await Promise.all([
      optional('/proc/pressure/cpu'),
      optional('/proc/pressure/memory'),
      optional('/proc/pressure/io'),
      optional('/proc/self/cgroup'),
    ]);
    const path = parseUnifiedCgroup(unified ?? '');
    const [cpuStat, current, swap, ioStat] =
      path === null
        ? [null, null, null, null]
        : await Promise.all([
            optional(`${path}/cpu.stat`),
            optional(`${path}/memory.current`),
            optional(`${path}/memory.swap.current`),
            optional(`${path}/io.stat`),
          ]);
    const usage = numberOrNull(/^usage_usec\s+(\d+)$/m.exec(cpuStat ?? '')?.[1] ?? null);
    const ioBytes = (key: string): number | null => {
      if (ioStat === null || !ioStat.trim()) return null;
      const values = [...ioStat.matchAll(new RegExp(`(?:^|\\s)${key}=(\\d+)(?=\\s|$)`, 'g'))].map(
        (x) => Number(x[1]),
      );
      const total = values.reduce((sum, n) => sum + n, 0);
      return values.length && Number.isSafeInteger(total) ? total : null;
    };
    const read = ioBytes('rbytes'),
      write = ioBytes('wbytes');
    const before = this.previous?.path === path ? this.previous : undefined;
    const seconds = before ? (at - before.at) / 1000 : 0;
    const cpuRate = difference(usage, before?.cpu, seconds);
    this.previous = { at, path, cpu: usage, read, write };
    return {
      // System-wide CPU full is undefined; deliberately not exposed as a measurement.
      hostCpuPressureSome: parsePressure(cpu ?? '').some,
      hostMemoryPressureSome: parsePressure(memory ?? '').some,
      hostMemoryPressureFull: parsePressure(memory ?? '').full,
      hostIoPressureSome: parsePressure(io ?? '').some,
      hostIoPressureFull: parsePressure(io ?? '').full,
      cgroupCpuCores: cpuRate === null ? null : cpuRate / 1000000,
      cgroupMemoryBytes: numberOrNull(current),
      cgroupSwapBytes: numberOrNull(swap),
      cgroupReadBps: difference(read, before?.read, seconds),
      cgroupWriteBps: difference(write, before?.write, seconds),
    };
  }
}
