import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { dataPlaneInvariant, ImportDataPlaneError } from './errors.js';

export type SpoolPaths = {
  jobDirectory: string;
  partPath: string;
  readyPath: string;
};

export type ReadyEvidence = {
  objectId: string;
  readyPath: string;
  size: string;
  device: string;
  inode: string;
  mtimeNs: string;
  directorySyncedAt: string;
};

export type ReadyHash = {
  sha256: string;
  size: string;
  hashedAt: string;
};

export type SpoolCleanupPermit = {
  objectId: string;
  ready: ReadyEvidence;
  recoveryGenerationId: string;
  recoveryState: 'CONTROL_PLANE_BACKED_UP';
};

export type SpoolManagerOptions = {
  root: string;
  now?: () => Date;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function fsyncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform !== 'win32' ||
      !['EINVAL', 'EPERM', 'EISDIR', 'EBADF'].includes(code ?? '')
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

function safeNumber(value: bigint): number {
  const result = Number(value);
  dataPlaneInvariant(Number.isSafeInteger(result), 'SPOOL_FILE_TOO_LARGE');
  return result;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export class SpoolManager {
  readonly root: string;
  private readonly now: () => Date;

  constructor(options: SpoolManagerOptions) {
    dataPlaneInvariant(path.isAbsolute(options.root), 'SPOOL_ROOT_NOT_ABSOLUTE');
    this.root = path.resolve(options.root);
    this.now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    const rootStat = await lstat(this.root);
    dataPlaneInvariant(
      rootStat.isDirectory() && !rootStat.isSymbolicLink(),
      'SPOOL_ROOT_TYPE_INVALID',
    );
  }

  async paths(jobId: string, objectId: string): Promise<SpoolPaths> {
    this.validateId(jobId);
    this.validateId(objectId);
    await this.initialize();
    const jobDirectory = this.inside(path.resolve(this.root, jobId));
    await mkdir(jobDirectory, { recursive: true, mode: 0o700 });
    await chmod(jobDirectory, 0o700);
    const jobStat = await lstat(jobDirectory);
    dataPlaneInvariant(
      jobStat.isDirectory() && !jobStat.isSymbolicLink(),
      'SPOOL_JOB_TYPE_INVALID',
    );
    return {
      jobDirectory,
      partPath: this.inside(path.resolve(jobDirectory, `${objectId}.part`)),
      readyPath: this.inside(path.resolve(jobDirectory, `${objectId}.ready`)),
    };
  }

  async assertPartialIdentity(
    partPath: string,
    expected: { device: string; inode: string; completedBytes: string },
  ): Promise<void> {
    const canonical = this.inside(path.resolve(partPath));
    dataPlaneInvariant(canonical === partPath, 'SPOOL_PART_PATH_INVALID');
    let current;
    try {
      current = await lstat(canonical, { bigint: true });
    } catch (error) {
      if (missing(error)) throw new ImportDataPlaneError('SPOOL_PART_MISSING');
      throw error;
    }
    dataPlaneInvariant(current.isFile() && !current.isSymbolicLink(), 'SPOOL_PART_TYPE_INVALID');
    dataPlaneInvariant(
      current.dev.toString() === expected.device &&
        current.ino.toString() === expected.inode &&
        current.size >= BigInt(expected.completedBytes),
      'SPOOL_PART_IDENTITY_CHANGED',
    );
  }

  async finalize(jobId: string, objectId: string, expectedSize: string): Promise<ReadyEvidence> {
    dataPlaneInvariant(/^(?:0|[1-9]\d*)$/.test(expectedSize), 'SPOOL_SIZE_INVALID');
    const paths = await this.paths(jobId, objectId);
    const readyExists = await lstat(paths.readyPath).then(
      () => true,
      (error: unknown) => {
        if (missing(error)) return false;
        throw error;
      },
    );
    const partExists = await lstat(paths.partPath).then(
      () => true,
      (error: unknown) => {
        if (missing(error)) return false;
        throw error;
      },
    );
    if (readyExists) {
      dataPlaneInvariant(!partExists, 'SPOOL_DUAL_LANDING');
      return this.readyEvidence(jobId, objectId, expectedSize);
    }
    if (!partExists) throw new ImportDataPlaneError('SPOOL_PART_MISSING');

    const part = await open(paths.partPath, fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0));
    let before;
    try {
      before = await part.stat({ bigint: true });
      dataPlaneInvariant(before.isFile(), 'SPOOL_PART_TYPE_INVALID');
      dataPlaneInvariant(before.size === BigInt(expectedSize), 'SPOOL_SIZE_MISMATCH');
      await part.sync();
    } finally {
      await part.close();
    }
    await rename(paths.partPath, paths.readyPath);
    await fsyncDirectory(paths.jobDirectory);
    const evidence = await this.readyEvidence(jobId, objectId, expectedSize);
    dataPlaneInvariant(
      evidence.device === before.dev.toString() && evidence.inode === before.ino.toString(),
      'SPOOL_RENAME_EVIDENCE_CHANGED',
    );
    return evidence;
  }

  async readyEvidence(
    jobId: string,
    objectId: string,
    expectedSize: string,
  ): Promise<ReadyEvidence> {
    const paths = await this.paths(jobId, objectId);
    let current;
    try {
      current = await stat(paths.readyPath, { bigint: true });
    } catch (error) {
      if (missing(error)) throw new ImportDataPlaneError('SPOOL_READY_MISSING');
      throw error;
    }
    dataPlaneInvariant(current.isFile(), 'SPOOL_READY_TYPE_INVALID');
    dataPlaneInvariant(current.size === BigInt(expectedSize), 'SPOOL_SIZE_MISMATCH');
    return {
      objectId,
      readyPath: paths.readyPath,
      size: current.size.toString(),
      device: current.dev.toString(),
      inode: current.ino.toString(),
      mtimeNs: current.mtimeNs.toString(),
      directorySyncedAt: this.now().toISOString(),
    };
  }

  async hashReady(evidence: ReadyEvidence): Promise<ReadyHash> {
    this.validateId(evidence.objectId);
    const readyPath = this.inside(path.resolve(evidence.readyPath));
    dataPlaneInvariant(readyPath === evidence.readyPath, 'SPOOL_EVIDENCE_PATH_INVALID');
    const handle = await open(readyPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat({ bigint: true });
      this.assertEvidence(evidence, before);
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let position = 0n;
      while (position < before.size) {
        const length = Math.min(buffer.byteLength, safeNumber(before.size - position));
        const read = await handle.read(buffer, 0, length, safeNumber(position));
        if (read.bytesRead === 0) throw new ImportDataPlaneError('SPOOL_HASH_SHORT_READ');
        hash.update(buffer.subarray(0, read.bytesRead));
        position += BigInt(read.bytesRead);
      }
      const after = await handle.stat({ bigint: true });
      this.assertEvidence(evidence, after);
      return {
        sha256: hash.digest('hex'),
        size: after.size.toString(),
        hashedAt: this.now().toISOString(),
      };
    } finally {
      await handle.close();
    }
  }

  async cleanup(permit: SpoolCleanupPermit): Promise<{ alreadyAbsent: boolean }> {
    dataPlaneInvariant(
      permit.recoveryState === 'CONTROL_PLANE_BACKED_UP' && permit.recoveryGenerationId.length > 0,
      'SPOOL_CLEANUP_GATE_MISSING',
    );
    dataPlaneInvariant(permit.objectId === permit.ready.objectId, 'SPOOL_CLEANUP_OBJECT_INVALID');
    const readyPath = this.inside(path.resolve(permit.ready.readyPath));
    let current;
    try {
      current = await lstat(readyPath, { bigint: true });
    } catch (error) {
      if (missing(error)) return { alreadyAbsent: true };
      throw error;
    }
    dataPlaneInvariant(!current.isSymbolicLink(), 'SPOOL_READY_TYPE_INVALID');
    this.assertEvidence(permit.ready, current);
    await rm(readyPath, { force: false });
    await fsyncDirectory(path.dirname(readyPath));
    return { alreadyAbsent: false };
  }

  private assertEvidence(
    evidence: ReadyEvidence,
    current: {
      isFile(): boolean;
      size: bigint;
      dev: bigint;
      ino: bigint;
      mtimeNs: bigint;
    },
  ): void {
    dataPlaneInvariant(current.isFile(), 'SPOOL_READY_TYPE_INVALID');
    dataPlaneInvariant(
      current.size.toString() === evidence.size &&
        current.dev.toString() === evidence.device &&
        current.ino.toString() === evidence.inode &&
        current.mtimeNs.toString() === evidence.mtimeNs,
      'SPOOL_EVIDENCE_CHANGED',
    );
  }

  private validateId(value: string): void {
    dataPlaneInvariant(UUID_PATTERN.test(value), 'SPOOL_ID_INVALID');
  }

  private inside(candidate: string): string {
    dataPlaneInvariant(candidate.startsWith(`${this.root}${path.sep}`), 'SPOOL_PATH_ESCAPE');
    return candidate;
  }
}
