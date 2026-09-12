import { realpathSync } from 'node:fs';
import { z } from 'zod';

import type { AppDatabase } from '../db/database.js';
import { configDigest, RcloneConfigError } from '../storage/rclone-config-files.js';
import {
  nativeToken,
  type NativeAuthorityContext,
  type NativeConfigAuthority,
} from '../storage/rclone-native-config.js';
import type { EncryptedSecretRepository, OAuthConnectionCredential } from './secrets.js';

const GuardSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('FILE'), binding: z.string() }).strict(),
  z
    .object({
      kind: z.literal('DATABASE'),
      connectionId: z.string(),
      secretRef: z.string(),
      revision: z.number().int().nonnegative(),
      payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
      externalAccountId: z.string(),
      clientId: z.string(),
      binding: z.string(),
      canonical: z.boolean(),
      restoreStamp: z.boolean(),
    })
    .strict(),
]);
type Guard = z.infer<typeof GuardSchema>;
type DatabaseGuard = Extract<Guard, { kind: 'DATABASE' }>;
type Connection = {
  id: string;
  provider: string;
  externalAccountId: string;
  authState: string;
  disconnectedAt: number | null;
  secretRef: string | null;
  revision: number;
  accessExpiresAt: number | null;
  encryptedPayload: string;
};
type Binding = {
  id: string;
  connectionId: string | null;
  rawRemote: string;
  cryptRemote: string;
  profileId: string | null;
  mode: string;
  enabled: number;
};

function stale(): never {
  throw new RcloneConfigError('RCLONE_CONFIG_AUTHORITY_STALE');
}
function sameToken(
  credential: OAuthConnectionCredential,
  token: ReturnType<typeof nativeToken>,
): boolean {
  return (
    credential.accessToken === token.accessToken &&
    credential.accessExpiresAt === token.expiresAt &&
    (token.refreshToken === undefined || credential.refreshToken === token.refreshToken)
  );
}

/** DB credentials remain authoritative even when rclone itself rotates a token.
 * The file publish callback is synchronous: no other DB writer can interleave
 * between its final CAS and rename while this short IMMEDIATE transaction runs.
 * A private journal survives a file-published / DB-rollback crash window.
 */
export class DatabaseNativeRcloneAuthority implements NativeConfigAuthority {
  constructor(
    private readonly options: {
      db: AppDatabase;
      secrets: Pick<
        EncryptedSecretRepository,
        'readOAuthConnectionCredential' | 'replaceOAuthConnectionCredential'
      >;
      canonicalPath: string | null;
      onCredentialChanged?: (connectionId: string) => void;
    },
  ) {}

  capture(context: NativeAuthorityContext): Record<string, unknown> {
    return this.options.db.transaction(() => {
      const guards: Record<string, Guard> = {};
      for (const alias of context.aliases) {
        const fields = context.sections.get(alias)!;
        if (!fields.has('token')) continue;
        const binding = this.binding(alias);
        const hints = context.bindings.filter((hint) => hint.alias === alias);
        if (hints.length > 1) stale();
        if (hints.length === 0 && binding?.enabled === 0) stale();
        const connectionId = hints[0]?.connectionId ?? binding?.connectionId;
        if (connectionId == null) {
          guards[alias] = { kind: 'FILE', binding: JSON.stringify(binding) };
          continue;
        }
        if (binding?.connectionId != null && binding.connectionId !== connectionId) stale();
        const connection = this.connection(connectionId);
        const credential = this.credential(connection);
        if (
          fields.get('type') !== 'onedrive' ||
          fields.get('drive_id') !== connection.externalAccountId ||
          (fields.has('client_id') && fields.get('client_id') !== credential.clientId) ||
          !sameToken(credential, nativeToken(fields.get('token')!))
        )
          stale();
        guards[alias] = {
          kind: 'DATABASE',
          connectionId,
          secretRef: connection.secretRef!,
          revision: connection.revision,
          payloadDigest: configDigest(connection.encryptedPayload),
          externalAccountId: connection.externalAccountId,
          clientId: credential.clientId,
          binding: JSON.stringify(binding),
          canonical:
            this.options.canonicalPath !== null &&
            context.source === realpathSync(this.options.canonicalPath),
          restoreStamp:
            this.options.db
              .prepare(
                'SELECT 1 FROM cloud_connection_materializations WHERE connection_id=? AND materialized_secret_ref=?',
              )
              .get(connectionId, connection.secretRef) !== undefined,
        };
      }
      return guards;
    })();
  }

