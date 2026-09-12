import { z } from 'zod';

export const TorrentStateSchema = z.enum([
  'DOWNLOADING',
  'SEEDING',
  'PAUSED',
  'CHECKING',
  'MISSING_FILES',
  'ERROR',
  'UNKNOWN',
]);

export const QbInstanceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);
export const InfoHashSchema = z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/);

/**
 * Accepts only http(s) so a misconfigured instance can never make the server
 * dial `file:`/`unix:`-style targets. Built on `URL` rather than a regex so the
 * check matches what the HTTP client will actually resolve.
 */
const HttpUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'must be an http(s) URL');

/**
 * One container→host prefix rewrite, written `containerPath=hostPath`.
 *
 * Validated here rather than only on the server so the form can reject a typo
 * while the operator is still looking at it. The shape check is deliberately
 * loose — both sides must be non-empty and absolute, and that is all this layer
 * can honestly assert; whether the host side exists is a question only the
 * machine holding the disk can answer.
 *
 * Commas are rejected because the server stores the whole set as one
 * comma-separated column. A path containing a comma is legal on Linux but not
 * representable in that encoding, and splitting it back would produce two
 * garbage rules instead of one correct one. Refusing at the door beats storing
 * something that silently mis-rewrites every path afterwards.
 */
const PathMapSchema = z
  .string()
  .min(3)
  .max(512)
  .refine((value) => {
    const separator = value.indexOf('=');
    if (separator <= 0 || separator === value.length - 1) return false;
    const from = value.slice(0, separator);
    const to = value.slice(separator + 1);
    if (!from.startsWith('/') || !to.startsWith('/')) return false;
    return !value.includes('\0') && !value.includes(',');
  }, 'must be written as /container/path=/host/path, without commas');

/**
 * Body of `POST /api/qb/instances`. `password` is optional so the web form can
 * update the display name or base URL without re-typing a secret it never
 * received back from the API; the server keeps the stored credential in that case.
 *
 * `pathMaps` follows the opposite rule: omitting the key keeps what is stored,
 * and sending an empty array clears it. A rename must not silently drop a
 * mapping the operator set on another screen, but "no mapping" has to remain
 * expressible.
 */
export const QbInstanceConfigSchema = z.object({
  id: QbInstanceIdSchema,
  displayName: z.string().min(1).max(64),
  enabled: z.boolean(),
  baseUrl: HttpUrlSchema,
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(512).optional(),
  pathMaps: z.array(PathMapSchema).max(16).optional(),
});

/**
 * Body of `POST /api/qb/instances/test` — dial these credentials once and report
 * whether qB answers.
 *
 * Separate from the config schema because a test is not a save: no `id` is
 * required to exist, nothing is written, and `password` is mandatory here since
 * there is no stored secret to fall back on. Sending a config body would invite
 * the reading that testing an instance also updates it.
 */
export const QbInstanceTestSchema = z.object({
  baseUrl: HttpUrlSchema,
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(512),
});

/**
 * Result of a connection test.
 *
 * A refused connection is a successful test that reports failure — the endpoint
 * answers 200 with `ok: false` rather than mirroring qB's status, so the web
 * client does not have to tell "your qB rejected the password" apart from "the
 * test endpoint itself is broken". `error` is a stable code, never a message:
 * qB's own errors carry the URL and would put an internal address on screen.
 */
export const QbInstanceTestResultSchema = z.object({
  ok: z.boolean(),
  version: z.string().max(64).nullable(),
  error: z.enum(['UNREACHABLE', 'AUTH_FAILED', 'BAD_RESPONSE']).nullable(),
});

export const QbSyncRequestSchema = z.object({
  instanceId: QbInstanceIdSchema.optional(),
});

export const TorrentIdentitySchema = z.object({
  instanceId: QbInstanceIdSchema,
  hash: InfoHashSchema,
});

export const TorrentSummarySchema = z.object({
  instanceId: QbInstanceIdSchema,
  hash: InfoHashSchema,
  name: z.string().min(1),
  progress: z.number().min(0).max(1),
  state: TorrentStateSchema,
  totalSize: z.number().int().nonnegative(),
  amountLeft: z.number().int().nonnegative(),
  contentPath: z.string().min(1),
  savePath: z.string().min(1),
  ratio: z.number().nonnegative(),
  seedingSeconds: z.number().int().nonnegative(),
  completedAt: z.number().int().nullable(),
  cloudState: z.enum([
    'LOCAL',
    'MIGRATING',
    // A verified cloud primary exists, but the local source is intentionally
    // still present until the operator separately authorizes cleanup.
    'CLOUD_COMMITTED',
    'CLOUD',
    'REHYDRATING',
    'BLOCKED',
  ]),
});

export const TorrentsResponseSchema = z.object({
  torrents: z.array(TorrentSummarySchema),
  total: z.number().int().nonnegative().optional(),
  page: z.number().int().positive().optional(),
  size: z.number().int().positive().max(200).optional(),
});

export const PreflightIssueSchema = z.object({
  code: z.enum([
    'NOT_COMPLETE',
    'ACTIVE_WRITE',
    'OUTSIDE_ALLOWED_ROOT',
    'SYMLINK_ESCAPE',
    'SHARED_TORRENT_FILE',
    'EXTERNAL_HARDLINK',
    'PATH_MISSING',
    'PATH_CHANGED',
  ]),
  path: z.string().nullable(),
  blocking: z.boolean(),
  message: z.string(),
});

export const TorrentPreflightSchema = z.object({
  instanceId: QbInstanceIdSchema,
  hash: InfoHashSchema,
  logicalBytes: z.number().int().nonnegative(),
  allocatedBytes: z.number().int().nonnegative(),
  reclaimableBytes: z.number().int().nonnegative(),
  eligible: z.boolean(),
  issues: z.array(PreflightIssueSchema),
});

export type TorrentState = z.infer<typeof TorrentStateSchema>;
export type QbInstanceId = z.infer<typeof QbInstanceIdSchema>;
export type QbInstanceConfig = z.infer<typeof QbInstanceConfigSchema>;
export type QbInstanceTest = z.infer<typeof QbInstanceTestSchema>;
export type QbInstanceTestResult = z.infer<typeof QbInstanceTestResultSchema>;
export type QbSyncRequest = z.infer<typeof QbSyncRequestSchema>;
export type InfoHash = z.infer<typeof InfoHashSchema>;
export type TorrentIdentity = z.infer<typeof TorrentIdentitySchema>;
export type TorrentSummary = z.infer<typeof TorrentSummarySchema>;
export type TorrentsResponse = z.infer<typeof TorrentsResponseSchema>;
export type PreflightIssue = z.infer<typeof PreflightIssueSchema>;
export type TorrentPreflight = z.infer<typeof TorrentPreflightSchema>;
