import { z } from 'zod';

import type { JobRepository } from '../jobs/repository.js';
import type { OffloadMachine } from './offload-machine.js';
import type { SecondaryReplicator } from './secondary-replica.js';

/**
 * A promote job carries only the offload it mirrors. Everything else — the
 * manifest, the verified primaries, the account to avoid — is read from the
 * database at run time, so a job queued hours ago cannot act on a stale view of
 * which replicas already exist.
 */
export const ReplicaPromotePayloadSchema = z.object({
  offloadJobId: z.string().uuid(),
});

export type ReplicaPromotePayload = z.infer<typeof ReplicaPromotePayloadSchema>;

/** `REPLICA_PROMOTE` is queued once per offload, so the key is the offload's id. */
export function replicaPromoteIdempotencyKey(offloadJobId: string): string {
  return `replica-promote:${offloadJobId}`;
}

export type ReplicaPromoteHandlerOptions = {
  machine: Pick<OffloadMachine, 'get'>;
  replicator: Pick<SecondaryReplicator, 'replicate'>;
};

/**
 * Runs the second cloud copy as its own job, after the offload has committed.
 *
 * Separate from the offload rather than a step inside it, because the two have
 * different costs and different urgency. Uploading a second full copy doubles
 * wall-clock time on a job the operator is waiting on — at the measured
 * ~5.1 MiB/s, a 578 GiB torrent would go from roughly 32 hours to 64. Deletion
 * eligibility depends on a verified *primary* (`cleanup.ts` asks
 * `hasVerifiedPrimaryForEveryFile`), never on the secondary, so making the
 * operator wait for redundancy buys nothing they need sooner.
 *
 * The redundancy still matters: without it a migrated torrent exists in exactly
 * one OneDrive account, and an account lost to suspension or a mistaken delete
 * takes the only cloud copy with it.
 */
export class ReplicaPromoteHandler {
  constructor(private readonly options: ReplicaPromoteHandlerOptions) {}

  async run(payload: unknown, signal: AbortSignal): Promise<void> {
    const parsed = ReplicaPromotePayloadSchema.safeParse(payload);
    if (!parsed.success) throw new Error('REPLICA_PROMOTE_PAYLOAD_INVALID');

    const snapshot = this.options.machine.get(parsed.data.offloadJobId);
    if (!snapshot) throw new Error('REPLICA_PROMOTE_OFFLOAD_NOT_FOUND');

    // Cancelled after the promote was queued: the operator abandoned this
    // transfer, so mirroring it would resurrect work they asked to stop.
    if (snapshot.cancelledAt !== null) return;

    await this.options.replicator.replicate(snapshot, signal);
  }
}

/**
 * Queues the second copy for an offload that just committed.
 *
 * Only for IMPORTANT transfers, matching `SecondaryReplicator`'s own guard: a
 * second copy of everything would need twice the cloud footprint, so which
 * torrents earn redundancy is the operator's call, expressed as importance when
 * they start the migration.
 *
 * Never throws. This runs immediately after a successful commit, and a failure
 * to queue the *optional* second copy must not turn a completed migration into a
 * failed job — the bytes are already safe in the primary and verified there.
 */
export function queueReplicaPromote(input: {
  jobs: Pick<JobRepository, 'insert'>;
  offloadJobId: string;
  importance: 'STANDARD' | 'IMPORTANT';
  onError?: (error: unknown) => void;
}): boolean {
  if (input.importance !== 'IMPORTANT') return false;

  try {
    input.jobs.insert({
      kind: 'REPLICA_PROMOTE',
      idempotencyKey: replicaPromoteIdempotencyKey(input.offloadJobId),
      payload: { offloadJobId: input.offloadJobId },
    });
    return true;
  } catch (error) {
    // A duplicate key means it is already queued, which is the desired state.
    input.onError?.(error);
    return false;
  }
}
