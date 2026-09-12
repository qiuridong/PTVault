import { z } from 'zod';

export const JobKindSchema = z.enum([
  'OFFLOAD',
  'REHYDRATE',
  'PREFETCH',
  'REPLICA_COPY',
  'REPLICA_PROMOTE',
]);

export const JobStateSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'RETRY_WAIT',
  'BLOCKED',
  'FAILED_SAFE',
  'CANCELLED_SAFE',
  'COMPLETED',
]);

export type JobKind = z.infer<typeof JobKindSchema>;
export type JobState = z.infer<typeof JobStateSchema>;
