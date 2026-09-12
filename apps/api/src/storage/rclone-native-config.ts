import { randomUUID } from 'node:crypto';
import { lstatSync, renameSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { z } from 'zod';
import type { ProcessResult, ProcessSpec } from './process-runner.js';
import {
  hasCode,
  parseRcloneConfig,
  prepareRcloneConfigSwap,
  readRcloneConfig,
  RcloneConfigError,
  sectionIdentity,
  setRcloneToken,
  syncConfigDirectory,
  syncPrivateFile,
  withRcloneConfigLock,
  type RcloneSections,
} from './rclone-config-files.js';

export type NativeCredentialBinding = { alias: string; connectionId: string };
export type NativeTokenChange = { alias: string; previous: string; next: string };
export type NativeAuthorityContext = {
  source: string;
  sections: RcloneSections;
  aliases: readonly string[];
  bindings: readonly NativeCredentialBinding[];
};
export interface NativeConfigAuthority {
  capture(context: NativeAuthorityContext): Record<string, unknown>;
  validate?(guards: Record<string, unknown>): void;
  persistenceFailed?(guards: Record<string, unknown>): void;
  commit(
    input: {
      guards: Record<string, unknown>;
      changes: readonly NativeTokenChange[];
      current: RcloneSections;
    },
    publish: () => void,
  ): Record<string, unknown>;
}
export type NativeConfigOptions = {
  authority?: NativeConfigAuthority;
  pollMs?: number;
  /** Testable process-liveness boundary. An ambiguous live PID is never stolen. */
  isProcessAlive?: (pid: number) => boolean;
};

const JournalSchema = z
  .object({
    version: z.literal(2),
    id: z.string().uuid(),
    source: z.string().min(1).max(4096),
    ownerPid: z.number().int().positive(),
    childPid: z.number().int().positive().nullable(),
    state: z.enum(['PREPARED', 'RUNNING', 'EXITED', 'RETRY']),
    baseline: z.string().max(4 * 1024 * 1024),
    aliases: z.array(z.string().regex(/^[A-Za-z0-9_-]+$/)).max(4096),
    guards: z.record(z.unknown()),
    nativeSaveFailed: z.boolean().default(false),
  })
  .strict();
type Journal = z.infer<typeof JournalSchema>;
const TOKEN = z
  .object({
    access_token: z.string().min(1).max(16_384),
    refresh_token: z.string().max(16_384).optional(),
    expiry: z.string().max(80),
    token_type: z.string().max(80).optional(),
  })
  .passthrough();
export function nativeToken(value: string): {
  accessToken: string;
  refreshToken: string | undefined;
  expiresAt: number;
} {
  let parsed: z.infer<typeof TOKEN>;
  try {
    parsed = TOKEN.parse(JSON.parse(value));
  } catch {
    throw new RcloneConfigError('RCLONE_CONFIG_TOKEN_INVALID');
  }
  const expiresAt = Date.parse(parsed.expiry);
  if (!Number.isSafeInteger(expiresAt)) throw new RcloneConfigError('RCLONE_CONFIG_TOKEN_INVALID');
  return { accessToken: parsed.access_token, refreshToken: parsed.refresh_token, expiresAt };
}
function tokenEqual(left: string | undefined, right: string | undefined): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  try {
    return JSON.stringify(nativeToken(left)) === JSON.stringify(nativeToken(right));
  } catch {
    return false;
  }
}
function configArgument(args: readonly string[]): number | null {
  let found: number | null = null;
  for (let index = 0; index < args.length && args[index] !== '--'; index += 1) {
    if (args[index] !== '--config') continue;
    if (found !== null || typeof args[index + 1] !== 'string' || args[index + 1]!.length === 0)
      throw new RcloneConfigError('RCLONE_CONFIG_ARGUMENT_INVALID');
    found = ++index;
  }
  return found;
}
function normalizedArguments(args: readonly string[]): string[] {
  const result: string[] = [];
  let positional = false;
  for (const argument of args) {
    if (argument === '--') positional = true;
    if (!positional && argument.startsWith('--config='))
      result.push('--config', argument.slice('--config='.length));
    else result.push(argument);
  }
  return result;
}
function nativeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Rclone environment options override file values. A private config is not
  // an authority boundary if inherited token/remote options can bypass it.
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key]) =>
        !key.toUpperCase().startsWith('RCLONE_') && key.toUpperCase() !== 'PTVAULT_MASTER_KEY',
    ),
  );
}
function nativeDiagnostic(line: string): string {
  // Newly-issued tokens can be logged before they are written to disk. Avoid a
  // blacklist of known secrets: publish only fixed diagnostics + numeric stats.
  let value: unknown;
  try {
    value = JSON.parse(line.replace(/("(?:bytes|totalBytes)"\s*:\s*)(-?[0-9]+)/g, '$1"$2"'));
  } catch {
    return '{"msg":"RCLONE_NATIVE_DIAGNOSTIC"}';
  }
  const result: Record<string, unknown> = { msg: 'RCLONE_NATIVE_DIAGNOSTIC' };
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.level === 'string' &&
      [
        'debug',
        'info',
        'notice',
        'warning',
        'error',
        'critical',
        'DEBUG',
        'INFO',
        'NOTICE',
        'WARNING',
        'ERROR',
        'CRITICAL',
      ].includes(entry.level)
    )
      result.level = entry.level;
    if ('stats' in entry) {
      const stats =
        entry.stats !== null && typeof entry.stats === 'object'
          ? (entry.stats as Record<string, unknown>)
          : {};
      const numeric: Record<string, string | number | null> = { bytes: null };
      for (const key of ['bytes', 'totalBytes'])
        if (typeof stats[key] === 'string' && /^(?:0|[1-9][0-9]{0,29})$/.test(stats[key]))
          numeric[key] = stats[key];
      for (const key of ['speed', 'transfers', 'checks', 'errors', 'elapsedTime'])
        if (typeof stats[key] === 'number' && Number.isFinite(stats[key]) && stats[key] >= 0)
          numeric[key] = stats[key];
      result.stats = numeric;
    }
  }
  return JSON.stringify(result);
}
function nativeSaveFailure(line: string): boolean {
  // Primary rclone fs/config.SaveConfig logs this failure and returns void.
  return /Failed to save config after \d+ tries:|couldn't store token:/i.test(line);
}
function usedAliases(args: readonly string[], sections: RcloneSections): string[] {
  const names = new Set<string>();
  const visit = (name: string): void => {
    if (names.has(name) || !sections.has(name)) return;
    names.add(name);
    const parent = /^([A-Za-z0-9_-]+):/.exec(sections.get(name)?.get('remote') ?? '');
    if (parent !== null) visit(parent[1]!);
  };
  for (const argument of args.slice(0, args.includes('--') ? args.indexOf('--') : args.length)) {
    const name = /^([A-Za-z0-9_-]+):/.exec(argument);
    if (name !== null) visit(name[1]!);
  }
  return [...names].sort();
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, 'ESRCH');
  }
}
async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
  )
    throw new RcloneConfigError('RCLONE_CONFIG_PRIVATE_DIRECTORY_INVALID');
}
async function saveJournal(directory: string, journal: Journal): Promise<void> {
  const temporary = path.join(directory, `${randomUUID()}.journal-swap`);
  await writeFile(temporary, JSON.stringify(journal), { flag: 'wx', mode: 0o600 });
  await syncPrivateFile(temporary);
  await rename(temporary, path.join(directory, 'journal.json'));
  syncConfigDirectory(directory);
}
function saveJournalSync(directory: string, journal: Journal): void {
  const temporary = path.join(directory, `${randomUUID()}.journal-swap`);
  writeFileSync(temporary, JSON.stringify(journal), { flag: 'wx', mode: 0o600, flush: true });
  renameSync(temporary, path.join(directory, 'journal.json'));
  syncConfigDirectory(directory);
}

