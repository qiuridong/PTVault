import { z } from 'zod';

/**
 * One recorded action, as the audit trail stores it.
 *
 * `action` is a plain string rather than an enum, deliberately. The API records
 * seventeen kinds today and gains more as surfaces land; a strict enum would
 * make a *newly added* action fail parsing, and because the page renders one
 * array, a single unparseable row would blank the whole audit log. An audit
 * surface that hides events it does not recognise is the one failure mode worth
 * designing against — the client maps known codes to Chinese labels and shows
 * the raw code for anything else. (Same lesson as the session `mode` field,
 * where making it required blanked the entire protected shell.)
 *
 * `detail` is already-parsed JSON, not a string: the repository parses it before
 * returning. It has also already been redacted at write time — keys matching
 * `/password|secret|token|code/i` are stripped recursively — so a client must
 * not redact it a second time. Doing so would hide the very fields an
 * administrator opens this page to read.
 */
export const AuditEventSchema = z.object({
  id: z.string().min(1),
  /** Null for actions taken before a session exists, e.g. a failed login. */
  actorAdminId: z.string().nullable(),
  sourceIp: z.string(),
  action: z.string().min(1),
  /** What was acted on: a job id, or `instanceId:infohash` for a torrent. */
  subject: z.string(),
  outcome: z.enum(['SUCCESS', 'DENIED', 'ERROR']),
  correlationId: z.string(),
  detail: z.record(z.unknown()),
  createdAt: z.number().int().positive(),
});

export const AuditResponseSchema = z.object({
  events: z.array(AuditEventSchema),
});

/** Hard ceiling shared by the route and the repository. */
export const AUDIT_MAX_LIMIT = 500;
export const AUDIT_DEFAULT_LIMIT = 100;

export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type AuditOutcome = AuditEvent['outcome'];
export type AuditResponse = z.infer<typeof AuditResponseSchema>;
