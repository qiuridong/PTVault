import { randomUUID } from 'node:crypto';

import { LoginRequestSchema } from '@ptvault/contracts';
import argon2 from 'argon2';
import * as OTPAuth from 'otpauth';

import type { Clock } from '../core/clock.js';
import { digestToken, newOpaqueToken, type SecretBox } from '../core/crypto.js';
import type { AuthRepository } from './repository.js';

const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;
const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;
const TOTP_PERIOD_SECONDS = 30;
/** How long a spent step-up code is remembered: its own window plus the ±1 skew. */
const STEP_UP_RETENTION_MS = 4 * TOTP_PERIOD_SECONDS * 1000;
export const MAX_MFA_FAILURES = 5;
const STEP_UP_FAILURE_WINDOW_MS = 5 * 60 * 1000;

export type AuthErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'MFA_CHALLENGE_INVALID'
  | 'MFA_CHALLENGE_EXPIRED'
  | 'MFA_CODE_INVALID'
  | 'MFA_RATE_LIMITED'
  | 'MFA_CHALLENGE_LOCKED'
  | 'MFA_CODE_ALREADY_USED';

const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  INVALID_CREDENTIALS: 'Invalid credentials',
  MFA_CHALLENGE_INVALID: 'MFA challenge is invalid or already consumed',
  MFA_CHALLENGE_EXPIRED: 'MFA challenge expired',
  MFA_CODE_INVALID: 'Invalid TOTP code',
  MFA_RATE_LIMITED: 'Too many verification attempts; wait before trying again',
  MFA_CHALLENGE_LOCKED: 'MFA challenge locked',
  MFA_CODE_ALREADY_USED: 'TOTP code was already used',
};

export class AuthError extends Error {
  constructor(readonly code: AuthErrorCode) {
    super(AUTH_ERROR_MESSAGES[code]);
    this.name = 'AuthError';
  }
}

export type AdminEnrollment = {
  currentTotp: string;
  otpauthUrl: string;
};

export type LoginChallenge = {
  id: string;
  expiresAt: number;
};

export type SessionToken = {
  raw: string;
  expiresAt: number;
};

export type SessionPrincipal = {
  adminId: string;
  username: string;
  expiresAt: number;
};

export type SessionContext = {
  sourceIp: string;
  userAgent: string;
};

export class AuthService {
  private readonly repository: AuthRepository;
  private readonly secretBox: SecretBox;
  private readonly now: Clock;
  // Shared across routes, deliberately outside business DB transactions. The
  // single-process budget resets on restart, like the HTTP login limiter.
  private readonly stepUpFailures = new Map<string, { count: number; expiresAt: number }>();

  constructor(input: { repository: AuthRepository; secretBox: SecretBox; now: Clock }) {
    this.repository = input.repository;
    this.secretBox = input.secretBox;
    this.now = input.now;
  }

  async createInitialAdmin(username: string, password: string): Promise<AdminEnrollment> {
    return this.enrollInitialAdmin(username, password, new OTPAuth.Secret({ size: 20 }));
  }

  /** Generates a proposal only. Refreshing an unfinished setup cannot leave a locked-out account. */
  prepareInitialAdmin(username: string): { secret: string; otpauthUrl: string } {
    if (!LoginRequestSchema.shape.username.safeParse(username).success) {
      throw new Error('Invalid administrator credentials');
    }
    if (this.repository.hasAdmin()) throw new Error('Initial admin already exists');
    const secret = new OTPAuth.Secret({ size: 20 });
    return { secret: secret.base32, otpauthUrl: this.createTotp(username, secret).toString() };
  }

  async createInitialAdminWithMfa(
    username: string,
    password: string,
    secretBase32: string,
    code: string,
  ): Promise<AdminEnrollment> {
    if (!/^[A-Z2-7]{32}$/.test(secretBase32) || !/^[0-9]{6}$/.test(code)) {
      throw new AuthError('MFA_CODE_INVALID');
    }
    const secret = OTPAuth.Secret.fromBase32(secretBase32);
    const totp = this.createTotp(username, secret);
    if (totp.validate({ token: code, timestamp: this.now().getTime(), window: 1 }) === null) {
      throw new AuthError('MFA_CODE_INVALID');
    }
    return this.enrollInitialAdmin(username, password, secret);
  }

  private async enrollInitialAdmin(
    username: string,
    password: string,
    secret: OTPAuth.Secret,
  ): Promise<AdminEnrollment> {
    if (!LoginRequestSchema.safeParse({ username, password }).success) {
      throw new Error('Invalid administrator credentials');
    }
    if (this.repository.hasAdmin()) {
      throw new Error('Initial admin already exists');
    }

    const totp = this.createTotp(username, secret);
    const timestamp = this.now().getTime();

    this.repository.insertInitialAdmin({
      id: randomUUID(),
      username,
      passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
      totpSecret: this.secretBox.seal(secret.base32),
      createdAt: timestamp,
    });

    return {
      currentTotp: totp.generate({ timestamp }),
      otpauthUrl: totp.toString(),
    };
  }

  async startLogin(username: string, password: string): Promise<LoginChallenge> {
    const admin = this.repository.findAdminByUsername(username);
    if (!admin || !(await argon2.verify(admin.passwordHash, password))) {
      throw new AuthError('INVALID_CREDENTIALS');
    }

    const createdAt = this.now().getTime();
    const challenge = {
      id: randomUUID(),
      adminId: admin.id,
      payload: '{}',
      createdAt,
      expiresAt: createdAt + CHALLENGE_LIFETIME_MS,
    };
    this.repository.insertChallenge(challenge);

    return { id: challenge.id, expiresAt: challenge.expiresAt };
  }