function closeOwner(owner: Database.Database): void {
  try {
    if (owner.inTransaction) owner.exec('ROLLBACK');
  } finally {
    owner.close();
  }
}
async function createOwner(directory: string): Promise<Database.Database> {
  const filename = path.join(directory, 'owner.sqlite3');
  await writeFile(filename, '', { flag: 'wx', mode: 0o600 });
  await syncPrivateFile(filename);
  const owner = new Database(filename, { timeout: 0 });
  try {
    owner.exec('BEGIN IMMEDIATE');
    return owner;
  } catch (error) {
    owner.close();
    throw error;
  }
}
function ownerIsLive(directory: string): boolean {
  const filename = path.join(directory, 'owner.sqlite3');
  const info = lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    throw new RcloneConfigError('RCLONE_CONFIG_OWNER_INVALID');
  const owner = new Database(filename, { fileMustExist: true, timeout: 0 });
  try {
    try {
      owner.exec('BEGIN IMMEDIATE');
      return false;
    } catch (error) {
      if (hasCode(error, 'SQLITE_BUSY')) return true;
      throw error;
    }
  } finally {
    closeOwner(owner);
  }
}

class NativeConfigLease {
  readonly configPath: string;
  constructor(
    readonly directory: string,
    readonly journal: Journal,
    private readonly authority?: NativeConfigAuthority,
    private owner?: Database.Database,
  ) {
    this.configPath = path.join(directory, 'rclone.conf');
  }
  observeSpawn(pid: number | undefined): void {
    this.journal.state = 'RUNNING';
    this.journal.childPid = pid !== undefined && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    saveJournalSync(this.directory, this.journal);
  }
  async exited(): Promise<void> {
    this.journal.state = 'EXITED';
    await saveJournal(this.directory, this.journal);
  }
  async retryable(): Promise<void> {
    try {
      this.journal.state = 'RETRY';
      await saveJournal(this.directory, this.journal);
    } finally {
      this.releaseOwner();
    }
  }
  private releaseOwner(): void {
    const owner = this.owner;
    this.owner = undefined;
    if (owner !== undefined) closeOwner(owner);
  }
  async persistenceFailed(): Promise<void> {
    this.journal.nativeSaveFailed = true;
    this.authority?.persistenceFailed?.(this.journal.guards);
    await saveJournal(this.directory, this.journal);
  }
  async publish(alreadyLocked = false): Promise<void> {
    const native = await readRcloneConfig(this.configPath);
    const before = parseRcloneConfig(this.journal.baseline);
    const after = parseRcloneConfig(native);
    if (before.size !== after.size)
      throw new RcloneConfigError('RCLONE_CONFIG_MUTATION_UNEXPECTED');
    const changes: NativeTokenChange[] = [];
    for (const [alias, fields] of before) {
      const next = after.get(alias);
      if (next === undefined || sectionIdentity(fields) !== sectionIdentity(next))
        throw new RcloneConfigError('RCLONE_CONFIG_MUTATION_UNEXPECTED');
      if (tokenEqual(fields.get('token'), next.get('token'))) continue;
      if (
        !this.journal.aliases.includes(alias) ||
        fields.get('token') === undefined ||
        next.get('token') === undefined
      )
        throw new RcloneConfigError('RCLONE_CONFIG_MUTATION_UNEXPECTED');
      const token = nativeToken(next.get('token')!);
      if (token.expiresAt <= Date.now()) {
        const previous = nativeToken(fields.get('token')!);
        // oauthutil.TokenSource.Expire persists an expiry-only invalidation
        // before fetching a new token. It changes no credential: keep observing
        // the private file, without publishing an expired value or aborting the
        // refresh in the middle. A changed access/refresh token must be valid.
        if (
          token.accessToken === previous.accessToken &&
          token.refreshToken === previous.refreshToken
        )
          continue;
        throw new RcloneConfigError('RCLONE_CONFIG_TOKEN_INVALID');
      }
      changes.push({ alias, previous: fields.get('token')!, next: next.get('token')! });
    }
    if (changes.length === 0) {
      this.authority?.validate?.(this.journal.guards);
      return;
    }
    const publishTo = async (source: string): Promise<void> => {
      let stale: RcloneConfigError | undefined;
      // A cross-account command can refresh more than one provider. Reconcile
      // each independently before reporting any stale authority: revoking B
      // must not discard A's only new refresh token as collateral damage.
      for (const change of changes) {
        try {
          const current = await readRcloneConfig(source);
          const sections = parseRcloneConfig(current);
          const currentFields = sections.get(change.alias);
          const old = before.get(change.alias)!;
          if (
            currentFields === undefined ||
            sectionIdentity(currentFields) !== sectionIdentity(old)
          ) {
            throw new RcloneConfigError('RCLONE_CONFIG_AUTHORITY_STALE');
          }
          if (
            !tokenEqual(currentFields.get('token'), change.previous) &&
            !tokenEqual(currentFields.get('token'), change.next)
          ) {
            // A different live writer won the token CAS. Never overwrite that
            // token or silently accept this child's result. Only a same-identity
            // collision may be retried by an idempotent caller with a NEW lease;
            // provider/crypt/binding/revocation changes remain hard stale fences.
            for (const alias of this.journal.aliases) {
              const canonical = sections.get(alias),
                original = before.get(alias);
              if (
                canonical === undefined ||
                original === undefined ||
                sectionIdentity(canonical) !== sectionIdentity(original)
              )
                throw new RcloneConfigError('RCLONE_CONFIG_AUTHORITY_STALE');
            }
            if (
              Object.keys(this.journal.guards).length > 0 &&
              this.authority?.validate === undefined
            )
              throw new RcloneConfigError('RCLONE_CONFIG_AUTHORITY_STALE');
            this.authority?.validate?.(this.journal.guards);
            nativeToken(currentFields.get('token') ?? '');
            throw new RcloneConfigError('RCLONE_CONFIG_TOKEN_SUPERSEDED');
          }
          const replacement = setRcloneToken(current, change.alias, change.next);
          const swap = await prepareRcloneConfigSwap(source, replacement, current);
          try {
            if (this.authority === undefined) {
              if (Object.keys(this.journal.guards).length > 0)
                throw new RcloneConfigError('RCLONE_CONFIG_DB_AUTHORITY_REQUIRED');
              swap.apply();
            } else {
              const guards = this.authority.commit(
                {
                  guards: { [change.alias]: this.journal.guards[change.alias] },
                  changes: [change],
                  current: sections,
                },
                () => swap.apply(),
              );
              this.journal.guards = { ...this.journal.guards, ...guards };
            }
          } finally {
            await swap.dispose();
          }
          // Observe native-to-native deltas, NOT other writers' shared values.
          // Checkpoint each committed alias so a later IO failure is replayable.
          this.journal.baseline = setRcloneToken(this.journal.baseline, change.alias, change.next);
          await saveJournal(this.directory, this.journal);
        } catch (error) {
          if (
            !(error instanceof RcloneConfigError) ||
            !['RCLONE_CONFIG_AUTHORITY_STALE', 'RCLONE_CONFIG_TOKEN_SUPERSEDED'].includes(
              error.code,
            )
          )
            throw error;
          // A hard identity fence must not be hidden by another alias's
          // recoverable token collision in the same cross-account command.
          if (stale?.code !== 'RCLONE_CONFIG_AUTHORITY_STALE') stale = error;
        }
      }
      if (stale !== undefined) throw stale;
      this.authority?.validate?.(this.journal.guards);
    };
    if (alreadyLocked) await publishTo(this.journal.source);
    else await withRcloneConfigLock(this.journal.source, publishTo);
  }
  async dispose(alreadyLocked = false): Promise<void> {
    const dispose = async (): Promise<void> => {
      this.releaseOwner();
      const root = `${this.journal.source}.ptvault-native`;
      if (
        path.dirname(this.directory) !== root ||
        path.basename(this.directory) !== this.journal.id ||
        lstatSync(this.directory).isSymbolicLink()
      )
        throw new RcloneConfigError('RCLONE_CONFIG_PRIVATE_DIRECTORY_INVALID');
      await rm(this.directory, { recursive: true, force: false });
    };
    try {
      if (alreadyLocked) await dispose();
      else await withRcloneConfigLock(this.journal.source, dispose);
    } finally {
      this.releaseOwner();
    }
  }
}

