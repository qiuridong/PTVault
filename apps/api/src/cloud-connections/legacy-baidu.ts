import { createHash } from 'node:crypto';
import type { AppDatabase } from '../db/database.js';
import { readLegacyBaiduEnvironmentFiles } from '../imports/baidu-oauth.js';
import { BaiduCloudProviderAdapter } from './baidu-provider.js';
import { CloudConnectionRepository } from './repository.js';
import type { EncryptedSecretRepository } from './secrets.js';
import type { TrustedBaiduClientProfile } from '../imports/baidu-client-profile.js';
import { registerProfileBaiduEnvironment } from './profile-baidu.js';

export async function loadLegacyBaiduEnvironment(options: {
  appCredentialFile: string;
  tokenFile: string;
  fetch?: typeof fetch;
  now?: () => number;
  trustedProfiles?: readonly TrustedBaiduClientProfile[];
}) {
  const files = await readLegacyBaiduEnvironmentFiles(
    options.appCredentialFile,
    options.tokenFile,
    options.trustedProfiles,
  );
  const configFingerprint = createHash('sha256')
    .update(files.app.version === 2 ? 'ptvault-profile-baidu-v2\0' : 'ptvault-legacy-baidu-v1\0')
    .update(
      JSON.stringify(
        files.app.version === 2
          ? [files.appPath, files.tokenPath, files.app.clientProfileId, files.app.clientFingerprint]
          : [files.appPath, files.tokenPath],
      ),
    )
    .digest('hex');
  const id = configFingerprint;
  const connectionId = `${id.slice(0, 8)}-${id.slice(8, 12)}-8${id.slice(13, 16)}-a${id.slice(17, 20)}-${id.slice(20, 32)}`;
  return {
    connectionId,
    configFingerprint,
    files,
    tokenFingerprint: createHash('sha256').update(JSON.stringify(files.token)).digest('hex'),
    provider: new BaiduCloudProviderAdapter({
      ...files.app,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
  };
}

export type LegacyBaiduEnvironment = Awaited<ReturnType<typeof loadLegacyBaiduEnvironment>>;

/** Explicit named environment slot; DB refreshes never roll back to the old token file. */
export async function registerLegacyBaiduEnvironment(
  db: AppDatabase,
  secrets: EncryptedSecretRepository,
  environment: LegacyBaiduEnvironment,
  now: () => number = () => Date.now(),
): Promise<string> {
  if (environment.files.app.version === 2)
    return registerProfileBaiduEnvironment(db, secrets, environment, now);
  const { connectionId, configFingerprint, tokenFingerprint, files, provider } = environment;
  const prior = db
    .prepare(
      `SELECT token_fingerprint AS tokenFingerprint, app_id AS appId, client_id AS clientId
    FROM legacy_environment_connections WHERE connection_id=?`,
    )
    .get(connectionId) as { tokenFingerprint: string; appId: string; clientId: string } | undefined;
  if (
    prior !== undefined &&
    (prior.clientId !== files.app.clientId || prior.appId !== files.app.appId)
  )
    throw new Error('AUTH_LEGACY_APP_IDENTITY_CHANGED');
  if (prior?.tokenFingerprint === tokenFingerprint) return connectionId;
  const material = await provider.inspectLegacyToken(files.token);
  const connections = new CloudConnectionRepository(db, now);
  db.transaction(() => {
    const current = db
      .prepare(
        'SELECT token_fingerprint AS tokenFingerprint FROM legacy_environment_connections WHERE connection_id=?',
      )
      .get(connectionId) as { tokenFingerprint: string } | undefined;
    if (current?.tokenFingerprint === tokenFingerprint) return;
    if ((current?.tokenFingerprint ?? null) !== (prior?.tokenFingerprint ?? null))
      throw new Error('AUTH_LEGACY_IMPORT_FENCE_REJECTED');
    const authority = prior === undefined ? null : connections.authority(connectionId);
    if (authority !== null && authority.externalAccountId !== material.externalAccountId)
      throw new Error('AUTH_LEGACY_IDENTITY_CHANGED');
    const identity = connections.authorityByIdentity('BAIDU', material.externalAccountId);
    if (identity !== null && identity.id !== connectionId)
      throw new Error('AUTH_LEGACY_IDENTITY_ALREADY_CONNECTED');
    const ref = secrets.createOAuthConnectionCredential({
      provider: 'BAIDU',
      clientId: material.clientId,
      externalAccountId: material.externalAccountId,
      accessToken: material.accessToken,
      refreshToken: material.refreshToken,
      accessExpiresAt: material.accessExpiresAt,
      scopes: material.scopes,
    });
    if (authority === null) {
      connections.insertOAuthConnection({
        id: connectionId,
        label: '百度 · 环境连接（只读）',
        secretRef: ref,
        material,
      });
      db.prepare(
        `INSERT INTO legacy_environment_connections(connection_id,config_fingerprint,token_fingerprint,app_id,client_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?)`,
      ).run(
        connectionId,
        configFingerprint,
        tokenFingerprint,
        files.app.appId,
        files.app.clientId,
        now(),
        now(),
      );
    } else {
      const changed = db
        .prepare(
          `UPDATE cloud_connections SET secret_ref=?,access_expires_at=?,auth_state='CONNECTED',revision=revision+1,updated_at=?
        WHERE id=? AND revision=? AND external_account_id=? AND secret_ref IS ?`,
        )
        .run(
          ref.id,
          material.accessExpiresAt,
          now(),
          connectionId,
          authority.revision,
          material.externalAccountId,
          authority.secretRef?.id ?? null,
        );
      if (changed.changes !== 1) throw new Error('AUTH_LEGACY_IMPORT_FENCE_REJECTED');
      db.prepare(
        'UPDATE legacy_environment_connections SET token_fingerprint=?,updated_at=? WHERE connection_id=?',
      ).run(tokenFingerprint, now(), connectionId);
      if (authority.secretRef !== null)
        secrets.deleteOAuthConnectionCredential(authority.secretRef);
    }
    // Persist the named default once; job resolution never consults this setting.
    db.prepare(
      `UPDATE netdisk_settings SET default_source_connection_id=?,revision=revision+1,updated_at=?
      WHERE singleton=1 AND default_source_connection_id IS NULL AND updated_by_admin_id IS NULL`,
    ).run(connectionId, now());
  }).immediate();
  return connectionId;
}
