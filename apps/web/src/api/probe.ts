import type { ZodType } from 'zod';

import { ApiError, apiGet } from './client.js';

/**
 * A reading, or the statement that this API cannot take it.
 *
 * The browser bundle and the API deploy down separate paths, so a bundle that
 * knows about an endpoint routinely meets an API that does not have it yet. That
 * is a different sentence from "the reading came back empty", and the two must
 * not share a rendering: one means go deploy the API, the other means the thing
 * genuinely has nothing to report.
 *
 * Lives here rather than in one feature because three surfaces now need it —
 * settings, imports, and whatever lands next. A second copy of this distinction
 * is a copy that eventually stops matching, and the failure mode is a page that
 * quietly renders "0" where it should say "not reported".
 */
export type Probe<T> = { supported: true; data: T } | { supported: false };

/**
 * GET a path, treating 404 as "this API version has no such route".
 *
 * Only 404 is folded into `supported: false`. A 401, a 403 or a 5xx still throws:
 * an expired session, a read-only demo and a broken endpoint each want their own
 * sentence on screen, and swallowing them into "not supported" would send an
 * operator to redeploy an API that was working.
 */
export async function probeGet<T>(path: string, schema: ZodType<T>): Promise<Probe<T>> {
  try {
    return { supported: true, data: await apiGet(path, schema) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { supported: false };
    throw error;
  }
}