/** Every real ProcessRunner --config invocation enters here, including streams.
 * The writable child file is never the canonical config, even during shutdown. */
export class NativeRcloneConfigCoordinator {
  private readonly pollMs: number;
  private readonly isAlive: (pid: number) => boolean;
  constructor(private readonly options: NativeConfigOptions = {}) {
    this.pollMs = options.pollMs ?? 1000;
    if (!Number.isSafeInteger(this.pollMs) || this.pollMs < 1)
      throw new RcloneConfigError('RCLONE_CONFIG_POLL_INVALID');
    this.isAlive = options.isProcessAlive ?? alive;
  }
  private async prepare(spec: ProcessSpec, index: number): Promise<NativeConfigLease> {
    const source = await realpath(spec.args[index]!);
    await this.recover(source);
    return withRcloneConfigLock(source, async () => {
      spec.signal?.throwIfAborted();
      const baseline = await readRcloneConfig(source);
      const sections = parseRcloneConfig(baseline);
      const aliases = usedAliases(spec.args, sections);
      const guards =
        this.options.authority?.capture({
          source,
          sections,
          aliases,
          bindings: spec.rcloneCredentialBindings ?? [],
        }) ?? {};
      const root = `${source}.ptvault-native`;
      await privateDirectory(root);
      const id = randomUUID();
      const directory = path.join(root, id);
      await mkdir(directory, { mode: 0o700 });
      const journal: Journal = {
        version: 2,
        id,
        source,
        ownerPid: process.pid,
        childPid: null,
        state: 'PREPARED',
        baseline,
        aliases,
        guards,
        nativeSaveFailed: false,
      };
      // This is a PRIVATE per-invocation ownership handle, not the shared
      // publication lock. It serializes no uploads. OS release after a crash
      // distinguishes the actual owner from an unrelated reused PID.
      const owner = await createOwner(directory);
      const lease = new NativeConfigLease(directory, journal, this.options.authority, owner);
      try {
        await writeFile(lease.configPath, baseline, { flag: 'wx', mode: 0o600 });
        await syncPrivateFile(lease.configPath);
        await saveJournal(directory, journal);
        syncConfigDirectory(root);
        syncConfigDirectory(path.dirname(root));
        return lease;
      } catch (error) {
        await lease.dispose(true).catch(() => undefined);
        throw error;
      }
    });
  }
  async recover(filename: string): Promise<void> {
    try {
      await this.recoverWithCandidates(filename);
    } catch (error) {
      throw error instanceof RcloneConfigError
        ? error
        : new RcloneConfigError('RCLONE_CONFIG_RECOVERY_FAILED');
    }
  }
  private async recoverWithCandidates(filename: string): Promise<void> {
    const source = await realpath(filename);
    await this.recoverSource(source);
    // Candidate identity is encoded by the provision adapter's owned filename.
    // Restart recovery cannot depend on that adapter's former in-memory map.
    if (/\.ptvault-candidate-[0-9a-f-]{36}$/i.test(source)) return;
    const prefix = `.${path.basename(source)}.ptvault-candidate-`;
    const suffix = '.ptvault-native';
    for (const name of await readdir(path.dirname(source))) {
      if (
        !name.startsWith(prefix) ||
        !name.endsWith(suffix) ||
        !/^[0-9a-f-]{36}$/i.test(name.slice(prefix.length, -suffix.length))
      )
        continue;
      const root = path.join(path.dirname(source), name);
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new RcloneConfigError('RCLONE_CONFIG_PRIVATE_DIRECTORY_INVALID');
      if ((await readdir(root)).length === 0) continue;
      const candidate = root.slice(0, -suffix.length);
      try {
        await this.recoverSource(await realpath(candidate));
      } catch (error) {
        // A concurrent successful candidate cleanup may have finished between
        // discovery and realpath. Non-empty orphan journals are never erased.
        if (hasCode(error, 'ENOENT') && (await readdir(root)).length === 0) continue;
        throw error;
      }
    }
  }
  private async recoverSource(source: string): Promise<void> {
    const root = `${source}.ptvault-native`;
    let names: string[];
    try {
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new RcloneConfigError('RCLONE_CONFIG_PRIVATE_DIRECTORY_INVALID');
      names = await readdir(root);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return;
      throw error;
    }
    for (const name of names) {
      if (!/^[0-9a-f-]{36}$/i.test(name)) continue;
      // Claim/read/publish/dispose share one short mutex. Two recovering API /
      // mount processes cannot replay the same journal or remove a live owner's
      // EXITED journal between its final publish and cleanup.
      await withRcloneConfigLock(source, async () => {
        const directory = path.join(root, name);
        let journal: Journal;
        try {
          const directoryInfo = await lstat(directory);
          if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
            throw new RcloneConfigError('RCLONE_CONFIG_PRIVATE_DIRECTORY_INVALID');
          const filename = path.join(directory, 'journal.json');
          const info = await lstat(filename);
          if (!info.isFile() || info.isSymbolicLink() || info.size > 12 * 1024 * 1024)
            throw new RcloneConfigError('RCLONE_CONFIG_JOURNAL_INVALID');
          journal = JournalSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
        } catch (error) {
          if (hasCode(error, 'ENOENT')) return;
          throw new RcloneConfigError('RCLONE_CONFIG_JOURNAL_INVALID');
        }
        if (journal.id !== name || journal.source !== source)
          throw new RcloneConfigError('RCLONE_CONFIG_JOURNAL_INVALID');
        if (ownerIsLive(directory)) return;
        if (
          journal.state !== 'EXITED' &&
          journal.state !== 'RETRY' &&
          (journal.childPid === null || this.isAlive(journal.childPid))
        )
          throw new RcloneConfigError('RCLONE_CONFIG_ORPHAN_DRAIN_REQUIRED');
        const lease = new NativeConfigLease(directory, journal, this.options.authority);
        try {
          if (journal.nativeSaveFailed) {
            this.options.authority?.validate?.(journal.guards);
            throw new RcloneConfigError('RCLONE_CONFIG_NATIVE_SAVE_FAILED');
          }
          await lease.publish(true);
        } catch (error) {
          if (
            !(error instanceof RcloneConfigError) ||
            !['RCLONE_CONFIG_AUTHORITY_STALE', 'RCLONE_CONFIG_TOKEN_SUPERSEDED'].includes(
              error.code,
            )
          )
            throw error;
        }
        await lease.dispose(true);
      });
    }
  }
  async run(
    spec: ProcessSpec,
    invoke: (privateSpec: ProcessSpec) => Promise<ProcessResult>,
  ): Promise<ProcessResult> {
    spec = { ...spec, args: normalizedArguments(spec.args) };
    const index = configArgument(spec.args);
    if (index === null) return invoke(spec);
    let lease: NativeConfigLease;
    try {
      lease = await this.prepare(spec, index);
    } catch (error) {
      if (spec.signal?.aborted && error === spec.signal.reason) throw error;
      throw error instanceof RcloneConfigError
        ? error
        : new RcloneConfigError('RCLONE_CONFIG_PREPARE_FAILED');
    }
    const controller = new AbortController();
    const polling = new AbortController();
    const signal =
      spec.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, spec.signal]);
    const args = [...spec.args];
    args[index] = lease.configPath;
    let fault: unknown;
    const poll = (async () => {
      while (!polling.signal.aborted) {
        try {
          await delay(this.pollMs, undefined, { signal: polling.signal, ref: false });
        } catch {
          return;
        }
        try {
          await lease.publish();
        } catch (error) {
          fault = error;
          controller.abort(new RcloneConfigError('RCLONE_CONFIG_COORDINATION_FAILED'));
          return;
        }
      }
    })();
    let result: ProcessResult | undefined;
    let processError: unknown;
    try {
      spec.signal?.throwIfAborted();
      result = await invoke({
        ...spec,
        args,
        signal,
        env: nativeEnvironment(spec.env ?? process.env),
        onSpawn: (pid) => {
          try {
            lease.observeSpawn(pid);
            spec.onSpawn?.(pid);
          } catch (error) {
            fault = error;
            controller.abort(new RcloneConfigError('RCLONE_CONFIG_JOURNAL_FAILED'));
          }
        },
        onStderrLine: (line: string) => {
          if (nativeSaveFailure(line)) {
            fault ??= new RcloneConfigError('RCLONE_CONFIG_NATIVE_SAVE_FAILED');
            controller.abort(fault);
          }
          spec.onStderrLine?.(nativeDiagnostic(line));
        },
      });
    } catch (error) {
      processError = error;
    }
    polling.abort();
    await poll;
    try {
      await lease.exited();
      await lease.publish();
    } catch (error) {
      fault ??= error;
    }
    if (result !== undefined && nativeSaveFailure(result.stderr))
      fault ??= new RcloneConfigError('RCLONE_CONFIG_NATIVE_SAVE_FAILED');
    if (fault instanceof RcloneConfigError && fault.code === 'RCLONE_CONFIG_NATIVE_SAVE_FAILED') {
      try {
        await lease.persistenceFailed();
      } catch {
        /* Retain the journal and the original explicit save failure. */
      }
    }
    if (
      fault === undefined ||
      (fault instanceof RcloneConfigError &&
        ['RCLONE_CONFIG_AUTHORITY_STALE', 'RCLONE_CONFIG_TOKEN_SUPERSEDED'].includes(fault.code))
    ) {
      try {
        await lease.dispose();
      } catch {
        throw new RcloneConfigError('RCLONE_CONFIG_CLEANUP_FAILED');
      }
    } else await lease.retryable().catch(() => undefined); // EXITED still recovers after the owner exits if storage is unavailable.
    if (fault !== undefined)
      throw fault instanceof RcloneConfigError
        ? fault
        : new RcloneConfigError('RCLONE_CONFIG_COORDINATION_FAILED');
    if (processError !== undefined) {
      if (spec.signal?.aborted) throw spec.signal.reason;
      throw new RcloneConfigError('RCLONE_NATIVE_PROCESS_FAILED');
    }
    if (result === undefined) throw new RcloneConfigError('RCLONE_NATIVE_PROCESS_FAILED');
    return {
      ...result,
      stderr: result.stderr.split(/\r?\n/).filter(Boolean).map(nativeDiagnostic).join('\n'),
    };
  }
  stream(
    spec: ProcessSpec,
    invoke: (privateSpec: ProcessSpec) => { stream: Readable; completed: Promise<ProcessResult> },
  ): { stream: Readable; completed: Promise<ProcessResult> } {
    if (configArgument(normalizedArguments(spec.args)) === null) return invoke(spec);
    const output = new PassThrough();
    output.on('error', () => undefined);
    const completed = this.run(spec, async (privateSpec) => {
      const child = invoke(privateSpec);
      child.stream.on('error', () =>
        output.destroy(new RcloneConfigError('RCLONE_NATIVE_PROCESS_FAILED')),
      );
      child.stream.pipe(output, { end: false });
      return child.completed;
    }).then(
      (result) => {
        output.end();
        return result;
      },
      (error: unknown) => {
        output.destroy(
          error instanceof Error ? error : new RcloneConfigError('RCLONE_NATIVE_PROCESS_FAILED'),
        );
        throw error;
      },
    );
    // Consumers usually drain stdout before awaiting completion; retain rejection
    // for that await without creating an unhandled-rejection window.
    void completed.catch(() => undefined);
    return { stream: output, completed };
  }
}
