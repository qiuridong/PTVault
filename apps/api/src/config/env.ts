import path from 'node:path';
import { isIP } from 'node:net';

import { z } from 'zod';
import { JellyfinImportLibrarySchema, type JellyfinImportLibrary } from '@ptvault/contracts';

import { parsePathMaps, PathMapError, type PathMap } from '../qb/path-map.js';

function isValidTrustedProxy(value: string): boolean {
  const [address, prefix, ...extra] = value.split('/');
  if (!address || extra.length > 0) return false;

  const family = isIP(address);
  if (family === 0) return false;
  if (prefix === undefined) return true;
  if (!/^(0|[1-9][0-9]*)$/.test(prefix)) return false;

  return Number(prefix) <= (family === 4 ? 32 : 128);
}

const TrustedProxyCidrsSchema = z
  .string()
  .optional()
  .transform((raw, context): string[] => {
    if (!raw || raw.trim() === '') return [];

    const entries = raw.split(',').map((entry) => entry.trim());
    const invalid = entries.find((entry) => !isValidTrustedProxy(entry));
    if (invalid !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid trusted proxy entry: ${invalid || '<empty>'}`,
      });
      return z.NEVER;
    }

    return entries;
  });

const AllowedRootsSchema = z
  .string()
  .optional()
  .transform((raw, context): string[] => {
    if (!raw || raw.trim() === '') return [];

    const entries = raw
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    const relative = entries.find((entry) => !path.isAbsolute(entry));
    if (relative !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Allowed root must be absolute: ${relative}`,
      });
      return z.NEVER;
    }

    return entries.map((entry) => path.resolve(entry));
  });

/**
 * Container→host path rewrites, as comma-separated `<container>=<host>` pairs.
 *
 * Comma-separated rather than `path.delimiter`-separated: an entry itself
 * contains `=`, and on Windows `path.delimiter` is `;`, but these values describe
 * the Linux container namespace, so a platform-dependent separator would make the
 * same configuration string mean different things on different machines.
 */
const PathMapsSchema = z
  .string()
  .optional()
  .transform((raw, context): PathMap[] => {
    if (!raw || raw.trim() === '') return [];

    const entries = raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    try {
      return parsePathMaps(entries);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          error instanceof PathMapError
            ? `Invalid path map (need absolute <container>=<host>): ${error.entry}`
            : 'Invalid path map',
      });
      return z.NEVER;
    }
  });

const JellyfinPathMapsSchema = PathMapsSchema;

const BooleanFlagSchema = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((value) => value === 'true' || value === '1');

function boundedPositiveInteger(maximum: number) {
  return z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .transform((value) => Number(value))
    .refine((value) => Number.isSafeInteger(value) && value <= maximum)
    .optional();
}

const ImportRecoveryAccountIdsSchema = z
  .string()
  .optional()
  .transform((raw, context): string[] => {
    if (raw === undefined || raw.trim() === '') return [];
    const values = raw
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value !== '');
    const invalid = values.find((value) => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value));
    if (invalid !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid import recovery account id',
      });
      return z.NEVER;
    }
    return [...new Set(values)];
  });

const ImportDownloadHostsSchema = z
  .string()
  .default('d.pcs.baidu.com,.baidupcs.com')
  .transform((raw, context): string[] => {
    const values = [...new Set(raw.split(',').map((value) => value.trim().toLowerCase()))];
    const invalid = values.find(
      (value) =>
        value === '' ||
        !/^\.?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
          value,
        ),
    );
    if (invalid !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid import download host' });
      return z.NEVER;
    }
    return values;
  });

const ImportJellyfinLibrariesSchema = z
  .string()
  .default('[]')
  .transform((raw, context): JellyfinImportLibrary[] => {
    try {
      return z
        .array(JellyfinImportLibrarySchema)
        .max(64)
        .parse(JSON.parse(raw) as unknown);
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid import Jellyfin library allowlist JSON',
      });
      return z.NEVER;
    }
  });

/**
 * Whether this process may mutate anything outside its own database.
 *
 * `SHADOW` (the default) is the safe state: the offload trigger is not
 * registered, so no torrent is ever paused, no byte is ever uploaded, and no
 * local file is ever deleted. `ACTIVE` registers the mutation surface.
 *
 * The default deliberately means "an operator who forgets this variable gets the
 * safe mode", never the destructive one. Flipping to ACTIVE is a go-live decision
 * that additionally requires a separately approved mutation manifest.
 */
