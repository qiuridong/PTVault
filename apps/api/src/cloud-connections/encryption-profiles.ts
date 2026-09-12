import { randomBytes as secureRandomBytes, randomUUID } from 'node:crypto';

import type { SecretBox } from '../core/crypto.js';
import type { AppDatabase } from '../db/database.js';
import {
  type EncryptedSecretRepository,
  type EncryptionProfileSecret,
  type EncryptionProfileSecretRef,
  type WrappingKeyIdentity,
} from './secrets.js';

export type EncryptionProfileEscrowState = 'PENDING' | 'VERIFIED' | 'FAILED';
export type EncryptionProfileRoundtripState = 'NOT_RUN' | 'PASSED' | 'FAILED';

export type EncryptionProfile = {
  id: string;
  version: number;
  wrappingKeyId: string;
  wrappingKeyVersion: number;
  escrowState: EncryptionProfileEscrowState;
  escrowReceiptRef: string | null;
  cryptRoundtripState: EncryptionProfileRoundtripState;
  createdAt: number;
};

type EncryptionProfileRow = {
  id: string;
  version: number;
  wrappedSecretBundle: string;
  wrappingKeyId: string;
  wrappingKeyVersion: number;
  escrowState: EncryptionProfileEscrowState;
  escrowReceiptRef: string | null;
  cryptRoundtripState: EncryptionProfileRoundtripState;
  createdAt: number;
};

function metadata(row: EncryptionProfileRow): EncryptionProfile {
  return {
    id: row.id,
    version: row.version,
    wrappingKeyId: row.wrappingKeyId,
    wrappingKeyVersion: row.wrappingKeyVersion,
    escrowState: row.escrowState,
    escrowReceiptRef: row.escrowReceiptRef,
    cryptRoundtripState: row.cryptRoundtripState,
    createdAt: row.createdAt,
  };
}

export class EncryptionProfileRepository {
  constructor(private readonly db: AppDatabase) {}

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation).immediate();
  }

  insert(input: {
    id: string;
    secretRef: EncryptionProfileSecretRef;
    wrappingKey: WrappingKeyIdentity;
    createdAt: number;
  }): EncryptionProfile {
    this.db
      .prepare(
        `INSERT INTO encryption_profiles(
           id, version, wrapped_secret_bundle, wrapping_key_id, wrapping_key_version,
           escrow_state, escrow_receipt_ref, crypt_roundtrip_state, created_at
         ) VALUES (
           @id, 1, @secretRef, @wrappingKeyId, @wrappingKeyVersion,
           'PENDING', NULL, 'NOT_RUN', @createdAt
         )`,
      )
      .run({
        id: input.id,
        secretRef: input.secretRef.id,
        wrappingKeyId: input.wrappingKey.id,
        wrappingKeyVersion: input.wrappingKey.version,
        createdAt: input.createdAt,
      });
    return this.get(input.id);
  }

  get(id: string): EncryptionProfile {
    return metadata(this.getRow(id));
  }

  secretRef(id: string): EncryptionProfileSecretRef {
    return Object.freeze({
      id: this.getRow(id).wrappedSecretBundle,
      kind: 'ENCRYPTION_PROFILE_SECRET',
    });
  }

  markEscrowVerified(id: string, receiptRef: string): EncryptionProfile {
    if (receiptRef.length === 0) throw new Error('INVALID_ESCROW_RECEIPT_REF');
    const changed = this.db
      .prepare(
        `UPDATE encryption_profiles
         SET escrow_state = 'VERIFIED', escrow_receipt_ref = ? WHERE id = ?`,
      )
      .run(receiptRef, id);
    if (changed.changes !== 1) throw new Error('ENCRYPTION_PROFILE_NOT_FOUND');
    return this.get(id);
  }

  markEscrowFailed(id: string): EncryptionProfile {
    const changed = this.db
      .prepare(
        `UPDATE encryption_profiles
         SET escrow_state = 'FAILED', escrow_receipt_ref = NULL WHERE id = ?`,
      )
      .run(id);
    if (changed.changes !== 1) throw new Error('ENCRYPTION_PROFILE_NOT_FOUND');
    return this.get(id);
  }

  markCryptRoundtrip(
    id: string,
    state: Exclude<EncryptionProfileRoundtripState, 'NOT_RUN'>,
  ): EncryptionProfile {
    const changed = this.db
      .prepare('UPDATE encryption_profiles SET crypt_roundtrip_state = ? WHERE id = ?')
      .run(state, id);
    if (changed.changes !== 1) throw new Error('ENCRYPTION_PROFILE_NOT_FOUND');
    return this.get(id);
  }

  updateWrappingKey(id: string, wrappingKey: WrappingKeyIdentity): void {
    const changed = this.db
      .prepare(
        `UPDATE encryption_profiles
         SET wrapping_key_id = ?, wrapping_key_version = ? WHERE id = ?`,
      )
      .run(wrappingKey.id, wrappingKey.version, id);
    if (changed.changes !== 1) throw new Error('ENCRYPTION_PROFILE_NOT_FOUND');
  }

  private getRow(id: string): EncryptionProfileRow {
    const row = this.db
      .prepare(
        `SELECT id, version, wrapped_secret_bundle AS wrappedSecretBundle,
                wrapping_key_id AS wrappingKeyId,
                wrapping_key_version AS wrappingKeyVersion,
                escrow_state AS escrowState, escrow_receipt_ref AS escrowReceiptRef,
                crypt_roundtrip_state AS cryptRoundtripState, created_at AS createdAt
         FROM encryption_profiles WHERE id = ?`,
      )
      .get(id) as EncryptionProfileRow | undefined;
    if (!row) throw new Error('ENCRYPTION_PROFILE_NOT_FOUND');
    return row;
  }
}

