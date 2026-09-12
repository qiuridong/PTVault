import { z } from 'zod';

export const StorageHealthSchema = z.enum([
  'HEALTHY',
  'DEGRADED',
  'THROTTLED',
  'AUTH_REQUIRED',
  'OFFLINE',
]);

/** rclone remote alias, e.g. `onedrive-a:` — never a token or path. */
export const RemoteAliasSchema = z.string().regex(/^[A-Za-z0-9_-]+:$/);

/** Stable opaque legacy identity; never trim/rewrite an existing id into a UUID. */
export const StorageAccountIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) => value.trim().length > 0 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value),
    'Invalid storage account identity',
  );

export const StorageAccountSchema = z.object({
  id: StorageAccountIdSchema,
  label: z.string().min(1).max(64),
  rawRemote: RemoteAliasSchema,
  cryptRemote: RemoteAliasSchema,
  health: StorageHealthSchema,
  totalBytes: z.number().int().nonnegative().nullable(),
  freeBytes: z.number().int().nonnegative().nullable(),
  reserveBytes: z.number().int().nonnegative(),
  circuitOpenUntil: z.number().int().nullable(),
  lastCheckedAt: z.number().int().nullable(),
  /** Optimistic-concurrency authority for account-scoped mutations such as takeover. */
  revision: z.number().int().nonnegative(),
});

export type StorageHealth = z.infer<typeof StorageHealthSchema>;
export type StorageAccount = z.infer<typeof StorageAccountSchema>;
