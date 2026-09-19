import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { StorageAccount } from '@ptvault/contracts';

import type { StorageAccountRepository } from '../storage/accounts.js';
import type { CommandRunner } from '../storage/process-runner.js';
import type { RcloneControl } from '../storage/rclone.js';
import { assertPassphraseEncryptedAge } from './escrow.js';
import type { RecoveryRepository } from './repository.js';

export type RecoveryBundleSource = {
  rcloneConfig: string;
  accountMapping: unknown;
  databaseBackup: Uint8Array;
  torrentManifest: unknown;
  recoveryInstructions: string;
};

export type GenerateRecoveryBundle = {
  reservation?: { version: number; publicRecipient: string; recipientGeneration: number };
  encryptedEscrow: Uint8Array;
  destinationAccountIds: readonly string[];
  source: RecoveryBundleSource;
  signal: AbortSignal;
};

export type RecoveryBundleResult = {
  version: number;
  bundlePath: string;
  bundleSha256: string;
  escrowSha256: string;
  accountIds: string[];
};

export type RecoveryBundleServiceOptions = {
  repository: RecoveryRepository;
  accounts: StorageAccountRepository;
  runner: CommandRunner;
  rclone: RcloneControl;
  ageExecutable: string;
  outputDirectory: string;
  now?: () => number;
};

type TarEntry = { name: string; bytes: Buffer };

export class RecoveryBundleService {
  private readonly repository: RecoveryRepository;
  private readonly accounts: StorageAccountRepository;
  private readonly runner: CommandRunner;
  private readonly rclone: RcloneControl;
  private readonly ageExecutable: string;
  private readonly outputDirectory: string;
  private readonly now: () => number;

  constructor(options: RecoveryBundleServiceOptions) {
    this.repository = options.repository;
    this.accounts = options.accounts;
    this.runner = options.runner;
    this.rclone = options.rclone;
    this.ageExecutable = options.ageExecutable;
    this.outputDirectory = path.resolve(options.outputDirectory);
    this.now = options.now ?? (() => Date.now());
  }

