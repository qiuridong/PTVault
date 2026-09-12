import type { OffloadResourceWait, OffloadSnapshot } from '@ptvault/contracts';

/** One Chinese vocabulary for physical scheduler waits everywhere in the jobs UI. */
const RESOURCE_WAIT_LABELS: Record<OffloadResourceWait, string> = {
  PREFLIGHT_SLOT: '预检槽位',
  PAUSE_SNAPSHOT_SLOT: '暂停/快照槽位',
  HASH_SLOT: '哈希槽位',
  UPLOAD_SLOT: '上传槽位',
  READBACK_SLOT: '解密回读槽位',
  REMOTE_HEAVY_SLOT: '上传/回读共享容量',
};

/**
 * Formats only facts the API actually supplied.
 *
 * Old snapshots have no resource fields, and queue position is explicitly
 * optional because it is omitted whenever the backend cannot keep it exact.
 * Active/capacity are shown only as a pair; rendering either alone would invent
 * the missing half of an occupancy reading.
 */
export function resourceWaitText(snapshot: OffloadSnapshot): string | null {
  if (snapshot.resourceWait === undefined) return null;
  const details: string[] = [];
  if (snapshot.resourceQueuePosition !== undefined) {
    details.push(`队列第 ${snapshot.resourceQueuePosition}`);
  }
  if (snapshot.resourceActive !== undefined && snapshot.resourceCapacity !== undefined) {
    details.push(`${snapshot.resourceActive}/${snapshot.resourceCapacity}`);
  }
  const suffix = details.length === 0 ? '' : `（${details.join('，')}）`;
  return `等待${RESOURCE_WAIT_LABELS[snapshot.resourceWait]}${suffix}`;
}

export function ResourceWaitStatus({
  snapshot,
  compact = false,
}: {
  snapshot: OffloadSnapshot;
  compact?: boolean;
}) {
  const text = resourceWaitText(snapshot);
  if (text === null) return null;
  if (compact) {
    return (
      <span className="resource-wait-status" role="status" aria-live="polite">
        {text}
      </span>
    );
  }
  return (
    <p className="inline-message resource-wait-status" role="status" aria-live="polite">
      <span className="note-text">{text}</span>
    </p>
  );
}
