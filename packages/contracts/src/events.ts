import { z } from 'zod';

import { OffloadControlEventCodeSchema, OffloadSchedulerStateSchema } from './offloads.js';

export const ServerEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('job.updated'),
      jobId: z.string().uuid(),
      state: z.string(),
      progress: z.number().min(0).max(1),
      /**
       * Set only on a durable control boundary (pause requested, paused, resumed).
       *
       * Present so a client can distinguish the transition itself from the stream of
       * ordinary progress ticks that surround it. Progress ticks may be coalesced
       * behind a short merge window; a boundary must not be, because the buttons the
       * operator is allowed to press change at exactly that moment.
       */
      eventCode: OffloadControlEventCodeSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('health.updated'),
      component: z.string(),
      healthy: z.boolean(),
    })
    .strict(),
  /**
   * The global OFFLOAD scheduler changed state.
   *
   * Carries `revision` rather than the whole drain picture: the counts and the
   * deployment blockers are derived server-side from live handler and job state,
   * and a snapshot pushed over SSE would be stale the moment it was framed. The
   * revision is the monotonic durable control version, so a client re-reads
   * `GET /api/offloads/scheduler` on receipt and can tell an old answer from a new
   * one.
   */
  z
    .object({
      type: z.literal('scheduler.updated'),
      component: z.literal('offload-scheduler'),
      schedulerState: OffloadSchedulerStateSchema,
      revision: z.number().int().nonnegative(),
    })
    .strict(),
]);

export type ServerEvent = z.infer<typeof ServerEventSchema>;
