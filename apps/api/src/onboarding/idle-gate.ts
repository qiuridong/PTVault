import { readFileSync, readdirSync } from 'node:fs';
import type { SetupValues } from '@ptvault/contracts';
import type { AppDatabase } from '../db/database.js';
import { parseUnifiedCgroup } from '../system/pipeline-pressure.js';

export function readSetupIdle(input: { db: AppDatabase; activeHandlers: number; activeMutations: number; childrenIdle: boolean | null; relocatingPaths: boolean }) {
  const any = (sql: string) => Number(input.db.prepare(sql).pluck().get()) > 0;
  const nonterminal = any("SELECT COUNT(*) FROM jobs WHERE state NOT IN ('COMPLETED','FAILED_SAFE','CANCELLED_SAFE')") ||
    any("SELECT COUNT(*) FROM import_jobs WHERE state NOT IN ('COMPLETED','FAILED_SAFE','CANCELLED_SAFE')") ||
    any("SELECT COUNT(*) FROM media_publications WHERE state='RUNNING'") ||
    any("SELECT COUNT(*) FROM source_cleanups WHERE status='RUNNING'");
  const retainedWork = any("SELECT COUNT(*) FROM import_pipeline_groups WHERE admission IN ('ADMITTED','CACHED','EVICTING') OR resident_bytes <> '0'") ||
    any("SELECT COUNT(*) FROM archive_inputs WHERE state IN ('DOWNLOADING','READY')") ||
    any("SELECT COUNT(*) FROM archive_imports WHERE phase IN ('EXTRACTING','PREPARING_VIDEOS','READY')") ||
    any("SELECT COUNT(*) FROM import_objects WHERE state NOT IN ('DISCOVERED','SOURCE_PREFLIGHT','SPOOL_CLEANED','COMPLETED')") ||
    any("SELECT COUNT(*) FROM import_spool_reservations WHERE reserved_bytes <> '0'");
  return { nonterminal, retainedWork, idle: !nonterminal && (!input.relocatingPaths || !retainedWork) && input.activeHandlers === 0 && input.activeMutations === 0 && input.childrenIdle === true };
}

export function changesDataLocations(before: SetupValues, after: SetupValues): boolean {
  return before.spoolRoot !== after.spoolRoot || before.mediaHotRoot !== after.mediaHotRoot ||
    JSON.stringify(before.sourceRoots) !== JSON.stringify(after.sourceRoots) ||
    JSON.stringify(before.jellyfinPathMaps) !== JSON.stringify(after.jellyfinPathMaps) ||
    (before.useCases.includes('NETDISK') && !after.useCases.includes('NETDISK')) ||
    (before.useCases.includes('PT_OFFLOAD') && !after.useCases.includes('PT_OFFLOAD')) ||
    (before.useCases.includes('JELLYFIN') && !after.useCases.includes('JELLYFIN'));
}

/** The public unit owns a dedicated systemd cgroup; never inspect argv or environment. */
export function managedChildrenIdle(): boolean | null {
  if (process.platform !== 'linux') return null;
  try {
    const directory = parseUnifiedCgroup(readFileSync('/proc/self/cgroup', 'utf8'));
    if (!directory || !/\/ptvault-public\.service$/.test(directory)) return null;
    // Child cgroups are unsupported by this non-delegated unit; fail closed if present.
    if (readdirSync(directory, { withFileTypes: true }).some((entry) => entry.isDirectory())) return null;
    const pids = readFileSync(`${directory}/cgroup.procs`, 'utf8').trim().split(/\s+/);
    if (!pids.every((pid) => /^[1-9][0-9]*$/.test(pid))) return null;
    return pids.length === 1 && pids[0] === String(process.pid);
  } catch { return null; }
}
