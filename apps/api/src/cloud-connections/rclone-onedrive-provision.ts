import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  hasCode,
  RcloneConfigError,
  withRcloneConfigLock,
} from '../storage/rclone-config-files.js';

import type { CommandRunner, ProcessResult } from '../storage/process-runner.js';
import type { EncryptedSecretRepository, EncryptionProfileSecret } from './secrets.js';
import {
  OneDriveProvisionError,
  type OneDriveProvisionAdapter,
  type OneDriveProvisionCandidate,
} from './onedrive-provision.js';
import type { CloudConnectionProviderSession } from './refresh-coordinator.js';

const REMOTE_ALIAS = /^[A-Za-z0-9_-]+:$/;
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_ESCROW_BYTES = 64 * 1024;

type CandidateState = {
  id: string;
  connectionId: string | null;
  path: string;
  rawRemote: string;
  cryptRemote: string;
  externalAccountId: string;
  originalConfig: Buffer;
  activationBase: Buffer | null;
  activatedConfig: Buffer | null;
  escrowRemotePath: string | null;
};

export type RcloneOneDriveProvisionAdapterOptions = {
  runner: CommandRunner;
  executable: string;
  configPath: string;
  clientSecret?: string;
  secrets: Pick<EncryptedSecretRepository, 'readOAuthConnectionCredential'>;
  /** Encrypts the recovery payload before it ever reaches a local temp file. */
  sealEscrow: (plaintext: string) => string;
  newId?: () => string;
  /** Deterministic integration-test boundaries; never receives config/secret bytes. */
  mutationHook?: (point: 'LOCKED' | 'BEFORE_REPLACE' | 'AFTER_REPLACE') => void | Promise<void>;
};

/**
 * Concrete rclone materializer for a managed OneDrive raw/crypt pair.
 *
 * All provider probes run against an isolated 0600 candidate config.  The live
 * config is switched only after every probe passes. Config publication uses a
 * short shared OS lock, never the lifetime of a native upload/probe/mount. Both
 * activation and compensation merge only owned sections. A stale candidate
 * never restores another connection's snapshot.
 */
export class RcloneOneDriveProvisionAdapter implements OneDriveProvisionAdapter {
  private readonly candidates = new Map<string, CandidateState>();
  private readonly newId: () => string;

  constructor(private readonly options: RcloneOneDriveProvisionAdapterOptions) {
    if (!path.isAbsolute(options.configPath) || options.configPath.includes('\0')) {
      throw new Error('ONEDRIVE_RCLONE_CONFIG_INVALID');
    }
    if (options.executable.length === 0 || /[\r\n\0]/.test(options.executable)) {
      throw new Error('ONEDRIVE_RCLONE_BINARY_INVALID');
    }
    this.newId = options.newId ?? randomUUID;
  }

  async materializeCandidate(input: {
    connectionId: string;
    session: CloudConnectionProviderSession;
    rawRemote: string;
    cryptRemote: string;
    secret: EncryptionProfileSecret;
    signal?: AbortSignal;
  }): Promise<OneDriveProvisionCandidate> {
    await this.options.runner.recoverRcloneConfig?.(this.options.configPath);
    assertRemote(input.rawRemote);
    assertRemote(input.cryptRemote);
    if (
      input.rawRemote === input.cryptRemote ||
      input.session.provider !== 'ONEDRIVE' ||
      input.session.connectionId !== input.connectionId
    ) {
      throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FENCE_REJECTED');
    }
    const credential = this.options.secrets.readOAuthConnectionCredential({
      id: input.session.secretRefId,
      kind: 'OAUTH_CONNECTION_CREDENTIAL',
    });
    if (
      credential.provider !== 'ONEDRIVE' ||
      credential.externalAccountId !== input.session.externalAccountId ||
      credential.accessToken !== input.session.accessToken ||
      credential.accessExpiresAt !== input.session.accessExpiresAt
    ) {
      throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FENCE_REJECTED');
    }

    const originalConfig = await boundedRead(this.options.configPath, MAX_CONFIG_BYTES);
    input.signal?.throwIfAborted();
    const password = obscure(input.secret.password);
    const password2 = obscure(input.secret.password2);
    const token = JSON.stringify({
      access_token: credential.accessToken,
      token_type: 'Bearer',
      refresh_token: credential.refreshToken,
      expiry: new Date(credential.accessExpiresAt).toISOString(),
    });
    const rawName = input.rawRemote.slice(0, -1);
    const cryptName = input.cryptRemote.slice(0, -1);
    const managed = [
      `[${rawName}]`,
      'type = onedrive',
      `client_id = ${safeConfigValue(credential.clientId)}`,
      ...(this.options.clientSecret === undefined
        ? []
        : [`client_secret = ${safeConfigValue(this.options.clientSecret)}`]),
      `token = ${safeConfigValue(token)}`,
      `drive_id = ${safeConfigValue(input.session.externalAccountId)}`,
      'drive_type = business',
      '',
      `[${cryptName}]`,
      'type = crypt',
      `remote = ${input.rawRemote}ptvault`,
      `password = ${safeConfigValue(password)}`,
      `password2 = ${safeConfigValue(password2)}`,
      'filename_encryption = standard',
      'directory_name_encryption = true',
      '',
    ].join('\n');
    const candidateConfig = replaceManagedSections(
      originalConfig.toString('utf8'),
      new Set([rawName, cryptName]),
      managed,
    );
    return this.persistCandidate(input, originalConfig, candidateConfig);
  }