export type EncryptionProfileServiceOptions = {
  profiles: EncryptionProfileRepository;
  secrets: EncryptedSecretRepository;
  randomBytes?: (size: number) => Buffer;
  newId?: () => string;
  now?: () => number;
};

export class EncryptionProfileService {
  private readonly randomBytes: (size: number) => Buffer;
  private readonly newId: () => string;
  private readonly now: () => number;

  constructor(private readonly options: EncryptionProfileServiceOptions) {
    this.randomBytes = options.randomBytes ?? secureRandomBytes;
    this.newId = options.newId ?? randomUUID;
    this.now = options.now ?? (() => Date.now());
  }

  create(): EncryptionProfile {
    const secret: EncryptionProfileSecret = {
      password: this.randomBytes(32).toString('base64url'),
      password2: this.randomBytes(32).toString('base64url'),
    };
    if (secret.password === secret.password2) throw new Error('CRYPT_SECRET_ENTROPY_COLLISION');
    return this.options.profiles.transaction(() => {
      const secretRef = this.options.secrets.createEncryptionProfileSecret(secret);
      return this.options.profiles.insert({
        id: this.newId(),
        secretRef,
        wrappingKey: this.options.secrets.wrappingKey,
        createdAt: this.now(),
      });
    });
  }

  /** Plaintext is exposed only to the future escrow/provision boundary. */
  openForProvisioning(id: string): EncryptionProfileSecret {
    return this.options.secrets.readEncryptionProfileSecret(this.options.profiles.secretRef(id));
  }

  rewrap(
    id: string,
    replacement: { secretBox: SecretBox; wrappingKey: WrappingKeyIdentity; at: number },
  ): EncryptionProfile {
    return this.options.profiles.transaction(() => {
      this.options.secrets.rewrapEncryptionProfileSecret(
        this.options.profiles.secretRef(id),
        replacement,
      );
      this.options.profiles.updateWrappingKey(id, replacement.wrappingKey);
      return this.options.profiles.get(id);
    });
  }
}

export type StorageEncryptionProfileBindingInput = {
  accountId: string;
  connectionId: string;
  encryptionProfileId: string;
  expectedRevision: number;
};

/** Creates a disabled candidate only; no Wave-1 method can claim provision success. */
export class StorageEncryptionProfileBindingRepository {
  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => number = () => Date.now(),
  ) {}

  bindCandidate(input: StorageEncryptionProfileBindingInput): void {
    const result = this.db
      .prepare(
        `UPDATE storage_accounts
         SET connection_id = @connectionId, provider = 'ONEDRIVE',
             provisioning_mode = 'WEB_OAUTH', encryption_profile_id = @encryptionProfileId,
             enabled = 0, revision = revision + 1, updated_at = @updatedAt
         WHERE id = @accountId AND revision = @expectedRevision`,
      )
      .run({ ...input, updatedAt: this.now() });
    if (result.changes === 1) return;
    const current = this.db
      .prepare('SELECT revision FROM storage_accounts WHERE id = ?')
      .pluck()
      .get(input.accountId);
    if (current === undefined) throw new Error('STORAGE_ACCOUNT_NOT_FOUND');
    throw new Error('STORAGE_ACCOUNT_REVISION_CONFLICT');
  }
}

/** Future boundary: writes and reads back the recovery escrow before READY. */
export interface RecoveryEscrowWriter {
  writeAndVerify(profileId: string, secret: EncryptionProfileSecret): Promise<string>;
}

/** Future boundary: materializes and verifies one OneDrive raw/crypt candidate. */
export interface OneDriveProvisioner {
  provisionCandidate(input: {
    connectionId: string;
    profileId: string;
    secret: EncryptionProfileSecret;
  }): Promise<{ rawRemote: string; cryptRemote: string }>;
}
