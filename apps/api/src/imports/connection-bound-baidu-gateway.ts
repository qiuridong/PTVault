import { CloudProviderRateLimitError } from '../cloud-connections/rate-limit.js';
import type {
  CloudConnectionProviderSession,
  CloudConnectionTokenRefreshCoordinator,
} from '../cloud-connections/refresh-coordinator.js';
import type { CloudConnectionRateLimitAuthority } from '../cloud-connections/rate-limit.js';
import {
  BaiduApiError,
  type BaiduBrowseGateway,
  type BaiduDirectoryPage,
  type BaiduPlanningGateway,
  type BaiduSharePreview,
  type BaiduFileSnapshotInput,
  type BaiduNameSearchInput,
  type BaiduNameSearchPage,
} from './baidu-official-gateway.js';
import type {
  BaiduGateway,
  BaiduObjectSnapshot,
  BaiduTransferredObject,
} from './data-plane/baidu-source.js';
import type { DownloadLease } from './data-plane/range-downloader.js';
import type { BaiduDirectorySnapshot } from './source-manifest.js';
import type {
  ImportSourceCleanupProvider,
  ImportSourceCleanupProviderReceipt,
  ImportSourceSnapshot,
} from './source-cleanup.js';

export type ConnectionBoundBaiduGatewayFactory = (session: {
  appId: string | null;
  accessToken: string;
}) => BaiduGateway &
  BaiduPlanningGateway &
  BaiduBrowseGateway &
  Partial<ImportSourceCleanupProvider>;

export type ConnectionBoundBaiduGatewayOptions = {
  connectionId: string;
  externalAccountId: string;
  appId: string | null;
  refresh: Pick<CloudConnectionTokenRefreshCoordinator, 'getSession'>;
  appIdForSession?: (session: CloudConnectionProviderSession) => string | null;
  rateLimits: Pick<CloudConnectionRateLimitAuthority, 'runProviderOperation'>;
  createGateway: ConnectionBoundBaiduGatewayFactory;
};

/**
 * Fetches a fresh connection session for every logical provider operation and
 * binds the call to its revision/secret authority. No token or gateway cache is
 * shared with another connection.
 */