  /** Long-running mounts also stop on revocation/binding replacement without
   * waiting for the next native refresh. A harmless concurrent token refresh
   * does not serialise or stop another upload; its later write still needs CAS. */
  validate(guards: Record<string, unknown>): void {
    for (const [alias, value] of Object.entries(guards)) {
      const guard = this.guard(value);
      if (JSON.stringify(this.binding(alias)) !== guard.binding) stale();
      if (guard.kind === 'DATABASE')
        this.assertIdentity(this.connection(guard.connectionId), guard);
    }
  }

  persistenceFailed(guards: Record<string, unknown>): void {
    this.options.db
      .transaction(() => {
        for (const value of Object.values(guards)) {
          const guard = this.guard(value);
          if (guard.kind !== 'DATABASE') continue;
          const connection = this.connection(guard.connectionId);
          if (
            connection.revision !== guard.revision ||
            connection.secretRef !== guard.secretRef ||
            configDigest(connection.encryptedPayload) !== guard.payloadDigest
          )
            continue;
          // rclone can log SaveConfig failure yet exit zero. Its unsaved rotating
          // refresh token is not reconstructible, so don't advertise the old one
          // as healthy or overwrite a newer login. Reauthorization clears this.
          this.options.db
            .prepare(
              "UPDATE cloud_connections SET auth_state='REAUTH_REQUIRED',revision=revision+1,updated_at=? WHERE id=? AND revision=?",
            )
            .run(Date.now(), guard.connectionId, guard.revision);
          this.options.db
            .prepare(
              "UPDATE cloud_connection_materializations SET materialized_secret_ref=NULL,owner_token=NULL,lease_expires_at=NULL,failure_code='RCLONE_CONFIG_NATIVE_SAVE_FAILED',updated_at=? WHERE connection_id=?",
            )
            .run(Date.now(), guard.connectionId);
        }
      })
      .immediate();
  }

