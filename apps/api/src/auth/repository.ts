import type { AppDatabase } from '../db/database.js';

export type AdminRecord = {
  id: string;
  username: string;
  passwordHash: string;
  totpSecret: string;
};

export type ChallengeRecord = {
  id: string;
  adminId: string;
  username: string;
  totpSecret: string;
  expiresAt: number;
  consumedAt: number | null;
  failedAttempts: number;
};

export type SessionRecord = {
  adminId: string;
  username: string;
  expiresAt: number;
  revokedAt: number | null;
};

export class AuthRepository {
  constructor(private readonly db: AppDatabase) {}

  hasAdmin(): boolean {
    return Number(this.db.prepare('SELECT COUNT(*) FROM admins').pluck().get()) > 0;
  }

  insertAdmin(input: {
    id: string;
    username: string;
    passwordHash: string;
    totpSecret: string;
    createdAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO admins(id, username, password_hash, totp_secret, created_at, updated_at)
         VALUES (@id, @username, @passwordHash, @totpSecret, @createdAt, @createdAt)`,
      )
      .run(input);
  }

  /** The first-admin claim must still be exclusive after asynchronous password hashing. */
  insertInitialAdmin(input: Parameters<AuthRepository['insertAdmin']>[0]): void {
    this.db.transaction(() => {
      if (this.hasAdmin()) throw new Error('Initial admin already exists');
      this.insertAdmin(input);
    }).immediate();
  }

  findAdminByUsername(username: string): AdminRecord | undefined {
    return this.db
      .prepare(
        `SELECT id, username, password_hash AS passwordHash, totp_secret AS totpSecret
         FROM admins WHERE username = ?`,
      )
      .get(username) as AdminRecord | undefined;
  }

  findAdminById(id: string): AdminRecord | undefined {
    return this.db
      .prepare(
        `SELECT id, username, password_hash AS passwordHash, totp_secret AS totpSecret
         FROM admins WHERE id = ?`,
      )
      .get(id) as AdminRecord | undefined;
  }

  /**
   * Claims a TOTP code for one step-up use. Returns false when this admin has
   * already spent that code in that period, which is what stops a replay of a
   * captured code inside its validity window. The uniqueness is enforced by the
   * primary key rather than by a read-then-write, so two concurrent requests
   * carrying the same code cannot both win.
   */
  claimStepUpCode(input: {
    adminId: string;
    codeHash: string;
    periodStart: number;
    createdAt: number;
  }): boolean {
    const claimed = this.db
      .prepare(
        `INSERT INTO mfa_step_up_uses(admin_id, code_hash, period_start, created_at)
         VALUES (@adminId, @codeHash, @periodStart, @createdAt)
         ON CONFLICT DO NOTHING`,
      )
      .run(input);
    return claimed.changes === 1;
  }

  /** Drops spent step-up codes whose window closed; keeps the table bounded. */
  pruneStepUpCodes(before: number): number {
    return this.db.prepare('DELETE FROM mfa_step_up_uses WHERE period_start < ?').run(before)
      .changes;
  }

  insertChallenge(input: {
    id: string;
    adminId: string;
    payload: string;
    createdAt: number;
    expiresAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO auth_challenges(id, admin_id, kind, payload, created_at, expires_at)
         VALUES (@id, @adminId, 'PASSWORD_MFA', @payload, @createdAt, @expiresAt)`,
      )
      .run(input);
  }

  findChallenge(id: string): ChallengeRecord | undefined {
    return this.db
      .prepare(
        `SELECT c.id, c.admin_id AS adminId, a.username, a.totp_secret AS totpSecret,
                c.expires_at AS expiresAt, c.consumed_at AS consumedAt,
                c.failed_attempts AS failedAttempts
         FROM auth_challenges c
         JOIN admins a ON a.id = c.admin_id
         WHERE c.id = ? AND c.kind = 'PASSWORD_MFA'`,
      )
      .get(id) as ChallengeRecord | undefined;
  }

  consumeChallenge(id: string, consumedAt: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE auth_challenges SET consumed_at = ?
         WHERE id = ? AND consumed_at IS NULL`,
      )
      .run(consumedAt, id);
    return result.changes === 1;
  }

  recordChallengeFailure(id: string, failedAt: number, limit: number): number | null {
    const row = this.db
      .prepare(
        `UPDATE auth_challenges
         SET failed_attempts = failed_attempts + 1,
             consumed_at = CASE
               WHEN failed_attempts + 1 >= @limit THEN @failedAt
               ELSE consumed_at
             END
         WHERE id = @id AND consumed_at IS NULL
         RETURNING failed_attempts AS failedAttempts`,
      )
      .get({ id, failedAt, limit }) as { failedAttempts: number } | undefined;
    return row?.failedAttempts ?? null;
  }

  insertSession(input: {
    id: string;
    adminId: string;
    tokenHash: string;
    createdAt: number;
    expiresAt: number;
    sourceIp: string;
    userAgent: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO sessions(
           id, admin_id, token_hash, created_at, expires_at, source_ip, user_agent
         ) VALUES (
           @id, @adminId, @tokenHash, @createdAt, @expiresAt, @sourceIp, @userAgent
         )`,
      )
      .run(input);
  }

  findSession(tokenHash: string): SessionRecord | undefined {
    return this.db
      .prepare(
        `SELECT s.admin_id AS adminId, a.username, s.expires_at AS expiresAt,
                s.revoked_at AS revokedAt
         FROM sessions s
         JOIN admins a ON a.id = s.admin_id
         WHERE s.token_hash = ?`,
      )
      .get(tokenHash) as SessionRecord | undefined;
  }

  revokeSession(tokenHash: string, revokedAt: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE sessions SET revoked_at = ?
         WHERE token_hash = ? AND revoked_at IS NULL`,
      )
      .run(revokedAt, tokenHash);
    return result.changes === 1;
  }
}
