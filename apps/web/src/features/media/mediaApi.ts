import {
  MediaCatalogEntrySchema,
  MountHealthListSchema,
  RehydrateSnapshotSchema,
  type MediaCatalogEntry,
  type MountHealth,
  type RehydrateSnapshot,
  DisksResponseSchema,
  type DisksResponse,
} from '@ptvault/contracts';
import { z } from 'zod';

import { apiGet, apiMutation } from '../../api/client.js';

const CatalogResponseSchema = z.object({
  entries: z.array(MediaCatalogEntrySchema),
});

const RehydratesResponseSchema = z.object({
  rehydrates: z.array(RehydrateSnapshotSchema),
});

/**
 * What a restore would cost.
 *
 * `wouldBreachReserve` is separate from `admissible` on purpose: a restore can fit
 * in free space while still eating into the protected 15%, and the operator should
 * see that distinction rather than only a yes/no.
 */
export const RehydratePreviewSchema = z.object({
  requestedBytes: z.number().int().nonnegative(),
  freeBytes: z.number().int().nonnegative(),
  reserveBytes: z.number().int().nonnegative(),
  outstandingReservedBytes: z.number().int().nonnegative(),
  availableBytes: z.number().int().nonnegative(),
  freeBytesAfter: z.number().int().nonnegative(),
  admissible: z.boolean(),
  missingBytes: z.number().int().nonnegative(),
  wouldBreachReserve: z.boolean(),
});

const PinResponseSchema = z.object({
  pinned: z.array(z.string()),
});

const CancelResponseSchema = z.object({
  jobId: z.string(),
  cancelled: z.literal(true),
  localPreserved: z.literal(true),
});

const RetryResponseSchema = z.object({
  jobId: z.string().uuid(),
  requeued: z.literal(true),
  resumingFrom: z.string().min(1),
});

export type RehydratePreview = z.infer<typeof RehydratePreviewSchema>;

export const mediaCatalogQueryKey = ['media', 'catalog'] as const;
export const mediaHealthQueryKey = ['media', 'health'] as const;
export const mediaRehydratesQueryKey = ['media', 'rehydrates'] as const;
export const mediaDisksQueryKey = ['media', 'disks'] as const;

export function mediaPreviewQueryKey(bytes: number) {
  return ['media', 'preview', bytes] as const;
}

export async function getMediaCatalog(): Promise<MediaCatalogEntry[]> {
  return (await apiGet('/api/media', CatalogResponseSchema)).entries;
}

/**
 * Health of every supervised mount — one per storage account.
 *
 * A list, because an account being down means *its* titles are temporarily
 * unplayable, never that the library is gone. An empty list means no storage
 * account is registered yet.
 */
export async function getDisks(): Promise<DisksResponse> {
  return apiGet('/api/media/disks', DisksResponseSchema);
}

export async function getMountHealth(): Promise<MountHealth[]> {
  return (await apiGet('/api/media/health', MountHealthListSchema)).mounts;
}

export async function getRehydrates(): Promise<RehydrateSnapshot[]> {
  return (await apiGet('/api/media/rehydrates', RehydratesResponseSchema)).rehydrates;
}

export async function getRehydratePreview(bytes: number): Promise<RehydratePreview> {
  return apiGet(
    `/api/media/rehydrate-preview?bytes=${encodeURIComponent(String(bytes))}`,
    RehydratePreviewSchema,
  );
}

export async function setPin(input: {
  logicalPath: string;
  instanceId: string;
  torrentHash: string;
  pinned: boolean;
  mfaCode: string;
}): Promise<string[]> {
  return (await apiMutation('/api/media/pin', input, PinResponseSchema)).pinned;
}

export async function startRehydrate(input: {
  instanceId: string;
  torrentHash: string;
  autoResume: boolean;
  mfaCode: string;
}): Promise<RehydrateSnapshot> {
  return apiMutation('/api/media/rehydrate', input, RehydrateSnapshotSchema);
}

export async function cancelRehydrate(input: {
  jobId: string;
  mfaCode: string;
}): Promise<z.infer<typeof CancelResponseSchema>> {
  return apiMutation('/api/media/rehydrate/cancel', input, CancelResponseSchema);
}

export async function retryRehydrate(input: {
  jobId: string;
  mfaCode: string;
}): Promise<z.infer<typeof RetryResponseSchema>> {
  return apiMutation('/api/media/rehydrate/retry', input, RetryResponseSchema);
}
