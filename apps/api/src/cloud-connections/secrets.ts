import { randomUUID } from 'node:crypto';

import { CloudProviderSchema, type CloudProvider } from '@ptvault/contracts';
import { z } from 'zod';

import type { SecretBox } from '../core/crypto.js';
import type { AppDatabase } from '../db/database.js';

export const SecretKindSchema = z.enum([
  'OAUTH_CONNECTION_CREDENTIAL',
  'OAUTH_FLOW_VERIFIER',
  'ENCRYPTION_PROFILE_SECRET',
  'IMPORT_JOB_CREDENTIAL',
]);

export type SecretKind = z.infer<typeof SecretKindSchema>;

type TypedSecretRef<K extends SecretKind> = Readonly<{
  id: string;
  kind: K;
}>;

export type OAuthConnectionCredentialRef = TypedSecretRef<'OAUTH_CONNECTION_CREDENTIAL'>;
export type OAuthFlowVerifierRef = TypedSecretRef<'OAUTH_FLOW_VERIFIER'>;
export type EncryptionProfileSecretRef = TypedSecretRef<'ENCRYPTION_PROFILE_SECRET'>;
export type ImportJobCredentialRef = TypedSecretRef<'IMPORT_JOB_CREDENTIAL'>;

export type OAuthConnectionCredential = {
  provider: CloudProvider;
  clientId: string;
  externalAccountId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  scopes: string[];
  baiduClientProfile?: { id: string; fingerprint: string } | undefined;
};

export type EncryptionProfileSecret = {
  password: string;
  password2: string;
};

export type ImportJobCredential = {
  credential: string;
};

export type WrappingKeyIdentity = {
  id: string;
  version: number;
};

