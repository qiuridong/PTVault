import type { AppDatabase } from '../db/database.js';
import type { Clock } from '../core/clock.js';
import { SecretBox } from '../core/crypto.js';

export type QbCredential = {
  id: string;
  baseUrl: string;
  username: string;
  encryptedPassword: string;
  createdAt: number;
  updatedAt: number;
};

export type QbCredentialInput = {
  id: string;
  baseUrl: string;
  username: string;
  password: string;
};

/**
 * Encrypted credential storage for qBittorrent WebUI access. Passwords are sealed
 * with SecretBox(master_key) so they never appear plaintext in the database or in
 * GET /api/qb/instances responses.
 *
 * The repository pattern keeps encryption logic separate from qB client construction:
 * - This class owns insert/update/retrieve with sealed passwords.
 * - DbQbControlRegistry (separate) combines this store + qb_instances to build QbClients.
 */
export class QbCredentialStore {
  private readonly secretBox: SecretBox;

  constructor(
    private readonly db: AppDatabase,
    masterKey: Buffer,
    private readonly now: Clock = () => new Date(),
  ) {
    this.secretBox = new SecretBox(masterKey);
  }

  /**
   * Insert or replace a credential. Password is encrypted before storage; the plaintext
   * never touches the database. Idempotent: same id overwrites.
   */
  upsert(input: QbCredentialInput): void {
    const encryptedPassword = this.secretBox.seal(input.password);
    const timestamp = this.now().getTime();

    this.db
      .prepare(
        `INSERT INTO qb_instance_secrets(id, base_url, username, encrypted_password, created_at, updated_at)
         VALUES (@id, @baseUrl, @username, @encryptedPassword, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           base_url = excluded.base_url,
           username = excluded.username,
           encrypted_password = excluded.encrypted_password,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: input.id,
        baseUrl: input.baseUrl,
        username: input.username,
        encryptedPassword,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
  }

  /**
   * Retrieve a credential by id. Returns the sealed password; caller must decrypt
   * with `open()` to get the plaintext.
   */
  get(id: string): QbCredential | null {
    const row = this.db
      .prepare(
        `SELECT id, base_url AS baseUrl, username, encrypted_password AS encryptedPassword,
                created_at AS createdAt, updated_at AS updatedAt
         FROM qb_instance_secrets WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          baseUrl: string;
          username: string;
          encryptedPassword: string;
          createdAt: number;
          updatedAt: number;
        }
      | undefined;

    return row ?? null;
  }

  /**
   * Decrypt a sealed password. Throws if the payload is corrupted or was encrypted
   * with a different master key.
   */
  open(encryptedPassword: string): string {
    return this.secretBox.open(encryptedPassword);
  }

  /**
   * Remove a credential. Used when an instance is deleted or credentials are rotated
   * to a new secret_ref.
   */
  delete(id: string): void {
    this.db.prepare('DELETE FROM qb_instance_secrets WHERE id = ?').run(id);
  }

  /**
   * List all credential IDs. Useful for auditing or cleanup. Does not return passwords.
   */
  listIds(): readonly string[] {
    return (
      this.db.prepare('SELECT id FROM qb_instance_secrets ORDER BY id').all() as Array<{
        id: string;
      }>
    ).map((row) => row.id);
  }
}
