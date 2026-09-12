import type { AppDatabase } from '../db/database.js';
import { ImportControlError } from './errors.js';

export type FrozenImportSourceBinding = {
  sourceConnectionId: string;
  sourceProvider: 'BAIDU';
  sourceExternalAccountId: string;
  sourceManifestRevision: number;
};

export interface ImportSourceConnectionCatalog {
  requireBaiduSource(
    connectionId: string,
    sourceKind?: 'BAIDU_SHARE' | 'BAIDU_APP_DIR' | 'OTHER',
  ): FrozenImportSourceBinding;
}

type SourceRow = {
  provider: string;
  externalAccountId: string;
  authState: string;
  secretRef: string | null;
  capabilitiesJson: string;
  revision: number;
};

/** Planning authority for freezing a concrete Baidu connection into a plan. */
export class DatabaseImportSourceConnectionCatalog implements ImportSourceConnectionCatalog {
  constructor(private readonly db: AppDatabase) {}

  requireBaiduSource(
    connectionId: string,
    sourceKind: 'BAIDU_SHARE' | 'BAIDU_APP_DIR' | 'OTHER' = 'BAIDU_SHARE',
  ): FrozenImportSourceBinding {
    if (sourceKind === 'OTHER') throw new ImportControlError('IMPORT_SOURCE_UNSUPPORTED', 409);
    const row = this.db
      .prepare(
        `SELECT provider, external_account_id AS externalAccountId,
                auth_state AS authState, secret_ref AS secretRef,
                capabilities_json AS capabilitiesJson, revision
         FROM cloud_connections WHERE id = ?`,
      )
      .get(connectionId) as SourceRow | undefined;
    if (row === undefined) throw new ImportControlError('IMPORT_SOURCE_CONNECTION_NOT_FOUND', 404);
    if (row.provider !== 'BAIDU')
      throw new ImportControlError('IMPORT_SOURCE_PROVIDER_INVALID', 409);
    if (row.authState !== 'CONNECTED' || row.secretRef === null) {
      throw new ImportControlError('IMPORT_SOURCE_AUTH_REQUIRED', 409);
    }
    let capabilities: unknown;
    try {
      capabilities = JSON.parse(row.capabilitiesJson) as unknown;
    } catch {
      throw new ImportControlError('IMPORT_SOURCE_CAPABILITY_INVALID', 500);
    }
    if (
      !Array.isArray(capabilities) ||
      !capabilities.includes('SOURCE_BROWSE') ||
      !capabilities.includes('SOURCE_DOWNLOAD') ||
      (sourceKind === 'BAIDU_SHARE' && !capabilities.includes('SHARE_TRANSFER'))
    ) {
      throw new ImportControlError('IMPORT_SOURCE_CAPABILITY_MISSING', 409);
    }
    return {
      sourceConnectionId: connectionId,
      sourceProvider: 'BAIDU',
      sourceExternalAccountId: row.externalAccountId,
      // This is the plan-time manifest/authority revision. Reauthorization may
      // advance the live row while the stable provider identity remains valid.
      sourceManifestRevision: row.revision,
    };
  }
}
