import {
  QbInstanceIdSchema,
  InfoHashSchema,
  OffloadCancelResultSchema,
  OffloadCleanupResultSchema,
  OffloadRejectionSchema,
  OffloadRetryResultSchema,
  OffloadSnapshotSchema,
  QbInstanceTestResultSchema,
  TorrentsResponseSchema,
  TorrentPreflightSchema,
  type OffloadImportance,
  type OffloadCancelResult,
  type OffloadCleanupResult,
  type OffloadRetryResult,
  type OffloadTarget,
  type QbInstanceTestResult,
  type TorrentSummary,
  type TorrentPreflight,
} from '@ptvault/contracts';
import { z } from 'zod';

import {
  ApiError,
  apiControlMutation,
  apiGet,
  apiMutation,
  apiMutationAllowing,
} from '../../api/client.js';

export const QbInstanceSummarySchema = z.object({
  id: QbInstanceIdSchema,
  displayName: z.string().min(1),
  enabled: z.boolean(),
  /** Null until credentials are stored; the password itself is never returned. */
  baseUrl: z.string().nullable(),
  username: z.string().nullable(),
  hasCredential: z.boolean(),
  /*
   * The three fields below are `.optional()`, not merely nullable, and the
   * difference carries meaning the settings page reads.
   *
   * The browser bundle and the API are deployed down separate paths and are
   * routinely different ages. Absent means "the API on this box does not report
   * this yet"; `[]` / `null` mean "reported, and there is nothing". Collapsing
   * the two would draw an old API as "no path mapping, never synced" — a
   * confident answer to a question that was never asked.
   */
  pathMaps: z.array(z.string()).optional(),
  lastSyncAt: z.number().int().nullable().optional(),
  lastSyncError: z.string().nullable().optional(),
});

export type QbInstanceSummary = z.infer<typeof QbInstanceSummarySchema>;

const InstancesResponseSchema = z.object({
  instances: z.array(QbInstanceSummarySchema),
});

export type TorrentPageResponse = {
  torrents: TorrentSummary[];
  total: number;
  page: number;
  size: number;
};

const PreflightResponseSchema = z.object({
  preflight: TorrentPreflightSchema,
});

const SyncSummarySchema = z.object({
  instanceId: z.string(),
  seen: z.number().int().nonnegative(),
  inserted: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  markedAbsent: z.number().int().nonnegative(),
  finishedAt: z.number().int(),
});

const SyncResponseSchema = z.object({
  synced: z.array(SyncSummarySchema),
  failed: z.array(z.object({ instanceId: z.string(), code: z.string() })),
});

export type QbSyncResponse = z.infer<typeof SyncResponseSchema>;

const InstanceConfigResponseSchema = z.object({
  instance: QbInstanceSummarySchema,
});

export type QbInstanceConfigInput = {
  id: string;
  displayName: string;
  enabled: boolean;
  baseUrl: string;
  username: string;
  /** Omit to keep the credential already stored for this instance. */
  password?: string;
  /**
   * Omit to keep the stored mapping; send `[]` to clear it. The server treats
   * the two differently on purpose, so the editor must not normalise "the form
   * did not touch this" into an empty array.
   */
  pathMaps?: string[];
};

export const qbInstancesQueryKey = ['qb', 'instances'] as const;

export function qbTorrentsQueryKey(instanceId?: string) {
  return ['qb', 'torrents', instanceId ?? 'all'] as const;
}

export function qbTorrentPageQueryKey(instanceId: string | undefined, page: number, size: number) {
  return ['qb', 'torrents', 'page', instanceId ?? 'all', page, size] as const;
}

export function qbPreflightQueryKey(instanceId: string, hash: string) {
  return ['qb', 'preflight', instanceId, hash] as const;
}

export async function getInstances(): Promise<QbInstanceSummary[]> {
  const response = await apiGet('/api/qb/instances', InstancesResponseSchema);
  return response.instances;
}

export async function getTorrents(instanceId?: string): Promise<TorrentSummary[]> {
  const query = instanceId === undefined ? '' : `?instanceId=${encodeURIComponent(instanceId)}`;
  const response = await apiGet(`/api/qb/torrents${query}`, TorrentsResponseSchema);
  return response.torrents;
}

export async function getTorrentPage(input: {
  /**
   * Explicitly `| undefined` rather than merely optional: the caller derives this
   * from a URL parameter that is absent for "all instances", and under
   * `exactOptionalPropertyTypes` passing that through would otherwise not compile.
   */
  instanceId?: string | undefined;
  page: number;
  size: number;
}): Promise<TorrentPageResponse> {
  const query = new URLSearchParams({ page: String(input.page), size: String(input.size) });
  if (input.instanceId !== undefined) query.set('instanceId', input.instanceId);
  const response = await apiGet(`/api/qb/torrents?${query.toString()}`, TorrentsResponseSchema);
  return {
    torrents: response.torrents,
    total: response.total ?? response.torrents.length,
    page: response.page ?? input.page,
    size: response.size ?? input.size,
  };
}

export async function getPreflight(instanceId: string, hash: string): Promise<TorrentPreflight> {
  const safeInstance = QbInstanceIdSchema.parse(instanceId);
  const safeHash = InfoHashSchema.parse(hash);
  const response = await apiGet(
    `/api/qb/torrents/${encodeURIComponent(safeInstance)}/${encodeURIComponent(safeHash)}/preflight`,
    PreflightResponseSchema,
  );
  return response.preflight;
}

