import type { Readable } from 'node:stream';

import type { AppDatabase } from '../../db/database.js';
import { StorageEligibilityAuthority } from '../../cloud-connections/eligibility.js';
import type { CommandRunner, ProcessResult } from '../../storage/process-runner.js';
import {
  DestinationError,
  type DestinationMoveReceipt,
  type DestinationObjectStat,
  type DestinationTransport,
  VerifiedDestinationAdapter,
} from './destination.js';
import { dataPlaneInvariant, ImportDataPlaneError } from './errors.js';
import type { ImportDataPlaneDestinationResolver, ResolvedImportDestination } from './types.js';
import type { ImportWorkerJob } from '../worker-repository.js';
import { RcloneConfigError } from '../../storage/rclone-config-files.js';

export type RcloneRunResult = { exitCode: number; stdout: Buffer; stderr: string };

export interface RcloneExecutor {
  run(args: readonly string[], signal?: AbortSignal): Promise<RcloneRunResult>;
  stream(
    args: readonly string[],
    signal?: AbortSignal,
  ): {
    stream: Readable;
    completed: Promise<ProcessResult>;
  };
}

export class CommandRunnerRcloneExecutor implements RcloneExecutor {
  constructor(
    private readonly runner: CommandRunner,
    private readonly executable: string,
  ) {
    dataPlaneInvariant(executable.length > 0, 'RCLONE_BINARY_INVALID');
  }

