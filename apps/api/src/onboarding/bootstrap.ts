import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import { AuthError, type AuthService } from '../auth/service.js';

const ENROLLMENT_LIFETIME = 10 * 60_000;

export class BootstrapError extends Error {
  constructor(
    readonly code:
      | 'SETUP_CLOSED'
      | 'SETUP_LINK_INVALID'
      | 'SETUP_LINK_EXPIRED'
      | 'SETUP_ENROLLMENT_EXPIRED'
      | 'SETUP_BUSY',
  ) {
    super(code);
  }
}

type Enrollment = {
  id: string;
  username: string;
  secret: string;
  expiresAt: number;
  failedAttempts: number;
};

/** Enabled only by the managed installer's private, short-lived setup link. */
export class BootstrapService {
  private pending: Enrollment | undefined;
  private busy = false;
  private readonly now: () => number;
  private credentialToken: string;

  constructor(
    private readonly options: {
      auth: AuthService;
      hasAdmin: () => boolean;
      token: string;
      expiresAt: number;
      now?: () => number;
      readCredential?: () => { token: string; expiresAt: number };
    },
  ) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(options.token)) throw new Error('SETUP_TOKEN_INVALID');
    this.credentialToken = options.token;
    this.now = options.now ?? Date.now;
  }

  private credential(): { token: string; expiresAt: number } {
    let credential: { token: string; expiresAt: number };
    try { credential = this.options.readCredential?.() ?? this.options; } catch { throw new BootstrapError('SETUP_LINK_INVALID'); }
    if (!/^[A-Za-z0-9_-]{43}$/.test(credential.token) || !Number.isSafeInteger(credential.expiresAt) || credential.expiresAt <= 0) {
      throw new BootstrapError('SETUP_LINK_INVALID');
    }
    if (credential.token !== this.credentialToken) { this.pending = undefined; this.credentialToken = credential.token; }
    return credential;
  }

  status(): { required: boolean; available: boolean } {
    const required = !this.options.hasAdmin();
    if (!required) return { required, available: false };
    try { return { required, available: this.now() < this.credential().expiresAt }; } catch { return { required, available: false }; }
  }

  private authorize(token: string): void {
    if (this.options.hasAdmin()) throw new BootstrapError('SETUP_CLOSED');
    const credential = this.credential();
    if (this.now() >= credential.expiresAt) throw new BootstrapError('SETUP_LINK_EXPIRED');
    const digest = (value: string) => createHash('sha256').update(value).digest();
    if (token.length > 128 || !timingSafeEqual(digest(token), digest(credential.token))) {
      throw new BootstrapError('SETUP_LINK_INVALID');
    }
  }

  begin(token: string, username: string) {
    this.authorize(token);
    if (this.busy) throw new BootstrapError('SETUP_BUSY');
    const enrollment = this.options.auth.prepareInitialAdmin(username);
    this.pending = {
      id: randomUUID(),
      username,
      secret: enrollment.secret,
      expiresAt: Math.min(this.credential().expiresAt, this.now() + ENROLLMENT_LIFETIME),
      failedAttempts: 0,
    };
    return {
      enrollmentId: this.pending.id,
      otpauthUrl: enrollment.otpauthUrl,
      expiresAt: this.pending.expiresAt,
    };
  }

  async complete(
    token: string,
    input: { enrollmentId: string; password: string; code: string },
  ): Promise<{ username: string }> {
    this.authorize(token);
    if (this.busy) throw new BootstrapError('SETUP_BUSY');
    const enrollment = this.pending;
    if (
      enrollment === undefined ||
      enrollment.id !== input.enrollmentId ||
      enrollment.expiresAt <= this.now() ||
      enrollment.failedAttempts >= 5
    ) {
      throw new BootstrapError('SETUP_ENROLLMENT_EXPIRED');
    }
    this.busy = true;
    try {
      await this.options.auth.createInitialAdminWithMfa(
        enrollment.username,
        input.password,
        enrollment.secret,
        input.code,
      );
      this.pending = undefined;
      return { username: enrollment.username };
    } catch (error) {
      if (error instanceof AuthError && error.code === 'MFA_CODE_INVALID') {
        enrollment.failedAttempts += 1;
      }
      throw error;
    } finally {
      this.busy = false;
    }
  }
}
