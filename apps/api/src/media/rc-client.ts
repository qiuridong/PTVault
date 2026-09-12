import { readFile } from 'node:fs/promises';

import type { RcloneRcClient } from './probe.js';

export type RcClientOptions = {
  /** Loopback address of one mount's RC listener, as `127.0.0.1:<port>`. */
  address: string;
  /** Reads the shared RC credential. */
  readCredential: () => Promise<string>;
  username?: string;
  timeoutMs?: number;
};

export const DEFAULT_RC_TIMEOUT_MS = 4_000;
const DEFAULT_RC_USERNAME = 'ptvault';

/**
 * Talks to one mount's rclone RC listener.
 *
 * Bound to a single address rather than shared across mounts: each mount is its own
 * rclone process with its own cache, so asking the wrong one returns another
 * account's numbers and reads as healthy while the mount in question is dead.
 *
 * Loopback only, enforced here rather than assumed. The RC port carries a password
 * but no transport security, so a routable address would put the credential and a
 * remote control for the mount on the wire.
 */
export function createRcClient(options: RcClientOptions): RcloneRcClient {
  const address = assertLoopbackAddress(options.address);
  const username = options.username ?? DEFAULT_RC_USERNAME;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RC_TIMEOUT_MS;

  return {
    async call(
      method: string,
      parameters: Record<string, unknown>,
      callOptions?: { timeoutMs?: number },
    ): Promise<unknown> {
      // A caller-supplied method must not be able to reshape the URL: `../` here
      // would reach a different RC endpoint than the one being named.
      if (!/^[a-z][a-z0-9]*(\/[a-z][a-z0-9-]*)+$/i.test(method)) {
        throw new Error('MOUNT_RC_METHOD_INVALID');
      }

      const credential = await options.readCredential();
      const requestTimeoutMs = callOptions?.timeoutMs ?? timeoutMs;
      if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
        throw new Error('MOUNT_RC_TIMEOUT_INVALID');
      }
      // Times out rather than hanging: this runs inside a health probe, and a
      // wedged FUSE mount can leave a socket open indefinitely. Without this the
      // probe never returns and the reconcile loop stops ticking entirely. Slow,
      // explicitly requested operations may supply a larger per-call deadline
      // without weakening the health probe's four-second bound.
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), requestTimeoutMs);
      try {
        const response = await fetch(`http://${address}/${method}`, {
          method: 'POST',
          signal: abort.signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Basic ${Buffer.from(`${username}:${credential}`).toString('base64')}`,
          },
          body: JSON.stringify(parameters),
        });
        if (!response.ok) {
          // The status, never the body: an rclone error carries remote paths and
          // account hints, and this value reaches a health record.
          throw new Error(`MOUNT_RC_STATUS_${response.status}`);
        }
        return await response.json();
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Reads the RC credential from a file once and caches it.
 *
 * Cached because the probe runs on a timer and would otherwise read the secret from
 * disk on every tick. Rotating the credential therefore needs a service restart —
 * an accepted limit, not an oversight: re-reading per tick would multiply the
 * exposure of a value whose whole purpose is to stay on disk. The value is never
 * logged and never appears in an error.
 */
export function createRcCredentialReader(filePath: string): () => Promise<string> {
  let cached: string | undefined;
  return async () => {
    if (cached !== undefined) return cached;
    const contents = await readFile(filePath, 'utf8');
    // Trailing newline is what an editor or `echo` leaves behind, and it would
    // silently become part of the credential — surfacing as a 401 that reads like
    // a wrong password rather than a stray byte.
    const credential = contents.trim();
    if (credential.length === 0) throw new Error('MOUNT_RC_CREDENTIAL_EMPTY');
    cached = credential;
    return credential;
  };
}

/** Rejects any address that is not loopback, before it can be dialled. */
function assertLoopbackAddress(address: string): string {
  const match = /^127\.0\.0\.1:(\d+)$/.exec(address);
  if (!match) throw new Error('MOUNT_RC_ADDRESS_NOT_LOOPBACK');
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('MOUNT_RC_ADDRESS_PORT_INVALID');
  }
  return address;
}
