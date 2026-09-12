import type { AppDatabase } from '../db/database.js';

export type StorageEligibilityPurpose = 'NEW_WORK' | 'EXISTING_WORK' | 'HEALTH_PROBE';

export type StorageEligibilityReason =
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_DISABLED'
  | 'RUNTIME_NOT_CONFIGURED'
  | 'AUTH_REQUIRED'
  | 'PROVISION_NOT_READY'
  | 'PROFILE_NOT_VERIFIED'
  | 'RATE_LIMITED'
  | 'CIRCUIT_OPEN'
  | 'HEALTH_UNAVAILABLE'
  | 'BINDING_INVALID';

export type StorageEligibilityDecision = {
  accountId: string;
  eligible: boolean;
  reason: StorageEligibilityReason | null;
  strategy:
    | 'NEW_WORK_REQUIRES_FULL_AUTHORITY'
    | 'EXISTING_WORK_MAY_CONTINUE_DEGRADED_ONLY'
    | 'HEALTH_PROBE_REQUIRES_PARENT_AUTHORITY';
};

export type StorageEligibilityAuthorityOptions = {
  now?: () => number;
  legacyRcloneConfigured?: boolean;
  webOAuthRuntimeConfigured?: boolean;
};

type EligibilityRow = {
  accountId: string;
  enabled: number;
  health: 'HEALTHY' | 'DEGRADED' | 'THROTTLED' | 'AUTH_REQUIRED' | 'OFFLINE';
  circuitOpenUntil: number | null;
  provisioningMode: 'LEGACY_RCLONE' | 'WEB_OAUTH';
  accountProvider: string;
  connectionId: string | null;
  connectionProvider: string | null;
  authState: string | null;
  provisionState: string | null;
  secretRef: string | null;
  capabilitiesJson: string | null;
  escrowState: string | null;
  cryptRoundtripState: string | null;
  rateLimitedUntil: number | null;
  materializationPending: number;
};

const ELIGIBILITY_SELECT = `
  SELECT account.id AS accountId, account.enabled, account.health,
         account.circuit_open_until AS circuitOpenUntil,
         account.provisioning_mode AS provisioningMode,
         account.provider AS accountProvider,
         account.connection_id AS connectionId,
         connection.provider AS connectionProvider,
         connection.auth_state AS authState,
         connection.provision_state AS provisionState,
         connection.secret_ref AS secretRef,
         connection.capabilities_json AS capabilitiesJson,
         profile.escrow_state AS escrowState,
         profile.crypt_roundtrip_state AS cryptRoundtripState,
         runtime.rate_limited_until AS rateLimitedUntil,
         EXISTS(SELECT 1 FROM cloud_connection_materializations AS materialization
           WHERE materialization.connection_id = connection.id
             AND materialization.materialized_secret_ref IS NOT connection.secret_ref) AS materializationPending
  FROM storage_accounts AS account
  LEFT JOIN cloud_connections AS connection ON connection.id = account.connection_id
  LEFT JOIN encryption_profiles AS profile ON profile.id = account.encryption_profile_id
  LEFT JOIN cloud_connection_runtime AS runtime ON runtime.connection_id = connection.id`;

/**
 * Single live authority for storage admission and provider-backed resolution.
 * New work requires a healthy account. Existing work may continue through a
 * DEGRADED probe only; it still stops immediately on disabled/auth/profile/
 * provision/runtime/rate-limit/circuit authority loss.
 */
export class StorageEligibilityAuthority {
  private readonly now: () => number;
  private readonly legacyRcloneConfigured: boolean;
  private readonly webOAuthRuntimeConfigured: boolean;

  constructor(
    private readonly db: AppDatabase,
    options: StorageEligibilityAuthorityOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.legacyRcloneConfigured = options.legacyRcloneConfigured ?? true;
    this.webOAuthRuntimeConfigured = options.webOAuthRuntimeConfigured ?? false;
  }

  evaluate(accountId: string, purpose: StorageEligibilityPurpose): StorageEligibilityDecision {
    const row = this.db.prepare(`${ELIGIBILITY_SELECT} WHERE account.id = ?`).get(accountId) as
      EligibilityRow | undefined;
    const strategy = eligibilityStrategy(purpose);
    if (!row) return { accountId, eligible: false, reason: 'ACCOUNT_NOT_FOUND', strategy };
    const reason = this.reason(row, purpose);
    return { accountId, eligible: reason === null, reason, strategy };
  }

