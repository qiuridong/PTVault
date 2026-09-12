import type {
  BaiduConnectionBrowseResponse,
  BaiduConnectionSearchQuery,
  BaiduConnectionSearchResponse,
} from '@ptvault/contracts';

import type { AppDatabase } from '../db/database.js';
import { BaiduApiError, type BaiduBrowseGateway } from '../imports/baidu-official-gateway.js';

type BrowsableConnection = {
  id: string;
  provider: string;
  externalAccountId: string;
  authState: string;
  secretRef: string | null;
  capabilitiesJson: string;
};

export type BaiduBrowseGatewayFactory = (binding: {
  connectionId: string;
  externalAccountId: string;
}) => BaiduBrowseGateway;

/** Read-only browse facade bound to one persisted Cloud Connection identity. */
export class BaiduConnectionBrowseService {
  constructor(
    private readonly db: AppDatabase,
    private readonly createGateway: BaiduBrowseGatewayFactory,
  ) {}

  async browse(input: {
    connectionId: string;
    path: string;
    start: number;
    limit: number;
    signal?: AbortSignal;
  }): Promise<BaiduConnectionBrowseResponse> {
    const connection = this.connection(input.connectionId);
    const gateway = this.createGateway({
      connectionId: connection.id,
      externalAccountId: connection.externalAccountId,
    });
    const page = await gateway.browseDirectory({
      path: input.path,
      start: input.start,
      limit: input.limit,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return { connectionId: connection.id, ...page };
  }

  async search(
    input: BaiduConnectionSearchQuery & { connectionId: string; signal?: AbortSignal },
  ): Promise<BaiduConnectionSearchResponse> {
    const connection = this.connection(input.connectionId);
    const gateway = this.createGateway({
      connectionId: connection.id,
      externalAccountId: connection.externalAccountId,
    });
    if (gateway.searchDirectory === undefined)
      throw new BaiduApiError('BAIDU_SEARCH_NOT_CONFIGURED', null);
    const page = await gateway.searchDirectory({
      path: input.path,
      query: input.query,
      page: input.page,
      limit: input.limit,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return { connectionId: connection.id, ...page };
  }

  private connection(id: string): BrowsableConnection {
    const connection = this.db
      .prepare(
        `SELECT id, provider, external_account_id AS externalAccountId,
                auth_state AS authState, secret_ref AS secretRef,
                capabilities_json AS capabilitiesJson
         FROM cloud_connections WHERE id = ?`,
      )
      .get(id) as BrowsableConnection | undefined;
    if (connection === undefined) throw new BaiduApiError('BAIDU_CONNECTION_NOT_FOUND', null);
    if (
      connection.provider !== 'BAIDU' ||
      connection.authState !== 'CONNECTED' ||
      connection.secretRef === null ||
      !hasBrowseCapability(connection.capabilitiesJson)
    ) {
      throw new BaiduApiError('BAIDU_CONNECTION_NOT_BROWSABLE', null);
    }
    return connection;
  }
}

function hasBrowseCapability(value: string): boolean {
  try {
    const decoded = JSON.parse(value) as unknown;
    return Array.isArray(decoded) && decoded.includes('SOURCE_BROWSE');
  } catch {
    return false;
  }
}
