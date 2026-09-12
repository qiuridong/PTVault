import { lstat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { parseConfig } from './env.js';

export type ImportPreparationInput = {
  environment: NodeJS.ProcessEnv;
  expectedUid: number;
  sourceRoots?: readonly string[];
  spoolMaxBytes: string;
  hostReserveBytes: string;
};

/** Read-only preparation, never an installer, token refresher or execution gate. */
export async function inspectImportPreparation(input: ImportPreparationInput) {
  let configurationValid = false;
  let sourceRoots = input.sourceRoots ?? [];
  try {
    const parsed = parseConfig(input.environment);
    configurationValid = true;
    sourceRoots = [
      ...sourceRoots,
      ...parsed.qbAllowedRoots,
      ...(parsed.mediaHotRoot ? [parsed.mediaHotRoot] : []),
    ];
  } catch {
    // Zod/config exception messages may contain operator inputs. Never serialize them.
  }
  const required = [
    'PTVAULT_IMPORT_SECRET_ROOT',
    'PTVAULT_IMPORT_SPOOL_ROOT',
    'PTVAULT_IMPORT_RECOVERY_ACCOUNT_IDS',
    'PTVAULT_RCLONE_CONFIG',
  ];
  const missingEnvironment = required.filter((key) => !input.environment[key]);
  const legacy = ['PTVAULT_IMPORT_BAIDU_APP_CREDENTIAL_FILE', 'PTVAULT_IMPORT_BAIDU_TOKEN_FILE'];
  const oauth = [
    'PTVAULT_BAIDU_OAUTH_CLIENT_ID',
    'PTVAULT_BAIDU_OAUTH_CLIENT_SECRET',
    'PTVAULT_BAIDU_APP_ID',
    'PTVAULT_CLOUD_OAUTH_CALLBACK_ORIGIN',
  ];
  if (
    !legacy.every((key) => input.environment[key]) &&
    !oauth.every((key) => input.environment[key])
  ) {
    missingEnvironment.push('BAIDU_PROVIDER_COMPLETE_GROUP');
  }
  const issues: string[] = configurationValid ? [] : ['CANONICAL_CONFIG_REJECTED'];
  const credentialFiles: Array<{ setting: string; exists: boolean; private: boolean }> = [];
  for (const setting of ['PTVAULT_RCLONE_CONFIG', ...legacy]) {
    const file = input.environment[setting];
    if (!file) continue;
    let exists = false;
    let privateFile = false;
    try {
      const info = await lstat(file);
      exists = true;
      privateFile =
        info.isFile() &&
        !info.isSymbolicLink() &&
        process.platform !== 'win32' &&
        info.uid === input.expectedUid &&
        (info.mode & 0o077) === 0;
    } catch {
      /* No secret content is read. */
    }
    credentialFiles.push({ setting, exists, private: privateFile });
    if (!exists) issues.push('CREDENTIAL_FILE_MISSING');
    else if (!privateFile) issues.push('CREDENTIAL_FILE_NOT_PRIVATE');
  }
  const directories: Array<{
    kind: string;
    path: string;
    exists: boolean;
    uid: number | null;
    mode: string | null;
    availableBytes: string | null;
  }> = [];
  const requested = [
    { kind: 'state', path: input.environment.PTVAULT_STATE_DIR },
    { kind: 'secret', path: input.environment.PTVAULT_IMPORT_SECRET_ROOT },
    { kind: 'spool', path: input.environment.PTVAULT_IMPORT_SPOOL_ROOT },
  ];
  const overlaps = (a: string, b: string) => {
    const relative = path.relative(path.resolve(a), path.resolve(b));
    return (
      relative === '' ||
      (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
    );
  };
  for (const entry of requested) {
    if (!entry.path) continue;
    if (!path.isAbsolute(entry.path)) {
      issues.push('DIRECTORY_NOT_ABSOLUTE');
      continue;
    }
    if (sourceRoots.some((root) => overlaps(root, entry.path!) || overlaps(entry.path!, root)))
      issues.push('SOURCE_ROOT_OVERLAP');
    const row = {
      kind: entry.kind,
      path: entry.path,
      exists: false,
      uid: null as number | null,
      mode: null as string | null,
      availableBytes: null as string | null,
    };
    let candidate = entry.path;
    for (;;) {
      try {
        const info = await lstat(candidate);
        if (info.isSymbolicLink()) issues.push('DIRECTORY_SYMLINK');
        if (candidate === entry.path) {
          row.exists = true;
          row.uid = info.uid;
          row.mode = (info.mode & 0o777).toString(8);
          if (!info.isDirectory()) issues.push('NOT_A_DIRECTORY');
          if (process.platform === 'win32') issues.push('POSIX_OWNER_CHECK_REQUIRED');
          else {
            if (info.uid !== input.expectedUid) issues.push('DIRECTORY_OWNER_MISMATCH');
            if ((info.mode & 0o700) !== 0o700) issues.push('DIRECTORY_OWNER_ACCESS_MISSING');
            // Existing state may be service-group readable (0750). Do not demand
            // an unrelated permission change; new secret/spool roots stay 0700.
            if ((info.mode & (entry.kind === 'state' ? 0o027 : 0o077)) !== 0)
              issues.push('DIRECTORY_NOT_PRIVATE');
          }
        }
        if (row.availableBytes === null && info.isDirectory()) {
          const stats = await statfs(candidate, { bigint: true });
          row.availableBytes = (stats.bavail * stats.bsize).toString();
        }
      } catch {
        /* Missing parents are reported, never created. */
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
    if (!row.exists) issues.push('DIRECTORY_MISSING');
    directories.push(row);
  }
  const secret = requested[1]?.path;
  const spool = requested[2]?.path;
  if (secret && spool && (overlaps(secret, spool) || overlaps(spool, secret)))
    issues.push('SECRET_SPOOL_OVERLAP');
  if (!/^\d+$/.test(input.spoolMaxBytes) || !/^\d+$/.test(input.hostReserveBytes))
    issues.push('BUDGET_INVALID');
  else {
    const available = directories.find((row) => row.kind === 'spool')?.availableBytes;
    if (available === null || available === undefined) issues.push('SPOOL_FILESYSTEM_UNCHECKED');
    else if (BigInt(input.spoolMaxBytes) + BigInt(input.hostReserveBytes) > BigInt(available))
      issues.push('SPOOL_BUDGET_EXCEEDS_AVAILABLE');
  }
  return {
    configurationValid,
    credentialFiles,
    missingEnvironment,
    directories,
    issues: [...new Set(issues)],
    assemblyPreflightPassed:
      configurationValid && missingEnvironment.length === 0 && issues.length === 0,
    executionAuthorized: false as const,
    credentialsValidated: false as const,
  };
}
