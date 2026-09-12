import { z } from 'zod';

const RemoteAliasSchema = z.string().regex(/^[A-Za-z0-9_-]+:$/);

export const OneDriveProvisionInputSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    mfaCode: z.string().regex(/^[0-9]{6}$/),
  })
  .strict();

export const OneDriveProvisionResponseSchema = z
  .object({
    connectionId: z.string().uuid(),
    connectionRevision: z.number().int().nonnegative(),
    /** An existing legacy binding keeps its historic non-UUID identifier. */
    accountId: z.string().min(1).max(128),
    /** Legacy credential rematerialization never invents an encryption profile. */
    profileId: z.string().uuid().nullable(),
    rawRemote: RemoteAliasSchema,
    cryptRemote: RemoteAliasSchema,
    provisionState: z.literal('READY'),
  })
  .strict();

export const OneDriveLegacyTakeoverInputSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    mfaCode: z.string().regex(/^[0-9]{6}$/),
    accountId: z.string().min(1).max(128),
    accountRevision: z.number().int().nonnegative(),
    rawRemote: RemoteAliasSchema,
    cryptRemote: RemoteAliasSchema,
    /** Prevents a generic reconnect click from silently adopting a legacy alias. */
    confirmTakeover: z.literal(true),
  })
  .strict();

export const OneDriveLegacyTakeoverResponseSchema = z
  .object({
    connectionId: z.string().uuid(),
    connectionRevision: z.number().int().nonnegative(),
    accountId: z.string().min(1).max(128),
    accountRevision: z.number().int().nonnegative(),
  })
  .strict();

export const BaiduConnectionBrowseQuerySchema = z
  .object({
    path: z.string().min(1).max(4096).default('/'),
    start: z.coerce.number().int().min(0).max(1_000_000).default(0),
    limit: z.coerce.number().int().min(1).max(1000).default(200),
  })
  .strict();

export const BaiduConnectionBrowseEntrySchema = z
  .object({
    fsid: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
    name: z.string().min(1).max(1024),
    path: z.string().min(1).max(4096),
    isDirectory: z.boolean(),
    size: z.string().regex(/^(?:0|[1-9][0-9]{0,29})$/),
    mtime: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
  })
  .strict();

export const BaiduConnectionBrowseResponseSchema = z
  .object({
    connectionId: z.string().uuid(),
    path: z.string().min(1).max(4096),
    entries: z.array(BaiduConnectionBrowseEntrySchema).max(1000),
    nextStart: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const BAIDU_NAME_SEARCH_MAX_PAGE = 100;
export const BAIDU_NAME_SEARCH_MAX_PAGE_SIZE = 200;

export const BaiduConnectionSearchQuerySchema = z
  .object({
    path: z.string().min(1).max(4096).default('/'),
    query: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .refine((value) =>
        Array.from(value).every(
          (character) => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f,
        ),
      ),
    page: z.coerce.number().int().min(1).max(BAIDU_NAME_SEARCH_MAX_PAGE).default(1),
    limit: z.coerce.number().int().min(1).max(BAIDU_NAME_SEARCH_MAX_PAGE_SIZE).default(100),
  })
  .strict();

/** Provider-index results, not a claim that every source object was enumerated. */
export const BaiduConnectionSearchResponseSchema = z
  .object({
    connectionId: z.string().uuid(),
    path: z.string().min(1).max(4096),
    query: z.string().min(1).max(256),
    page: z.number().int().min(1).max(BAIDU_NAME_SEARCH_MAX_PAGE),
    limit: z.number().int().min(1).max(BAIDU_NAME_SEARCH_MAX_PAGE_SIZE),
    entries: z.array(BaiduConnectionBrowseEntrySchema).max(BAIDU_NAME_SEARCH_MAX_PAGE_SIZE),
    nextPage: z.number().int().min(2).max(BAIDU_NAME_SEARCH_MAX_PAGE).nullable(),
    limitReached: z.boolean(),
  })
  .strict()
  .refine(
    (value) =>
      value.entries.length <= value.limit &&
      (value.nextPage === null || (value.nextPage === value.page + 1 && !value.limitReached)) &&
      (!value.limitReached ||
        (value.page === BAIDU_NAME_SEARCH_MAX_PAGE && value.nextPage === null)),
  );

export type OneDriveProvisionInput = z.infer<typeof OneDriveProvisionInputSchema>;
export type OneDriveProvisionResponse = z.infer<typeof OneDriveProvisionResponseSchema>;
export type OneDriveLegacyTakeoverInput = z.infer<typeof OneDriveLegacyTakeoverInputSchema>;
export type OneDriveLegacyTakeoverResponse = z.infer<typeof OneDriveLegacyTakeoverResponseSchema>;
export type BaiduConnectionBrowseEntry = z.infer<typeof BaiduConnectionBrowseEntrySchema>;
export type BaiduConnectionBrowseResponse = z.infer<typeof BaiduConnectionBrowseResponseSchema>;
export type BaiduConnectionSearchQuery = z.infer<typeof BaiduConnectionSearchQuerySchema>;
export type BaiduConnectionSearchResponse = z.infer<typeof BaiduConnectionSearchResponseSchema>;