const OAuthConnectionCredentialSchema = z
  .object({
    provider: CloudProviderSchema,
    clientId: z.string().min(1).max(256),
    externalAccountId: z.string().min(1).max(256),
    accessToken: z.string().min(1).max(16_384),
    refreshToken: z.string().min(1).max(16_384),
    accessExpiresAt: z.number().int().nonnegative(),
    scopes: z.array(z.string().min(1).max(128)).max(64),
    baiduClientProfile: z.object({ id: z.string().min(1).max(128), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  })
  .strict().refine(value => value.baiduClientProfile === undefined || value.provider === 'BAIDU');

const OAuthFlowVerifierSchema = z.string().min(16).max(1024);

const EncryptionProfileSecretSchema = z
  .object({
    password: z.string().min(20).max(1024),
    password2: z.string().min(20).max(1024),
  })
  .strict();

const ImportJobCredentialSchema = z.object({ credential: z.string().min(1).max(4096) }).strict();

const EnvelopeSchema = z
  .object({
    version: z.literal(1),
    kind: SecretKindSchema,
    payload: z.unknown(),
  })
  .strict();

type SecretRow = {
  id: string;
  kind: SecretKind;
  encryptedPayload: string;
  wrappingKeyId: string;
  wrappingKeyVersion: number;
};

export type SecretRepositoryErrorCode =
  'SECRET_NOT_FOUND' | 'SECRET_KIND_MISMATCH' | 'SECRET_DECRYPT_FAILED' | 'SECRET_PAYLOAD_INVALID';

export class SecretRepositoryError extends Error {
  constructor(readonly code: SecretRepositoryErrorCode) {
    super(code);
    this.name = 'SecretRepositoryError';
  }
}

export type EncryptedSecretRepositoryOptions = {
  db: AppDatabase;
  secretBox: SecretBox;
  wrappingKey: WrappingKeyIdentity;
  now?: () => number;
  newId?: () => string;
};

/**
 * One encrypted namespace with four compile-time and runtime separated kinds.
 * Callers never pass a naked string reference and every read validates both the
 * database row kind and the authenticated envelope kind before decoding data.
 */
export class EncryptedSecretRepository {
  private readonly db: AppDatabase;
  private readonly secretBox: SecretBox;
  private readonly now: () => number;
  private readonly newId: () => string;
  readonly wrappingKey: WrappingKeyIdentity;

  constructor(options: EncryptedSecretRepositoryOptions) {
    if (options.wrappingKey.id.length === 0 || options.wrappingKey.version <= 0) {
      throw new Error('INVALID_WRAPPING_KEY_IDENTITY');
    }
    this.db = options.db;
    this.secretBox = options.secretBox;
    this.wrappingKey = { ...options.wrappingKey };
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? randomUUID;
  }

  createOAuthConnectionCredential(
    credential: OAuthConnectionCredential,
  ): OAuthConnectionCredentialRef {
    const parsed = OAuthConnectionCredentialSchema.parse(credential);
    return this.create('OAUTH_CONNECTION_CREDENTIAL', parsed);
  }

  createOAuthFlowVerifier(verifier: string): OAuthFlowVerifierRef {
    return this.create('OAUTH_FLOW_VERIFIER', OAuthFlowVerifierSchema.parse(verifier));
  }

  createEncryptionProfileSecret(secret: EncryptionProfileSecret): EncryptionProfileSecretRef {
    return this.create('ENCRYPTION_PROFILE_SECRET', EncryptionProfileSecretSchema.parse(secret));
  }

  createImportJobCredential(credential: ImportJobCredential): ImportJobCredentialRef {
    return this.create('IMPORT_JOB_CREDENTIAL', ImportJobCredentialSchema.parse(credential));
  }

  readOAuthConnectionCredential(ref: OAuthConnectionCredentialRef): OAuthConnectionCredential {
    return this.read(ref, OAuthConnectionCredentialSchema);
  }

  readOAuthFlowVerifier(ref: OAuthFlowVerifierRef): string {
    return this.read(ref, OAuthFlowVerifierSchema);
  }

  readEncryptionProfileSecret(ref: EncryptionProfileSecretRef): EncryptionProfileSecret {
    return this.read(ref, EncryptionProfileSecretSchema);
  }

  readImportJobCredential(ref: ImportJobCredentialRef): ImportJobCredential {
    return this.read(ref, ImportJobCredentialSchema);
  }

  replaceOAuthConnectionCredential(
    ref: OAuthConnectionCredentialRef,
    credential: OAuthConnectionCredential,
    at = this.now(),
  ): void {
    this.assertStoredKind(ref);
    const parsed = OAuthConnectionCredentialSchema.parse(credential);
    const encryptedPayload = this.seal(ref.kind, parsed, this.secretBox);
    const result = this.db
      .prepare(
        `UPDATE encrypted_secrets
         SET encrypted_payload = @encryptedPayload, wrapping_key_id = @wrappingKeyId,
             wrapping_key_version = @wrappingKeyVersion, updated_at = @updatedAt
         WHERE id = @id AND kind = @kind`,
      )
      .run({
        id: ref.id,
        kind: ref.kind,
        encryptedPayload,
        wrappingKeyId: this.wrappingKey.id,
        wrappingKeyVersion: this.wrappingKey.version,
        updatedAt: at,
      });
    if (result.changes !== 1) throw new SecretRepositoryError('SECRET_NOT_FOUND');
  }

  deleteOAuthConnectionCredential(ref: OAuthConnectionCredentialRef): void {
    this.assertStoredKind(ref);
    const result = this.db
      .prepare(
        "DELETE FROM encrypted_secrets WHERE id = ? AND kind = 'OAUTH_CONNECTION_CREDENTIAL'",
      )
      .run(ref.id);
    if (result.changes !== 1) throw new SecretRepositoryError('SECRET_NOT_FOUND');
  }

  deleteOAuthFlowVerifier(ref: OAuthFlowVerifierRef): void {
    this.assertStoredKind(ref);
    const result = this.db
      .prepare("DELETE FROM encrypted_secrets WHERE id = ? AND kind = 'OAUTH_FLOW_VERIFIER'")
      .run(ref.id);
    if (result.changes !== 1) throw new SecretRepositoryError('SECRET_NOT_FOUND');
  }

  /** The only supported KEK rotation path: crypt material is decrypted then re-sealed unchanged. */
  rewrapEncryptionProfileSecret(
    ref: EncryptionProfileSecretRef,
    replacement: {
      secretBox: SecretBox;
      wrappingKey: WrappingKeyIdentity;
      at: number;
    },
  ): void {
    if (replacement.wrappingKey.id.length === 0 || replacement.wrappingKey.version <= 0) {
      throw new Error('INVALID_WRAPPING_KEY_IDENTITY');
    }
    const plaintext = this.readEncryptionProfileSecret(ref);
    const encryptedPayload = this.seal(ref.kind, plaintext, replacement.secretBox);
    const result = this.db
      .prepare(
        `UPDATE encrypted_secrets
         SET encrypted_payload = @encryptedPayload, wrapping_key_id = @wrappingKeyId,
             wrapping_key_version = @wrappingKeyVersion, updated_at = @updatedAt
         WHERE id = @id AND kind = 'ENCRYPTION_PROFILE_SECRET'`,
      )
      .run({
        id: ref.id,
        encryptedPayload,
        wrappingKeyId: replacement.wrappingKey.id,
        wrappingKeyVersion: replacement.wrappingKey.version,
        updatedAt: replacement.at,
      });
    if (result.changes !== 1) throw new SecretRepositoryError('SECRET_NOT_FOUND');
  }

  private create<K extends SecretKind>(kind: K, payload: unknown): TypedSecretRef<K> {
    const id = this.newId();
    const timestamp = this.now();
    this.db
      .prepare(
        `INSERT INTO encrypted_secrets(
           id, kind, encrypted_payload, wrapping_key_id, wrapping_key_version,
           created_at, updated_at
         ) VALUES (
           @id, @kind, @encryptedPayload, @wrappingKeyId, @wrappingKeyVersion,
           @timestamp, @timestamp
         )`,
      )
      .run({
        id,
        kind,
        encryptedPayload: this.seal(kind, payload, this.secretBox),
        wrappingKeyId: this.wrappingKey.id,
        wrappingKeyVersion: this.wrappingKey.version,
        timestamp,
      });
    return Object.freeze({ id, kind });
  }

  private read<K extends SecretKind, T>(ref: TypedSecretRef<K>, payloadSchema: z.ZodType<T>): T {
    const row = this.assertStoredKind(ref);
    let decoded: unknown;
    try {
      decoded = JSON.parse(this.secretBox.open(row.encryptedPayload)) as unknown;
    } catch {
      throw new SecretRepositoryError('SECRET_DECRYPT_FAILED');
    }

    const envelope = EnvelopeSchema.safeParse(decoded);
    if (!envelope.success) throw new SecretRepositoryError('SECRET_PAYLOAD_INVALID');
    if (envelope.data.kind !== ref.kind) {
      throw new SecretRepositoryError('SECRET_KIND_MISMATCH');
    }
    const payload = payloadSchema.safeParse(envelope.data.payload);
    if (!payload.success) throw new SecretRepositoryError('SECRET_PAYLOAD_INVALID');
    return payload.data;
  }

  private assertStoredKind<K extends SecretKind>(ref: TypedSecretRef<K>): SecretRow {
    const row = this.db
      .prepare(
        `SELECT id, kind, encrypted_payload AS encryptedPayload,
                wrapping_key_id AS wrappingKeyId,
                wrapping_key_version AS wrappingKeyVersion
         FROM encrypted_secrets WHERE id = ?`,
      )
      .get(ref.id) as SecretRow | undefined;
    if (!row) throw new SecretRepositoryError('SECRET_NOT_FOUND');
    if (row.kind !== ref.kind) throw new SecretRepositoryError('SECRET_KIND_MISMATCH');
    return row;
  }

  private seal(kind: SecretKind, payload: unknown, box: SecretBox): string {
    return box.seal(JSON.stringify({ version: 1, kind, payload }));
  }
}
