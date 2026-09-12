import type { AppDatabase } from '../db/database.js';
import type { LegacyBaiduEnvironment } from './legacy-baidu.js';
import { CloudConnectionRepository } from './repository.js';
import type { EncryptedSecretRepository } from './secrets.js';

type Binding = {
  tokenFingerprint: string;
  profileId: string;
  clientId: string;
  clientFingerprint: string;
  sourceCommit: string;
  sourceSha256: string;
};
const SELECT = `SELECT token_fingerprint AS tokenFingerprint,profile_id AS profileId,client_id AS clientId,
 client_fingerprint AS clientFingerprint,source_commit AS sourceCommit,source_sha256 AS sourceSha256
 FROM baidu_profile_environment_connections WHERE connection_id=?`;

/** Version2 has no invented app_id and never changes version1 legacy-job bindings. */
export async function registerProfileBaiduEnvironment(
  db: AppDatabase,
  secrets: EncryptedSecretRepository,
  environment: LegacyBaiduEnvironment,
  now: () => number,
): Promise<string> {
  const { connectionId, configFingerprint, tokenFingerprint, files, provider } = environment;
  const app = files.app;
  if (app.version !== 2) throw new Error('AUTH_CLIENT_PROFILE_MISMATCH');
  const prior = db.prepare(SELECT).get(connectionId) as Binding | undefined;
  if (
    prior &&
    (prior.profileId !== app.clientProfileId ||
      prior.clientId !== app.clientId ||
      prior.clientFingerprint !== app.clientFingerprint ||
      prior.sourceCommit !== app.sourceCommit ||
      prior.sourceSha256 !== app.sourceSha256)
  )
    throw new Error('AUTH_PROFILE_BINDING_CHANGED');
  // A file is an import slot, not the refresh authority. Never replay stale file
  // credentials over newer DB material, or silently reconnect a disconnected row.
  if (prior?.tokenFingerprint === tokenFingerprint) return connectionId;
  const material = await provider.inspectLegacyToken(files.token);
  const connections = new CloudConnectionRepository(db, now);
  db.transaction(() => {
    const current = db.prepare(SELECT).get(connectionId) as Binding | undefined;
    if (current?.tokenFingerprint === tokenFingerprint) return;
    if ((current?.tokenFingerprint ?? null) !== (prior?.tokenFingerprint ?? null))
      throw new Error('AUTH_PROFILE_IMPORT_FENCE_REJECTED');
    const authority =
      db.prepare('SELECT 1 FROM cloud_connections WHERE id=?').get(connectionId) === undefined
        ? null
        : connections.authority(connectionId);
    if (prior === undefined && authority !== null)
      throw new Error('AUTH_PROFILE_BINDING_INCOMPLETE');
    if (authority !== null && authority.externalAccountId !== material.externalAccountId)
      throw new Error('AUTH_PROFILE_IDENTITY_CHANGED');
    const identity = connections.authorityByIdentity('BAIDU', material.externalAccountId);
    if (identity !== null && identity.id !== connectionId)
      throw new Error('AUTH_PROFILE_IDENTITY_ALREADY_CONNECTED');
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
        label: '百度 · 默认客户端账户',
        secretRef: ref,
        material,
      });
      db.prepare(
        `INSERT INTO baidu_profile_environment_connections(connection_id,config_fingerprint,token_fingerprint,profile_id,client_id,client_fingerprint,source_commit,source_sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        connectionId,
        configFingerprint,
        tokenFingerprint,
        app.clientProfileId,
        app.clientId,
        app.clientFingerprint,
        app.sourceCommit,
        app.sourceSha256,
        now(),
        now(),
      );
    } else {
      const changed = db
        .prepare(
          `UPDATE cloud_connections SET secret_ref=?,access_expires_at=?,auth_state='CONNECTED',capabilities_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND external_account_id=? AND secret_ref IS ?`,
        )
        .run(
          ref.id,
          material.accessExpiresAt,
          JSON.stringify(material.capabilities),
          now(),
          connectionId,
          authority.revision,
          material.externalAccountId,
          authority.secretRef?.id ?? null,
        );
      if (changed.changes !== 1) throw new Error('AUTH_PROFILE_IMPORT_FENCE_REJECTED');
      db.prepare(
        'UPDATE baidu_profile_environment_connections SET token_fingerprint=?,updated_at=? WHERE connection_id=?',
      ).run(tokenFingerprint, now(), connectionId);
      if (authority.secretRef) secrets.deleteOAuthConnectionCredential(authority.secretRef);
    }
    db.prepare(
      `UPDATE netdisk_settings SET default_source_connection_id=?,revision=revision+1,updated_at=? WHERE singleton=1 AND default_source_connection_id IS NULL AND updated_by_admin_id IS NULL`,
    ).run(connectionId, now());
  }).immediate();
  return connectionId;
}
