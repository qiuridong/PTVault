import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { assertPassphraseEncryptedAge } from './escrow.js';
import type { RecoveryPreparationCoordinator } from './preparation-coordinator.js';
import type { RecoveryMaterialObserver } from './preparation-material.js';
import type { RecoveryPreparationStore } from './preparation-state.js';
import type { RecoveryPreparationRequests } from './preparation-requests.js';

export type MaterialWriteCheckpoint =
  'TEMP_WRITTEN' | 'TEMP_SYNCED' | 'JOURNAL_WRITTEN' | 'RENAMED' | 'DIRECTORY_SYNCED' | 'SETTLED';
type Options = {
  requests: RecoveryPreparationRequests;
  settlementCheckpoint?: () => void;
  store: RecoveryPreparationStore;
  observer: RecoveryMaterialObserver;
  coordinator: RecoveryPreparationCoordinator;
  checkpoint?: (point: MaterialWriteCheckpoint) => Promise<void>;
};
type Replacement = {
  bytes: Uint8Array;
  expectedMaterialRevision: number;
  operationId: string;
  signal: AbortSignal;
};

/** File publication is journaled before rename; startup recovery is explicitly separate from GET. */
export class RecoveryMaterialWriter {
  constructor(private readonly options: Options) {}

  async replace(input: Replacement): Promise<{ escrowSha256: string }> {
    return this.options.coordinator.withWrite(() => this.replaceLeased(input));
  }

  /** The HTTP owner holds the same exclusive lease from pre-MFA validation through completion. */
  async replaceLeased(input: Replacement): Promise<{ escrowSha256: string }> {
    const { store, observer } = this.options;
    const bytes = Buffer.from(input.bytes);
    assertPassphraseEncryptedAge(bytes);
    this.abort(input.signal);
    const previous = store.get();
    if (previous.materialRevision !== input.expectedMaterialRevision)
      throw new Error('RECOVERY_PREPARATION_STALE');
    if (previous.escrowState === 'UPDATING' || previous.escrowState === 'UNRESOLVED')
      throw new Error('RECOVERY_MATERIAL_UPDATE_PENDING');
    const escrowSha256 = createHash('sha256').update(bytes).digest('hex');
    let actual: string | null;
    try {
      actual = (await observer.read(input.signal)).sha256;
    } catch {
      actual = null;
    }
    this.abort(input.signal);
    if (previous.escrowState === 'STABLE' && actual !== previous.activeEscrowSha256)
      throw new Error('RECOVERY_ESCROW_CHANGED');
    if (actual !== null && previous.escrowState === 'UNINITIALIZED')
      throw new Error('RECOVERY_ESCROW_NOT_REGISTERED');
    if (actual === escrowSha256 && actual === previous.activeEscrowSha256) {
      if (this.options.requests.operation(input.operationId))
        this.options.requests.succeed(input.operationId, {
          escrowSha256,
          materialRevision: previous.materialRevision,
        });
      return { escrowSha256 };
    }

    await mkdir(observer.directory, { recursive: true, mode: 0o700 });
    const root = await lstat(observer.directory, { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('RECOVERY_ESCROW_UNSAFE');
    const canonical = await realpath(observer.directory);
    const temporary = path.join(canonical, `.escrow-${randomUUID()}.tmp`);
    let journaled = false;
    let renamed = false;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(bytes, { signal: input.signal });
        await this.checkpoint('TEMP_WRITTEN');
        await handle.sync();
        await this.checkpoint('TEMP_SYNCED');
      } finally {
        await handle.close();
      }
      this.abort(input.signal);
      const currentRoot = await lstat(observer.directory, { bigint: true });
      if (
        currentRoot.isSymbolicLink() ||
        !currentRoot.isDirectory() ||
        currentRoot.dev !== root.dev ||
        currentRoot.ino !== root.ino
      )
        throw new Error('RECOVERY_ESCROW_UNSAFE');
      store.beginEscrowUpdate({
        expectedMaterialRevision: input.expectedMaterialRevision,
        escrowSha256,
        operationId: input.operationId,
      });
      journaled = true;
      await this.checkpoint('JOURNAL_WRITTEN');
      this.abort(input.signal);
      await rename(temporary, path.join(canonical, 'escrow.age'));
      renamed = true;
      await this.checkpoint('RENAMED');
      await syncDirectory(canonical);
      await this.checkpoint('DIRECTORY_SYNCED');
      const published = await observer.read();
      if (published.sha256 !== escrowSha256) {
        this.settle(input.operationId, published.sha256);
        throw new Error('RECOVERY_ESCROW_CHANGED');
      }
      this.settle(input.operationId, published.sha256);
      await this.checkpoint('SETTLED');
      return { escrowSha256 };
    } catch (error) {
      if (journaled && !renamed) {
        let observed: string | null = null;
        try {
          observed = (await observer.read()).sha256;
        } catch {
          /* Keep unresolved evidence. */
        }
        this.settle(input.operationId, observed);
      }
      // After rename, an fsync/readback error remains UPDATING, not assumed durable.
      throw error;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async reconcileStartup(
    readOnly = false,
  ): Promise<'READ_ONLY' | 'NONE' | 'INITIALIZED' | 'UNAVAILABLE' | 'OLD' | 'NEW' | 'UNRESOLVED'> {
    if (readOnly) return 'READ_ONLY';
    return this.options.coordinator.withWrite(async () => {
      const { store, observer } = this.options;
      const current = store.get();
      this.options.requests.failUnpublishedStartup(current.pendingOperationId);
      if (current.escrowState === 'STABLE') return 'NONE';
      let actual: string | null = null;
      try {
        actual = (await observer.read()).sha256;
      } catch {
        /* Never infer bytes from pending metadata. */
      }
      if (current.escrowState === 'UNINITIALIZED') {
        if (actual === null) return 'UNAVAILABLE';
        store.initializeEscrow(actual);
        return 'INITIALIZED';
      }
      if (current.pendingOperationId === null) return 'UNRESOLVED';
      if (actual !== null) await syncDirectory(observer.directory);
      return this.settle(current.pendingOperationId, actual);
    });
  }

  private settle(operationId: string, actualSha256: string | null): 'NEW' | 'OLD' | 'UNRESOLVED' {
    const { requests, store } = this.options;
    return requests.atomic(() => {
      const request = requests.operation(operationId);
      if (request && request.operation !== 'ESCROW_REPLACE')
        throw new Error('RECOVERY_MATERIAL_OPERATION_MISMATCH');
      const result = store.resolveEscrowUpdate(operationId, actualSha256);
      if (request) {
        if (result === 'NEW')
          requests.succeed(operationId, {
            escrowSha256: actualSha256!,
            materialRevision: store.get().materialRevision,
          });
        else
          requests.fail(
            operationId,
            result === 'OLD' ? 'FAILED' : 'UNRESOLVED',
            result === 'OLD' ? 'RECOVERY_MATERIAL_NOT_PUBLISHED' : 'RECOVERY_ESCROW_CHANGED',
          );
      }
      this.options.settlementCheckpoint?.();
      return result;
    });
  }

  private async checkpoint(point: MaterialWriteCheckpoint): Promise<void> {
    await this.options.checkpoint?.(point);
  }

  private abort(signal: AbortSignal): void {
    if (signal.aborted) throw new Error('RECOVERY_MATERIAL_ABORTED');
  }
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    // Windows does not offer POSIX directory fsync through this API.
    if (process.platform !== 'win32') throw error;
  }
}