  commit(
    input: Parameters<NativeConfigAuthority['commit']>[0],
    publish: () => void,
  ): Record<string, unknown> {
    const changedConnections = new Set<string>();
    const result = this.options.db
      .transaction(() => {
        this.validate(input.guards);
        const nextGuards = { ...input.guards };
        for (const change of input.changes) {
          const guard = this.guard(input.guards[change.alias]);
          if (guard.kind === 'FILE') continue;
          const connection = this.connection(guard.connectionId);
          this.assertIdentity(connection, guard);
          const credential = this.credential(connection);
          if (credential.clientId !== guard.clientId) stale();
          const token = nativeToken(change.next);
          const exactFence =
            connection.revision === guard.revision &&
            configDigest(connection.encryptedPayload) === guard.payloadDigest;
          // Crash replay is idempotent only for this exact next token and one
          // committed revision, never for an arbitrary newer same-identity login.
          const alreadyCommitted =
            connection.revision === guard.revision + 1 && sameToken(credential, token);
          if (!exactFence && !alreadyCommitted) stale();
          if (exactFence) {
            if (!sameToken(credential, nativeToken(change.previous))) stale();
            this.options.secrets.replaceOAuthConnectionCredential(
              { id: guard.secretRef, kind: 'OAUTH_CONNECTION_CREDENTIAL' },
              {
                ...credential,
                accessToken: token.accessToken,
                refreshToken: token.refreshToken || credential.refreshToken,
                accessExpiresAt: token.expiresAt,
              },
            );
            const updated = this.options.db
              .prepare(
                `UPDATE cloud_connections SET access_expires_at=?, revision=revision+1, updated_at=?
            WHERE id=? AND revision=? AND secret_ref=? AND auth_state='CONNECTED' AND disconnected_at IS NULL`,
              )
              .run(
                token.expiresAt,
                Date.now(),
                guard.connectionId,
                guard.revision,
                guard.secretRef,
              );
            if (updated.changes !== 1) stale();
            // The secret reference itself does not change on rotation. A token
            // adopted from a probe candidate must invalidate any old canonical
            // stamp; only a guarded canonical publication below can restore it.
            this.options.db
              .prepare(
                'UPDATE cloud_connection_materializations SET materialized_secret_ref=NULL,updated_at=? WHERE connection_id=?',
              )
              .run(Date.now(), guard.connectionId);
            changedConnections.add(guard.connectionId);
          }
          const committed = this.connection(guard.connectionId);
          nextGuards[change.alias] = {
            ...guard,
            revision: committed.revision,
            payloadDigest: configDigest(committed.encryptedPayload),
          } satisfies DatabaseGuard;
        }
        publish();
        for (const change of input.changes) {
          const guard = this.guard(nextGuards[change.alias]);
          if (
            guard.kind !== 'DATABASE' ||
            !guard.canonical ||
            !guard.restoreStamp ||
            this.binding(change.alias)?.connectionId !== guard.connectionId
          )
            continue;
          // Native refresh changes no encryption/binding options. Only the real
          // canonical pair receives a stamp; a candidate is still pending probes.
          this.options.db
            .prepare(
              `INSERT INTO cloud_connection_materializations(connection_id,materialized_secret_ref,updated_at)
          VALUES (?,?,?) ON CONFLICT(connection_id) DO UPDATE SET materialized_secret_ref=excluded.materialized_secret_ref,
          owner_token=NULL,lease_expires_at=NULL,failure_code=NULL,updated_at=excluded.updated_at`,
            )
            .run(guard.connectionId, guard.secretRef, Date.now());
        }
        return nextGuards;
      })
      .immediate();
    for (const connectionId of changedConnections) this.options.onCredentialChanged?.(connectionId);
    return result;
  }

  private guard(value: unknown): Guard {
    const parsed = GuardSchema.safeParse(value);
    if (!parsed.success) throw new RcloneConfigError('RCLONE_CONFIG_JOURNAL_INVALID');
    return parsed.data;
  }
  private binding(alias: string): Binding | null {
    return (
      (this.options.db
        .prepare(
          `SELECT id, connection_id AS connectionId, raw_remote AS rawRemote,
      crypt_remote AS cryptRemote, encryption_profile_id AS profileId, provisioning_mode AS mode, enabled
      FROM storage_accounts WHERE raw_remote=?`,
        )
        .get(`${alias}:`) as Binding | undefined) ?? null
    );
  }
  private connection(id: string): Connection {
    const row = this.options.db
      .prepare(
        `SELECT connection.id,connection.provider,external_account_id AS externalAccountId,
      auth_state AS authState,disconnected_at AS disconnectedAt,secret_ref AS secretRef,revision,access_expires_at AS accessExpiresAt,
      secret.encrypted_payload AS encryptedPayload FROM cloud_connections AS connection
      JOIN encrypted_secrets AS secret ON secret.id=connection.secret_ref AND secret.kind='OAUTH_CONNECTION_CREDENTIAL'
      WHERE connection.id=?`,
      )
      .get(id) as Connection | undefined;
    if (
      row === undefined ||
      row.authState !== 'CONNECTED' ||
      row.disconnectedAt !== null ||
      row.provider !== 'ONEDRIVE' ||
      row.secretRef === null
    )
      stale();
    return row;
  }
  private credential(connection: Connection): OAuthConnectionCredential {
    const value = this.options.secrets.readOAuthConnectionCredential({
      id: connection.secretRef!,
      kind: 'OAUTH_CONNECTION_CREDENTIAL',
    });
    if (
      value.provider !== connection.provider ||
      value.externalAccountId !== connection.externalAccountId ||
      value.accessExpiresAt !== connection.accessExpiresAt
    )
      stale();
    return value;
  }
  private assertIdentity(connection: Connection, guard: DatabaseGuard): void {
    if (
      connection.secretRef !== guard.secretRef ||
      connection.externalAccountId !== guard.externalAccountId
    )
      stale();
  }
}