  run(args: readonly string[], signal?: AbortSignal): Promise<RcloneRunResult> {
    return this.runner.run({
      executable: this.executable,
      args,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  stream(
    args: readonly string[],
    signal?: AbortSignal,
  ): {
    stream: Readable;
    completed: Promise<ProcessResult>;
  } {
    return this.runner.streamStdout({
      executable: this.executable,
      args,
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

function safeRelativePath(value: string): string {
  dataPlaneInvariant(
    value.length > 0 &&
      !value.startsWith('/') &&
      !value.endsWith('/') &&
      !value.includes('\\') &&
      !value.includes('\0') &&
      value
        .split('/')
        .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'),
    'RCLONE_REMOTE_PATH_INVALID',
  );
  return value;
}

export type RcloneDestinationTransportOptions = {
  executor: RcloneExecutor;
  configPath: string;
  remote: string;
  allowedRoot: string;
};

export class RcloneDestinationTransport implements DestinationTransport {
  private readonly executor: RcloneExecutor;
  private readonly configPath: string;
  private readonly remote: string;
  private readonly allowedRoot: string;

  constructor(options: RcloneDestinationTransportOptions) {
    dataPlaneInvariant(/^[A-Za-z0-9_-]+:$/.test(options.remote), 'RCLONE_REMOTE_INVALID');
    dataPlaneInvariant(options.configPath.length > 0, 'RCLONE_CONFIG_INVALID');
    this.executor = options.executor;
    this.configPath = options.configPath;
    this.remote = options.remote;
    this.allowedRoot = safeRelativePath(options.allowedRoot);
  }

  async stat(key: string, signal?: AbortSignal): Promise<DestinationObjectStat | null> {
    const result = await this.executor.run(
      ['lsjson', this.remotePath(key), '--stat', '--files-only', ...this.commonArgs()],
      signal,
    );
    if (result.exitCode === 3) return null;
    if (result.exitCode !== 0)
      throw new DestinationError('RCLONE_STAT_FAILED', 'rclone stat failed');
    let decoded: unknown;
    try {
      decoded = JSON.parse(result.stdout.toString('utf8')) as unknown;
    } catch {
      throw new DestinationError('RCLONE_STAT_INVALID', 'rclone stat JSON is invalid');
    }
    // Successful lsjson --stat may report an absent object as JSON null (rclone 1.74).
    // Only this exact successful response means absence; malformed/error output stays fatal.
    if (decoded === null) return null;
    const entry: unknown = Array.isArray(decoded) ? (decoded as unknown[])[0] : decoded;
    if (entry === null || typeof entry !== 'object' || !('Size' in entry)) {
      throw new DestinationError('RCLONE_STAT_INVALID', 'rclone stat omitted size');
    }
    const size = (entry as Record<string, unknown>).Size;
    dataPlaneInvariant(
      typeof size === 'number' && Number.isSafeInteger(size) && size >= 0,
      'RCLONE_STAT_INVALID',
    );
    return { size: String(size) };
  }

  async upload(localPath: string, key: string, signal?: AbortSignal): Promise<void> {
    dataPlaneInvariant(!localPath.includes('\0'), 'RCLONE_LOCAL_PATH_INVALID');
    const result = await this.executor.run(
      [
        'copyto',
        localPath,
        this.remotePath(key),
        ...this.commonArgs(),
        '--transfers',
        '1',
        '--checkers',
        '1',
        '--low-level-retries',
        '1',
      ],
      signal,
    );
    if (result.exitCode !== 0) {
      throw new DestinationError('DESTINATION_UPLOAD_FAILED', 'rclone upload failed');
    }
  }

  async *read(key: string, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    const process = this.executor.stream(
      ['cat', this.remotePath(key), ...this.commonArgs()],
      signal,
    );
    try {
      for await (const chunk of process.stream) {
        const bytes = chunk as Buffer;
        yield new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      }
      const completed = await process.completed;
      if (completed.exitCode !== 0) {
        throw new DestinationError('RCLONE_READ_FAILED', 'rclone readback failed');
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      // The child stream can close before its config coordinator settles.
      // Drain completion to retain its fixed authority code and permit only
      // the explicit token-collision handoff; no raw stderr/credential escapes.
      try {
        await process.completed;
      } catch (completionError) {
        if (signal?.aborted) throw signal.reason ?? completionError;
        if (completionError instanceof RcloneConfigError)
          throw new DestinationError(completionError.code, completionError.code);
      }
      if (error instanceof RcloneConfigError) throw new DestinationError(error.code, error.code);
      if (error instanceof DestinationError) throw error;
      throw new DestinationError('RCLONE_READ_FAILED', 'rclone readback failed');
    }
  }

  async move(
    sourceKey: string,
    destinationKey: string,
    signal?: AbortSignal,
  ): Promise<DestinationMoveReceipt> {
    const result = await this.executor.run(
      ['moveto', this.remotePath(sourceKey), this.remotePath(destinationKey), ...this.commonArgs()],
      signal,
    );
    if (result.exitCode !== 0) {
      throw new DestinationError('DESTINATION_COMMIT_FAILED', 'rclone commit failed');
    }
    return {};
  }

  private remotePath(key: string): string {
    return `${this.remote}${this.allowedRoot}/${safeRelativePath(key)}`;
  }

  private commonArgs(): string[] {
    return ['--config', this.configPath];
  }
}

type AccountRemoteRow = { rawRemote: string; cryptRemote: string };

class AuthorityCheckedDestinationTransport implements DestinationTransport {
  constructor(
    private readonly transport: DestinationTransport,
    private readonly assertEligible: () => void,
  ) {}

  async stat(key: string, signal?: AbortSignal): Promise<DestinationObjectStat | null> {
    this.assertEligible();
    const result = await this.transport.stat(key, signal);
    this.assertEligible();
    return result;
  }

  async upload(localPath: string, key: string, signal?: AbortSignal): Promise<void> {
    this.assertEligible();
    await this.transport.upload(localPath, key, signal);
    this.assertEligible();
  }

  async *read(key: string, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    this.assertEligible();
    for await (const chunk of this.transport.read(key, signal)) {
      yield chunk;
    }
    this.assertEligible();
  }

  async move(
    sourceKey: string,
    destinationKey: string,
    signal?: AbortSignal,
  ): Promise<DestinationMoveReceipt> {
    this.assertEligible();
    const result = await this.transport.move(sourceKey, destinationKey, signal);
    this.assertEligible();
    return result;
  }
}

export type DatabaseRcloneImportDestinationResolverOptions = {
  db: AppDatabase;
  executor: RcloneExecutor;
  configPath: string;
  allowedRoot?: string;
  webOAuthRuntimeConfigured?: boolean;
  now?: () => number;
};

/** Must also be the remote root of the independent read-only import mounts. */
export const IMPORT_REMOTE_ROOT = 'ptvault-imports';

export class DatabaseRcloneImportDestinationResolver implements ImportDataPlaneDestinationResolver {
  private readonly allowedRoot: string;
  private readonly eligibility: StorageEligibilityAuthority;

  constructor(private readonly options: DatabaseRcloneImportDestinationResolverOptions) {
    this.allowedRoot = options.allowedRoot ?? IMPORT_REMOTE_ROOT;
    safeRelativePath(this.allowedRoot);
    this.eligibility = new StorageEligibilityAuthority(options.db, {
      legacyRcloneConfigured: true,
      webOAuthRuntimeConfigured: options.webOAuthRuntimeConfigured ?? false,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  async resolve(job: ImportWorkerJob): Promise<ResolvedImportDestination> {
    // Keep validation failures on the resolver's promised async boundary.
    await Promise.resolve();
    const prefix =
      job.destinationKind === 'ONEDRIVE_RAW'
        ? 'onedrive-raw:'
        : job.destinationKind === 'STANDALONE_CRYPT'
          ? 'onedrive-crypt:'
          : null;
    if (prefix === null || !job.destinationId.startsWith(prefix)) {
      throw new ImportDataPlaneError('IMPORT_DESTINATION_NOT_SUPPORTED');
    }
    const accountId = job.destinationId.slice(prefix.length);
    dataPlaneInvariant(accountId.length > 0, 'IMPORT_DESTINATION_ID_INVALID');
    const eligibility = this.eligibility.evaluate(accountId, 'NEW_WORK');
    if (!eligibility.eligible) {
      throw new ImportDataPlaneError(
        'IMPORT_DESTINATION_ACCOUNT_INELIGIBLE',
        `Import destination account is ineligible: ${eligibility.reason ?? 'BINDING_INVALID'}`,
      );
    }
    const row = this.options.db
      .prepare(
        `SELECT raw_remote AS rawRemote, crypt_remote AS cryptRemote
         FROM storage_accounts WHERE id = ? AND enabled = 1`,
      )
      .get(accountId) as AccountRemoteRow | undefined;
    if (row === undefined) throw new ImportDataPlaneError('IMPORT_DESTINATION_ACCOUNT_MISSING');
    const remote = job.destinationKind === 'ONEDRIVE_RAW' ? row.rawRemote : row.cryptRemote;
    const transport = new RcloneDestinationTransport({
      executor: this.options.executor,
      configPath: this.options.configPath,
      remote,
      allowedRoot: this.allowedRoot,
    });
    return {
      destinationAccountId: accountId,
      adapter: new VerifiedDestinationAdapter(
        new AuthorityCheckedDestinationTransport(transport, () => {
          const current = this.eligibility.evaluate(accountId, 'EXISTING_WORK');
          if (!current.eligible) {
            throw new DestinationError(
              'DESTINATION_ACCOUNT_INELIGIBLE',
              `Import destination account is ineligible: ${current.reason ?? 'BINDING_INVALID'}`,
            );
          }
        }),
      ),
      stagingPrefix: 'staging',
      committedPrefix: 'objects',
    };
  }
}
