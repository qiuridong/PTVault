import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { isManagedBaiduMutationPath } from './baidu-paths.js';

const decimal = z.string().regex(/^(?:0|[1-9][0-9]{0,39})$/);
const ApprovalSchema = z
  .object({
    connectionId: z.string().uuid(),
    externalAccountId: decimal,
    fsid: decimal,
    path: z.string().max(4096).refine(isManagedBaiduMutationPath),
    size: decimal,
    mtime: decimal,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();
export type SourceDeleteApproval = z.infer<typeof ApprovalSchema>;
export type SourceDeleteObject = Omit<SourceDeleteApproval, 'issuedAt' | 'expiresAt' | 'sha256'> & {
  sha256?: string;
};
function active(grant: SourceDeleteApproval, now: number): boolean {
  return (
    Number.isFinite(now) &&
    grant.issuedAt <= now &&
    now < grant.expiresAt &&
    grant.expiresAt - grant.issuedAt <= 6 * 3600000
  );
}

/** Operator-owned, non-cached, fail-closed authority. Never changes account capabilities. */
export function readSourceDeleteApprovals(
  filename: string | null,
  now: number,
): SourceDeleteApproval[] {
  if (filename === null) return [];
  let fd: number | undefined;
  try {
    fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 65536 ||
      (process.platform !== 'win32' && (stat.mode & 0o022) !== 0)
    )
      return [];
    const parsed = z
      .array(ApprovalSchema)
      .max(16)
      .safeParse(JSON.parse(readFileSync(fd, 'utf8')) as unknown);
    return parsed.success ? parsed.data.filter((grant) => active(grant, now)) : [];
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function matchesSourceDeleteApproval(
  grants: readonly SourceDeleteApproval[],
  object: SourceDeleteObject,
  now: number,
): boolean {
  return grants.some(
    (grant) =>
      ApprovalSchema.safeParse(grant).success &&
      active(grant, now) &&
      grant.connectionId === object.connectionId &&
      grant.externalAccountId === object.externalAccountId &&
      grant.fsid === object.fsid &&
      grant.path === object.path &&
      grant.size === object.size &&
      grant.mtime === object.mtime &&
      (object.sha256 === undefined || grant.sha256 === object.sha256),
  );
}
