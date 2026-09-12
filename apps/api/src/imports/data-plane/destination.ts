import { createHash } from 'node:crypto';

import { dataPlaneInvariant, ImportDataPlaneError } from './errors.js';

export type DestinationObjectStat = {
  size: string;
  providerRequestId?: string;
};

export type DestinationMoveReceipt = { providerRequestId?: string };

export interface DestinationTransport {
  stat(key: string, signal?: AbortSignal): Promise<DestinationObjectStat | null>;
  upload(localPath: string, key: string, signal?: AbortSignal): Promise<void>;
  read(key: string, signal?: AbortSignal): AsyncIterable<Uint8Array>;
  move(
    sourceKey: string,
    destinationKey: string,
    signal?: AbortSignal,
  ): Promise<DestinationMoveReceipt>;
}

export type DestinationReceipt =
  | {
      kind: 'STAGING_UPLOADED';
      key: string;
      size: string;
      providerRequestId?: string;
    }
  | { kind: 'STAGING_VERIFIED'; key: string; size: string; sha256: string }
  | {
      kind: 'COMMITTED';
      key: string;
      size: string;
      providerRequestId?: string;
      reconciled: boolean;
    }
  | {
      kind: 'COMMITTED_VERIFIED';
      key: string;
      size: string;
      sha256: string;
      reconciled: boolean;
    };

export type DestinationStage =
  'UPLOADING_STAGING' | 'STAGING_READBACK' | 'COMMITTING' | 'COMMITTED_READBACK';

export type VerifiedCommitOptions = {
  localReadyPath: string;
  expectedSize: string;
  expectedSha256: string;
  stagingKey: string;
  committedKey: string;
  reconcileCommittedFirst: boolean;
  signal?: AbortSignal;
  onStage?: (stage: DestinationStage) => void | Promise<void>;
  onDurableReceipt?: (receipt: DestinationReceipt) => void | Promise<void>;
  /** Permit boundary around the upload body only; probes/readbacks/move stay outside. */
  withStagingUpload?: <T>(body: () => Promise<T>) => Promise<T>;
};

export type VerifiedCommitResult = {
  committedKey: string;
  size: string;
  sha256: string;
  alreadyCommitted: boolean;
};

export class DestinationError extends ImportDataPlaneError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'DestinationError';
  }
}

function decimal(value: string): bigint {
  dataPlaneInvariant(/^(?:0|[1-9]\d*)$/.test(value), 'DESTINATION_DECIMAL_INVALID');
  return BigInt(value);
}

function validateKey(value: string): string {
  dataPlaneInvariant(
    value.length > 0 &&
      value.length <= 4096 &&
      !value.startsWith('/') &&
      !value.endsWith('/') &&
      !value.includes('\\') &&
      !value.includes('\0') &&
      value
        .split('/')
        .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'),
    'DESTINATION_KEY_INVALID',
  );
  return value;
}

export class VerifiedDestinationAdapter {
  constructor(private readonly transport: DestinationTransport) {}

  async commit(options: VerifiedCommitOptions): Promise<VerifiedCommitResult> {
    for (let handoff = 0; ; handoff++) {
      options.signal?.throwIfAborted();
      try {
        return await this.commitOnce({
          ...options,
          reconcileCommittedFirst: handoff > 0 || options.reconcileCommittedFirst,
        });
      } catch (error) {
        options.signal?.throwIfAborted();
        // Native token CAS collisions are not revocations. The failed process
        // has drained its private lease; each transport call captures the latest
        // authority again. Re-enter at object reconciliation (including complete
        // readback/hash), never append a restarted stream or blindly redo a move.
        if (
          handoff >= 2 ||
          error === null ||
          typeof error !== 'object' ||
          !('code' in error) ||
          error.code !== 'RCLONE_CONFIG_TOKEN_SUPERSEDED'
        )
          throw error;
      }
    }
  }

