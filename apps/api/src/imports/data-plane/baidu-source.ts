import type { ImportSecretStore } from '../secret-store.js';
import { createHash } from 'node:crypto';
import {
  buildSourceManifest,
  buildFileSourceManifest,
  sourceManifestDigest,
  type BaiduDirectorySnapshot,
} from '../source-manifest.js';
import type { BaiduSharePreview, BaiduFileSnapshotInput } from '../baidu-official-gateway.js';
import { ImportControlError } from '../errors.js';
import { sanitizeBaiduShareReference } from '../share-reference.js';
import type { DiscoveredImportObject, ImportWorkerJob } from '../worker-repository.js';
import { dataPlaneInvariant, ImportDataPlaneError } from './errors.js';
import type { DownloadLease } from './range-downloader.js';
import type { ImportDataPlaneSource, ImportObjectTask, SourcePreflightResult } from './types.js';

export type BaiduTransferredObject = {
  fsid: string;
  relativePath: string;
  size: string;
  mtime: string;
  md5?: string;
};

export type BaiduObjectSnapshot = {
  fsid: string;
  size: string;
  mtime: string;
  path?: string;
  isDirectory?: boolean;
};

export interface BaiduGateway {
  snapshotFile?(input: BaiduFileSnapshotInput): Promise<BaiduTransferredObject>;
  createFileDownloadLease?(input: BaiduFileSnapshotInput): Promise<DownloadLease>;
  previewShare?(input: {
    sanitizedShareUrl: string;
    extractionCode: string | null;
    signal?: AbortSignal;
  }): Promise<BaiduSharePreview>;
  snapshotAppDirectory?(input: {
    sourcePath: string;
    signal?: AbortSignal;
  }): Promise<BaiduDirectorySnapshot>;
  transferShare(input: {
    sourceManifestDigest?: string;
    jobId: string;
    sanitizedShareUrl: string;
    extractionCode: string | null;
    destinationRoot: string;
    signal?: AbortSignal;
  }): Promise<{ transferId: string }>;
  confirmShareTransfer(input: {
    transferId: string;
    destinationRoot: string;
    signal?: AbortSignal;
  }): Promise<BaiduTransferredObject[]>;
  listAppDirectory?(input: {
    sourcePath: string;
    signal?: AbortSignal;
  }): Promise<BaiduTransferredObject[]>;
  statObject(fsid: string, signal?: AbortSignal): Promise<BaiduObjectSnapshot>;
  createDownloadLease(fsid: string, signal?: AbortSignal): Promise<DownloadLease>;
}

export type BaiduTransferState = 'SUBMITTED' | 'CONFIRMED' | 'FAILED';

export type BaiduTransferReceipt = {
  transferId: string;
  destinationRoot: string;
  attempt: number;
  state: BaiduTransferState;
};

export interface BaiduTransferJournal {
  sourceTransfer(jobId: string): BaiduTransferReceipt | null;
  recordSourceTransfer(
    input: BaiduTransferReceipt & { jobId: string },
  ): BaiduTransferReceipt | void | Promise<BaiduTransferReceipt | void>;
}

export type BaiduImportSourceOptions = {
  gateway: BaiduGateway;
  secrets: Pick<ImportSecretStore, 'read' | 'delete'>;
  destinationRoot?: string;
  allowedHosts?: readonly string[];
  transferJournal?: BaiduTransferJournal;
};

function decimal(value: string): void {
  dataPlaneInvariant(/^(?:0|[1-9]\d*)$/.test(value), 'BAIDU_DECIMAL_INVALID');
}

function safeRelativePath(value: string): void {
  dataPlaneInvariant(
    value.length > 0 &&
      !value.startsWith('/') &&
      !value.startsWith('\\') &&
      !value.includes('\0') &&
      value
        .replaceAll('\\', '/')
        .split('/')
        .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'),
    'BAIDU_OBJECT_PATH_INVALID',
  );
}

function selectionObject(job: ImportWorkerJob): Record<string, unknown> {
  dataPlaneInvariant(
    typeof job.selection === 'object' && job.selection !== null && !Array.isArray(job.selection),
    'BAIDU_SELECTION_INVALID',
  );
  return job.selection as Record<string, unknown>;
}

/**
 * Baidu boundary used by the integrated worker. Protected-share passcodes are
 * read only for the gateway call, while SQLite receives only the opaque ref.
 */
export class BaiduImportSource implements ImportDataPlaneSource {
  private readonly gateway: BaiduGateway;
  private readonly secrets: Pick<ImportSecretStore, 'read' | 'delete'>;
  private readonly destinationRoot: string;
  private readonly allowedHosts: readonly string[];
  private readonly transferJournal: BaiduTransferJournal | undefined;

