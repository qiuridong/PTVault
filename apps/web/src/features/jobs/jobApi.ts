import {
  OffloadPauseResultSchema,
  OffloadResumeResultSchema,
  OffloadSchedulerStatusSchema,
  OffloadSnapshotSchema,
  JobStateSchema,
  type OffloadPauseResult,
  type OffloadResumeResult,
  type OffloadSchedulerStatus,
  type OffloadSnapshot,
} from '@ptvault/contracts';
import { z } from 'zod';

import { apiControlMutation, apiGet } from '../../api/client.js';

/** Timeline event projection consumed by the job timeline. */
export const JobEventViewSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().uuid(),
  eventType: z.string().min(1),
  detail: z.object({
    from: JobStateSchema.optional(),
    to: JobStateSchema.optional(),
  }),
  createdAt: z.number().int().nonnegative(),
});

export type JobEventView = z.infer<typeof JobEventViewSchema>;

const OffloadsResponseSchema = z.object({
  offloads: z.array(OffloadSnapshotSchema),
});

const EventsResponseSchema = z.object({
  events: z.array(JobEventViewSchema),
});

export const offloadsQueryKey = ['offloads'] as const;

export function offloadEventsQueryKey(jobId: string) {
  return ['offloads', jobId, 'events'] as const;
}

export async function getOffloads(): Promise<OffloadSnapshot[]> {
  const response = await apiGet('/api/offloads', OffloadsResponseSchema);
  return response.offloads;
}

export async function getOffloadEvents(jobId: string): Promise<JobEventView[]> {
  const safeJobId = z.string().uuid().parse(jobId);
  const response = await apiGet(
    `/api/offloads/${encodeURIComponent(safeJobId)}/events`,
    EventsResponseSchema,
  );
  return response.events;
}

/*
 * Durable pause/resume.
 *
 * Every one of these carries a caller-minted idempotency key rather than minting
 * its own, because the key has to survive a retry: the server replays the
 * recorded receipt for a key it has seen, which is what makes 「press 暂停 again
 * after the answer was lost」 safe. A key minted inside the request function
 * would be a fresh one per attempt and would book a second control request.
 */

/**
 * Deliberately not a child of `offloadsQueryKey`.
 *
 * TanStack matches by key prefix, so `['offloads', 'scheduler']` would be
 * invalidated by every `['offloads']` invalidation — which is one per progress
 * tick. The scheduler answer changes on a control boundary, not on a byte, and
 * the route is `no-store`: re-reading it per tick would be a request per second
 * for an answer that had not moved. `offloadEventsQueryKey` *is* under the prefix,
 * because an open timeline genuinely does go stale with its job.
 */
export const offloadSchedulerQueryKey = ['offload-scheduler'] as const;

/**
 * The global scheduler and three-layer drain picture.
 *
 * Answered to any live session, unlike the mutations, because reading whether a
 * restart is safe is not itself a change. The response is the status object
 * directly rather than an envelope — that is what the route sends.
 */
export async function getOffloadScheduler(): Promise<OffloadSchedulerStatus> {
  return apiGet('/api/offloads/scheduler', OffloadSchedulerStatusSchema);
}

/**
 * Asks one transfer to stop where it is. No MFA code: pausing destroys nothing.
 *
 * 202 is allowed through because it is the *normal* answer to a pause that took
 * effect — durably recorded, handler not yet unwound. Treating it as an error
 * would throw away the receipt that says how far the request got, and would
 * report a failure for a pause that is in flight.
 */
export async function pauseOffload(input: {
  jobId: string;
  idempotencyKey: string;
}): Promise<OffloadPauseResult> {
  return apiControlMutation(
    '/api/offloads/pause',
    { jobId: input.jobId },
    OffloadPauseResultSchema,
    { idempotencyKey: input.idempotencyKey, allowedStatus: [202] },
  );
}

/** Re-queues a paused transfer. Carries a code: resuming restarts uploads. */
export async function resumeOffload(input: {
  jobId: string;
  mfaCode: string;
  idempotencyKey: string;
}): Promise<OffloadResumeResult> {
  return apiControlMutation(
    '/api/offloads/resume',
    { jobId: input.jobId, mfaCode: input.mfaCode },
    OffloadResumeResultSchema,
    { idempotencyKey: input.idempotencyKey },
  );
}

/**
 * Pauses every OFFLOAD there is, and answers with the drain picture either way.
 *
 * 202 means the gate is persisted but handlers are still unwinding, 200 that the
 * OFFLOAD plane is drained. Both carry the same body, so the caller reads
 * `offloadDrained` rather than the status code — and neither answer says the
 * database is drained, let alone that a deploy is safe.
 */
export async function pauseAllOffloads(input: {
  idempotencyKey: string;
}): Promise<OffloadSchedulerStatus> {
  return apiControlMutation('/api/offloads/pause-all', {}, OffloadSchedulerStatusSchema, {
    idempotencyKey: input.idempotencyKey,
    allowedStatus: [202],
  });
}

/** Lifts the freeze. Restarts uploads in bulk, so it takes a fresh code. */
export async function resumeAllOffloads(input: {
  mfaCode: string;
  idempotencyKey: string;
}): Promise<OffloadSchedulerStatus> {
  return apiControlMutation(
    '/api/offloads/resume-all',
    { mfaCode: input.mfaCode },
    OffloadSchedulerStatusSchema,
    { idempotencyKey: input.idempotencyKey },
  );
}