  finishLogin(
    challengeId: string,
    code: string,
    context: SessionContext = { sourceIp: 'unknown', userAgent: 'unknown' },
  ): SessionToken {
    const challenge = this.repository.findChallenge(challengeId);
    if (!challenge) {
      throw new AuthError('MFA_CHALLENGE_INVALID');
    }
    if (challenge.consumedAt !== null) {
      throw new AuthError(
        challenge.failedAttempts >= MAX_MFA_FAILURES
          ? 'MFA_CHALLENGE_LOCKED'
          : 'MFA_CHALLENGE_INVALID',
      );
    }

    const createdAt = this.now().getTime();
    if (challenge.expiresAt < createdAt) {
      throw new AuthError('MFA_CHALLENGE_EXPIRED');
    }

    const secret = OTPAuth.Secret.fromBase32(this.secretBox.open(challenge.totpSecret));
    const totp = this.createTotp(challenge.username, secret);
    if (totp.validate({ token: code, timestamp: createdAt, window: 1 }) === null) {
      const failures = this.repository.recordChallengeFailure(
        challenge.id,
        createdAt,
        MAX_MFA_FAILURES,
      );
      if (failures === null) {
        throw new AuthError('MFA_CHALLENGE_INVALID');
      }
      throw new AuthError(
        failures >= MAX_MFA_FAILURES ? 'MFA_CHALLENGE_LOCKED' : 'MFA_CODE_INVALID',
      );
    }

    if (!this.repository.consumeChallenge(challenge.id, createdAt)) {
      throw new AuthError('MFA_CHALLENGE_INVALID');
    }

    const raw = newOpaqueToken();
    const expiresAt = createdAt + SESSION_LIFETIME_MS;
    this.repository.insertSession({
      id: randomUUID(),
      adminId: challenge.adminId,
      tokenHash: digestToken(raw),
      createdAt,
      expiresAt,
      sourceIp: context.sourceIp,
      userAgent: context.userAgent,
    });

    return { raw, expiresAt };
  }

  requireSession(raw: string): SessionPrincipal | null {
    const session = this.repository.findSession(digestToken(raw));
    if (!session || session.revokedAt !== null || session.expiresAt <= this.now().getTime()) {
      return null;
    }

    return {
      adminId: session.adminId,
      username: session.username,
      expiresAt: session.expiresAt,
    };
  }

  revokeSession(raw: string): boolean {
    return this.repository.revokeSession(digestToken(raw), this.now().getTime());
  }

  /**
   * Re-proves possession of the authenticator for a single mutating action.
   *
   * A valid session is not enough for an action that pauses a torrent, uploads
   * bytes, and eventually deletes local files: a stolen cookie would be enough to
   * start one. The code is spent on success, so the same six digits cannot launch
   * a second offload inside their 30-second window — that single-use property is
   * the whole point, and it is enforced by a primary key rather than a read.
   *
   * Throws `AuthError`; never returns false, so a caller cannot mistake an
   * ignored return value for a passed check.
   */
  verifyStepUp(adminId: string, code: string): void {
    const admin = this.repository.findAdminById(adminId);
    if (!admin) throw new AuthError('MFA_CHALLENGE_INVALID');
    if (this.stepUpRetryAfter(adminId) > 0) throw new AuthError('MFA_RATE_LIMITED');

    const timestamp = this.now().getTime();
    const secret = OTPAuth.Secret.fromBase32(this.secretBox.open(admin.totpSecret));
    const totp = this.createTotp(admin.username, secret);
    const delta = totp.validate({ token: code, timestamp, window: 1 });
    if (delta === null) {
      const previous = this.stepUpFailures.get(adminId);
      this.stepUpFailures.set(adminId, {
        count: (previous?.count ?? 0) + 1,
        expiresAt: previous?.expiresAt ?? timestamp + STEP_UP_FAILURE_WINDOW_MS,
      });
      throw new AuthError('MFA_CODE_INVALID');
    }

    // Bind the claim to the period the code actually belongs to, not to "now":
    // within the ±1 window the same code is accepted across three periods, and
    // keying on the current period would let it be spent once in each.
    const currentPeriod = Math.floor(timestamp / (TOTP_PERIOD_SECONDS * 1000));
    const periodStart = (currentPeriod + delta) * TOTP_PERIOD_SECONDS * 1000;
    const claimed = this.repository.claimStepUpCode({
      adminId,
      codeHash: digestToken(`${adminId}:${code}`),
      periodStart,
      createdAt: timestamp,
    });
    if (!claimed) throw new AuthError('MFA_CODE_ALREADY_USED');
    this.stepUpFailures.delete(adminId);

    this.repository.pruneStepUpCodes(timestamp - STEP_UP_RETENTION_MS);
  }

  stepUpRetryAfter(adminId: string): number {
    const now = this.now().getTime();
    for (const [id, budget] of this.stepUpFailures) {
      if (budget.expiresAt <= now) this.stepUpFailures.delete(id);
    }
    const budget = this.stepUpFailures.get(adminId);
    return budget !== undefined && budget.count >= MAX_MFA_FAILURES
      ? Math.max(1, Math.ceil((budget.expiresAt - now) / 1000)) : 0;
  }

  private createTotp(username: string, secret: OTPAuth.Secret): OTPAuth.TOTP {
    return new OTPAuth.TOTP({
      issuer: 'PT Cloud Vault',
      label: username,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret,
    });
  }
}