const ModeSchema = z.enum(['SHADOW', 'ACTIVE']).default('SHADOW');

const BuildVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+/-]*$/)
  .optional();

const BuildCommitSchema = z
  .string()
  .trim()
  .min(7)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+/-]*$/)
  .optional();

const RawConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PTVAULT_STATE_DIR: z.string().min(1),
  PTVAULT_MASTER_KEY: z.string().min(1),
  PTVAULT_HOST: z.string().default('127.0.0.1'),
  PTVAULT_PORT: z.coerce.number().int().min(1).max(65_535).default(3210),
  PTVAULT_MODE: ModeSchema,
  // Unset preserves the existing ACTIVE offload contract. New installations can
  // explicitly choose netdisk-only without arming any local-file deletion path.
  PTVAULT_OFFLOAD_ENABLED: z.enum(['true', 'false', '1', '0']).optional(),
  PTVAULT_BUILD_VERSION: BuildVersionSchema,
  PTVAULT_BUILD_COMMIT: BuildCommitSchema,
  PTVAULT_TRUSTED_PROXY_CIDRS: TrustedProxyCidrsSchema,
  PTVAULT_QB_ALLOWED_ROOTS: AllowedRootsSchema,
  PTVAULT_QB_PATH_MAPS: PathMapsSchema,
  PTVAULT_RCLONE_BIN: z.string().min(1).default('rclone'),
  PTVAULT_RCLONE_CONFIG: z.string().min(1).optional(),
  PTVAULT_AGE_BIN: z.string().min(1).default('age'),
  // Where restored torrents are written and where the VFS cache lives. Both must be
  // on the hot filesystem: the restore renames out of a temp directory into the qB
  // location, and rename across filesystems is not atomic.
  PTVAULT_MEDIA_HOT_ROOT: z.string().min(1).optional(),
  // Parent of the per-account mount points (`<root>/<accountId>`), not itself a
  // mount. One mount per account rather than one aggregate view: an rclone union
  // over several accounts was measured on the real machine to fail closed, taking
  // healthy accounts offline along with a broken one.
  PTVAULT_MEDIA_MOUNT_ROOT: z.string().min(1).optional(),
  PTVAULT_IMPORT_MOUNT_ROOT: z.string().min(1).optional(),
  PTVAULT_IMPORT_RC_BASE_PORT: z.coerce.number().int().min(1024).max(65_534).default(5672),
  // Where the symlink farm is built. Separate from the mount root because it is
  // writable and the mounts are read-only.
  PTVAULT_MEDIA_FARM_ROOT: z.string().min(1).optional(),
  PTVAULT_MEDIA_CACHE_DIR: z.string().min(1).optional(),
  // First loopback RC port; each mount takes the next one by its index. Matches the
  // `RC_ADDR` the rendered mount units are given.
  PTVAULT_MEDIA_RC_BASE_PORT: z.coerce.number().int().min(1024).max(65_535).default(5572),
  // File holding the RC credential. A path, never the secret itself, so the value
  // stays out of the unit file and out of `systemctl show`.
  PTVAULT_MEDIA_RC_CREDENTIAL_FILE: z.string().min(1).optional(),
  // Jellyfin's loopback API is the authoritative source for active playback.
  // The token is read from a root-owned file so it never appears in the unit or
  // `systemctl show`. ACTIVE mode requires both values; deletion without this
  // probe would silently skip the last safety check before unlink.
  PTVAULT_JELLYFIN_URL: z.string().trim().url().optional(),
  PTVAULT_JELLYFIN_TOKEN_FILE: z.string().trim().min(1).optional(),
  PTVAULT_JELLYFIN_PATH_MAPS: JellyfinPathMapsSchema,
  PTVAULT_OFFLOAD_PARALLEL_ENABLED: BooleanFlagSchema,
  PTVAULT_OFFLOAD_MAX_IN_FLIGHT: boundedPositiveInteger(32),
  PTVAULT_OFFLOAD_PREFLIGHT_CONCURRENCY: boundedPositiveInteger(32),
  PTVAULT_OFFLOAD_PAUSE_SNAPSHOT_CONCURRENCY: boundedPositiveInteger(8),
  PTVAULT_OFFLOAD_MAX_PAUSED_PIPELINES: boundedPositiveInteger(8),
  PTVAULT_OFFLOAD_HASH_CONCURRENCY: boundedPositiveInteger(4),
  PTVAULT_OFFLOAD_REMOTE_DATA_CONCURRENCY: boundedPositiveInteger(4),
  // First-start seed for the durable netdisk creation gate. Provisioning is
  // derived from the runtime graph and remains independent of this value.
  PTVAULT_IMPORT_ENABLED: BooleanFlagSchema,
  PTVAULT_IMPORT_ARCHIVE_ENABLED: BooleanFlagSchema,
  PTVAULT_IMPORT_ARCHIVE_SEVENZIP: z.string().min(1).optional(),
  PTVAULT_IMPORT_ARCHIVE_SANDBOX: z.string().min(1).optional(),
  PTVAULT_IMPORT_ARCHIVE_PROBE_RUNTIME: z.string().min(1).optional(),
  PTVAULT_IMPORT_SECRET_ROOT: z.string().trim().min(1).optional(),
  PTVAULT_IMPORT_SPOOL_ROOT: z.string().trim().min(1).optional(),
  PTVAULT_IMPORT_BAIDU_APP_CREDENTIAL_FILE: z.string().trim().min(1).optional(),
  PTVAULT_IMPORT_BAIDU_TOKEN_FILE: z.string().trim().min(1).optional(),
  PTVAULT_BAIDU_CLIENT_PROFILE_FILE: z.string().trim().min(1).optional(),
  PTVAULT_IMPORT_RECOVERY_ACCOUNT_IDS: ImportRecoveryAccountIdsSchema,
  PTVAULT_IMPORT_DOWNLOAD_HOSTS: ImportDownloadHostsSchema,
  PTVAULT_IMPORT_PUBLICATION_ENABLED: BooleanFlagSchema,
  PTVAULT_IMPORT_JELLYFIN_LIBRARIES: ImportJellyfinLibrariesSchema,
  PTVAULT_IMPORT_SOURCE_CLEANUP_ENABLED: BooleanFlagSchema,
  PTVAULT_IMPORT_SELECTED_SOURCE_DELETE_ENABLED: BooleanFlagSchema,
  PTVAULT_IMPORT_SOURCE_DELETE_APPROVAL_FILE: z.string().trim().min(1).optional(),
  PTVAULT_CLOUD_OAUTH_CALLBACK_ORIGIN: z.string().trim().url().optional(),
  PTVAULT_BAIDU_OAUTH_CLIENT_ID: z.string().trim().min(1).max(512).optional(),
  PTVAULT_BAIDU_OAUTH_CLIENT_SECRET: z.string().trim().min(1).max(512).optional(),
  PTVAULT_BAIDU_APP_ID: z.string().trim().min(1).max(128).optional(),
  PTVAULT_ONEDRIVE_OAUTH_CLIENT_ID: z.string().trim().min(1).max(256).optional(),
  PTVAULT_ONEDRIVE_OAUTH_CLIENT_SECRET: z.string().trim().min(1).max(512).optional(),
  PTVAULT_ONEDRIVE_TENANT: z.string().trim().min(1).max(128).default('organizations'),
  PTVAULT_ONEDRIVE_PROVISION_ENABLED: BooleanFlagSchema,
});

