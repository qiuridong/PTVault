import { z } from 'zod';
const concurrency = z.number().int().min(1).max(8);
const bytes = z.string().regex(/^(0|[1-9]\d{0,29})$/);
const fields = z
  .object({
    maxResidentGroups: concurrency,
    downloadConcurrency: concurrency,
    /** Missing in pre-customization settings; does not change group concurrency. */
    fileDownloadConnections: z.number().int().min(1).max(16).default(5),
    extractionConcurrency: concurrency,
    uploadConcurrency: concurrency,
    /** Null uses min(64 GiB, one quarter of the global usable spool budget). */
    waitingCacheMaxBytes: bytes.nullable(),
  })
  .strict();
export const GroupSettingsValuesSchema = fields.refine((x) =>
  [x.downloadConcurrency, x.extractionConcurrency, x.uploadConcurrency].every(
    (n) => n <= x.maxResidentGroups,
  ),
);
export const GroupSettingsPatchSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    mfaCode: z.string().regex(/^\d{6}$/),
    settings: fields.partial().refine((x) => Object.keys(x).length > 0),
  })
  .strict();
const resource = z.object({
  active: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  capacity: concurrency,
});
export const GroupSettingsStatusSchema = z.object({
  revision: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  provisioned: z.boolean(),
  configured: GroupSettingsValuesSchema,
  effective: fields.extend({ waitingCacheMaxBytes: bytes }),
  residentBudgetBytes: bytes,
  resources: z.object({
    inFlight: resource,
    download: resource,
    extraction: resource,
    upload: resource,
  }),
});
export type GroupSettingsValues = z.infer<typeof GroupSettingsValuesSchema>;
export type GroupSettingsPatch = z.infer<typeof GroupSettingsPatchSchema>;
export type GroupSettingsStatus = z.infer<typeof GroupSettingsStatusSchema>;
