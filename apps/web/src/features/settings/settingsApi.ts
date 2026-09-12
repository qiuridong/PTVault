import {
  JellyfinInfoSchema,
  JellyfinTestResultSchema,
  SystemInfoSchema,
  TransferSettingsStatusSchema,
  type JellyfinInfo,
  type JellyfinTestResult,
  type SystemInfo,
  type TransferSettingsPatch,
  type TransferSettingsStatus,
} from '@ptvault/contracts';

import { ApiError, apiControlMutation, apiMutation } from '../../api/client.js';
import { probeGet, type Probe } from '../../api/probe.js';

export type { Probe } from '../../api/probe.js';

/*
 * Read-only reads for the settings page.
 *
 * The schemas were briefly mirrored here, because the endpoints shipped to
 * production while their contracts were still in the API track's worktree.
 * They are now on master, so this imports them: a second copy of a shape is a
 * copy that stops being updated, and nobody finds out which one is stale until
 * a field silently stops rendering.
 *
 * Nothing on this surface writes Jellyfin config, and the token itself is never
 * returned by the API — only the path to the file holding it.
 */

export const jellyfinInfoQueryKey = ['jellyfin', 'info'] as const;
export const systemInfoQueryKey = ['system', 'info'] as const;

/** Read-only: reports the configured connection and the libraries it can see. */
export async function getJellyfinInfo(): Promise<Probe<JellyfinInfo>> {
  return probeGet('/api/jellyfin/info', JellyfinInfoSchema);
}

/** Read-only: deployment identity, schema version, and mount health. */
export async function getSystemInfo(): Promise<Probe<SystemInfo>> {
  return probeGet('/api/system/info', SystemInfoSchema);
}

/**
 * Dials the configured Jellyfin once and reports what came back.
 *
 * Takes no body: the connection is server-side configuration, and a test that
 * accepted a URL would be a request-forgery primitive rather than a test of
 * what is actually deployed. Writes nothing beyond the refresh notification it
 * has to attempt in order to answer whether that path works at all.
 */
export async function testJellyfin(): Promise<Probe<JellyfinTestResult>> {
  try {
    return {
      supported: true,
      data: await apiMutation('/api/jellyfin/test', {}, JellyfinTestResultSchema),
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { supported: false };
    throw error;
  }
}

export const transferSettingsQueryKey = ['settings', 'transfers'] as const;

/**
 * The configured and effective transfer limits, plus what is running right now.
 *
 * Probed rather than fetched outright: the route is registered unconditionally on
 * a current API, but this bundle also ships to boxes whose API predates it, and
 * an absent route must not render as 「全部关闭」. A missing endpoint means go
 * deploy the API; every field genuinely off is a different sentence.
 */
export async function getTransferSettings(): Promise<Probe<TransferSettingsStatus>> {
  return probeGet('/api/settings/transfers', TransferSettingsStatusSchema);
}

/**
 * Writes the operator's intended limits, carrying the revision it was editing.
 *
 * `PATCH`, and a durable control mutation rather than a plain one, for three
 * reasons the route enforces: it refuses a request with no `idempotency-key`
 * (400 `IDEMPOTENCY_KEY_REQUIRED`), it replays the recorded receipt when the same
 * key returns with the same body, and it rejects a stale `revision` with 409
 * rather than overwriting whatever another session saved in between. The caller
 * therefore mints one key per *intent* and reuses it across retries — a save
 * whose answer was lost to a dropped connection must be re-sendable without
 * booking a second, different revision bump.
 *
 * No status is allowed through: 400/403/409 all answer `{ error, code }`, not a
 * status object, so letting one past would run the error body through
 * `TransferSettingsStatusSchema` and report a schema mismatch in place of the
 * reason. Thrown as `ApiError` instead, whose message carries the server's own
 * code — which is what lets the caller tell a revision conflict from an
 * idempotency conflict rather than printing one sentence for both.
 */
export async function updateTransferSettings(input: {
  patch: TransferSettingsPatch;
  idempotencyKey: string;
}): Promise<TransferSettingsStatus> {
  return apiControlMutation('/api/settings/transfers', input.patch, TransferSettingsStatusSchema, {
    idempotencyKey: input.idempotencyKey,
    method: 'PATCH',
  });
}
