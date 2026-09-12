import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { SetupConfigStore } from './config-store.js';
import { isPathWithinRoot } from '../core/paths.js';
import { readPrivateText, writePrivateText } from './private-files.js';

export type ManagedEnvironmentOptions = {
  stateDir: string;
  releaseRoot: string;
  credentialRoot: string;
  mediaExportRoot: string;
  masterKey: Buffer;
  port: number;
};

/** A fresh allowlisted environment, never an overlay on another installation. */
export function managedEnvironment(settings: ReturnType<SetupConfigStore['active']>, options: ManagedEnvironmentOptions): NodeJS.ProcessEnv {
  if (!path.isAbsolute(options.mediaExportRoot) || isPathWithinRoot(options.mediaExportRoot, options.stateDir) || isPathWithinRoot(options.stateDir, options.mediaExportRoot)) throw new Error('SETUP_MEDIA_EXPORT_OVERLAP');
  const { values, secrets } = settings;
  const runtime = path.join(options.releaseRoot, 'runtime');
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    PTVAULT_STATE_DIR: options.stateDir,
    PTVAULT_MASTER_KEY: options.masterKey.toString('base64'),
    PTVAULT_HOST: '127.0.0.1',
    PTVAULT_PORT: String(options.port),
    PTVAULT_MODE: 'ACTIVE',
    PTVAULT_OFFLOAD_ENABLED: 'false',
    PTVAULT_RCLONE_CONFIG: path.join(options.stateDir, 'rclone', 'rclone.conf'),
    PTVAULT_RCLONE_BIN: path.join(runtime, 'bin', 'rclone'),
    PTVAULT_AGE_BIN: path.join(runtime, 'bin', 'age'),
    PTVAULT_IMPORT_ENABLED: 'false',
    PTVAULT_IMPORT_SOURCE_CLEANUP_ENABLED: 'false',
    PTVAULT_IMPORT_SELECTED_SOURCE_DELETE_ENABLED: 'false',
    PTVAULT_IMPORT_PUBLICATION_ENABLED: 'false',
  };
  const netdisk = values.useCases.includes('NETDISK');
  const offload = values.useCases.includes('PT_OFFLOAD');
  const media = offload || values.useCases.includes('JELLYFIN');
  env.PTVAULT_QB_ALLOWED_ROOTS = values.sourceRoots.join(path.delimiter);
  if (netdisk) {
    env.PTVAULT_IMPORT_SECRET_ROOT = path.join(options.stateDir, 'import-secrets');
    env.PTVAULT_IMPORT_SPOOL_ROOT = values.spoolRoot;
    env.PTVAULT_IMPORT_RECOVERY_ACCOUNT_IDS = values.recoveryAccountIds.join(',');
    env.PTVAULT_IMPORT_ARCHIVE_ENABLED = 'true';
    env.PTVAULT_IMPORT_ARCHIVE_SEVENZIP = path.join(runtime, 'archive', '7zzs');
    env.PTVAULT_IMPORT_ARCHIVE_SANDBOX = path.join(runtime, 'archive', 'archive-sandbox.py');
    env.PTVAULT_IMPORT_ARCHIVE_PROBE_RUNTIME = path.join(runtime, 'archive', 'probe');
    if (values.baiduClient === 'DEFAULT') env.PTVAULT_BAIDU_CLIENT_PROFILE_FILE = path.join(runtime, 'baidu-client.json');
    if (values.baiduClient === 'CUSTOM' && values.baiduClientId && values.baiduAppId && secrets.baiduClientSecret) {
      env.PTVAULT_BAIDU_OAUTH_CLIENT_ID = values.baiduClientId;
      env.PTVAULT_BAIDU_OAUTH_CLIENT_SECRET = secrets.baiduClientSecret;
      env.PTVAULT_BAIDU_APP_ID = values.baiduAppId;
    }
  }
  if (values.oauthCallbackOrigin) env.PTVAULT_CLOUD_OAUTH_CALLBACK_ORIGIN = values.oauthCallbackOrigin;
  if (values.oneDriveClientId && values.oauthCallbackOrigin) {
    env.PTVAULT_ONEDRIVE_OAUTH_CLIENT_ID = values.oneDriveClientId;
    if (secrets.oneDriveClientSecret) env.PTVAULT_ONEDRIVE_OAUTH_CLIENT_SECRET = secrets.oneDriveClientSecret;
    env.PTVAULT_ONEDRIVE_TENANT = values.oneDriveTenant;
    env.PTVAULT_CLOUD_OAUTH_CALLBACK_ORIGIN = values.oauthCallbackOrigin;
    env.PTVAULT_ONEDRIVE_PROVISION_ENABLED = 'true';
  }
  // Incomplete selections are editable drafts, not a reason to lose the setup UI.
  // Existing capability checks still distinguish configured from verified/ready.
  const mediaHotRoot = values.mediaHotRoot ?? (offload ? null : path.join(options.mediaExportRoot,'hot'));
  if (media && mediaHotRoot && values.jellyfinUrl && secrets.jellyfinToken && values.jellyfinPathMaps.length > 0) {
    const digest = createHash('sha256').update(secrets.jellyfinToken).digest('hex');
    const tokenFile = path.join(options.credentialRoot, `jellyfin-${digest}.key`);
    if (!existsSync(tokenFile) || readPrivateText(tokenFile) !== secrets.jellyfinToken) writePrivateText(tokenFile, secrets.jellyfinToken);
    const rcFile = path.join(options.credentialRoot, 'mount-rc.key');
    if (!existsSync(rcFile)) writePrivateText(rcFile, randomBytes(32).toString('base64url'));
    else readPrivateText(rcFile);
    Object.assign(env, {
      PTVAULT_JELLYFIN_URL: values.jellyfinUrl,
      PTVAULT_JELLYFIN_TOKEN_FILE: tokenFile,
      PTVAULT_JELLYFIN_PATH_MAPS: values.jellyfinPathMaps.join(','),
      PTVAULT_MEDIA_HOT_ROOT: mediaHotRoot,
      PTVAULT_MEDIA_MOUNT_ROOT: path.join(options.mediaExportRoot, 'mounts', 'media'),
      PTVAULT_IMPORT_MOUNT_ROOT: path.join(options.mediaExportRoot, 'mounts', 'imports'),
      PTVAULT_MEDIA_FARM_ROOT: path.join(options.mediaExportRoot, 'library'),
      PTVAULT_MEDIA_CACHE_DIR: path.join(options.stateDir, 'media-cache'),
      PTVAULT_MEDIA_RC_CREDENTIAL_FILE: rcFile,
      PTVAULT_IMPORT_PUBLICATION_ENABLED: String(netdisk),
      PTVAULT_OFFLOAD_ENABLED: String(offload && values.sourceRoots.length > 0),
    });
  }
  return env;
}