  private async commitOnce(options: VerifiedCommitOptions): Promise<VerifiedCommitResult> {
    const expectedSize = decimal(options.expectedSize);
    dataPlaneInvariant(/^[a-f0-9]{64}$/.test(options.expectedSha256), 'DESTINATION_HASH_INVALID');
    const stagingKey = validateKey(options.stagingKey);
    const committedKey = validateKey(options.committedKey);
    dataPlaneInvariant(stagingKey !== committedKey, 'DESTINATION_KEY_COLLISION');

    if (options.reconcileCommittedFirst) {
      const existing = await this.transport.stat(committedKey, options.signal);
      if (existing !== null) {
        await options.onStage?.('COMMITTING');
        this.verifyStat(existing, expectedSize, 'DESTINATION_COMMITTED_SIZE_MISMATCH');
        await options.onDurableReceipt?.({
          kind: 'COMMITTED',
          key: committedKey,
          size: existing.size,
          ...(existing.providerRequestId === undefined
            ? {}
            : { providerRequestId: existing.providerRequestId }),
          reconciled: true,
        });
        return this.verifyCommitted(options, committedKey, expectedSize, true);
      }
    }

    await options.onStage?.('UPLOADING_STAGING');
    let stagingStat = await this.transport.stat(stagingKey, options.signal);
    if (stagingStat === null) {
      const upload = () =>
        this.transport.upload(options.localReadyPath, stagingKey, options.signal);
      await (options.withStagingUpload === undefined
        ? upload()
        : options.withStagingUpload(upload));
      stagingStat = await this.transport.stat(stagingKey, options.signal);
    }
    if (stagingStat === null) {
      throw new DestinationError('DESTINATION_STAGING_MISSING', 'Staging object is missing');
    }
    this.verifyStat(stagingStat, expectedSize, 'DESTINATION_STAGING_SIZE_MISMATCH');
    await options.onDurableReceipt?.({
      kind: 'STAGING_UPLOADED',
      key: stagingKey,
      size: stagingStat.size,
      ...(stagingStat.providerRequestId === undefined
        ? {}
        : { providerRequestId: stagingStat.providerRequestId }),
    });
    await options.onStage?.('STAGING_READBACK');
    const stagingVerified = await this.readback(
      stagingKey,
      expectedSize,
      options.expectedSha256,
      options.signal,
    );
    await options.onDurableReceipt?.({
      kind: 'STAGING_VERIFIED',
      key: stagingKey,
      size: stagingVerified.size,
      sha256: stagingVerified.sha256,
    });

    await options.onStage?.('COMMITTING');
    let reconciled = false;
    let moveReceipt: DestinationMoveReceipt = {};
    const raced = await this.transport.stat(committedKey, options.signal);
    if (raced !== null) {
      this.verifyStat(raced, expectedSize, 'DESTINATION_COMMITTED_SIZE_MISMATCH');
      reconciled = true;
    } else {
      try {
        moveReceipt = await this.transport.move(stagingKey, committedKey, options.signal);
      } catch (error) {
        const afterError = await this.transport.stat(committedKey, options.signal);
        if (afterError === null) throw error;
        this.verifyStat(afterError, expectedSize, 'DESTINATION_COMMITTED_SIZE_MISMATCH');
        reconciled = true;
      }
    }

    const committedStat = await this.transport.stat(committedKey, options.signal);
    if (committedStat === null) {
      throw new DestinationError('DESTINATION_COMMIT_MISSING', 'Committed object is missing');
    }
    this.verifyStat(committedStat, expectedSize, 'DESTINATION_COMMITTED_SIZE_MISMATCH');
    const providerRequestId = moveReceipt.providerRequestId ?? committedStat.providerRequestId;
    await options.onDurableReceipt?.({
      kind: 'COMMITTED',
      key: committedKey,
      size: committedStat.size,
      ...(providerRequestId === undefined ? {} : { providerRequestId }),
      reconciled,
    });
    return this.verifyCommitted(options, committedKey, expectedSize, reconciled);
  }

  private async verifyCommitted(
    options: VerifiedCommitOptions,
    committedKey: string,
    expectedSize: bigint,
    reconciled: boolean,
  ): Promise<VerifiedCommitResult> {
    await options.onStage?.('COMMITTED_READBACK');
    const verified = await this.readback(
      committedKey,
      expectedSize,
      options.expectedSha256,
      options.signal,
    );
    await options.onDurableReceipt?.({
      kind: 'COMMITTED_VERIFIED',
      key: committedKey,
      size: verified.size,
      sha256: verified.sha256,
      reconciled,
    });
    return {
      committedKey,
      size: verified.size,
      sha256: verified.sha256,
      alreadyCommitted: reconciled,
    };
  }

  private verifyStat(stat: DestinationObjectStat, expected: bigint, code: string): void {
    if (decimal(stat.size) !== expected) throw new DestinationError(code, 'Object size mismatch');
  }

  private async readback(
    key: string,
    expectedSize: bigint,
    expectedSha256: string,
    signal: AbortSignal | undefined,
  ): Promise<{ size: string; sha256: string }> {
    const hash = createHash('sha256');
    let bytes = 0n;
    try {
      for await (const chunk of this.transport.read(key, signal)) {
        dataPlaneInvariant(chunk.byteLength > 0, 'DESTINATION_READ_EMPTY');
        bytes += BigInt(chunk.byteLength);
        if (bytes > expectedSize) {
          throw new DestinationError('DESTINATION_HASH_MISMATCH', 'Readback exceeded size');
        }
        hash.update(chunk);
      }
    } catch (error) {
      if (error instanceof ImportDataPlaneError) throw error;
      throw new DestinationError('DESTINATION_READ_FAILED', 'Destination readback failed');
    }
    const sha256 = hash.digest('hex');
    if (bytes !== expectedSize || sha256 !== expectedSha256) {
      throw new DestinationError('DESTINATION_HASH_MISMATCH', 'Destination hash mismatch');
    }
    return { size: bytes.toString(), sha256 };
  }
}