export class ConnectionBoundBaiduGateway
  implements BaiduGateway, BaiduPlanningGateway, BaiduBrowseGateway, ImportSourceCleanupProvider
{
  constructor(private readonly options: ConnectionBoundBaiduGatewayOptions) {}

  previewShare(input: {
    sanitizedShareUrl: string;
    extractionCode: string | null;
    signal?: AbortSignal;
  }): Promise<BaiduSharePreview> {
    return this.run((gateway) => gateway.previewShare(input));
  }

  listAppDirectory(input: {
    sourcePath: string;
    signal?: AbortSignal;
  }): Promise<BaiduTransferredObject[]> {
    return this.run((gateway) => gateway.listAppDirectory(input));
  }

  snapshotAppDirectory(input: {
    sourcePath: string;
    signal?: AbortSignal;
  }): Promise<BaiduDirectorySnapshot> {
    return this.run((gateway) => {
      if (gateway.snapshotAppDirectory === undefined)
        throw new BaiduApiError('IMPORT_SOURCE_MANIFEST_REQUIRED', null);
      return gateway.snapshotAppDirectory(input);
    });
  }

  browseDirectory(input: {
    path: string;
    start: number;
    limit: number;
    signal?: AbortSignal;
  }): Promise<BaiduDirectoryPage> {
    return this.run((gateway) => gateway.browseDirectory(input));
  }

  searchDirectory(input: BaiduNameSearchInput): Promise<BaiduNameSearchPage> {
    return this.run((gateway) => {
      if (gateway.searchDirectory === undefined)
        throw new BaiduApiError('BAIDU_SEARCH_NOT_CONFIGURED', null);
      return gateway.searchDirectory(input);
    });
  }

  transferShare(input: {
    sourceManifestDigest?: string;
    jobId: string;
    sanitizedShareUrl: string;
    extractionCode: string | null;
    destinationRoot: string;
    signal?: AbortSignal;
  }): Promise<{ transferId: string }> {
    return this.run((gateway) => gateway.transferShare(input));
  }

  confirmShareTransfer(input: {
    transferId: string;
    destinationRoot: string;
    signal?: AbortSignal;
  }): Promise<BaiduTransferredObject[]> {
    return this.run((gateway) => gateway.confirmShareTransfer(input));
  }

  snapshotFile(input: BaiduFileSnapshotInput): Promise<BaiduTransferredObject> {
    return this.run((gateway) => {
      if (gateway.snapshotFile === undefined)
        throw new BaiduApiError('IMPORT_SOURCE_MANIFEST_REQUIRED', null);
      return gateway.snapshotFile(input);
    });
  }

  statObject(fsid: string, signal?: AbortSignal): Promise<BaiduObjectSnapshot> {
    return this.run((gateway) => gateway.statObject(fsid, signal));
  }

  createDownloadLease(fsid: string, signal?: AbortSignal): Promise<DownloadLease> {
    return this.run((gateway) => gateway.createDownloadLease(fsid, signal));
  }

  createFileDownloadLease(input: BaiduFileSnapshotInput): Promise<DownloadLease> {
    return this.run((gateway) => {
      if (gateway.createFileDownloadLease === undefined)
        throw new BaiduApiError('IMPORT_SOURCE_MANIFEST_REQUIRED', null);
      return gateway.createFileDownloadLease(input);
    });
  }

  statSourceObject(fsid: string, signal?: AbortSignal): Promise<ImportSourceSnapshot | null> {
    return this.run((gateway) => {
      if (gateway.statSourceObject === undefined) {
        throw new BaiduApiError('BAIDU_SOURCE_CLEANUP_NOT_CONFIGURED', null);
      }
      return gateway.statSourceObject(fsid, signal);
    });
  }

  deleteToRecycleBin(input: {
    fsid: string;
    path: string;
    idempotencyKey: string;
    signal?: AbortSignal;
    beforeDelete?: () => void;
    expectedSource?: ImportSourceSnapshot;
  }): Promise<ImportSourceCleanupProviderReceipt> {
    return this.run((gateway) => {
      if (gateway.deleteToRecycleBin === undefined) {
        throw new BaiduApiError('BAIDU_SOURCE_CLEANUP_NOT_CONFIGURED', null);
      }
      return gateway.deleteToRecycleBin(input);
    });
  }

  lookupRecycleBinReceipt(
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ImportSourceCleanupProviderReceipt | null> {
    return this.run((gateway) =>
      gateway.lookupRecycleBinReceipt === undefined
        ? Promise.resolve(null)
        : gateway.lookupRecycleBinReceipt(idempotencyKey, signal),
    );
  }

  private async run<T>(
    operation: (
      gateway: BaiduGateway &
        BaiduPlanningGateway &
        BaiduBrowseGateway &
        Partial<ImportSourceCleanupProvider>,
    ) => Promise<T>,
  ): Promise<T> {
    const session = await this.options.refresh.getSession(this.options.connectionId);
    this.assertSession(session);
    try {
      return await this.options.rateLimits.runProviderOperation(
        {
          connectionId: session.connectionId,
          provider: 'BAIDU',
          connectionRevision: session.connectionRevision,
          secretRefId: session.secretRefId,
        },
        async () => {
          try {
            return await operation(
              this.options.createGateway({
                appId: this.options.appIdForSession ? this.options.appIdForSession(session) : this.options.appId,
                accessToken: session.accessToken,
              }),
            );
          } catch (error) {
            if (error instanceof BaiduApiError && error.code === 'RATE_LIMITED') {
              const retryAfter =
                error.retryAfterMs === null
                  ? undefined
                  : String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000)));
              throw new CloudProviderRateLimitError(retryAfter);
            }
            throw error;
          }
        },
      );
    } catch (error) {
      if (error instanceof CloudProviderRateLimitError) {
        const seconds = error.retryAfter === undefined ? Number.NaN : Number(error.retryAfter);
        throw new BaiduApiError(
          'RATE_LIMITED',
          Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1_000 : null,
        );
      }
      throw error;
    }
  }

  private assertSession(session: CloudConnectionProviderSession): void {
    if (
      session.connectionId !== this.options.connectionId ||
      session.provider !== 'BAIDU' ||
      session.externalAccountId !== this.options.externalAccountId
    ) {
      throw new BaiduApiError('AUTH_IDENTITY_DRIFT', null);
    }
  }
}
