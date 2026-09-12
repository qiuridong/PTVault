import type { AuditEvent } from '@ptvault/contracts';

/**
 * Coarse groupings an operator actually browses by.
 *
 * Grouped rather than listing seventeen action codes as chips: the question
 * behind opening this page is usually "who touched the data" or "who got in",
 * not "show me OFFLOAD_RETRIED". `DATA` deliberately holds every action that
 * moves or deletes bytes — offload, cleanup, and restore — because those are the
 * ones worth reading together when something is missing.
 */
export type AuditGroup = 'ALL' | 'AUTH' | 'DATA' | 'RECOVERY' | 'OTHER';

const GROUP_OF: Record<string, Exclude<AuditGroup, 'ALL' | 'OTHER'>> = {
  AUTH_LOGIN: 'AUTH',
  AUTH_MFA: 'AUTH',
  AUTH_LOGOUT: 'AUTH',
  SESSION_REVOKE: 'AUTH',
  OFFLOAD_TRIGGER: 'DATA',
  OFFLOAD_CANCELLED: 'DATA',
  OFFLOAD_RETRIED: 'DATA',
  OFFLOAD_CLEANUP: 'DATA',
  MEDIA_PIN_SET: 'DATA',
  MEDIA_REHYDRATE_STARTED: 'DATA',
  MEDIA_REHYDRATE_RETRIED: 'DATA',
  MEDIA_REHYDRATE_CANCELLED: 'DATA',
  RECOVERY_RECIPIENT_SET: 'RECOVERY',
  RECOVERY_ESCROW_UPLOADED: 'RECOVERY',
  RECOVERY_BUNDLE_GENERATED: 'RECOVERY',
  RECOVERY_COMPUTER_CONFIRMED: 'RECOVERY',
  RECOVERY_DRILL_ATTESTED: 'RECOVERY',
};

/**
 * Which group an action belongs to.
 *
 * An action the client has never heard of lands in `OTHER` rather than being
 * dropped. A newly added action must stay visible somewhere — an audit log that
 * quietly omits what it does not recognise is worse than one showing a raw code.
 */
export function groupOf(action: string): Exclude<AuditGroup, 'ALL'> {
  return GROUP_OF[action] ?? 'OTHER';
}

export type AuditFilters = {
  group: AuditGroup;
  /** Empty means every outcome. */
  outcomes: readonly AuditEvent['outcome'][];
  query: string;
};

/**
 * Narrows the trail without ever reordering it.
 *
 * Order is the server's (newest first) and is left alone: an audit log read out
 * of chronological order invites reading a cause as a consequence.
 */
export function applyAuditFilters(
  events: readonly AuditEvent[],
  filters: AuditFilters,
): AuditEvent[] {
  const needle = filters.query.trim().toLowerCase();

  return events.filter((event) => {
    if (filters.group !== 'ALL' && groupOf(event.action) !== filters.group) return false;
    if (filters.outcomes.length > 0 && !filters.outcomes.includes(event.outcome)) return false;
    if (needle === '') return true;

    // Searches the fields an operator has in hand: what was touched, what was
    // done, and where from. Not `detail`, whose shape varies per action and
    // would make the same query mean different things on different rows.
    return (
      event.subject.toLowerCase().includes(needle) ||
      event.action.toLowerCase().includes(needle) ||
      event.sourceIp.toLowerCase().includes(needle)
    );
  });
}

export type ParsedSubject =
  { kind: 'TORRENT'; instanceId: string; hash: string } | { kind: 'PLAIN'; value: string };

/**
 * Splits `instanceId:infohash` so a row can link to the torrent it acted on.
 *
 * Anything not shaped like an infohash stays plain rather than being coerced:
 * job ids and usernames also land in `subject`, and a link to a torrent that
 * does not exist would be a worse answer than plain text.
 */
export function parseSubject(subject: string): ParsedSubject {
  const separator = subject.indexOf(':');
  if (separator > 0) {
    const instanceId = subject.slice(0, separator);
    const hash = subject.slice(separator + 1);
    if (/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(hash)) {
      return { kind: 'TORRENT', instanceId, hash };
    }
  }
  return { kind: 'PLAIN', value: subject };
}
