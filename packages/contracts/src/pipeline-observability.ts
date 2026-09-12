import { z } from 'zod';

export const PipelineMetricSchema = z.enum([
  'hostCpuPercent',
  'hostStealPercent',
  'hostMemoryUsedPercent',
  'hostSwapUsedBytes',
  'hostReadBps',
  'hostWriteBps',
  'hostRxBps',
  'hostTxBps',
  'hostCpuPressureSome',
  'hostMemoryPressureSome',
  'hostMemoryPressureFull',
  'hostIoPressureSome',
  'hostIoPressureFull',
  'cgroupCpuCores',
  'cgroupMemoryBytes',
  'cgroupSwapBytes',
  'cgroupReadBps',
  'cgroupWriteBps',
  'downloadActive',
  'extractionActive',
  'uploadActive',
  'residentBytes',
  'reservedBytes',
  'qbDownloading',
  'qbSeeding',
  'qbInventoryAgeSeconds',
  'jellyfinPlaying',
  'jellyfinTranscoding',
  'jellyfinSampleAgeSeconds',
]);
export const PipelineMetricsSchema = z.record(
  PipelineMetricSchema,
  z.number().finite().nonnegative().nullable(),
);
const stamp = z.number().int().nonnegative();
const build = z
  .string()
  .regex(/^[A-Za-z0-9_.+ /-]{1,120}$/)
  .nullable();
export const PipelineObservationSampleSchema = z
  .object({
    at: stamp,
    metrics: PipelineMetricsSchema,
    configRevision: stamp.nullable(),
    build,
  })
  .strict();
export const PipelineObservationEventSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9:_-]{1,180}$/),
    at: stamp,
    kind: z.enum([
      'WAITING',
      'ACQUIRED',
      'RELEASED',
      'STATE',
      'FAILED',
      'VERIFIED',
      'CONFIG',
      'ADMISSION',
      'EVICTION',
      'REDOWNLOAD',
    ]),
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
    failureCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,79}$/)
      .nullable()
      .default(null),
    pipelineId: z.string().uuid().nullable().default(null),
    groupKey: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .default(null),
    jobId: z.string().uuid().nullable().default(null),
    attempt: stamp.nullable().default(null),
    durationMs: stamp.nullable().default(null),
    bytes: z
      .string()
      .regex(/^(0|[1-9]\d{0,29})$/)
      .nullable()
      .default(null),
    configRevision: stamp.nullable(),
    build,
  })
  .strict();
export const PipelineObservationQuerySchema = z
  .object({
    from: z.coerce.number().int().nonnegative(),
    to: z.coerce.number().int().nonnegative(),
    maxPoints: z.coerce.number().int().min(1).max(500).default(240),
  })
  .strict()
  .refine((x) => x.to > x.from && x.to - x.from <= 30 * 86400000);

export type PipelineMetric = z.infer<typeof PipelineMetricSchema>;
export type PipelineMetrics = z.infer<typeof PipelineMetricsSchema>;
export type PipelineObservationSample = z.infer<typeof PipelineObservationSampleSchema>;
export type PipelineObservationEvent = z.infer<typeof PipelineObservationEventSchema>;
export type PipelineObservationEventInput = z.input<typeof PipelineObservationEventSchema>;
export type PipelineObservationQuery = z.infer<typeof PipelineObservationQuerySchema>;
export type PipelineObservationPoint = {
  at: number;
  samples: number;
  metrics: PipelineMetrics;
  maxima: PipelineMetrics;
  configRevision: number | null;
  build: string | null;
};
export type PipelineObservationStatus = {
  state: 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE';
  storageBytes: number;
  maxBytes: number;
  queued: number;
  dropped: number;
  lastSampleAt: number | null;
  rawRetentionDays: 7;
  minuteRetentionDays: 30;
};
export type PipelineObservationHistory = {
  from: number;
  to: number;
  resolution: 'RAW' | 'MINUTE';
  points: PipelineObservationPoint[];
  sampleCount: number;
  firstSampleAt: number | null;
  lastSampleAt: number | null;
  coverage: number;
  status: PipelineObservationStatus;
};
export type PipelineObservationSummary = {
  verifiedBytes: string;
  verifiedGiBPerHour: number;
  completedGroups: number;
  failedGroups: number;
  observedHours: number;
  sufficient: boolean;
  reason: 'INSUFFICIENT_SAMPLES' | 'INSUFFICIENT_COMPLETIONS' | 'SUFFICIENT_FOR_COMPARISON';
};
export type PipelineObservationResponse = PipelineObservationHistory & {
  summary: PipelineObservationSummary;
  events: PipelineObservationEvent[];
  eventsTruncated: boolean;
  context: {
    qbittorrent: 'NOT_ATTRIBUTED';
    jellyfin: 'NOT_ATTRIBUTED';
    cgroup: 'API_WITH_CHILDREN';
  };
};

export const PipelineObservationResponseSchema = z.object({
  from: stamp,
  to: stamp,
  resolution: z.enum(['RAW', 'MINUTE']),
  points: z
    .array(
      z.object({
        at: stamp,
        samples: stamp,
        metrics: PipelineMetricsSchema,
        maxima: PipelineMetricsSchema,
        configRevision: stamp.nullable(),
        build,
      }),
    )
    .max(500),
  sampleCount: stamp,
  firstSampleAt: stamp.nullable(),
  lastSampleAt: stamp.nullable(),
  coverage: z.number().min(0).max(1),
  status: z.object({
    state: z.enum(['HEALTHY', 'DEGRADED', 'UNAVAILABLE']),
    storageBytes: stamp,
    maxBytes: stamp,
    queued: stamp,
    dropped: stamp,
    lastSampleAt: stamp.nullable(),
    rawRetentionDays: z.literal(7),
    minuteRetentionDays: z.literal(30),
  }),
  summary: z.object({
    verifiedBytes: z.string().regex(/^\d+$/),
    verifiedGiBPerHour: z.number().finite().nonnegative(),
    completedGroups: stamp,
    failedGroups: stamp,
    observedHours: z.number().nonnegative(),
    sufficient: z.boolean(),
    reason: z.enum([
      'INSUFFICIENT_SAMPLES',
      'INSUFFICIENT_COMPLETIONS',
      'SUFFICIENT_FOR_COMPARISON',
    ]),
  }),
  events: z.array(PipelineObservationEventSchema).max(1000),
  eventsTruncated: z.boolean(),
  context: z.object({
    qbittorrent: z.literal('NOT_ATTRIBUTED'),
    jellyfin: z.literal('NOT_ATTRIBUTED'),
    cgroup: z.literal('API_WITH_CHILDREN'),
  }),
});