  /** Reauthorization changes credentials, never historic encryption/root options. */
  async materializeCredentialCandidate(input: {
    connectionId: string;
    session: CloudConnectionProviderSession;
    rawRemote: string;
    cryptRemote: string;
    signal?: AbortSignal;
  }): Promise<OneDriveProvisionCandidate> {
    await this.options.runner.recoverRcloneConfig?.(this.options.configPath);
    assertRemote(input.rawRemote);
    assertRemote(input.cryptRemote);
    const credential = this.options.secrets.readOAuthConnectionCredential({
      id: input.session.secretRefId,
      kind: 'OAUTH_CONNECTION_CREDENTIAL',
    });
    if (
      input.session.connectionId !== input.connectionId ||
      credential.provider !== 'ONEDRIVE' ||
      input.session.provider !== 'ONEDRIVE' ||
      credential.externalAccountId !== input.session.externalAccountId ||
      credential.accessToken !== input.session.accessToken ||
      credential.accessExpiresAt !== input.session.accessExpiresAt
    ) {
      throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FENCE_REJECTED');
    }
    const original = await boundedRead(this.options.configPath, MAX_CONFIG_BYTES);
    const rawName = input.rawRemote.slice(0, -1);
    const cryptName = input.cryptRemote.slice(0, -1);
    const raw = readSection(original.toString('utf8'), rawName);
    const crypt = readSection(original.toString('utf8'), cryptName);
    if (
      raw.get('type') !== 'onedrive' ||
      raw.get('drive_id') !== credential.externalAccountId ||
      crypt.get('type') !== 'crypt' ||
      !crypt.get('remote')?.startsWith(input.rawRemote)
    ) {
      throw new OneDriveProvisionError('ONEDRIVE_LEGACY_IDENTITY_MISMATCH');
    }
    let rawText = ownedSections(original, new Set([rawName]));
    const updates: Record<string, string> = {
      client_id: credential.clientId,
      token: JSON.stringify({
        access_token: credential.accessToken,
        token_type: 'Bearer',
        refresh_token: credential.refreshToken,
        expiry: new Date(credential.accessExpiresAt).toISOString(),
      }),
      ...(this.options.clientSecret === undefined
        ? {}
        : { client_secret: this.options.clientSecret }),
    };
    for (const [key, value] of Object.entries(updates)) {
      const line = new RegExp(`^${key}[ \\t]*=.*(?:\\r?\\n|$)`, 'gm');
      rawText = rawText.replace(line, '');
      rawText += `${rawText.endsWith('\n') ? '' : '\n'}${key} = ${safeConfigValue(value)}\n`;
    }
    const config = replaceManagedSections(original.toString('utf8'), new Set([rawName]), rawText);
    return this.persistCandidate(input, original, config);
  }

