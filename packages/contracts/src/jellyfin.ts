import { z } from 'zod';

/** Stable failures a settings page can turn into an operator action. */
export const JellyfinConnectionErrorSchema = z.enum([
  'NOT_CONFIGURED',
  'AUTH_FAILED',
  'UNREACHABLE',
  'BAD_RESPONSE',
  'NOTIFICATION_REJECTED',
]);

export const JellyfinLibraryLocationSchema = z.object({
  path: z.string().min(1).max(4096),
  /** Which PTVault tree the configured path map resolves this location into. */
  kind: z.enum(['LOCAL', 'CLOUD', 'OTHER']),
});

export const JellyfinLibrarySchema = z.object({
  name: z.string().min(1).max(256),
  collectionType: z.string().min(1).max(64).nullable(),
  locations: z.array(JellyfinLibraryLocationSchema).max(256),
  hasLocal: z.boolean(),
  hasCloud: z.boolean(),
  /** Every configured local subtree has a matching cloud subtree; not playback evidence. */
  covered: z.boolean(),
  /** Configuration-only diagnosis; neither indexing nor playback is verified here. */
  typeConflicts: z
    .array(
      z.object({
        libraryName: z.string().min(1).max(256),
        collectionType: z.string().min(1).max(64).nullable(),
        path: z.string().min(1).max(4096),
        otherPath: z.string().min(1).max(4096),
      }),
    )
    .optional(),
});

/** Current read-only configuration plus the last live library reading. */
export const JellyfinInfoSchema = z.object({
  configured: z.boolean(),
  baseUrl: z.string().url().nullable(),
  /** Path to the credential file, never the credential stored in it. */
  tokenFile: z.string().min(1).nullable(),
  pathMaps: z.array(z.string().min(3).max(8192)),
  libraries: z.array(JellyfinLibrarySchema).max(512),
  checkedAt: z.number().int().nonnegative().nullable(),
  error: JellyfinConnectionErrorSchema.exclude(['NOT_CONFIGURED']).nullable(),
});

export const JellyfinTestResultSchema = z.object({
  ok: z.boolean(),
  serverName: z.string().min(1).max(128).nullable(),
  version: z.string().min(1).max(64).nullable(),
  notificationAccepted: z.boolean(),
  error: JellyfinConnectionErrorSchema.nullable(),
});

export type JellyfinConnectionError = z.infer<typeof JellyfinConnectionErrorSchema>;
export type JellyfinLibraryLocation = z.infer<typeof JellyfinLibraryLocationSchema>;
export type JellyfinLibrary = z.infer<typeof JellyfinLibrarySchema>;
export type JellyfinInfo = z.infer<typeof JellyfinInfoSchema>;
export type JellyfinTestResult = z.infer<typeof JellyfinTestResultSchema>;