  constructor(options: BaiduImportSourceOptions) {
    this.gateway = options.gateway;
    this.secrets = options.secrets;
    this.destinationRoot = options.destinationRoot ?? '/apps/bdpan/ptvault-imports';
    this.allowedHosts = options.allowedHosts ?? ['pan.baidu.com'];
    this.transferJournal = options.transferJournal;
    dataPlaneInvariant(
      this.destinationRoot.startsWith('/apps/bdpan/') &&
        !this.destinationRoot.includes('\0') &&
        !this.destinationRoot.split('/').includes('..'),
      'BAIDU_DESTINATION_ROOT_INVALID',
    );
  }

  async discover(job: ImportWorkerJob, signal?: AbortSignal): Promise<DiscoveredImportObject[]> {
    try {
      return await this.discoverObjects(job, signal);
    } catch (error) {
      if (error instanceof ImportControlError && error.code === 'IMPORT_SOURCE_MANIFEST_INVALID') {
        throw new ImportDataPlaneError('SOURCE_CHANGED');
      }
      throw error;
    }
  }

  private async discoverObjects(
    job: ImportWorkerJob,
    signal?: AbortSignal,
  ): Promise<DiscoveredImportObject[]> {
    const selection = selectionObject(job);
    const manifest = job.sourceManifest;
    if (manifest != null)
      dataPlaneInvariant(
        sourceManifestDigest(manifest) === job.sourceManifestDigest,
        'SOURCE_CHANGED',
      );
    if (job.sourceConnectionId != null && (manifest == null || job.sourceManifestDigest == null)) {
      throw new ImportDataPlaneError('IMPORT_SOURCE_MANIFEST_REQUIRED');
    }
    let objects: BaiduTransferredObject[];
    if (job.sourceKind === 'BAIDU_SHARE') {
      dataPlaneInvariant(
        typeof selection.sanitizedShareUrl === 'string',
        'BAIDU_SHARE_SELECTION_INVALID',
      );
      const reference = sanitizeBaiduShareReference(selection.sanitizedShareUrl, this.allowedHosts);
      dataPlaneInvariant(
        reference.inlinePasscode === null && reference.sanitizedUrl === selection.sanitizedShareUrl,
        'BAIDU_SHARE_NOT_SANITIZED',
      );
      const extractionCode = job.secretRef === null ? null : this.secrets.read(job.secretRef);
      const destinationRoot = `${this.destinationRoot}/${job.jobId}`;
      let started = this.transferJournal?.sourceTransfer(job.jobId) ?? null;
      if (started !== null) {
        dataPlaneInvariant(
          started.state !== 'FAILED' && started.destinationRoot === destinationRoot,
          'BAIDU_TRANSFER_RECEIPT_CONFLICT',
        );
      } else {
        if (manifest != null) {
          dataPlaneInvariant(
            this.gateway.previewShare !== undefined,
            'IMPORT_SOURCE_MANIFEST_REQUIRED',
          );
          const preview = await this.gateway.previewShare({
            sanitizedShareUrl: reference.sanitizedUrl,
            extractionCode,
            ...(signal === undefined ? {} : { signal }),
          });
          dataPlaneInvariant(preview.directories !== undefined, 'IMPORT_SOURCE_MANIFEST_REQUIRED');
          const current = buildSourceManifest(
            'BAIDU_SHARE',
            '/',
            createHash('sha256').update(reference.sanitizedUrl).digest('hex'),
            { objects: preview.objects, directories: preview.directories },
          );
          dataPlaneInvariant(
            sourceManifestDigest(current) === job.sourceManifestDigest,
            'SOURCE_CHANGED',
          );
        }
        const submitted = await this.gateway.transferShare({
          ...(job.sourceManifestDigest == null
            ? {}
            : { sourceManifestDigest: job.sourceManifestDigest }),
          jobId: job.jobId,
          sanitizedShareUrl: reference.sanitizedUrl,
          extractionCode,
          destinationRoot,
          ...(signal === undefined ? {} : { signal }),
        });
        started = {
          transferId: submitted.transferId,
          destinationRoot,
          attempt: job.attempt,
          state: 'SUBMITTED',
        };
        await this.transferJournal?.recordSourceTransfer({ jobId: job.jobId, ...started });
      }
      dataPlaneInvariant(started.transferId.length > 0, 'BAIDU_TRANSFER_RECEIPT_INVALID');
      try {
        objects = await this.gateway.confirmShareTransfer({
          transferId: started.transferId,
          destinationRoot,
          ...(signal === undefined ? {} : { signal }),
        });
        await this.transferJournal?.recordSourceTransfer({
          jobId: job.jobId,
          attempt: job.attempt,
          transferId: started.transferId,
          destinationRoot,
          state: 'CONFIRMED',
        });
      } catch (error) {
        if (error instanceof ImportDataPlaneError && error.code === 'BAIDU_TRANSFER_FAILED') {
          await this.transferJournal?.recordSourceTransfer({
            jobId: job.jobId,
            attempt: job.attempt,
            transferId: started.transferId,
            destinationRoot,
            state: 'FAILED',
          });
        }
        throw error;
      }
    } else if (job.sourceKind === 'BAIDU_APP_DIR') {
      dataPlaneInvariant(typeof selection.sourcePath === 'string', 'BAIDU_PATH_SELECTION_INVALID');
      if (manifest?.version === 4 || selection.sourceScope === 'GROUP') {
        dataPlaneInvariant(
          manifest?.version === 4 &&
            selection.sourceScope === 'GROUP' &&
            manifest.rootPath === selection.sourcePath &&
            this.gateway.snapshotFile !== undefined,
          'IMPORT_SOURCE_MANIFEST_REQUIRED',
        );
        // V4 freezes a subset, not a claim that its parent directory is otherwise empty.
        // An unrelated group's change cannot invalidate this group. Ancestor identity
        // and every selected file remain exact; directory mtime is deliberately not a content proof.
        for (const directory of manifest.directories) {
          const current = await this.gateway.statObject(directory.fsid, signal);
          dataPlaneInvariant(
            current.fsid === directory.fsid &&
              current.path === directory.path &&
              current.isDirectory === true,
            'SOURCE_CHANGED',
          );
        }
        objects = [];
        for (const expected of manifest.objects) {
          const current = await this.gateway.snapshotFile({
            sourcePath: expected.path,
            expectedFile: { fsid: expected.fsid, size: expected.size, mtime: expected.mtime },
            ...(signal === undefined ? {} : { signal }),
          });
          dataPlaneInvariant(
            current.fsid === expected.fsid &&
              current.size === expected.size &&
              current.mtime === expected.mtime &&
              (expected.md5 === undefined || current.md5?.toLowerCase() === expected.md5),
            'SOURCE_CHANGED',
          );
          objects.push({ ...current, relativePath: expected.relativePath });
        }
      } else if (selection.sourceScope === 'FILE' || manifest?.version === 2) {
        dataPlaneInvariant(
          selection.sourceScope === 'FILE' &&
            manifest?.version === 2 &&
            this.gateway.snapshotFile !== undefined,
          'IMPORT_SOURCE_MANIFEST_REQUIRED',
        );
        dataPlaneInvariant(manifest.rootPath === selection.sourcePath, 'SOURCE_CHANGED');
        const expected = manifest.objects[0]!;
        const object = await this.gateway.snapshotFile({
          sourcePath: manifest.rootPath,
          expectedFile: { fsid: expected.fsid, size: expected.size, mtime: expected.mtime },
          ...(signal === undefined ? {} : { signal }),
        });
        const current = buildFileSourceManifest(manifest.rootPath, object);
        dataPlaneInvariant(
          sourceManifestDigest(current) === job.sourceManifestDigest,
          'SOURCE_CHANGED',
        );
        objects = [object];
      } else if (manifest != null) {
        dataPlaneInvariant(
          this.gateway.snapshotAppDirectory !== undefined,
          'IMPORT_SOURCE_MANIFEST_REQUIRED',
        );
        const snapshot = await this.gateway.snapshotAppDirectory({
          sourcePath: selection.sourcePath,
          ...(signal === undefined ? {} : { signal }),
        });
        const root = snapshot.directories.find((entry) => entry.path === selection.sourcePath);
        dataPlaneInvariant(root !== undefined, 'SOURCE_CHANGED');
        const current = buildSourceManifest(
          'BAIDU_APP_DIR',
          selection.sourcePath,
          root.fsid,
          snapshot,
        );
        dataPlaneInvariant(
          sourceManifestDigest(current) === job.sourceManifestDigest,
          'SOURCE_CHANGED',
        );
        objects = snapshot.objects;
      } else {
        dataPlaneInvariant(
          this.gateway.listAppDirectory !== undefined,
          'BAIDU_APP_DIR_NOT_CONFIGURED',
        );
        objects = await this.gateway.listAppDirectory({
          sourcePath: selection.sourcePath,
          ...(signal === undefined ? {} : { signal }),
        });
      }
    } else {
      throw new ImportDataPlaneError('IMPORT_SOURCE_NOT_SUPPORTED');
    }
    dataPlaneInvariant(objects.length === job.objectCount, 'BAIDU_DISCOVERY_COUNT_MISMATCH');
    if (manifest != null && job.sourceKind === 'BAIDU_SHARE') {
      // A provider transfer creates new fsids. Freeze original fsids before the transfer,
      // then match the copied content to that manifest, not merely count and total bytes.
      const expectedByPath = new Map(manifest.objects.map((entry) => [entry.relativePath, entry]));
      for (const object of objects) {
        const expected = expectedByPath.get(object.relativePath);
        dataPlaneInvariant(
          expected !== undefined &&
            expected.size === object.size &&
            (expected.md5 === undefined || expected.md5 === object.md5?.toLowerCase()),
          'SOURCE_CHANGED',
        );
      }
      dataPlaneInvariant(
        new Set(objects.map((object) => object.relativePath)).size === objects.length,
        'SOURCE_CHANGED',
      );
    }
    const seen = new Set<string>();
    let total = 0n;
    return objects
      .map((object) => {
        decimal(object.fsid);
        decimal(object.size);
        safeRelativePath(object.relativePath);
        dataPlaneInvariant(!seen.has(object.fsid), 'BAIDU_DISCOVERY_DUPLICATE_FSID');
        if (object.md5 !== undefined) {
          dataPlaneInvariant(/^[0-9a-f]{32}$/i.test(object.md5), 'BAIDU_OBJECT_MD5_INVALID');
        }
        seen.add(object.fsid);
        total += BigInt(object.size);
        return {
          jobId: job.jobId,
          sourceFsid: object.fsid,
          relativePath: object.relativePath,
          sourceSize: object.size,
          sourceMtime: object.mtime,
          ...(object.md5 === undefined ? {} : { sourceReportedMd5: object.md5 }),
        };
      })
      .map((object, index, all) => {
        if (index === all.length - 1) {
          dataPlaneInvariant(total === BigInt(job.jobBytesTotal), 'BAIDU_DISCOVERY_BYTES_MISMATCH');
        }
        return object;
      });
  }