  private async persistCandidate(
    input: { rawRemote: string; cryptRemote: string; session: CloudConnectionProviderSession },
    originalConfig: Buffer,
    candidateConfig: string,
  ): Promise<OneDriveProvisionCandidate> {
    const id = this.newId();
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FAILED');
    const candidatePath = path.join(
      path.dirname(this.options.configPath),
      `.${path.basename(this.options.configPath)}.ptvault-candidate-${id}`,
    );
    await writeFile(candidatePath, candidateConfig, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await fsyncFile(candidatePath);
    const state: CandidateState = {
      id,
      connectionId: input.session.connectionId,
      path: candidatePath,
      rawRemote: input.rawRemote,
      cryptRemote: input.cryptRemote,
      externalAccountId: input.session.externalAccountId,
      originalConfig,
      activationBase: null,
      activatedConfig: null,
      escrowRemotePath: null,
    };
    this.candidates.set(id, state);
    return Object.freeze({ candidateId: id });
  }

  async writeEscrow(
    candidate: OneDriveProvisionCandidate,
    input: { profileId: string; secret: EncryptionProfileSecret; signal?: AbortSignal },
  ): Promise<{ receiptRef: string; digest: string }> {
    const state = this.state(candidate);
    if (!/^[0-9a-f-]{36}$/i.test(input.profileId)) {
      throw new OneDriveProvisionError('ONEDRIVE_ESCROW_VERIFY_FAILED');
    }
    const sealed = this.options.sealEscrow(
      JSON.stringify({
        version: 1,
        profileId: input.profileId,
        password: input.secret.password,
        password2: input.secret.password2,
      }),
    );
    if (sealed.length === 0 || Buffer.byteLength(sealed, 'utf8') > MAX_ESCROW_BYTES) {
      throw new OneDriveProvisionError('ONEDRIVE_ESCROW_VERIFY_FAILED');
    }
    const localPath = this.tempPath(state, 'escrow');
    const remotePath = `${state.rawRemote}.ptvault/recovery/${input.profileId}.escrow`;
    try {
      await writeFile(localPath, sealed, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await fsyncFile(localPath);
      await this.run(state, ['copyto', localPath, remotePath, '--transfers', '1'], input.signal);
      state.escrowRemotePath = remotePath;
      return { receiptRef: remotePath, digest: digest(Buffer.from(sealed, 'utf8')) };
    } finally {
      await unlink(localPath).catch(() => undefined);
    }
  }

  async readBackEscrow(
    candidate: OneDriveProvisionCandidate,
    input: { receiptRef: string; signal?: AbortSignal },
  ): Promise<{ digest: string }> {
    const state = this.state(candidate);
    if (state.escrowRemotePath === null || input.receiptRef !== state.escrowRemotePath) {
      throw new OneDriveProvisionError('ONEDRIVE_ESCROW_VERIFY_FAILED');
    }
    const result = await this.run(state, ['cat', input.receiptRef], input.signal, MAX_ESCROW_BYTES);
    return { digest: digest(result.stdout) };
  }

  async probeAbout(
    candidate: OneDriveProvisionCandidate,
    signal?: AbortSignal,
  ): Promise<{ totalBytes: number | null; freeBytes: number | null }> {
    const state = this.state(candidate);
    const result = await this.run(state, ['about', state.rawRemote, '--json'], signal);
    let decoded: unknown;
    try {
      decoded = JSON.parse(result.stdout.toString('utf8')) as unknown;
    } catch {
      throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FAILED');
    }
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FAILED');
    }
    const record = decoded as Record<string, unknown>;
    return {
      totalBytes: quota(record.total),
      freeBytes: quota(record.free),
    };
  }

  async probeList(candidate: OneDriveProvisionCandidate, signal?: AbortSignal): Promise<void> {
    const state = this.state(candidate);
    const result = await this.run(state, ['lsjson', state.cryptRemote, '--max-depth', '1'], signal);
    try {
      if (!Array.isArray(JSON.parse(result.stdout.toString('utf8')))) {
        throw new Error('not an array');
      }
    } catch {
      throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FAILED');
    }
  }

  async cryptRoundTrip(
    candidate: OneDriveProvisionCandidate,
    sample: { plaintext: Uint8Array; sha256: string; signal?: AbortSignal },
  ): Promise<{ sha256: string }> {
    const state = this.state(candidate);
    if (!/^[0-9a-f]{64}$/.test(sample.sha256)) {
      throw new OneDriveProvisionError('ONEDRIVE_CRYPT_ROUNDTRIP_FAILED');
    }
    const localPath = this.tempPath(state, 'roundtrip');
    const remotePath = `${state.cryptRemote}.ptvault-probe/${state.id}.bin`;
    let uploaded = false;
    try {
      await writeFile(localPath, sample.plaintext, { flag: 'wx', mode: 0o600 });
      await fsyncFile(localPath);
      await this.run(state, ['copyto', localPath, remotePath, '--transfers', '1'], sample.signal);
      uploaded = true;
      const readback = await this.run(state, ['cat', remotePath], sample.signal);
      return { sha256: digest(readback.stdout) };
    } finally {
      if (uploaded) {
        await this.run(state, ['deletefile', remotePath], sample.signal).catch(() => undefined);
      }
      await unlink(localPath).catch(() => undefined);
    }
  }

  async activateCandidate(candidate: OneDriveProvisionCandidate): Promise<void> {
    const state = this.state(candidate);
    await withConfigLock(this.options.configPath, async (filename) => {
      await this.options.mutationHook?.('LOCKED');
      const current = await boundedRead(filename, MAX_CONFIG_BYTES);
      const names = new Set([state.rawRemote.slice(0, -1), state.cryptRemote.slice(0, -1)]);
      const expected = state.activatedConfig ?? state.originalConfig;
      if (ownedSections(current, names) !== ownedSections(expected, names)) {
        throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FENCE_REJECTED');
      }
      if (state.activatedConfig !== null) return;
      const candidateConfig = await boundedRead(state.path, MAX_CONFIG_BYTES);
      const replacement = Buffer.from(
        replaceManagedSections(
          current.toString('utf8'),
          names,
          ownedSections(candidateConfig, names),
        ),
      );
      await this.options.mutationHook?.('BEFORE_REPLACE');
      await atomicReplace(filename, replacement, state.id, digest(current), () => {
        // Record ownership immediately after rename, even if directory fsync or
        // the caller's DB switch subsequently fails and requests compensation.
        state.activationBase = current;
        state.activatedConfig = replacement;
      });
      await this.options.mutationHook?.('AFTER_REPLACE');
    });
  }

  async rollbackCandidate(candidate: OneDriveProvisionCandidate): Promise<void> {
    const state = this.state(candidate);
    let failed = false;
    if (state.escrowRemotePath !== null) {
      try {
        await this.run(state, ['deletefile', state.escrowRemotePath]);
      } catch {
        failed = true;
      }
    }
    if (state.activatedConfig !== null && state.activationBase !== null) {
      try {
        await withConfigLock(this.options.configPath, async (filename) => {
          const live = await boundedRead(filename, MAX_CONFIG_BYTES);
          const names = new Set([state.rawRemote.slice(0, -1), state.cryptRemote.slice(0, -1)]);
          if (ownedSections(live, names) !== ownedSections(state.activatedConfig!, names)) {
            throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FENCE_REJECTED');
          }
          const replacement =
            digest(live) === digest(state.activatedConfig!)
              ? state.activationBase!
              : Buffer.from(
                  replaceManagedSections(
                    live.toString('utf8'),
                    names,
                    ownedSections(state.activationBase!, names),
                  ),
                );
          await atomicReplace(filename, replacement, state.id, digest(live), () => {
            state.activationBase = null;
            state.activatedConfig = null;
          });
        });
      } catch {
        failed = true;
      }
    }
    // Keep the private candidate for an explicit retry if compensation lost its
    // section fence. Never delete another writer's lock/config to force success.
    if (failed) throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FAILED');
    await this.releaseCandidate(state);
  }

  async finalizeCandidate(candidate: OneDriveProvisionCandidate): Promise<void> {
    const state = this.state(candidate);
    await this.releaseCandidate(state);
  }

  private async releaseCandidate(state: CandidateState): Promise<void> {
    // A failed native publish may be the only durable copy of a rotating token.
    // Reconcile it before deleting its source; on IO failure retain both for
    // canonical startup recovery. Do not race a still-running native probe.
    await this.options.runner.recoverRcloneConfig?.(state.path);
    await withConfigLock(state.path, async (filename) => {
      try {
        if ((await readdir(`${filename}.ptvault-native`)).length > 0)
          throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FAILED');
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
      }
      await unlink(filename);
    });
    this.candidates.delete(state.id);
  }

  async inspectLegacyIdentity(input: {
    rawRemote: string;
    cryptRemote: string;
    signal?: AbortSignal;
  }): Promise<{ externalAccountId: string }> {
    assertRemote(input.rawRemote);
    assertRemote(input.cryptRemote);
    const config = (await boundedRead(this.options.configPath, MAX_CONFIG_BYTES)).toString('utf8');
    const raw = readSection(config, input.rawRemote.slice(0, -1));
    const crypt = readSection(config, input.cryptRemote.slice(0, -1));
    const driveId = raw.get('drive_id');
    const cryptTarget = crypt.get('remote');
    if (
      raw.get('type') !== 'onedrive' ||
      crypt.get('type') !== 'crypt' ||
      driveId === undefined ||
      driveId.length === 0 ||
      driveId.length > 256 ||
      cryptTarget === undefined ||
      !cryptTarget.startsWith(input.rawRemote)
    ) {
      throw new OneDriveProvisionError('ONEDRIVE_LEGACY_REMOTE_MISMATCH');
    }
    const temporary: CandidateState = {
      id: randomUUID(),
      connectionId: null,
      path: this.options.configPath,
      rawRemote: input.rawRemote,
      cryptRemote: input.cryptRemote,
      externalAccountId: driveId,
      originalConfig: Buffer.alloc(0),
      activationBase: null,
      activatedConfig: null,
      escrowRemotePath: null,
    };
    await this.run(temporary, ['about', input.rawRemote, '--json'], input.signal);
    await this.run(temporary, ['lsjson', input.cryptRemote, '--max-depth', '1'], input.signal);
    return { externalAccountId: driveId };
  }

  private state(candidate: OneDriveProvisionCandidate): CandidateState {
    const state = this.candidates.get(candidate.candidateId);
    if (state === undefined) throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FAILED');
    return state;
  }

  private tempPath(state: CandidateState, kind: string): string {
    return path.join(path.dirname(state.path), `.ptvault-${kind}-${state.id}-${randomUUID()}`);
  }

  private async run(
    state: CandidateState,
    args: readonly string[],
    signal?: AbortSignal,
    maximumBytes?: number,
  ): Promise<ProcessResult> {
    try {
      const result = await this.options.runner.run(
        {
          executable: this.options.executable,
          args: ['--config', state.path, ...args],
          ...(state.connectionId === null
            ? {}
            : {
                rcloneCredentialBindings: [
                  { alias: state.rawRemote.slice(0, -1), connectionId: state.connectionId },
                ],
              }),
          ...(signal === undefined ? {} : { signal }),
        },
        maximumBytes,
      );
      if (result.exitCode !== 0) throw new Error('process failed');
      return result;
    } catch {
      // Subprocess errors/stdout/stderr may echo config material. Never attach
      // them as a public error message or cause (including spawn failures).
      throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FAILED');
    }
  }
}

/** rclone's public config encoding, NOT encryption at rest. Secrets stay in memory.
 * Format: base64url(16-byte random IV || AES-256-CTR(public key, IV, UTF-8)).
 * https://github.com/rclone/rclone/blob/master/fs/config/obscure/obscure.go
 */
function obscure(value: string): string {
  if (value.length === 0 || Buffer.byteLength(value) > 4096 || /[\r\n\0]/.test(value)) {
    throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FAILED');
  }
  const iv = randomBytes(16);
  const key = Buffer.from(
    '9c935b48730a554d6bfd7c63c886a92bd390198eb8128afbf4de162b8b95f638',
    'hex',
  );
  const plaintext = Buffer.from(value, 'utf8');
  try {
    const encoder = createCipheriv('aes-256-ctr', key, iv);
    return Buffer.concat([iv, encoder.update(plaintext), encoder.final()]).toString('base64url');
  } finally {
    plaintext.fill(0);
  }
}

function assertRemote(value: string): void {
  if (!REMOTE_ALIAS.test(value)) throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FAILED');
}

function safeConfigValue(value: string): string {
  if (value.length === 0 || /[\r\n\0]/.test(value)) {
    throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FAILED');
  }
  return value;
}

function quota(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FAILED');
  }
  return value;
}

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function boundedRead(filename: string, maximum: number): Promise<Buffer> {
  const value = await readFile(filename);
  if (value.byteLength > maximum) throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FAILED');
  return value;
}