/**
 * Refreshes the inventory from qB. Read-only against qB (`torrents/info` only) —
 * it cannot pause, delete, or move a torrent. Omit `instanceId` to refresh every
 * enabled instance.
 */
export async function syncInventory(instanceId?: string): Promise<QbSyncResponse> {
  const body = instanceId === undefined ? {} : { instanceId };
  return apiMutation('/api/qb/sync', body, SyncResponseSchema);
}

/** Writes our own polling config. Touches no torrent and no media file. */
export async function saveInstance(input: QbInstanceConfigInput): Promise<QbInstanceSummary> {
  const response = await apiMutation('/api/qb/instances', input, InstanceConfigResponseSchema);
  return response.instance;
}

/**
 * Outcome of a connection test, with "this API is too old to have the endpoint"
 * kept apart from every other result.
 *
 * The distinction is not academic here: the browser bundle and the API are
 * deployed down two separate paths, so a browser holding today's bundle
 * routinely talks to an API from an earlier one. Folding the 404 into the error
 * path would put "测试失败" on screen for an instance that is perfectly
 * reachable, and send the operator to re-check a password that was never wrong.
 */
export type QbInstanceTestOutcome =
  { supported: true; result: QbInstanceTestResult } | { supported: false };

/**
 * Dials a qB with credentials that have not been saved yet.
 *
 * Writes nothing on either side — it calls `app/version` and nothing else. A
 * refused password comes back as a 200 with `ok: false`, so anything thrown here
 * is a fault in the test endpoint itself rather than an answer about the qB.
 */
export async function testInstance(input: {
  baseUrl: string;
  username: string;
  password: string;
}): Promise<QbInstanceTestOutcome> {
  try {
    return {
      supported: true,
      result: await apiMutation('/api/qb/instances/test', input, QbInstanceTestResultSchema),
    };
  } catch (error) {
    // The endpoint answers 200/400/401/403 and never 404, so a 404 can only mean
    // the route is not registered on the API this browser is talking to.
    if (error instanceof ApiError && error.status === 404) return { supported: false };
    throw error;
  }
}

const OffloadTriggerResponseSchema = z.object({
  offloads: z.array(OffloadSnapshotSchema),
  rejected: z.array(OffloadRejectionSchema),
  requested: z.number().int().nonnegative(),
});

export type OffloadTriggerResponse = z.infer<typeof OffloadTriggerResponseSchema>;

/**
 * Starts an offload for the selected batch.
 *
 * This is the one call in the web client that mutates anything outside our own
 * database: each queued job pauses its torrent, uploads its bytes, and
 * eventually deletes the local copy. It carries a fresh TOTP code because a
 * live session alone must not be enough to start one.
 *
 * A batch may be partially accepted, so callers must read `rejected` rather than
 * treating a resolved promise as "everything queued".
 */
/**
 * 409 is accepted here, not thrown: the server answers it when the whole batch
 * was refused, and the body carries the reason for each target. Discarding it
 * would leave the operator with a status code where an explanation should be.
 */
export async function startOffloads(input: {
  targets: OffloadTarget[];
  importance: OffloadImportance;
  mfaCode: string;
}): Promise<OffloadTriggerResponse> {
  return apiMutationAllowing('/api/offloads', input, OffloadTriggerResponseSchema, 409);
}

/**
 * Releases a transfer that has stopped, so its torrent can be migrated again.
 *
 * Books a durable control receipt like pause and resume do, so the key travels
 * in the `idempotency-key` header and never in the body — the route reads only
 * the header and would refuse the request with 400 `IDEMPOTENCY_KEY_REQUIRED`.
 * The receipt is replayed *before* the MFA code is consumed, which is precisely
 * why the caller must reuse one key across retries of a single intent: a fresh
 * key per attempt would miss the replay and burn a second one-time code.
 */
export async function cancelOffload(input: {
  jobId: string;
  mfaCode: string;
  idempotencyKey: string;
}): Promise<OffloadCancelResult> {
  const { idempotencyKey, ...body } = input;
  return apiControlMutation('/api/offloads/cancel', body, OffloadCancelResultSchema, {
    idempotencyKey,
  });
}

/**
 * Re-queues a stopped transfer, resuming from the step it reached.
 *
 * Deliberately *not* a control mutation, unlike cancel. `/api/offloads/retry` is
 * registered through the route file's `recoveryAction` helper — documented there
 * as "recovery actions without durable control receipts" — so it never reads,
 * requires, or persists an `idempotency-key`. Sending one would be inert at best
 * and misleading in this file at worst: it would suggest a replay guarantee the
 * server does not offer. Making retry durable is a contract change of its own,
 * not something to smuggle in beside the cancel wiring.
 */
export async function retryOffload(input: {
  jobId: string;
  mfaCode: string;
}): Promise<OffloadRetryResult> {
  return apiMutation('/api/offloads/retry', input, OffloadRetryResultSchema);
}

/**
 * Separately authorizes deletion after a transfer has stopped at CLOUD_COMMITTED,
 * or resumes a crash/follow-up from LOCAL_CLEANUP.
 * The server mints the recovery-version-bound permit; the browser never handles it.
 */
export async function cleanupOffload(input: {
  jobId: string;
  mfaCode: string;
}): Promise<OffloadCleanupResult> {
  return apiMutation('/api/offloads/cleanup', input, OffloadCleanupResultSchema);
}
