import type { Clock } from '../core/clock.js';
import type { AppDatabase } from '../db/database.js';
import type { AppMode } from '../config/env.js';
import {
  StorageEligibilityAuthority,
  type StorageEligibilityReason,
} from '../cloud-connections/eligibility.js';
import { ImportControlError } from './errors.js';
import type { ImportDestination, JellyfinImportLibrary } from './model.js';
import { StorageAccountRepository } from '../storage/accounts.js';
import type { ImportLibraryCatalog } from '../jellyfin/import-libraries.js';
import { importLibraryAcceptsMediaType } from '@ptvault/contracts';

export type ImportDestinationPublicationConfig = {
  enabled: () => boolean;
  libraries: readonly JellyfinImportLibrary[];
  libraryCatalog?: Pick<ImportLibraryCatalog, 'list'>;
  mounts: readonly { accountId: string; mountPoint: string }[];
  maximumHealthAgeMs?: number;
};

export interface ImportDestinationCatalog {
  list(): ImportDestination[];
  require(destinationId: string): ImportDestination;
}

type StorageAccountRow = {
  id: string;
  label: string;
  health: 'HEALTHY' | 'DEGRADED' | 'THROTTLED' | 'AUTH_REQUIRED' | 'OFFLINE';
  availableBytes: string | null;
  circuitOpenUntil: number | null;
  enabled: number;
};

export class DatabaseImportDestinationCatalog implements ImportDestinationCatalog {
  private readonly eligibility: StorageEligibilityAuthority;

  constructor(
    private readonly db: AppDatabase,
    private readonly mode: AppMode,
    private readonly runtimeConfigured: boolean,
    private readonly creationEnabled: () => boolean,
    private readonly now: Clock = () => new Date(),
    private readonly publication?: ImportDestinationPublicationConfig,
  ) {
    this.eligibility = new StorageEligibilityAuthority(db, {
      now: () => this.now().getTime(),
      legacyRcloneConfigured: runtimeConfigured,
      webOAuthRuntimeConfigured: runtimeConfigured,
    });
  }

  list(): ImportDestination[] {
    const rows = this.db
      .prepare(
        `SELECT id, label, health,
                CASE
                  WHEN free_bytes IS NULL THEN NULL
                  WHEN free_bytes <= reserve_bytes THEN '0'
                  ELSE CAST(free_bytes - reserve_bytes AS TEXT)
                END AS availableBytes,
                circuit_open_until AS circuitOpenUntil,
                enabled
         FROM storage_accounts
         ORDER BY label ASC, id ASC`,
      )
      .all() as StorageAccountRow[];

    const capacity = new StorageAccountRepository(this.db, () => this.now().getTime(), {
      legacyRcloneConfigured: this.runtimeConfigured,
      webOAuthRuntimeConfigured: this.runtimeConfigured,
    });
    for (const row of rows) row.availableBytes = capacity.availableCapacity(row.id);

    const destinations = rows.flatMap((row) => [
      this.mapAccount(row, 'ONEDRIVE_RAW'),
      this.mapAccount(row, 'STANDALONE_CRYPT'),
    ]);
    destinations.push({
      destinationId: 'pt-vault-import',
      displayName: 'PT Cloud Vault Import',
      kind: 'PT_VAULT_IMPORT',
      available: false,
      unavailableReason:
        this.mode === 'SHADOW'
          ? 'SHADOW_MODE'
          : !this.runtimeConfigured
            ? 'NOT_CONFIGURED'
            : 'FEATURE_DISABLED',
      availableBytes: null,
      allowedRoot: null,
      supportsRestore: false,
      supportsJellyfin: false,
    });
    return destinations;
  }

  require(destinationId: string): ImportDestination {
    const destination = this.list().find((candidate) => candidate.destinationId === destinationId);
    if (!destination) throw new ImportControlError('IMPORT_DESTINATION_NOT_FOUND', 404);
    return destination;
  }

  /** Shared with the publication worker: a DB row alone does not configure a mount. */
  supportsPublication(accountId: string): boolean {
    const config = this.publication;
    if (
      this.mode !== 'ACTIVE' ||
      !this.runtimeConfigured ||
      config === undefined ||
      !config.enabled() ||
      !(config.libraryCatalog?.list() ?? config.libraries).some(
        (library) =>
          library.unavailableReason == null &&
          (importLibraryAcceptsMediaType('MOVIE', library.contentType) ||
            importLibraryAcceptsMediaType('SERIES', library.contentType)),
      ) ||
      !this.eligibility.evaluate(accountId, 'EXISTING_WORK').eligible
    )
      return false;
    const mount = config.mounts.find((entry) => entry.accountId === accountId);
    if (mount === undefined) return false;
    const cutoff = this.now().getTime() - (config.maximumHealthAgeMs ?? 120_000);
    return (
      this.db
        .prepare(
          `SELECT 1 FROM mount_health
      WHERE account_id = ? AND mount_point = ? AND mounted = 1 AND rc_reachable = 1
        AND pressure <> 'CRITICAL' AND last_error IS NULL AND checked_at >= ? AND checked_at <= ?`,
        )
        .get(accountId, mount.mountPoint, cutoff, this.now().getTime()) !== undefined
    );
  }

  private mapAccount(
    row: StorageAccountRow,
    kind: 'ONEDRIVE_RAW' | 'STANDALONE_CRYPT',
  ): ImportDestination {
    let unavailableReason: ImportDestination['unavailableReason'] = null;
    if (this.mode === 'SHADOW') unavailableReason = 'SHADOW_MODE';
    else if (!this.runtimeConfigured) unavailableReason = 'NOT_CONFIGURED';
    else if (!this.creationEnabled()) unavailableReason = 'FEATURE_DISABLED';
    else {
      const decision = this.eligibility.evaluate(row.id, 'NEW_WORK');
      unavailableReason = mapEligibilityReason(decision.reason);
      if (unavailableReason === null && row.availableBytes === '0') {
        unavailableReason = 'QUOTA_EXHAUSTED';
      }
    }

    const suffix = kind === 'ONEDRIVE_RAW' ? 'raw' : 'crypt';
    return {
      destinationId: `onedrive-${suffix}:${row.id}`,
      displayName: `${row.label} · ${kind === 'ONEDRIVE_RAW' ? 'OneDrive Raw' : '独立 Crypt'}`,
      kind,
      available: unavailableReason === null,
      unavailableReason,
      availableBytes: row.availableBytes,
      allowedRoot: null,
      supportsRestore: false,
      supportsJellyfin:
        kind === 'STANDALONE_CRYPT' &&
        unavailableReason === null &&
        this.supportsPublication(row.id),
    };
  }
}

function mapEligibilityReason(
  reason: StorageEligibilityReason | null,
): ImportDestination['unavailableReason'] {
  if (reason === null) return null;
  if (reason === 'AUTH_REQUIRED') return 'AUTH_REQUIRED';
  if (reason === 'RATE_LIMITED') return 'RATE_LIMITED';
  if (reason === 'CIRCUIT_OPEN') return 'CIRCUIT_OPEN';
  return 'NOT_CONFIGURED';
}

export class StaticImportDestinationCatalog implements ImportDestinationCatalog {
  constructor(private readonly destinations: readonly ImportDestination[]) {}

  list(): ImportDestination[] {
    return this.destinations.map((destination) => ({ ...destination }));
  }

  require(destinationId: string): ImportDestination {
    const destination = this.destinations.find(
      (candidate) => candidate.destinationId === destinationId,
    );
    if (!destination) throw new ImportControlError('IMPORT_DESTINATION_NOT_FOUND', 404);
    return { ...destination };
  }
}