async function fsyncFile(filename: string): Promise<void> {
  // Windows rejects fsync on a read-only handle even when the file itself is
  // writable. Every caller owns a private candidate/temp/swap, so r+ is valid.
  const handle = await open(filename, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicReplace(
  filename: string,
  value: Uint8Array,
  fence: string,
  expectedDigest: string,
  applied: () => void,
): Promise<void> {
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${fence}.swap`);
  await writeFile(temporary, value, { flag: 'wx', mode: 0o600 });
  try {
    await fsyncFile(temporary);
    await chmod(temporary, 0o600);
    if (digest(await boundedRead(filename, MAX_CONFIG_BYTES)) !== expectedDigest) {
      throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FENCE_REJECTED');
    }
    await rename(temporary, filename);
    applied();
    await fsyncDirectory(path.dirname(filename));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

/** Cooperative cross-process publication lock. Native product commands write
 * only private configs and acquire this same short OS lock when merging tokens.
 * A crashed owner releases the OS lock; a legacy sentinel still requires drain.
 * Out-of-band administrative writers remain outside this protocol. The digest
 * fence detects only their edits that precede the final check, not later races.
 */
async function withConfigLock<T>(
  filename: string,
  operation: (canonical: string) => Promise<T>,
): Promise<T> {
  try {
    return await withRcloneConfigLock(filename, operation);
  } catch (error) {
    if (error instanceof RcloneConfigError)
      throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FENCE_REJECTED');
    throw error;
  }
}

function ownedSections(config: Buffer, names: ReadonlySet<string>): string {
  const source = config.toString('utf8');
  const matches = [...source.matchAll(/^\[([^\]\r\n]+)\][ \t]*(?:\r?\n|$)/gm)];
  const sections = new Map<string, string>();
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const name = match[1]!;
    if (!names.has(name)) continue;
    if (sections.has(name)) throw new OneDriveProvisionError('ONEDRIVE_PROVISION_FENCE_REJECTED');
    sections.set(name, source.slice(match.index, matches[index + 1]?.index ?? source.length));
  }
  return [...names]
    .sort()
    .map((name) => sections.get(name) ?? '')
    .join('');
}

async function fsyncDirectory(directoryName: string): Promise<void> {
  let directory;
  try {
    directory = await open(directoryName, 'r');
    await directory.sync();
  } catch (error) {
    // Windows does not expose POSIX directory fsync. File fsync + atomic rename
    // still provide the strongest primitive available there; Linux failures
    // remain fatal so the durability guarantee does not silently weaken.
    const code =
      error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (
      process.platform !== 'win32' ||
      !['EACCES', 'EBADF', 'EISDIR', 'EINVAL', 'EPERM'].includes(code)
    ) {
      throw error;
    }
  } finally {
    await directory?.close();
  }
}

function replaceManagedSections(
  source: string,
  managedNames: ReadonlySet<string>,
  replacement: string,
): string {
  const section = /^\[([^\]\r\n]+)\][ \t]*(?:\r?\n|$)/gm;
  const ranges: Array<{ start: number; end: number }> = [];
  const matches = [...source.matchAll(section)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const name = match[1]!;
    if (!managedNames.has(name)) continue;
    ranges.push({ start: match.index, end: matches[index + 1]?.index ?? source.length });
  }
  let result = source;
  for (const range of ranges.reverse())
    result = result.slice(0, range.start) + result.slice(range.end);
  const separator = result.length === 0 || result.endsWith('\n') ? '' : '\n';
  return `${result}${separator}${replacement}`;
}

function readSection(source: string, name: string): Map<string, string> {
  const header = new RegExp(`^\\[${escapeRegExp(name)}\\][ \\t]*(?:\\r?\\n|$)`, 'm');
  const match = header.exec(source);
  if (match === null) throw new OneDriveProvisionError('ONEDRIVE_LEGACY_REMOTE_MISMATCH');
  const start = match.index + match[0].length;
  const next = /^\[[^\]\r\n]+\][ \t]*(?:\r?\n|$)/m.exec(source.slice(start));
  const body = source.slice(start, next === null ? source.length : start + next.index);
  const values = new Map<string, string>();
  for (const line of body.split(/\r?\n/)) {
    const parsed = /^([A-Za-z0-9_]+)[ \t]*=[ \t]*(.*)$/.exec(line);
    if (parsed !== null) values.set(parsed[1]!, parsed[2]!.trim());
  }
  return values;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