  eligibleAccountIds(purpose: StorageEligibilityPurpose): Set<string> {
    const rows = this.db
      .prepare(`${ELIGIBILITY_SELECT} ORDER BY account.id`)
      .all() as EligibilityRow[];
    return new Set(
      rows.filter((row) => this.reason(row, purpose) === null).map((row) => row.accountId),
    );
  }

  require(accountId: string, purpose: StorageEligibilityPurpose): void {
    const decision = this.evaluate(accountId, purpose);
    if (!decision.eligible) {
      throw new StorageEligibilityError(accountId, decision.reason ?? 'BINDING_INVALID');
    }
  }

  private reason(
    row: EligibilityRow,
    purpose: StorageEligibilityPurpose,
  ): StorageEligibilityReason | null {
    if (row.enabled !== 1) return 'ACCOUNT_DISABLED';
    if (row.circuitOpenUntil !== null && row.circuitOpenUntil > this.now()) {
      return 'CIRCUIT_OPEN';
    }

    // Takeover preserves the original aliases/profile/mode, not independence
    // from the newly attached parent. Even a health probe must obey this fence.
    if (row.connectionId !== null) {
      if (row.accountProvider !== 'ONEDRIVE' || row.connectionProvider !== 'ONEDRIVE')
        return 'BINDING_INVALID';
      if (row.authState !== 'CONNECTED' || row.secretRef === null) return 'AUTH_REQUIRED';
      if (row.rateLimitedUntil !== null && row.rateLimitedUntil > this.now()) return 'RATE_LIMITED';
      if (row.materializationPending === 1) return 'PROVISION_NOT_READY';
    }

    if (row.provisioningMode === 'LEGACY_RCLONE') {
      if (!this.legacyRcloneConfigured) return 'RUNTIME_NOT_CONFIGURED';
      return accountHealthReason(row.health, purpose);
    }
    if (!this.webOAuthRuntimeConfigured) return 'RUNTIME_NOT_CONFIGURED';
    if (
      row.accountProvider !== 'ONEDRIVE' ||
      row.connectionId === null ||
      row.connectionProvider !== 'ONEDRIVE'
    ) {
      return 'BINDING_INVALID';
    }
    if (row.authState !== 'CONNECTED' || row.secretRef === null) return 'AUTH_REQUIRED';
    if (row.provisionState !== 'READY') return 'PROVISION_NOT_READY';
    if (row.escrowState !== 'VERIFIED' || row.cryptRoundtripState !== 'PASSED') {
      return 'PROFILE_NOT_VERIFIED';
    }
    if (!hasCapability(row.capabilitiesJson, 'ARCHIVE_DESTINATION')) {
      return 'PROVISION_NOT_READY';
    }
    if (row.rateLimitedUntil !== null && row.rateLimitedUntil > this.now()) {
      return 'RATE_LIMITED';
    }
    return accountHealthReason(row.health, purpose);
  }
}

export class StorageEligibilityError extends Error {
  readonly code = 'STORAGE_ACCOUNT_INELIGIBLE';

  constructor(
    readonly accountId: string,
    readonly reason: StorageEligibilityReason,
  ) {
    super(`STORAGE_ACCOUNT_INELIGIBLE:${reason}`);
    this.name = 'StorageEligibilityError';
  }
}

function hasCapability(raw: string | null, capability: string): boolean {
  if (raw === null) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.includes(capability);
  } catch {
    return false;
  }
}

function eligibilityStrategy(
  purpose: StorageEligibilityPurpose,
): StorageEligibilityDecision['strategy'] {
  switch (purpose) {
    case 'NEW_WORK':
      return 'NEW_WORK_REQUIRES_FULL_AUTHORITY';
    case 'EXISTING_WORK':
      return 'EXISTING_WORK_MAY_CONTINUE_DEGRADED_ONLY';
    case 'HEALTH_PROBE':
      return 'HEALTH_PROBE_REQUIRES_PARENT_AUTHORITY';
  }
}

function accountHealthReason(
  health: EligibilityRow['health'],
  purpose: StorageEligibilityPurpose,
): StorageEligibilityReason | null {
  // A health probe is what repairs OFFLINE/AUTH_REQUIRED/THROTTLED state. It may
  // ignore that derived state, but never the live account, parent connection,
  // profile, rate gate or circuit authority checked above.
  if (purpose === 'HEALTH_PROBE') return null;
  if (health === 'AUTH_REQUIRED') return 'AUTH_REQUIRED';
  if (health === 'HEALTHY' || (purpose === 'EXISTING_WORK' && health === 'DEGRADED')) {
    return null;
  }
  return 'HEALTH_UNAVAILABLE';
}