export type AppMode = 'SHADOW' | 'ACTIVE';

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  stateDir: string;
  masterKey: Buffer;
  host: string;
  port: number;
  mode: AppMode;
  /** Explicit false supports netdisk-only ACTIVE installations; unset is legacy. */
  offloadEnabled?: boolean;
  /** Installer-managed loopback setup can expose incomplete, inactive integrations. */
  guidedSetup?: boolean;
  /** Deployment label shown by the read-only system information endpoint. */
  buildVersion: string | null;
  /** Commit identity paired with the artifact, or null when the deployer omitted it. */
  buildCommit: string | null;
  trustedProxyCidrs: string[];
  qbAllowedRoots: string[];
  qbPathMaps: PathMap[];
  rcloneBin: string;
  /** Absolute path to rclone.conf; null lets rclone use its own default. */
  rcloneConfigPath: string | null;
  /**
   * Media playback paths. Null means the playback surface is not configured, and
   * the server simply does not build it — the same shape as `rcloneConfigPath`.
   */
  mediaHotRoot: string | null;
  /** Parent directory holding one mount per storage account. */
  mediaMountRoot: string | null;
  importMountRoot: string | null;
  importRcBasePort: number;
  /** Where the symlink farm Jellyfin reads is built. */
  mediaFarmRoot: string | null;
  mediaCacheDir: string | null;
  /** First loopback RC port; mount N answers on base + N. */
  mediaRcBasePort: number;
  /** Path to the file holding the RC credential, never the credential itself. */
  mediaRcCredentialFile: string | null;
  /** Loopback Jellyfin origin used only for active-session checks. */
  jellyfinUrl: string | null;
  /** Path to the Jellyfin API token, never the token itself. */
  jellyfinTokenFile: string | null;
  /** Jellyfin container paths rewritten into the host namespace cleanup uses. */
  jellyfinPathMaps: PathMap[];
  offloadParallelEnabled: boolean;
  offloadMaxInFlight: number;
  offloadPreflightConcurrency: number;
  offloadPauseSnapshotConcurrency: number;
  offloadMaxPausedPipelines: number;
  offloadHashConcurrency: number;
  offloadRemoteDataConcurrency: number;
  /** `age` binary used to encrypt recovery bundles to the operator's public key. */
  ageBin: string;
  /** First-start seed for durable netdisk creationEnabled; not a runtime provision gate. */
  importEnabled: boolean;
  importArchiveRuntime?: { binary: string; sandboxHelper: string; probeRuntimeRoot: string } | null;
  /** Private filesystem ingress for protected-share passcodes. */
  importSecretRoot: string | null;
  /** Bounded local landing area; one `.part`/`.ready` object per active import job. */
  importSpoolRoot: string | null;
  /** Private, read-only Baidu app id/client credential envelope. */
  importBaiduAppCredentialFile: string | null;
  /** Private, atomically writable Baidu OAuth token envelope. */
  importBaiduTokenFile: string | null;
  baiduClientProfileFile?: string | null;
  /** At least two storage accounts that receive every recovery generation. */
  importRecoveryAccountIds: string[];
  /** Exact/suffix allowlist accepted by the resumable download boundary. */
  importDownloadHosts: string[];
  /** Independent post-archive projection gate; safe default is off. */
  importPublicationEnabled: boolean;
  /** Server-side Jellyfin library allowlist; clients submit only libraryId. */
  importJellyfinLibraries: JellyfinImportLibrary[];
  /** Overall source-cleanup executor gate; safe default is off. */
  importSourceCleanupEnabled: boolean;
  /** Independent high-risk owner-source deletion gate; safe default is off. */
  importSelectedSourceDeleteEnabled: boolean;
  /** Optional private operator-owned exact-file approvals, reread at each mutation fence. */
  importSourceDeleteApprovalFile?: string | null;
  cloudOauthCallbackOrigin?: string | null;
  baiduOauthClientId?: string | null;
  baiduOauthClientSecret?: string | null;
  baiduAppId?: string | null;
  oneDriveOauthClientId?: string | null;
  oneDriveOauthClientSecret?: string | null;
  oneDriveTenant?: string;
  oneDriveProvisionEnabled?: boolean;
};