  async generate(input: GenerateRecoveryBundle): Promise<RecoveryBundleResult> {
    assertPassphraseEncryptedAge(input.encryptedEscrow);
    const accountIds = [...new Set(input.destinationAccountIds)];
    if (accountIds.length < 2) throw new Error('RECOVERY_REQUIRES_TWO_DESTINATIONS');
    const accounts = accountIds.map((id) => this.requireHealthyAccount(id));
    const recipient = input.reservation?.publicRecipient ?? this.repository.getPublicRecipient();
    if (!recipient) throw new Error('RECOVERY_RECIPIENT_NOT_CONFIGURED');

    const escrowBytes = Buffer.from(input.encryptedEscrow);
    const escrowSha256 = sha256(escrowBytes);
    const version = input.reservation?.version ?? this.repository.beginExport({ escrowSha256 });
    if (input.reservation) {
      const reserved = this.repository.getExport(version);
      if (
        !reserved ||
        reserved.completedAt !== null ||
        reserved.bundleSha256 !== null ||
        reserved.escrowSha256 !== escrowSha256 ||
        reserved.publicRecipient !== recipient ||
        reserved.recipientGeneration !== input.reservation.recipientGeneration
      )
        throw new Error('RECOVERY_EXPORT_RESERVATION_INVALID');
    }

    await mkdir(this.outputDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.outputDirectory, 0o700);
    const tempDirectory = await mkdtemp(path.join(this.outputDirectory, `.recovery-v${version}-`));
    await chmod(tempDirectory, 0o700);
    const tarPath = path.join(tempDirectory, 'bundle.tar');
    const encryptedTemporaryPath = path.join(tempDirectory, 'bundle.age.tmp');
    const escrowTemporaryPath = path.join(tempDirectory, 'escrow.tmp.age');
    const bundlePath = path.join(this.outputDirectory, `recovery-v${version}.tar.age`);

    try {
      const tar = deterministicTar([
        { name: 'RECOVERY.md', bytes: Buffer.from(input.source.recoveryInstructions, 'utf8') },
        { name: 'accounts.json', bytes: stableJson(input.source.accountMapping) },
        { name: 'ptvault.db', bytes: Buffer.from(input.source.databaseBackup) },
        {
          name: 'rclone.conf',
          bytes: Buffer.from(sanitizeRcloneConfig(input.source.rcloneConfig)),
        },
        { name: 'torrents.json', bytes: stableJson(input.source.torrentManifest) },
      ]);
      await writePrivateFile(tarPath, tar);
      await writePrivateFile(escrowTemporaryPath, escrowBytes);

      const age = await this.runner.run({
        executable: this.ageExecutable,
        args: ['--recipient', recipient, '--output', encryptedTemporaryPath, tarPath],
        signal: input.signal,
      });
      if (age.exitCode !== 0) throw new Error('RECOVERY_AGE_ENCRYPTION_FAILED');
      await fsyncFile(encryptedTemporaryPath);
      await rename(encryptedTemporaryPath, bundlePath);
      await fsyncDirectory(this.outputDirectory);

      const bundleBytes = await readFile(bundlePath);
      const bundleSha256 = sha256(bundleBytes);
      this.repository.completeExport(version, { bundleSha256 });

      for (const account of accounts) {
        this.accounts.getEligible(account.id, 'NEW_WORK');
        // Bootstrap must not require the crypt keys contained inside this bundle.
        // Recipient/content namespaces keep independent installations and versions apart.
        const prefix = `${account.rawRemote}ptvault-recovery/${sha256(Buffer.from(recipient)).slice(0, 32)}/v${version}/${bundleSha256}`;
        const bundleRemotePath = `${prefix}/bundle.tar.age`;
        const escrowRemotePath = `${prefix}/escrow.age`;
        await this.copyNewOrVerify(bundlePath, bundleRemotePath, bundleBytes, input.signal);
        this.accounts.getEligible(account.id, 'NEW_WORK');
        await this.copyNewOrVerify(escrowTemporaryPath, escrowRemotePath, escrowBytes, input.signal);
        this.accounts.getEligible(account.id, 'NEW_WORK');
        const assertEligible = (): void => {
          this.accounts.getEligible(account.id, 'NEW_WORK');
        };
        await verifyRemote(
          this.rclone,
          bundleRemotePath,
          bundleBytes,
          input.signal,
          assertEligible,
        );
        await verifyRemote(
          this.rclone,
          escrowRemotePath,
          escrowBytes,
          input.signal,
          assertEligible,
        );
        this.accounts.getEligible(account.id, 'NEW_WORK');
        this.repository.recordCloudCopy({
          version,
          accountId: account.id,
          bundleSha256,
          escrowSha256,
          bundleRemotePath,
          escrowRemotePath,
          verifiedAt: this.now(),
        });
      }

      return { version, bundlePath, bundleSha256, escrowSha256, accountIds };
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }

  private requireHealthyAccount(id: string): StorageAccount {
    const account = this.accounts.getEligible(id, 'NEW_WORK');
    if (
      account.health !== 'HEALTHY' ||
      (account.circuitOpenUntil !== null && account.circuitOpenUntil > this.now())
    ) {
      throw new Error('RECOVERY_DESTINATION_NOT_HEALTHY');
    }
    return account;
  }

  private async copyNewOrVerify(local: string, remote: string, expected: Buffer, signal: AbortSignal): Promise<void> {
    const existing = await this.rclone.stat(remote, signal);
    if (existing !== null) {
      await verifyRemote(this.rclone, remote, expected, signal, () => signal.throwIfAborted());
      return;
    }
    await this.rclone.copy(local, remote, signal, undefined, { immutable: true });
  }
}

async function verifyRemote(
  rclone: RcloneControl,
  remotePath: string,
  expected: Buffer,
  signal: AbortSignal,
  assertEligible: () => void,
): Promise<void> {
  assertEligible();
  const stat = await rclone.stat(remotePath, signal);
  assertEligible();
  if (!stat || stat.size !== expected.length) throw new Error('RECOVERY_COPY_SIZE_MISMATCH');
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let child: ReturnType<RcloneControl['cat']> | undefined;
  try {
    child = rclone.cat(remotePath, controller.signal);
    // Attach rejection handling immediately, even while consuming stdout.
    void child.completed.catch(() => undefined);
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of child.stream) {
      signal.throwIfAborted();
      bytes += (chunk as Buffer).length;
      if (bytes > expected.length) throw new Error('RECOVERY_COPY_SIZE_MISMATCH');
      hash.update(chunk as Buffer);
    }
    const result = await child.completed;
    assertEligible();
    if (result.exitCode !== 0 || bytes !== expected.length || hash.digest('hex') !== sha256(expected)) {
      throw new Error('RECOVERY_COPY_CHECKSUM_MISMATCH');
    }
  } finally {
    controller.abort();
    if (child) await child.completed.catch(() => undefined);
    signal.removeEventListener('abort', abort);
  }
}

function sanitizeRcloneConfig(config: string): string {
  return config
    .split(/\r?\n/)
    .filter((line) => !/^\s*(token|access_token|refresh_token|client_secret)\s*=/i.test(line))
    .join('\n');
}

function stableJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(sortJson(value), null, 2)}\n`, 'utf8');
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}

function deterministicTar(entries: readonly TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    const name = Buffer.from(entry.name, 'utf8');
    if (name.length > 100) throw new Error('RECOVERY_TAR_ENTRY_NAME_TOO_LONG');
    const header = Buffer.alloc(512);
    name.copy(header, 0);
    writeOctal(header, 100, 8, 0o600);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.bytes.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = '0'.charCodeAt(0);
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');
    const checksum = header.reduce((total, byte) => total + byte, 0);
    const encodedChecksum = checksum.toString(8).padStart(6, '0');
    header.write(encodedChecksum, 148, 6, 'ascii');
    header[154] = 0;
    header[155] = 0x20;
    chunks.push(header, entry.bytes);
    const padding = (512 - (entry.bytes.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, '0');
  if (encoded.length >= length) throw new Error('RECOVERY_TAR_VALUE_TOO_LARGE');
  buffer.write(encoded, offset, length - 1, 'ascii');
  buffer[offset + length - 1] = 0;
}

async function writePrivateFile(filePath: string, bytes: Uint8Array): Promise<void> {
  await writeFile(filePath, bytes, { mode: 0o600, flag: 'wx' });
  await fsyncFile(filePath);
}

async function fsyncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    if (process.platform !== 'win32') throw error;
  }
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