  preflight(task: ImportObjectTask, signal?: AbortSignal): Promise<SourcePreflightResult> {
    return this.preflightObject(task, signal);
  }

  releaseCredential(job: ImportWorkerJob): void {
    if (job.secretRef !== null) this.secrets.delete(job.secretRef);
  }

  private async preflightObject(
    task: ImportObjectTask,
    signal?: AbortSignal,
  ): Promise<SourcePreflightResult> {
    if (task.sourceScope === 'FILE') {
      dataPlaneInvariant(
        task.sourcePath !== undefined &&
          this.gateway.snapshotFile !== undefined &&
          this.gateway.createFileDownloadLease !== undefined,
        'IMPORT_SOURCE_MANIFEST_REQUIRED',
      );
      const input: BaiduFileSnapshotInput = {
        sourcePath: task.sourcePath,
        expectedFile: { fsid: task.sourceFsid, size: task.sourceSize, mtime: task.sourceMtime },
        ...(signal === undefined ? {} : { signal }),
      };
      const snapshot = await this.gateway.snapshotFile(input);
      dataPlaneInvariant(
        snapshot.fsid === task.sourceFsid &&
          snapshot.size === task.sourceSize &&
          snapshot.mtime === task.sourceMtime,
        'SOURCE_CHANGED',
      );
      const lease = await this.gateway.createFileDownloadLease(input);
      dataPlaneInvariant(lease.expectedSize === task.sourceSize, 'SOURCE_CHANGED');
      return {
        lease,
        sourceSnapshot: { fsid: snapshot.fsid, size: snapshot.size, mtime: snapshot.mtime },
      };
    }
    const snapshot = await this.gateway.statObject(task.sourceFsid, signal);
    dataPlaneInvariant(
      snapshot.fsid === task.sourceFsid &&
        (task.sourcePath === undefined || task.sourcePath === snapshot.path) &&
        snapshot.size === task.sourceSize &&
        snapshot.mtime === task.sourceMtime,
      'SOURCE_CHANGED',
    );
    const lease = await this.gateway.createDownloadLease(task.sourceFsid, signal);
    dataPlaneInvariant(lease.expectedSize === task.sourceSize, 'SOURCE_CHANGED');
    return { lease, sourceSnapshot: snapshot };
  }
}
