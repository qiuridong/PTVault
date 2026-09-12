import type { ImportAction, PublicationState } from '@ptvault/contracts';

import type { Clock } from '../core/clock.js';
import type { AppDatabase } from '../db/database.js';
import { ImportControlError } from './errors.js';

type PublicationAuthorityRow = {
  publicationId: string;
  jobId: string;
  jobState: string;
  pauseRequestedAt: number | null;
  cancelRequestedAt: number | null;
  objectCount: number;
  publicationPolicy: string;
  sourceCleanupRequiresPublication: number;
  publicationState: PublicationState;
  libraryId: string;
  receiptJson: string;
  executionOwnerToken: string | null;
  executionLeaseExpiresAt: number | null;
};

type ArchiveObjectRow = {
  localSha256: string | null;
  stagingSha256: string | null;
  committedSha256: string | null;
  destinationAccountId: string | null;
  committedKey: string | null;
  commitState: string | null;
};

const AUTHORITY_SELECT = `
  SELECT publication.id AS publicationId, job.id AS jobId,
         job.state AS jobState, job.pause_requested_at AS pauseRequestedAt,
         job.cancel_requested_at AS cancelRequestedAt,
         job.object_count AS objectCount,
         job.publication_policy AS publicationPolicy,
         job.source_cleanup_requires_publication AS sourceCleanupRequiresPublication,
         publication.state AS publicationState,
         publication.library_id AS libraryId,
         publication.receipt_json_sanitized AS receiptJson,
         publication.execution_owner_token AS executionOwnerToken,
         publication.execution_lease_expires_at AS executionLeaseExpiresAt
  FROM import_jobs AS job
  JOIN media_publications AS publication ON publication.job_id = job.id`;

/**
 * Canonical publication mutation authority shared by the import detail
 * projection and the mutation worker. It intentionally derives from durable
 * job, archive, execution-lease and cleanup-reference state rather than from a
 * browser interpretation of publication.state.
 */
export class ImportPublicationActionAuthority {
  constructor(
    private readonly db: AppDatabase,
    private readonly now: Clock = () => new Date(),
    private readonly allowedLibraryIdsSource:
      ReadonlySet<string> | (() => ReadonlySet<string>) | null = null,
  ) {}

  private get allowedLibraryIds(): ReadonlySet<string> | null {
    return typeof this.allowedLibraryIdsSource === 'function'
      ? this.allowedLibraryIdsSource()
      : this.allowedLibraryIdsSource;
  }

  forJob(
    jobId: string,
    deploymentEnabled: boolean,
    allowedLibraryIds: ReadonlySet<string> | null = this.allowedLibraryIds,
  ): ImportAction[] {
    const row = this.db.prepare(`${AUTHORITY_SELECT} WHERE job.id = ?`).get(jobId) as
      PublicationAuthorityRow | undefined;
    if (row === undefined) return [];
    return this.actions(row, deploymentEnabled, allowedLibraryIds);
  }

  require(publicationId: string, action: 'REPUBLISH' | 'UNPUBLISH'): void {
    const row = this.db
      .prepare(`${AUTHORITY_SELECT} WHERE publication.id = ?`)
      .get(publicationId) as PublicationAuthorityRow | undefined;
    if (row === undefined) throw new ImportControlError('IMPORT_PUBLICATION_NOT_FOUND', 404);
    if (!this.actions(row, true, this.allowedLibraryIds).includes(action)) {
      throw new ImportControlError('IMPORT_PUBLICATION_ACTION_CONFLICT', 409);
    }
  }

  requireWhileExecuting(
    publicationId: string,
    action: 'REPUBLISH' | 'UNPUBLISH',
    executionOwnerToken: string,
  ): void {
    const row = this.db
      .prepare(`${AUTHORITY_SELECT} WHERE publication.id = ?`)
      .get(publicationId) as PublicationAuthorityRow | undefined;
    if (row === undefined) throw new ImportControlError('IMPORT_PUBLICATION_NOT_FOUND', 404);
    const now = this.now().getTime();
    if (
      row.executionOwnerToken !== executionOwnerToken ||
      row.executionLeaseExpiresAt === null ||
      row.executionLeaseExpiresAt <= now ||
      !this.actions(row, true, this.allowedLibraryIds, executionOwnerToken).includes(action)
    ) {
      throw new ImportControlError('IMPORT_PUBLICATION_ACTION_CONFLICT', 409);
    }
  }