export function parseConfig(input: NodeJS.ProcessEnv, options: { guidedSetup?: boolean } = {}): AppConfig {
  const raw = RawConfigSchema.parse(input);
  if (options.guidedSetup && !['127.0.0.1', '::1'].includes(raw.PTVAULT_HOST)) {
    throw new Error('Managed setup must bind to a loopback interface');
  }
  const offloadEnabled =
    raw.PTVAULT_MODE === 'ACTIVE' &&
    raw.PTVAULT_OFFLOAD_ENABLED !== 'false' &&
    raw.PTVAULT_OFFLOAD_ENABLED !== '0';
  if (!path.isAbsolute(raw.PTVAULT_STATE_DIR)) {
    throw new Error('PTVAULT_STATE_DIR must be absolute');
  }

  const masterKey = Buffer.from(raw.PTVAULT_MASTER_KEY, 'base64');
  let importArchiveRuntime: AppConfig['importArchiveRuntime'] = null;
  if (raw.PTVAULT_IMPORT_ARCHIVE_ENABLED) {
    const binary = raw.PTVAULT_IMPORT_ARCHIVE_SEVENZIP,
      sandboxHelper = raw.PTVAULT_IMPORT_ARCHIVE_SANDBOX,
      probeRuntimeRoot = raw.PTVAULT_IMPORT_ARCHIVE_PROBE_RUNTIME;
    if (
      binary === undefined ||
      sandboxHelper === undefined ||
      probeRuntimeRoot === undefined ||
      ![binary, sandboxHelper, probeRuntimeRoot].every((value) => path.isAbsolute(value))
    )
      throw new Error('PTVAULT_IMPORT_ARCHIVE requires all absolute runtime paths');
    importArchiveRuntime = { binary, sandboxHelper, probeRuntimeRoot };
  }
  if (masterKey.length !== 32) {
    throw new Error('PTVAULT_MASTER_KEY must decode to exactly 32 bytes');
  }

  const offloadProfile = [
    raw.PTVAULT_OFFLOAD_MAX_IN_FLIGHT,
    raw.PTVAULT_OFFLOAD_PREFLIGHT_CONCURRENCY,
    raw.PTVAULT_OFFLOAD_PAUSE_SNAPSHOT_CONCURRENCY,
    raw.PTVAULT_OFFLOAD_MAX_PAUSED_PIPELINES,
    raw.PTVAULT_OFFLOAD_HASH_CONCURRENCY,
    raw.PTVAULT_OFFLOAD_REMOTE_DATA_CONCURRENCY,
  ];
  const configuredOffloadValues = offloadProfile.filter((value) => value !== undefined).length;
  if (configuredOffloadValues !== 0 && configuredOffloadValues !== offloadProfile.length) {
    throw new Error('PTVAULT OFFLOAD parallel limits must be configured together');
  }
  const [
    offloadMaxInFlight = 8,
    offloadPreflightConcurrency = 8,
    offloadPauseSnapshotConcurrency = 2,
    offloadMaxPausedPipelines = 3,
    offloadHashConcurrency = 1,
    offloadRemoteDataConcurrency = 1,
  ] = offloadProfile;
  if (offloadMaxPausedPipelines >= offloadMaxInFlight) {
    throw new Error(
      'PTVAULT OFFLOAD max paused pipelines must be strictly less than max in-flight offloads',
    );
  }
  if (offloadRemoteDataConcurrency !== 1) {
    throw new Error('PTVAULT OFFLOAD global remote data concurrency must remain 1');
  }

  const rcloneConfig = raw.PTVAULT_RCLONE_CONFIG?.trim();
  if (rcloneConfig !== undefined && rcloneConfig !== '' && !path.isAbsolute(rcloneConfig)) {
    // A relative rclone.conf would resolve against whatever cwd systemd happens
    // to give the unit, which is not a property worth depending on.
    throw new Error('PTVAULT_RCLONE_CONFIG must be absolute');
  }

  // ACTIVE is the mode that can pause torrents, upload bytes, and delete local
  // files. Refusing to start without an explicit rclone.conf is cheaper than
  // discovering mid-upload that rclone resolved a different config than intended.
  if (raw.PTVAULT_MODE === 'ACTIVE' && (rcloneConfig === undefined || rcloneConfig === '')) {
    throw new Error('PTVAULT_RCLONE_CONFIG is required when PTVAULT_MODE=ACTIVE');
  }

  const jellyfinUrl = raw.PTVAULT_JELLYFIN_URL?.trim();
  const jellyfinTokenFile = raw.PTVAULT_JELLYFIN_TOKEN_FILE?.trim();
  const jellyfinConfigured = jellyfinUrl !== undefined || jellyfinTokenFile !== undefined;
  if ((jellyfinUrl === undefined) !== (jellyfinTokenFile === undefined)) {
    throw new Error(
      'PTVAULT_JELLYFIN_URL and PTVAULT_JELLYFIN_TOKEN_FILE must be configured together',
    );
  }
  if (jellyfinUrl !== undefined) assertLoopbackHttpOrigin(jellyfinUrl);
  if (jellyfinTokenFile !== undefined && !path.isAbsolute(jellyfinTokenFile)) {
    throw new Error('PTVAULT_JELLYFIN_TOKEN_FILE must be absolute');
  }
  if (offloadEnabled && jellyfinUrl === undefined) {
    throw new Error('Jellyfin playback probe is required when PTVAULT_MODE=ACTIVE');
  }
  if (offloadEnabled && raw.PTVAULT_JELLYFIN_PATH_MAPS.length === 0) {
    throw new Error('PTVAULT_JELLYFIN_PATH_MAPS is required when PTVAULT_MODE=ACTIVE');
  }
  if (jellyfinConfigured && raw.PTVAULT_JELLYFIN_PATH_MAPS.length === 0) {
    throw new Error('PTVAULT_JELLYFIN_PATH_MAPS is required with the Jellyfin playback probe');
  }

  // Rejected at startup rather than at first use. A relative media path would
  // resolve against whatever the working directory happens to be, and the value
  // decides where hundreds of gigabytes get written.
  for (const [key, value] of [
    ['PTVAULT_MEDIA_HOT_ROOT', raw.PTVAULT_MEDIA_HOT_ROOT],
    ['PTVAULT_MEDIA_MOUNT_ROOT', raw.PTVAULT_MEDIA_MOUNT_ROOT],
    ['PTVAULT_IMPORT_MOUNT_ROOT', raw.PTVAULT_IMPORT_MOUNT_ROOT],
    ['PTVAULT_MEDIA_FARM_ROOT', raw.PTVAULT_MEDIA_FARM_ROOT],
    ['PTVAULT_MEDIA_CACHE_DIR', raw.PTVAULT_MEDIA_CACHE_DIR],
  ] as const) {
    if (value !== undefined && value !== '' && !path.isAbsolute(value)) {
      throw new Error(`${key} must be absolute`);
    }
  }

  const mediaValues = [
    raw.PTVAULT_MEDIA_HOT_ROOT,
    raw.PTVAULT_MEDIA_MOUNT_ROOT,
    raw.PTVAULT_MEDIA_FARM_ROOT,
    raw.PTVAULT_MEDIA_CACHE_DIR,
    raw.PTVAULT_MEDIA_RC_CREDENTIAL_FILE,
  ];
  const mediaConfigured = mediaValues.some((value) => value !== undefined && value !== '');
  const mediaComplete = mediaValues.every((value) => value !== undefined && value !== '');
  if (mediaConfigured && !mediaComplete) {
    throw new Error(
      'PTVAULT media hot, mount, farm, cache, and RC credential paths must be configured together',
    );
  }
  if (offloadEnabled && !mediaComplete) {
    throw new Error('PTVAULT media paths are required when PTVAULT_MODE=ACTIVE');
  }

  const importPaths = [raw.PTVAULT_IMPORT_SECRET_ROOT, raw.PTVAULT_IMPORT_SPOOL_ROOT];
  const legacyBaiduConfigured =
    raw.PTVAULT_IMPORT_BAIDU_APP_CREDENTIAL_FILE !== undefined ||
    raw.PTVAULT_IMPORT_BAIDU_TOKEN_FILE !== undefined;
  const legacyBaiduComplete =
    raw.PTVAULT_IMPORT_BAIDU_APP_CREDENTIAL_FILE !== undefined &&
    raw.PTVAULT_IMPORT_BAIDU_TOKEN_FILE !== undefined;
  const cloudBaiduConfigured =
    raw.PTVAULT_BAIDU_OAUTH_CLIENT_ID !== undefined ||
    raw.PTVAULT_BAIDU_OAUTH_CLIENT_SECRET !== undefined ||
    raw.PTVAULT_BAIDU_APP_ID !== undefined;
  const cloudBaiduComplete =
    raw.PTVAULT_BAIDU_OAUTH_CLIENT_ID !== undefined &&
    raw.PTVAULT_BAIDU_OAUTH_CLIENT_SECRET !== undefined &&
    raw.PTVAULT_BAIDU_APP_ID !== undefined;
  const publicBaiduConfigured = raw.PTVAULT_BAIDU_CLIENT_PROFILE_FILE !== undefined;
  if (publicBaiduConfigured && cloudBaiduConfigured) {
    throw new Error('Choose one Baidu client configuration');
  }
  const importConfigured =
    importPaths.some((value) => value !== undefined) ||
    legacyBaiduConfigured ||
    cloudBaiduConfigured ||
    publicBaiduConfigured ||
    raw.PTVAULT_IMPORT_RECOVERY_ACCOUNT_IDS.length > 0;
  const importComplete =
    importPaths.every((value) => value !== undefined) &&
    (legacyBaiduComplete || cloudBaiduComplete || publicBaiduConfigured) &&
    raw.PTVAULT_IMPORT_RECOVERY_ACCOUNT_IDS.length >= 2 &&
    rcloneConfig !== undefined &&
    rcloneConfig !== '';
  if (importConfigured && !importComplete && !options.guidedSetup) {
    throw new Error(
      'PTVAULT import runtime must be configured together with rclone and two recovery accounts',
    );
  }
  if (options.guidedSetup &&
    ((importPaths[0] === undefined) !== (importPaths[1] === undefined) ||
      (legacyBaiduConfigured && !legacyBaiduComplete))) {
    throw new Error('Import directory and legacy credential pairs must be configured together');
  }
  if (raw.PTVAULT_IMPORT_PUBLICATION_ENABLED && (jellyfinUrl === undefined || !mediaComplete)) {
    throw new Error(
      'PTVAULT import publication requires media mounts and Jellyfin; libraries are discovered live',
    );
  }

  const baiduOAuth = [
    raw.PTVAULT_BAIDU_OAUTH_CLIENT_ID,
    raw.PTVAULT_BAIDU_OAUTH_CLIENT_SECRET,
    raw.PTVAULT_BAIDU_APP_ID,
  ];
  const baiduOAuthCount = baiduOAuth.filter((value) => value !== undefined).length;
  if (baiduOAuthCount !== 0 && baiduOAuthCount !== baiduOAuth.length) {
    throw new Error(
      'PTVAULT Baidu OAuth client id, secret, and app id must be configured together',
    );
  }
  if (
    raw.PTVAULT_ONEDRIVE_OAUTH_CLIENT_SECRET !== undefined &&
    raw.PTVAULT_ONEDRIVE_OAUTH_CLIENT_ID === undefined
  ) {
    throw new Error('PTVAULT OneDrive OAuth client id is required with its client secret');
  }
  if (
    raw.PTVAULT_ONEDRIVE_PROVISION_ENABLED &&
    (raw.PTVAULT_ONEDRIVE_OAUTH_CLIENT_ID === undefined ||
      rcloneConfig === undefined ||
      rcloneConfig === '')
  ) {
    throw new Error(
      'PTVAULT OneDrive provision requires OAuth client id and an explicit rclone config',
    );
  }
  const anyCloudOAuth =
    (baiduOAuthCount > 0 && !options.guidedSetup) || raw.PTVAULT_ONEDRIVE_OAUTH_CLIENT_ID !== undefined;
  if (anyCloudOAuth && raw.PTVAULT_CLOUD_OAUTH_CALLBACK_ORIGIN === undefined) {
    throw new Error('PTVAULT_CLOUD_OAUTH_CALLBACK_ORIGIN is required for cloud OAuth');
  }
  if (raw.PTVAULT_CLOUD_OAUTH_CALLBACK_ORIGIN !== undefined) {
    const callback = new URL(raw.PTVAULT_CLOUD_OAUTH_CALLBACK_ORIGIN);
    if (
      callback.protocol !== 'https:' ||
      callback.username !== '' ||
      callback.password !== '' ||
      callback.pathname !== '/' ||
      callback.search !== '' ||
      callback.hash !== ''
    ) {
      throw new Error('PTVAULT_CLOUD_OAUTH_CALLBACK_ORIGIN must be an HTTPS origin');
    }
  }
  for (const [key, value] of [
    ['PTVAULT_IMPORT_SECRET_ROOT', raw.PTVAULT_IMPORT_SECRET_ROOT],
    ['PTVAULT_IMPORT_SPOOL_ROOT', raw.PTVAULT_IMPORT_SPOOL_ROOT],
    ['PTVAULT_IMPORT_BAIDU_APP_CREDENTIAL_FILE', raw.PTVAULT_IMPORT_BAIDU_APP_CREDENTIAL_FILE],
    ['PTVAULT_IMPORT_BAIDU_TOKEN_FILE', raw.PTVAULT_IMPORT_BAIDU_TOKEN_FILE],
    ['PTVAULT_BAIDU_CLIENT_PROFILE_FILE', raw.PTVAULT_BAIDU_CLIENT_PROFILE_FILE],
  ] as const) {
    if (value !== undefined && !path.isAbsolute(value)) {
      throw new Error(`${key} must be absolute`);
    }
  }

  return {
    nodeEnv: raw.NODE_ENV,
    stateDir: path.resolve(raw.PTVAULT_STATE_DIR),
    masterKey,
    host: raw.PTVAULT_HOST,
    port: raw.PTVAULT_PORT,
    mode: raw.PTVAULT_MODE,
    offloadEnabled,
    guidedSetup: options.guidedSetup ?? false,
    buildVersion: raw.PTVAULT_BUILD_VERSION ?? null,
    buildCommit: raw.PTVAULT_BUILD_COMMIT ?? null,
    trustedProxyCidrs: raw.PTVAULT_TRUSTED_PROXY_CIDRS,
    qbAllowedRoots: raw.PTVAULT_QB_ALLOWED_ROOTS,
    qbPathMaps: raw.PTVAULT_QB_PATH_MAPS,
    rcloneBin: raw.PTVAULT_RCLONE_BIN,
    rcloneConfigPath:
      rcloneConfig === undefined || rcloneConfig === '' ? null : path.resolve(rcloneConfig),
    ageBin: raw.PTVAULT_AGE_BIN,
    mediaHotRoot: absoluteOrNull(raw.PTVAULT_MEDIA_HOT_ROOT),
    mediaMountRoot: absoluteOrNull(raw.PTVAULT_MEDIA_MOUNT_ROOT),
    importMountRoot: absoluteOrNull(raw.PTVAULT_IMPORT_MOUNT_ROOT),
    importRcBasePort: raw.PTVAULT_IMPORT_RC_BASE_PORT,
    mediaFarmRoot: absoluteOrNull(raw.PTVAULT_MEDIA_FARM_ROOT),
    mediaCacheDir: absoluteOrNull(raw.PTVAULT_MEDIA_CACHE_DIR),
    mediaRcBasePort: raw.PTVAULT_MEDIA_RC_BASE_PORT,
    mediaRcCredentialFile: absoluteOrNull(raw.PTVAULT_MEDIA_RC_CREDENTIAL_FILE),
    jellyfinUrl: jellyfinUrl ?? null,
    jellyfinTokenFile: jellyfinTokenFile === undefined ? null : path.resolve(jellyfinTokenFile),
    jellyfinPathMaps: raw.PTVAULT_JELLYFIN_PATH_MAPS,
    offloadParallelEnabled: raw.PTVAULT_OFFLOAD_PARALLEL_ENABLED,
    offloadMaxInFlight,
    offloadPreflightConcurrency,
    offloadPauseSnapshotConcurrency,
    offloadMaxPausedPipelines,
    offloadHashConcurrency,
    offloadRemoteDataConcurrency,
    importEnabled: raw.PTVAULT_IMPORT_ENABLED,
    importArchiveRuntime,
    importSecretRoot: absoluteOrNull(raw.PTVAULT_IMPORT_SECRET_ROOT),
    importSpoolRoot: absoluteOrNull(raw.PTVAULT_IMPORT_SPOOL_ROOT),
    importBaiduAppCredentialFile: absoluteOrNull(raw.PTVAULT_IMPORT_BAIDU_APP_CREDENTIAL_FILE),
    importBaiduTokenFile: absoluteOrNull(raw.PTVAULT_IMPORT_BAIDU_TOKEN_FILE),
    baiduClientProfileFile: absoluteOrNull(raw.PTVAULT_BAIDU_CLIENT_PROFILE_FILE),
    importRecoveryAccountIds: raw.PTVAULT_IMPORT_RECOVERY_ACCOUNT_IDS,
    importDownloadHosts: raw.PTVAULT_IMPORT_DOWNLOAD_HOSTS,
    importPublicationEnabled: raw.PTVAULT_IMPORT_PUBLICATION_ENABLED,
    importJellyfinLibraries: raw.PTVAULT_IMPORT_JELLYFIN_LIBRARIES,
    importSourceCleanupEnabled: raw.PTVAULT_IMPORT_SOURCE_CLEANUP_ENABLED,
    importSelectedSourceDeleteEnabled: raw.PTVAULT_IMPORT_SELECTED_SOURCE_DELETE_ENABLED,
    importSourceDeleteApprovalFile: absoluteOrNull(raw.PTVAULT_IMPORT_SOURCE_DELETE_APPROVAL_FILE),
    cloudOauthCallbackOrigin: raw.PTVAULT_CLOUD_OAUTH_CALLBACK_ORIGIN ?? null,
    baiduOauthClientId: raw.PTVAULT_BAIDU_OAUTH_CLIENT_ID ?? null,
    baiduOauthClientSecret: raw.PTVAULT_BAIDU_OAUTH_CLIENT_SECRET ?? null,
    baiduAppId: raw.PTVAULT_BAIDU_APP_ID ?? null,
    oneDriveOauthClientId: raw.PTVAULT_ONEDRIVE_OAUTH_CLIENT_ID ?? null,
    oneDriveOauthClientSecret: raw.PTVAULT_ONEDRIVE_OAUTH_CLIENT_SECRET ?? null,
    oneDriveTenant: raw.PTVAULT_ONEDRIVE_TENANT,
    oneDriveProvisionEnabled: raw.PTVAULT_ONEDRIVE_PROVISION_ENABLED,
  };
}

/** Treats an unset and an empty value alike: both mean "not configured". */
function absoluteOrNull(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : path.resolve(value);
}

export function assertLoopbackHttpOrigin(value: string): void {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('PTVAULT_JELLYFIN_URL must be a loopback HTTP origin');
  }
}
