import type { Session } from '@ptvault/contracts';

const DEMO_USERNAME = 'test';
const DEMO_PASSWORD = '123456';
const DEMO_MFA_CODE = '123456';
const DEMO_CHALLENGE_ID = '10000000-0000-4000-8000-000000000001';
const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;
const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;
const SESSION_KEY = 'ptvault.demo.session.v1';
const CHALLENGE_KEY = 'ptvault.demo.challenge.v1';
const MODE_KEY = 'ptvault.demo.mode.v1';

type DemoChallenge = {
  challengeId: string;
  expiresAt: number;
};

type StoredSession = {
  version: 1;
  username: typeof DEMO_USERNAME;
  expiresAt: number;
};

export type DemoSessionState = 'none' | 'active' | 'expired' | 'invalid';

export type DemoLoginResult =
  | { handled: false }
  | { handled: true; accepted: false }
  | { handled: true; accepted: true; challenge: DemoChallenge };

export type DemoMfaResult =
  | { handled: false }
  | { handled: true; accepted: false }
  | { handled: true; accepted: true; session: Session };

function storage(kind: 'local' | 'session'): Storage | undefined {
  try {
    return kind === 'local' ? globalThis.localStorage : globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

const inMemoryLocal = new Map<string, string>();
const inMemorySession = new Map<string, string>();

function read(kind: 'local' | 'session', key: string): string | null {
  const target = storage(kind);
  try {
    if (target) return target.getItem(key);
  } catch {
    // Some privacy modes expose Storage but throw when it is touched.
  }
  return (kind === 'session' ? inMemorySession : inMemoryLocal).get(key) ?? null;
}

function write(kind: 'local' | 'session', key: string, value: string): void {
  const target = storage(kind);
  try {
    if (target) {
      target.setItem(key, value);
      return;
    }
  } catch {
    // Fall through to the tab-local copy.
  }
  (kind === 'local' ? inMemoryLocal : inMemorySession).set(key, value);
}

function remove(kind: 'local' | 'session', key: string): void {
  const target = storage(kind);
  try {
    target?.removeItem(key);
  } catch {
    // The in-memory copy is still cleared below.
  }
  (kind === 'local' ? inMemoryLocal : inMemorySession).delete(key);
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readStoredSession(): StoredSession | null {
  const raw = read('local', SESSION_KEY);
  if (raw === null) return null;
  const value = parseObject(raw);
  if (
    value?.version !== 1 ||
    value.username !== DEMO_USERNAME ||
    typeof value.expiresAt !== 'number' ||
    !Number.isInteger(value.expiresAt)
  ) {
    return null;
  }
  return value as StoredSession;
}

function readStoredChallenge(): DemoChallenge | null {
  const raw = read('session', CHALLENGE_KEY);
  if (raw === null) return null;
  const value = parseObject(raw);
  if (
    value?.challengeId !== DEMO_CHALLENGE_ID ||
    typeof value.expiresAt !== 'number' ||
    !Number.isInteger(value.expiresAt)
  ) {
    return null;
  }
  return value as DemoChallenge;
}

export function demoSessionState(at = Date.now()): DemoSessionState {
  if (read('local', SESSION_KEY) === null) {
    return read('local', MODE_KEY) === null ? 'none' : 'expired';
  }
  const session = readStoredSession();
  if (!session) return 'invalid';
  return session.expiresAt > at ? 'active' : 'expired';
}

export function currentDemoSession(at = Date.now()): Session | null {
  if (demoSessionState(at) !== 'active') return null;
  const session = readStoredSession();
  if (!session) return null;
  return { username: DEMO_USERNAME, expiresAt: session.expiresAt, mode: 'SHADOW' };
}

export function isDemoSessionActive(): boolean {
  return demoSessionState() === 'active';
}

export function hasDemoSessionRecord(): boolean {
  return read('local', SESSION_KEY) !== null;
}

export function clearDemoSession(): void {
  remove('local', SESSION_KEY);
  remove('session', CHALLENGE_KEY);
}

/** Forget the browser-level demo tombstone before entering the real login flow. */
export function forgetDemoMode(): void {
  clearDemoSession();
  remove('local', MODE_KEY);
}

export function startDemoLogin(username: string, password: string): DemoLoginResult {
  if (username.trim() !== DEMO_USERNAME) {
    forgetDemoMode();
    return { handled: false };
  }
  if (password !== DEMO_PASSWORD) return { handled: true, accepted: false };

  const challenge = {
    challengeId: DEMO_CHALLENGE_ID,
    expiresAt: Date.now() + CHALLENGE_LIFETIME_MS,
  };
  remove('local', SESSION_KEY);
  write('local', MODE_KEY, 'demo');
  write('session', CHALLENGE_KEY, JSON.stringify(challenge));
  return { handled: true, accepted: true, challenge };
}

export function finishDemoLogin(challengeId: string, code: string): DemoMfaResult {
  if (challengeId !== DEMO_CHALLENGE_ID) return { handled: false };

  const challenge = readStoredChallenge();
  if (!challenge || challenge.expiresAt <= Date.now() || code !== DEMO_MFA_CODE) {
    return { handled: true, accepted: false };
  }

  const stored: StoredSession = {
    version: 1,
    username: DEMO_USERNAME,
    expiresAt: Date.now() + SESSION_LIFETIME_MS,
  };
  write('local', SESSION_KEY, JSON.stringify(stored));
  remove('session', CHALLENGE_KEY);
  return {
    handled: true,
    accepted: true,
    session: { username: DEMO_USERNAME, expiresAt: stored.expiresAt, mode: 'SHADOW' },
  };
}
