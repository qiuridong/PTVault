import { z } from 'zod';
import { ProcessRunner, type CommandRunner } from '../storage/process-runner.js';
import type { QuotaSnapshot } from '../storage/health.js';

/** FILE-only native authority. Never pass the user's original config here. */
export function createRcloneImportProbe(
  executable: string,
  runner: CommandRunner = new ProcessRunner(),
) {
  return async (
    configPath: string,
    rawRemote: string,
    cryptRemote: string,
  ): Promise<QuotaSnapshot> => {
    await runner.recoverRcloneConfig?.(configPath);
    const signal = AbortSignal.timeout(45_000);
    const common = { executable, signal, env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } };
    const about = await runner.run(
      { ...common, args: ['--config', configPath, 'about', '--json', rawRemote] },
      65536,
    );
    if (about.exitCode !== 0) throw new Error('RCLONE_IMPORT_PROBE_FAILED');
    const value = z
      .object({
        total: z.number().int().nonnegative().safe().optional(),
        free: z.number().int().nonnegative().safe().optional(),
      })
      .passthrough()
      .parse(JSON.parse(about.stdout.toString('utf8')));
    const root = await runner.run(
      { ...common, args: ['--config', configPath, 'lsjson', '--stat', cryptRemote] },
      65536,
    );
    if (
      root.exitCode !== 0 ||
      z
        .object({ IsDir: z.literal(true) })
        .passthrough()
        .safeParse(JSON.parse(root.stdout.toString('utf8'))).success === false
    )
      throw new Error('RCLONE_IMPORT_PROBE_FAILED');
    return { total: value.total ?? null, free: value.free ?? null };
  };
}