  private actions(
    row: PublicationAuthorityRow,
    deploymentEnabled: boolean,
    allowedLibraryIds: ReadonlySet<string> | null,
    ignoredExecutionOwnerToken: string | null = null,
  ): ImportAction[] {
    if (
      !deploymentEnabled ||
      row.jobState !== 'COMPLETED' ||
      row.publicationPolicy !== 'PUBLISH_TO_JELLYFIN' ||
      (allowedLibraryIds !== null && !allowedLibraryIds.has(row.libraryId)) ||
      row.pauseRequestedAt !== null ||
      row.cancelRequestedAt !== null ||
      (row.executionOwnerToken !== null &&
        row.executionOwnerToken !== ignoredExecutionOwnerToken &&
        row.executionLeaseExpiresAt !== null &&
        row.executionLeaseExpiresAt > this.now().getTime())
    ) {
      return [];
    }

    const projectionRemoval =
      (row.publicationState === 'FAILED_SAFE' || row.publicationState === 'RUNNING') &&
      this.isProjectionRemoval(row);
    const actions: ImportAction[] = [];
    if (
      (row.publicationState === 'FAILED_SAFE' || row.publicationState === 'RUNNING') &&
      !projectionRemoval &&
      this.archiveVerified(row.jobId, row.objectCount)
    ) {
      actions.push('REPUBLISH');
    }
    if (
      (row.publicationState === 'PUBLISHED' ||
        row.publicationState === 'FAILED_SAFE' ||
        row.publicationState === 'RUNNING') &&
      !this.hasActiveRequiredCleanup(row)
    ) {
      actions.push('UNPUBLISH');
    }
    return actions;
  }

  private archiveVerified(jobId: string, expectedObjectCount: number): boolean {
    if (expectedObjectCount <= 0) return false;
    const objects = this.db
      .prepare(
        `SELECT object.local_sha256 AS localSha256,
                object.staging_sha256 AS stagingSha256,
                object.committed_sha256 AS committedSha256,
                destination_commit.destination_account_id AS destinationAccountId,
                destination_commit.committed_key AS committedKey,
                destination_commit.commit_state AS commitState
         FROM import_objects AS object
         LEFT JOIN destination_commits AS destination_commit
           ON destination_commit.job_id = object.job_id
          AND destination_commit.object_id = object.id
          AND destination_commit.destination_account_id = object.destination_account_id
         WHERE object.job_id = ?`,
      )
      .all(jobId) as ArchiveObjectRow[];
    const accountIds = new Set(objects.map((object) => object.destinationAccountId));
    return (
      objects.length === expectedObjectCount &&
      objects.length > 0 &&
      accountIds.size === 1 &&
      !accountIds.has(null) &&
      objects.every(
        (object) =>
          object.commitState === 'COMMITTED_VERIFIED' &&
          object.committedKey !== null &&
          object.localSha256 !== null &&
          object.stagingSha256 === object.localSha256 &&
          object.committedSha256 === object.localSha256,
      )
    );
  }

  private isProjectionRemoval(row: PublicationAuthorityRow): boolean {
    try {
      const receipt = JSON.parse(row.receiptJson) as {
        projectionRemovalStarted?: unknown;
        projectionRemovalFailedSafe?: unknown;
      };
      if (
        receipt.projectionRemovalStarted === true ||
        receipt.projectionRemovalFailedSafe === true
      ) {
        return true;
      }
    } catch {
      return true;
    }
    const statuses = this.db
      .prepare('SELECT status FROM import_publication_objects WHERE publication_id = ?')
      .pluck()
      .all(row.publicationId) as string[];
    return statuses.length > 0 && statuses.every((status) => status === 'UNPUBLISHED');
  }

  private hasActiveRequiredCleanup(row: PublicationAuthorityRow): boolean {
    if (row.sourceCleanupRequiresPublication !== 1) return false;
    return (
      this.db
        .prepare(
          `SELECT 1 FROM source_cleanups
           WHERE job_id = ? AND status <> 'COMPLETED' LIMIT 1`,
        )
        .get(row.jobId) !== undefined
    );
  }
}
