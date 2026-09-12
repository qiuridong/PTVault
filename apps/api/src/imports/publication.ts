import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { importLibraryAcceptsMediaType } from '@ptvault/contracts';

import type {
  ImportMediaType,
  ImportPublication,
  ImportPublicationError,
  JellyfinImportLibrary,
  MediaPublicationRequest,
} from '@ptvault/contracts';

import type { Clock } from '../core/clock.js';
import type { AppDatabase } from '../db/database.js';
import type { FarmPlanEntry } from '../media/symlink-farm.js';
import { ImportControlError, importInvariant } from './errors.js';
import { ImportPublicationActionAuthority } from './publication-actions.js';
import type { ImportLibraryCatalog } from '../jellyfin/import-libraries.js';

export type ImportPublicationFarm = {
  syncImports?: (plan: () => readonly FarmPlanEntry[]) => Promise<unknown>;
  sync: (plan: readonly FarmPlanEntry[]) => Promise<unknown>;
};

export type ImportPublicationJellyfinInput = {
  library: JellyfinImportLibrary;
  linkRelativePaths: string[];
  publicationRevision: number;
};

export type ImportPublicationJellyfin = {
  publish: (input: ImportPublicationJellyfinInput) => Promise<void>;
  unpublish: (input: ImportPublicationJellyfinInput) => Promise<void>;
};

export type ImportPublicationServiceOptions = {
  db: AppDatabase;
  libraries: readonly JellyfinImportLibrary[];
  libraryCatalog?: ImportLibraryCatalog;
  farm: ImportPublicationFarm;
  /** Existing torrent-backed entries. Import links are appended to this plan. */
  baseFarmPlan: () => readonly FarmPlanEntry[];
  isMountable: (accountId: string) => boolean | Promise<boolean>;
  /** Refreshes only the actual destination account and committed object paths. */
  refreshVfs: (accountId: string, cloudLogicalPaths: string[]) => Promise<void>;
  /** Opens/stats a link through the farm against the verified manifest size. */
  probeLink: (linkRelativePath: string, expectedSize: string) => Promise<void>;
  jellyfin: ImportPublicationJellyfin;
  now?: Clock;
  executionLeaseMs?: number;
  executionHeartbeatMs?: number;
  /** Injectable wait for the supervised mount's bounded restart recovery. */
  waitForMountRecovery?: (milliseconds: number) => Promise<void>;
};

type PublicationRow = {
  id: string;
  jobId: string;
  state: ImportPublication['state'];
  mediaType: ImportPublication['mediaType'];
  libraryId: string;
  libraryKey: string | null;
  libraryDisplayName: string;
  containerPath: string;
  logicalPath: string;
  mountAccountId: string | null;
  mountAccountLabel: string | null;
  readProbe: ImportPublication['readProbe'];
  jellyfinNotified: number | null;
  lastError: ImportPublication['error'];
  revision: number;
  objectCount: number;
  updatedAt: number;
};

type VerifiedObjectRow = {
  objectId: string;
  relativePath: string;
  sourceSize: string;
  localSha256: string | null;
  stagingSha256: string | null;
  committedSha256: string | null;
  accountId: string | null;
  committedKey: string | null;
  commitState: string | null;
  accountLabel: string | null;
};

type PublicationObjectRow = {
  publicationId: string;
  objectId: string;
  accountId: string;
  cloudLogicalPath: string;
  linkRelativePath: string;
  publicationRevision: number;
};

type OperationRow = {
  publicationId: string;
  operation: 'REQUEST' | 'RETRY' | 'UNPUBLISH';
  requestFingerprint: string;
  responseJson: string | null;
};

class PublicationFailure extends Error {
  constructor(readonly code: ImportPublicationError) {
    super(code);
  }
}

const PUBLICATION_SELECT = `
  SELECT publication.id, publication.job_id AS jobId, publication.state,
         publication.media_type AS mediaType, publication.library_id AS libraryId,
         publication.library_key AS libraryKey,
         publication.library_display_name AS libraryDisplayName,
         publication.container_path AS containerPath,
         publication.logical_path AS logicalPath,
         publication.mount_account_id AS mountAccountId,
         publication.mount_account_label AS mountAccountLabel,
         publication.read_probe AS readProbe,
         publication.jellyfin_notified AS jellyfinNotified,
         publication.last_error AS lastError,
         publication.publication_revision AS revision,
         publication.object_count AS objectCount,
         publication.updated_at AS updatedAt
  FROM media_publications AS publication`;

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeRelative(value: string, code: ImportPublicationError): string {
  if (
    value.length === 0 ||
    value.length > 4096 ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new PublicationFailure(code);
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new PublicationFailure(code);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized.startsWith('../')) throw new PublicationFailure(code);
  return normalized;
}

function publicationPath(libraryKey: string, logicalPath: string, relativePath: string): string {
  const library = normalizeRelative(libraryKey, 'PUBLICATION_PATH_CONFLICT');
  const logical = normalizeRelative(logicalPath, 'PUBLICATION_PATH_CONFLICT');
  const relative = normalizeRelative(relativePath, 'PUBLICATION_PATH_CONFLICT');
  return normalizeRelative(
    path.posix.join(library, logical, relative),
    'PUBLICATION_PATH_CONFLICT',
  );
}

function operationResponse<T>(row: OperationRow | undefined): T | null {
  if (row?.responseJson === null || row?.responseJson === undefined) return null;
  try {
    return JSON.parse(row.responseJson) as T;
  } catch {
    throw new ImportControlError('IMPORT_PUBLICATION_RECEIPT_CORRUPT', 500);
  }
}

/**
 * Independent publication catalog and worker.
 *
 * This class never mutates import_jobs, import_objects, destination_commits or
 * recovery receipts.  Its only writable authority is the publication catalog,
 * its per-object projection journal and its idempotency receipts.
 */
export class ImportPublicationService {
  private readonly db: AppDatabase;
  private readonly staticLibraries: readonly JellyfinImportLibrary[];
  private readonly libraryCatalog: ImportLibraryCatalog | undefined;
  private readonly farm: ImportPublicationFarm;
  private readonly baseFarmPlan: () => readonly FarmPlanEntry[];
  private readonly isMountable: ImportPublicationServiceOptions['isMountable'];
  private readonly refreshVfs: ImportPublicationServiceOptions['refreshVfs'];
  private readonly probeLink: ImportPublicationServiceOptions['probeLink'];
  private readonly jellyfin: ImportPublicationJellyfin;
  private readonly now: Clock;
  private readonly executionLeaseMs: number;
  private readonly executionHeartbeatMs: number;
  private readonly actionAuthority: ImportPublicationActionAuthority;
  private readonly waitForMountRecovery: (milliseconds: number) => Promise<void>;

  constructor(options: ImportPublicationServiceOptions) {
    this.db = options.db;
    this.staticLibraries = options.libraries;
    this.libraryCatalog = options.libraryCatalog;
    this.farm = options.farm;
    this.baseFarmPlan = options.baseFarmPlan;
    this.isMountable = options.isMountable;
    this.refreshVfs = options.refreshVfs;
    this.probeLink = options.probeLink;
    this.jellyfin = options.jellyfin;
    this.now = options.now ?? (() => new Date());
    this.waitForMountRecovery =
      options.waitForMountRecovery ?? ((milliseconds) => delay(milliseconds));
    this.executionLeaseMs = options.executionLeaseMs ?? 5 * 60_000;
    this.executionHeartbeatMs =
      options.executionHeartbeatMs ?? Math.max(1, Math.floor(this.executionLeaseMs / 3));
    this.actionAuthority = new ImportPublicationActionAuthority(
      options.db,
      this.now,
      () => new Set(this.libraries.keys()),
    );
    if (
      !Number.isFinite(this.executionLeaseMs) ||
      !Number.isFinite(this.executionHeartbeatMs) ||
      this.executionLeaseMs <= 1 ||
      this.executionHeartbeatMs <= 0 ||
      this.executionHeartbeatMs >= this.executionLeaseMs
    ) {
      throw new Error('INVALID_IMPORT_PUBLICATION_EXECUTION_TIMING');
    }
  }

  private get libraries(): Map<string, JellyfinImportLibrary> {
    return new Map(
      (this.libraryCatalog?.list() ?? this.staticLibraries)
        .filter((library) => library.unavailableReason == null)
        .map((library) => [library.libraryId, library]),
    );
  }

  get(publicationId: string): ImportPublication {
    return this.mapPublication(this.requireRow(publicationId));
  }

  /** Runs one pending/failed catalog revision synchronously and durably. */
  async run(publicationId: string): Promise<ImportPublication> {
    await this.libraryCatalog?.refresh();
    const current = this.requireRow(publicationId);
    if (current.state === 'PUBLISHED') return this.mapPublication(current);
    if (current.state === 'UNPUBLISHED') {
      throw new ImportControlError('IMPORT_PUBLICATION_ACTION_CONFLICT', 409);
    }

    return this.withExecutionLease(publicationId, async (ownerToken, assertLease) => {
      const revision = this.beginAttempt(publicationId, ownerToken);
      let stage: 'ARCHIVE' | 'MOUNT' | 'VFS' | 'FARM' | 'PROBE' | 'JELLYFIN' = 'ARCHIVE';
      try {
        const publication = this.requireRow(publicationId);
        const library = this.requireLibrary(publication);
        const objects = this.verifiedObjects(publication);
        this.replaceAttemptObjects(publication, revision, objects, ownerToken);
        const accountId = objects[0]!.accountId!;
        const accountLabel = objects[0]!.accountLabel!;

        const cloudLogicalPaths = objects.map((object) => object.committedKey!);
        stage = 'VFS';
        await this.prepareMount(accountId, cloudLogicalPaths, assertLease);
        assertLease();

        stage = 'FARM';
        try {
          await this.syncFarm();
        } catch (error) {
          if (error instanceof PublicationFailure) throw error;
          throw new PublicationFailure('FARM_LINK_FAILED');
        }
        assertLease();
        this.markLinked(publicationId, revision, ownerToken);

        const publicationObjects = this.objectRows(publicationId, revision);
        const verifiedById = new Map(objects.map((object) => [object.objectId, object]));
        const linkRelativePaths = publicationObjects.map((object) => object.linkRelativePath);
        stage = 'PROBE';
        try {
          for (const object of publicationObjects) {
            const verified = verifiedById.get(object.objectId);
            if (verified === undefined) {
              throw new PublicationFailure('ARCHIVE_NOT_VERIFIED');
            }
            await this.probeLink(object.linkRelativePath, verified.sourceSize);
            assertLease();
          }
        } catch (error) {
          if (
            error instanceof ImportControlError &&
            error.code === 'IMPORT_PUBLICATION_EXECUTION_LEASE_LOST'
          ) {
            throw error;
          }
          throw new PublicationFailure('READ_PROBE_FAILED');
        }
        this.markProbed(publicationId, revision, ownerToken);

        stage = 'JELLYFIN';
        try {
          await this.jellyfin.publish({
            library,
            linkRelativePaths,
            publicationRevision: revision,
          });
        } catch (error) {
          if (error instanceof PublicationFailure) throw error;
          throw new PublicationFailure(this.jellyfinFailureCode(error));
        }
        assertLease();
        this.complete(publicationId, revision, accountId, accountLabel, ownerToken);
        return this.get(publicationId);
      } catch (error) {
        assertLease();
        if (
          error instanceof ImportControlError &&
          error.code === 'IMPORT_PUBLICATION_EXECUTION_LEASE_LOST'
        ) {
          throw error;
        }
        const code =
          error instanceof PublicationFailure ? error.code : this.failureCodeForStage(stage);
        this.fail(publicationId, revision, code, ownerToken);
        // Excluding FAILED_SAFE rows from the combined plan removes any projection
        // that was created before a later probe/notification failed. The cleanup is
        // best-effort; the durable failed state makes a retry reconcile it again.
        try {
          await this.syncFarm();
        } catch {
          // The stable catalog failure is the operator-visible authority.
        }
        assertLease();
        return this.get(publicationId);
      }
    });
  }

  private async prepareMount(
    accountId: string,
    cloudLogicalPaths: string[],
    assertLease: () => void,
  ): Promise<void> {
    // A long import can rotate the managed credential while its idle read-only
    // mount still holds the previous generation. Its first cloud read fences the
    // old process; systemd then restarts it with the current credential. Preserve
    // that fence and wait through the observed ~14-second restart, rather than
    // turning the brief handover into a permanent failed publication.
    // Only readiness/cache refresh is retried: no transfers, links, read-proof
    // shortcuts, or Jellyfin notifications are repeated here.
    for (let attempt = 0; ; attempt += 1) {
      assertLease();
      let failure = new PublicationFailure('DESTINATION_UNMOUNTABLE');
      let mountable = false;
      try {
        mountable = await this.isMountable(accountId);
      } catch {
        // A disconnected FUSE/RC probe is also a transient readiness failure.
      }
      assertLease();
      if (mountable) {
        let refreshed = false;
        try {
          await this.refreshVfs(accountId, cloudLogicalPaths);
          refreshed = true;
        } catch {
          failure = new PublicationFailure('VFS_REFRESH_FAILED');
        }
        assertLease();
        if (refreshed) return;
      }
      if (attempt === 2) throw failure;
      await this.waitForMountRecovery(10_000);
    }
  }

  async runForJob(jobId: string): Promise<ImportPublication | null> {
    const id = this.db
      .prepare(
        `SELECT id FROM media_publications
         WHERE job_id = ? AND state IN ('PENDING', 'RUNNING', 'FAILED_SAFE')`,
      )
      .pluck()
      .get(jobId) as string | undefined;
    return id === undefined ? null : this.run(id);
  }

  async request(
    request: MediaPublicationRequest,
    idempotencyKey: string,
  ): Promise<ImportPublication> {
    await this.libraryCatalog?.refresh();
    const library = this.libraries.get(request.publication.libraryId);
    if (library === undefined) throw new ImportControlError('IMPORT_LIBRARY_NOT_ALLOWLISTED', 409);
    this.assertMediaType(request.publication.mediaType, library);
    normalizeRelative(request.publication.logicalPath, 'PUBLICATION_PATH_CONFLICT');

    const publicationId = this.prepareRequestedPublication(request, library, idempotencyKey);
    const replay = this.replayOperation<ImportPublication>(
      publicationId,
      'REQUEST',
      idempotencyKey,
      request,
    );
    if (replay !== null) return replay;
    const response = await this.run(publicationId);
    this.completeOperation(publicationId, 'REQUEST', idempotencyKey, request, response);
    return response;
  }

  async retry(publicationId: string, idempotencyKey: string): Promise<ImportPublication> {
    await this.libraryCatalog?.refresh();
    const intent = { publicationId };
    const replay = this.beginOperation<ImportPublication>(
      publicationId,
      'RETRY',
      idempotencyKey,
      intent,
      () => this.actionAuthority.require(publicationId, 'REPUBLISH'),
    );
    if (replay !== null) return replay;
    const current = this.requireRow(publicationId);
    const response =
      current.state === 'PUBLISHED' ? this.mapPublication(current) : await this.run(publicationId);
    this.completeOperation(publicationId, 'RETRY', idempotencyKey, intent, response);
    return response;
  }

  async unpublish(
    publicationId: string,
    idempotencyKey: string,
  ): Promise<{ publicationId: string; state: 'UNPUBLISHED'; cloudObjectsDeleted: false }> {
    await this.libraryCatalog?.refresh();
    const intent = { publicationId };
    const replay = this.beginOperation<{
      publicationId: string;
      state: 'UNPUBLISHED';
      cloudObjectsDeleted: false;
    }>(publicationId, 'UNPUBLISH', idempotencyKey, intent, () =>
      this.actionAuthority.require(publicationId, 'UNPUBLISH'),
    );
    if (replay !== null) return replay;

    const response = await this.withExecutionLease(
      publicationId,
      async (ownerToken, assertLease) => {
        const before = this.requireRow(publicationId);
        if (before.state === 'UNPUBLISHED') {
          return {
            publicationId,
            state: 'UNPUBLISHED' as const,
            cloudObjectsDeleted: false as const,
          };
        }
        const library = this.requireLibrary(before);
        const rows = this.allObjectRows(publicationId);
        const linkRelativePaths = [...new Set(rows.map((row) => row.linkRelativePath))].sort();
        const timestamp = this.now().getTime();
        this.withExecutionFence(publicationId, ownerToken, () => {
          this.actionAuthority.requireWhileExecuting(publicationId, 'UNPUBLISH', ownerToken);
          this.db
            .prepare(
              `UPDATE import_publication_objects
               SET status = 'UNPUBLISHED', updated_at = ? WHERE publication_id = ?`,
            )
            .run(timestamp, publicationId);
          this.db
            .prepare(
              `UPDATE media_publications
               SET state = 'RUNNING', last_error = NULL,
                   receipt_json_sanitized = ?, updated_at = ? WHERE id = ?`,
            )
            .run(
              JSON.stringify({
                revision: before.revision,
                projectionRemovalStarted: true,
                cloudObjectsDeleted: false,
              }),
              timestamp,
              publicationId,
            );
        });

        // The combined farm plan still contains all torrent publications and every
        // other live import publication. Only this projection disappeared.
        try {
          await this.syncFarm();
        } catch {
          this.failUnpublish(publicationId, before.revision, 'FARM_LINK_FAILED', ownerToken);
          throw new ImportControlError('FARM_LINK_FAILED', 502);
        }
        assertLease();
        try {
          await this.jellyfin.unpublish({
            library,
            linkRelativePaths,
            publicationRevision: before.revision,
          });
        } catch (error) {
          const code = this.jellyfinFailureCode(error);
          this.failUnpublish(publicationId, before.revision, code, ownerToken);
          throw new ImportControlError(code, 502);
        }
        assertLease();
        const completedAt = this.now().getTime();
        this.withExecutionFence(publicationId, ownerToken, () => {
          this.db
            .prepare(
              `UPDATE media_publications
               SET state = 'UNPUBLISHED', jellyfin_notified = 0, last_error = NULL,
                   receipt_json_sanitized = ?, updated_at = ? WHERE id = ?`,
            )
            .run(
              JSON.stringify({
                revision: before.revision,
                projectionRemoved: true,
                cloudObjectsDeleted: false,
                unpublishedAt: iso(completedAt),
              }),
              completedAt,
              publicationId,
            );
        });
        return {
          publicationId,
          state: 'UNPUBLISHED' as const,
          cloudObjectsDeleted: false as const,
        };
      },
    );
    this.completeOperation(publicationId, 'UNPUBLISH', idempotencyKey, intent, response);
    return response;
  }

  /** Complete farm plan used by periodic reconcile and publication mutations. */
  private syncFarm(): Promise<unknown> {
    return this.farm.syncImports !== undefined
      ? this.farm.syncImports(() => this.buildFarmPlan())
      : this.farm.sync(this.buildFarmPlan());
  }

  /** Complete catalog composition; real filesystem mutations are serialized by the farm. */
  buildFarmPlan(): FarmPlanEntry[] {
    const combined: FarmPlanEntry[] = [...this.baseFarmPlan()];
    const seen = new Set<string>();
    for (const entry of combined) {
      normalizeRelative(entry.linkRelativePath, 'PUBLICATION_PATH_CONFLICT');
      if (seen.has(entry.linkRelativePath))
        throw new PublicationFailure('PUBLICATION_PATH_CONFLICT');
      seen.add(entry.linkRelativePath);
    }
    for (const entry of this.buildPublicationFarmPlan()) {
      if (seen.has(entry.linkRelativePath))
        throw new PublicationFailure('PUBLICATION_PATH_CONFLICT');
      seen.add(entry.linkRelativePath);
      combined.push(entry);
    }
    return combined;
  }

  /** Import-publication projection only, for composition by the media reconciler. */
  buildPublicationFarmPlan(): FarmPlanEntry[] {
    const rows = this.db
      .prepare(
        `SELECT object.publication_id AS publicationId,
                object.object_id AS objectId, object.account_id AS accountId,
                object.cloud_logical_path AS cloudLogicalPath,
                object.link_relative_path AS linkRelativePath,
                object.publication_revision AS publicationRevision
         FROM import_publication_objects AS object
         JOIN media_publications AS publication ON publication.id = object.publication_id
         WHERE publication.state IN ('RUNNING', 'PUBLISHED')
           AND object.status IN ('LINK_PENDING', 'LINKED', 'PROBED', 'PUBLISHED')
         ORDER BY object.link_relative_path, object.publication_id, object.object_id`,
      )
      .all() as PublicationObjectRow[];
    const plan: FarmPlanEntry[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      normalizeRelative(row.linkRelativePath, 'PUBLICATION_PATH_CONFLICT');
      normalizeRelative(row.cloudLogicalPath, 'PUBLICATION_PATH_CONFLICT');
      if (seen.has(row.linkRelativePath)) throw new PublicationFailure('PUBLICATION_PATH_CONFLICT');
      seen.add(row.linkRelativePath);
      plan.push({
        linkRelativePath: row.linkRelativePath,
        accountId: row.accountId,
        blobRelativePath: row.cloudLogicalPath,
        namespace: 'IMPORT',
      });
    }
    return plan;
  }

  private beginAttempt(publicationId: string, ownerToken: string): number {
    let nextRevision = 0;
    this.withExecutionFence(publicationId, ownerToken, () => {
      const row = this.requireRow(publicationId);
      importInvariant(
        row.state === 'PENDING' || row.state === 'RUNNING' || row.state === 'FAILED_SAFE',
        'IMPORT_PUBLICATION_ACTION_CONFLICT',
        409,
      );
      const revision = row.revision + 1;
      nextRevision = revision;
      const timestamp = this.now().getTime();
      this.db
        .prepare(
          `UPDATE import_publication_objects
           SET status = 'FAILED_SAFE', updated_at = ? WHERE publication_id = ?`,
        )
        .run(timestamp, publicationId);
      const changed = this.db
        .prepare(
          `UPDATE media_publications
            SET state = 'RUNNING', publication_revision = ?, object_count = 0,
                mount_account_id = NULL, mount_account_label = NULL,
                read_probe = 'NOT_RUN', jellyfin_notified = NULL, last_error = NULL,
                receipt_json_sanitized = '{}', updated_at = ?
            WHERE id = ? AND publication_revision = ?
              AND state IN ('PENDING', 'RUNNING', 'FAILED_SAFE')
              AND execution_owner_token = ?`,
        )
        .run(revision, timestamp, publicationId, row.revision, ownerToken);
      importInvariant(changed.changes === 1, 'IMPORT_PUBLICATION_REVISION_CONFLICT', 409);
    });
    return nextRevision;
  }

  private verifiedObjects(publication: PublicationRow): VerifiedObjectRow[] {
    const job = this.db
      .prepare('SELECT state, object_count AS objectCount FROM import_jobs WHERE id = ?')
      .get(publication.jobId) as { state: string; objectCount: number } | undefined;
    if (job === undefined || job.state !== 'COMPLETED' || job.objectCount <= 0) {
      throw new PublicationFailure('ARCHIVE_NOT_VERIFIED');
    }
    const rows = this.db
      .prepare(
        `SELECT object.id AS objectId, object.relative_path AS relativePath,
                object.source_size AS sourceSize, object.local_sha256 AS localSha256,
                object.staging_sha256 AS stagingSha256,
                object.committed_sha256 AS committedSha256,
                destination_commit.destination_account_id AS accountId,
                destination_commit.committed_key AS committedKey,
                destination_commit.commit_state AS commitState,
                account.label AS accountLabel
         FROM import_objects AS object
         LEFT JOIN destination_commits AS destination_commit
           ON destination_commit.job_id = object.job_id
          AND destination_commit.object_id = object.id
          AND destination_commit.destination_account_id = object.destination_account_id
         LEFT JOIN storage_accounts AS account
           ON account.id = destination_commit.destination_account_id
         WHERE object.job_id = ? ORDER BY object.relative_path, object.id`,
      )
      .all(publication.jobId) as VerifiedObjectRow[];
    const accountIds = new Set(rows.map((row) => row.accountId));
    if (
      rows.length !== job.objectCount ||
      rows.length === 0 ||
      accountIds.size !== 1 ||
      accountIds.has(null) ||
      rows.some(
        (row) =>
          row.commitState !== 'COMMITTED_VERIFIED' ||
          row.committedKey === null ||
          row.accountLabel === null ||
          row.localSha256 === null ||
          row.stagingSha256 !== row.localSha256 ||
          row.committedSha256 !== row.localSha256,
      )
    ) {
      throw new PublicationFailure('ARCHIVE_NOT_VERIFIED');
    }
    for (const row of rows) {
      normalizeRelative(row.relativePath, 'PUBLICATION_PATH_CONFLICT');
      normalizeRelative(row.committedKey!, 'PUBLICATION_PATH_CONFLICT');
    }
    return rows;
  }

  private replaceAttemptObjects(
    publication: PublicationRow,
    revision: number,
    objects: VerifiedObjectRow[],
    ownerToken: string,
  ): void {
    const libraryKey = publication.libraryKey;
    if (libraryKey === null) throw new PublicationFailure('LIBRARY_NOT_ALLOWLISTED');
    const timestamp = this.now().getTime();
    const links = new Set<string>();
    try {
      this.withExecutionFence(publication.id, ownerToken, () => {
        for (const object of objects) {
          const linkRelativePath = publicationPath(
            libraryKey,
            publication.logicalPath,
            object.relativePath,
          );
          if (links.has(linkRelativePath))
            throw new PublicationFailure('PUBLICATION_PATH_CONFLICT');
          links.add(linkRelativePath);
          this.db
            .prepare(
              `INSERT INTO import_publication_objects(
                 publication_id, job_id, object_id, account_id,
                 cloud_logical_path, link_relative_path, media_type, library_id,
                 publication_revision, status, read_probe,
                 receipt_json_sanitized, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'LINK_PENDING', 'NOT_RUN', '{}', ?, ?)
               ON CONFLICT(publication_id, object_id) DO UPDATE SET
                 account_id = excluded.account_id,
                 cloud_logical_path = excluded.cloud_logical_path,
                 link_relative_path = excluded.link_relative_path,
                 media_type = excluded.media_type,
                 library_id = excluded.library_id,
                 publication_revision = excluded.publication_revision,
                 status = excluded.status, read_probe = excluded.read_probe,
                 receipt_json_sanitized = excluded.receipt_json_sanitized,
                 updated_at = excluded.updated_at`,
            )
            .run(
              publication.id,
              publication.jobId,
              object.objectId,
              object.accountId,
              object.committedKey,
              linkRelativePath,
              publication.mediaType,
              publication.libraryId,
              revision,
              timestamp,
              timestamp,
            );
        }
        this.db
          .prepare(
            `UPDATE media_publications SET object_count = ?, updated_at = ?
             WHERE id = ? AND publication_revision = ? AND state = 'RUNNING'`,
          )
          .run(objects.length, timestamp, publication.id, revision);
      });
      // Detect a conflict against the torrent plan before SymlinkFarm's Map can
      // silently let one entry overwrite another.
      this.buildFarmPlan();
    } catch (error) {
      if (error instanceof PublicationFailure) throw error;
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new PublicationFailure('PUBLICATION_PATH_CONFLICT');
      }
      throw error;
    }
  }

  private markLinked(publicationId: string, revision: number, ownerToken: string): void {
    this.withExecutionFence(publicationId, ownerToken, () => {
      this.db
        .prepare(
          `UPDATE import_publication_objects SET status = 'LINKED', updated_at = ?
           WHERE publication_id = ? AND publication_revision = ? AND status = 'LINK_PENDING'`,
        )
        .run(this.now().getTime(), publicationId, revision);
    });
  }

  private markProbed(publicationId: string, revision: number, ownerToken: string): void {
    const timestamp = this.now().getTime();
    this.withExecutionFence(publicationId, ownerToken, () => {
      this.db
        .prepare(
          `UPDATE import_publication_objects
           SET status = 'PROBED', read_probe = 'PASSED', updated_at = ?
           WHERE publication_id = ? AND publication_revision = ? AND status = 'LINKED'`,
        )
        .run(timestamp, publicationId, revision);
      this.db
        .prepare(
          `UPDATE media_publications SET read_probe = 'PASSED', updated_at = ?
           WHERE id = ? AND publication_revision = ? AND state = 'RUNNING'`,
        )
        .run(timestamp, publicationId, revision);
    });
  }

  private complete(
    publicationId: string,
    revision: number,
    accountId: string,
    accountLabel: string,
    ownerToken: string,
  ): void {
    const timestamp = this.now().getTime();
    this.withExecutionFence(publicationId, ownerToken, () => {
      const rows = this.objectRows(publicationId, revision);
      importInvariant(rows.length > 0, 'IMPORT_PUBLICATION_OBJECTS_MISSING', 500);
      for (const row of rows) {
        const receipt = JSON.stringify({
          revision,
          objectId: row.objectId,
          accountId,
          cloudLogicalPath: row.cloudLogicalPath,
          linkRelativePath: row.linkRelativePath,
          readProbe: 'PASSED',
          jellyfinNotified: true,
          publishedAt: iso(timestamp),
        });
        this.db
          .prepare(
            `UPDATE import_publication_objects
             SET status = 'PUBLISHED', read_probe = 'PASSED',
                 receipt_json_sanitized = ?, updated_at = ?
             WHERE publication_id = ? AND object_id = ? AND publication_revision = ?`,
          )
          .run(receipt, timestamp, publicationId, row.objectId, revision);
      }
      const changed = this.db
        .prepare(
          `UPDATE media_publications
           SET state = 'PUBLISHED', mount_account_id = ?, mount_account_label = ?,
               read_probe = 'PASSED', jellyfin_notified = 1, last_error = NULL,
               receipt_json_sanitized = ?, updated_at = ?
           WHERE id = ? AND publication_revision = ? AND state = 'RUNNING'`,
        )
        .run(
          accountId,
          accountLabel,
          JSON.stringify({
            revision,
            objectCount: rows.length,
            accountId,
            readProbe: 'PASSED',
            jellyfinNotified: true,
            publishedAt: iso(timestamp),
          }),
          timestamp,
          publicationId,
          revision,
        );
      importInvariant(changed.changes === 1, 'IMPORT_PUBLICATION_REVISION_CONFLICT', 409);
    });
  }

  private fail(
    publicationId: string,
    revision: number,
    code: ImportPublicationError,
    ownerToken: string,
  ): void {
    const timestamp = this.now().getTime();
    this.withExecutionFence(publicationId, ownerToken, () => {
      this.db
        .prepare(
          `UPDATE import_publication_objects
           SET status = 'FAILED_SAFE',
               read_probe = CASE WHEN ? = 'READ_PROBE_FAILED' THEN 'FAILED' ELSE read_probe END,
               updated_at = ?
           WHERE publication_id = ? AND publication_revision = ?`,
        )
        .run(code, timestamp, publicationId, revision);
      this.db
        .prepare(
          `UPDATE media_publications
           SET state = 'FAILED_SAFE',
               read_probe = CASE WHEN ? = 'READ_PROBE_FAILED' THEN 'FAILED' ELSE read_probe END,
               jellyfin_notified = CASE WHEN ? LIKE 'JELLYFIN_%' OR ? = 'NOTIFICATION_REJECTED' THEN 0 ELSE jellyfin_notified END,
               last_error = ?, receipt_json_sanitized = ?, updated_at = ?
           WHERE id = ? AND publication_revision = ? AND state = 'RUNNING'`,
        )
        .run(
          code,
          code,
          code,
          code,
          JSON.stringify({ revision, failedSafe: true, error: code, failedAt: iso(timestamp) }),
          timestamp,
          publicationId,
          revision,
        );
    });
  }

  private failUnpublish(
    publicationId: string,
    revision: number,
    code: ImportPublicationError,
    ownerToken: string,
  ): void {
    const timestamp = this.now().getTime();
    this.withExecutionFence(publicationId, ownerToken, () => {
      this.db
        .prepare(
          `UPDATE media_publications
           SET state = 'FAILED_SAFE',
               jellyfin_notified = CASE
                 WHEN ? LIKE 'JELLYFIN_%' OR ? = 'NOTIFICATION_REJECTED' THEN 0
                 ELSE jellyfin_notified
               END,
               last_error = ?, receipt_json_sanitized = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          code,
          code,
          code,
          JSON.stringify({
            revision,
            projectionRemovalFailedSafe: true,
            cloudObjectsDeleted: false,
            error: code,
            failedAt: iso(timestamp),
          }),
          timestamp,
          publicationId,
        );
    });
  }

  private async withExecutionLease<T>(
    publicationId: string,
    operation: (ownerToken: string, assertLease: () => void) => Promise<T>,
  ): Promise<T> {
    const ownerToken = this.claimExecution(publicationId);
    let leaseFailure: ImportControlError | null = null;
    const heartbeat = setInterval(() => {
      try {
        this.renewExecution(publicationId, ownerToken);
      } catch (error) {
        leaseFailure =
          error instanceof ImportControlError
            ? error
            : new ImportControlError('IMPORT_PUBLICATION_EXECUTION_LEASE_LOST', 409);
        clearInterval(heartbeat);
      }
    }, this.executionHeartbeatMs);
    heartbeat.unref();
    const assertLease = (): void => {
      if (leaseFailure !== null) throw leaseFailure;
      this.assertExecutionOwner(publicationId, ownerToken);
    };
    try {
      return await operation(ownerToken, assertLease);
    } finally {
      clearInterval(heartbeat);
      this.releaseExecution(publicationId, ownerToken);
    }
  }

  private claimExecution(publicationId: string): string {
    const ownerToken = randomUUID();
    const now = this.now().getTime();
    const changed = this.db
      .prepare(
        `UPDATE media_publications
         SET execution_owner_token = ?, execution_lease_expires_at = ?
         WHERE id = ? AND (
           execution_owner_token IS NULL OR execution_lease_expires_at <= ?
         )`,
      )
      .run(ownerToken, now + this.executionLeaseMs, publicationId, now);
    importInvariant(changed.changes === 1, 'IMPORT_PUBLICATION_IN_PROGRESS', 409);
    return ownerToken;
  }

  private renewExecution(publicationId: string, ownerToken: string): void {
    const changed = this.db
      .prepare(
        `UPDATE media_publications SET execution_lease_expires_at = ?
         WHERE id = ? AND execution_owner_token = ?`,
      )
      .run(this.now().getTime() + this.executionLeaseMs, publicationId, ownerToken);
    importInvariant(changed.changes === 1, 'IMPORT_PUBLICATION_EXECUTION_LEASE_LOST', 409);
  }

  private assertExecutionOwner(publicationId: string, ownerToken: string): void {
    const owned = this.db
      .prepare(
        `SELECT 1 FROM media_publications
         WHERE id = ? AND execution_owner_token = ?
           AND execution_lease_expires_at > ?`,
      )
      .get(publicationId, ownerToken, this.now().getTime());
    importInvariant(owned !== undefined, 'IMPORT_PUBLICATION_EXECUTION_LEASE_LOST', 409);
  }

  private withExecutionFence(publicationId: string, ownerToken: string, action: () => void): void {
    this.db
      .transaction(() => {
        this.assertExecutionOwner(publicationId, ownerToken);
        action();
      })
      .immediate();
  }

  private releaseExecution(publicationId: string, ownerToken: string): void {
    this.db
      .prepare(
        `UPDATE media_publications
         SET execution_owner_token = NULL, execution_lease_expires_at = NULL
         WHERE id = ? AND execution_owner_token = ?`,
      )
      .run(publicationId, ownerToken);
  }

  private jellyfinFailureCode(
    error: unknown,
  ): Extract<
    ImportPublicationError,
    'JELLYFIN_UNREACHABLE' | 'JELLYFIN_AUTH_FAILED' | 'NOTIFICATION_REJECTED'
  > {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      if (error.code === 'JELLYFIN_AUTH_FAILED' || error.code === 'NOTIFICATION_REJECTED') {
        return error.code;
      }
    }
    return 'JELLYFIN_UNREACHABLE';
  }

  private failureCodeForStage(
    stage: 'ARCHIVE' | 'MOUNT' | 'VFS' | 'FARM' | 'PROBE' | 'JELLYFIN',
  ): ImportPublicationError {
    if (stage === 'ARCHIVE') return 'ARCHIVE_NOT_VERIFIED';
    if (stage === 'MOUNT') return 'DESTINATION_UNMOUNTABLE';
    if (stage === 'VFS') return 'VFS_REFRESH_FAILED';
    if (stage === 'FARM') return 'FARM_LINK_FAILED';
    if (stage === 'PROBE') return 'READ_PROBE_FAILED';
    return 'JELLYFIN_UNREACHABLE';
  }

  private requireRow(publicationId: string): PublicationRow {
    const row = this.db
      .prepare(`${PUBLICATION_SELECT} WHERE publication.id = ?`)
      .get(publicationId) as PublicationRow | undefined;
    if (row === undefined) throw new ImportControlError('IMPORT_PUBLICATION_NOT_FOUND', 404);
    return row;
  }

  private requireLibrary(publication: PublicationRow): JellyfinImportLibrary {
    const library = this.libraries.get(publication.libraryId);
    if (
      library === undefined ||
      publication.libraryKey !== library.libraryKey ||
      publication.containerPath !== library.containerPath
    ) {
      throw new PublicationFailure('LIBRARY_NOT_ALLOWLISTED');
    }
    this.assertMediaType(publication.mediaType, library);
    return library;
  }

  private assertMediaType(mediaType: ImportMediaType, library: JellyfinImportLibrary): void {
    if (!importLibraryAcceptsMediaType(mediaType, library.contentType)) {
      throw new PublicationFailure('MEDIA_TYPE_MISMATCH');
    }
  }

  private objectRows(publicationId: string, revision: number): PublicationObjectRow[] {
    return this.db
      .prepare(
        `SELECT publication_id AS publicationId, object_id AS objectId,
                account_id AS accountId, cloud_logical_path AS cloudLogicalPath,
                link_relative_path AS linkRelativePath,
                publication_revision AS publicationRevision
         FROM import_publication_objects
         WHERE publication_id = ? AND publication_revision = ?
         ORDER BY link_relative_path, object_id`,
      )
      .all(publicationId, revision) as PublicationObjectRow[];
  }

  private allObjectRows(publicationId: string): PublicationObjectRow[] {
    return this.db
      .prepare(
        `SELECT publication_id AS publicationId, object_id AS objectId,
                account_id AS accountId, cloud_logical_path AS cloudLogicalPath,
                link_relative_path AS linkRelativePath,
                publication_revision AS publicationRevision
         FROM import_publication_objects WHERE publication_id = ?
         ORDER BY link_relative_path, object_id`,
      )
      .all(publicationId) as PublicationObjectRow[];
  }

  private mapPublication(row: PublicationRow): ImportPublication {
    return {
      publicationId: row.id,
      state: row.state,
      revision: row.revision,
      objectCount: row.objectCount,
      mediaType: row.mediaType,
      libraryId: row.libraryId,
      libraryDisplayName: row.libraryDisplayName,
      containerPath: row.containerPath,
      logicalPath: row.logicalPath,
      mountAccountLabel: row.mountAccountLabel,
      readProbe: row.readProbe,
      jellyfinNotified: row.jellyfinNotified === null ? null : row.jellyfinNotified === 1,
      error: row.lastError,
      updatedAt: iso(row.updatedAt),
    };
  }

  private prepareRequestedPublication(
    request: MediaPublicationRequest,
    library: JellyfinImportLibrary,
    idempotencyKey: string,
  ): string {
    return this.db.transaction(() => {
      const job = this.db
        .prepare(
          `SELECT id, state, destination_account_id AS destinationAccountId
           FROM import_jobs WHERE id = ?`,
        )
        .get(request.jobId) as
        { id: string; state: string; destinationAccountId: string | null } | undefined;
      importInvariant(job !== undefined, 'IMPORT_NOT_FOUND', 404);
      importInvariant(job.state === 'COMPLETED', 'IMPORT_COMMITTED_VERIFY_REQUIRED', 409);
      importInvariant(job.destinationAccountId !== null, 'IMPORT_DESTINATION_UNSUPPORTED', 409);
      const existing = this.db
        .prepare(`${PUBLICATION_SELECT} WHERE publication.job_id = ?`)
        .get(request.jobId) as PublicationRow | undefined;
      const timestamp = this.now().getTime();
      const publicationId = existing?.id ?? randomUUID();
      const intentFingerprint = fingerprint(request);

      const operation = this.db
        .prepare(
          `SELECT publication_id AS publicationId, operation,
                  request_fingerprint AS requestFingerprint,
                  response_json AS responseJson
           FROM media_publication_operations WHERE idempotency_key = ?`,
        )
        .get(idempotencyKey) as OperationRow | undefined;
      if (operation !== undefined) {
        importInvariant(
          operation.publicationId === publicationId &&
            operation.operation === 'REQUEST' &&
            operation.requestFingerprint === intentFingerprint,
          'IMPORT_IDEMPOTENCY_CONFLICT',
          409,
        );
        return publicationId;
      }

      if (existing === undefined) {
        this.db
          .prepare(
            `INSERT INTO media_publications(
               id, job_id, state, media_type, library_id, library_key,
               library_display_name, container_path, logical_path,
               publication_revision, object_count, receipt_json_sanitized,
               created_at, updated_at
             ) VALUES (?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, 0, 0, '{}', ?, ?)`,
          )
          .run(
            publicationId,
            request.jobId,
            request.publication.mediaType,
            library.libraryId,
            library.libraryKey,
            library.displayName,
            library.containerPath,
            request.publication.logicalPath,
            timestamp,
            timestamp,
          );
      } else {
        importInvariant(
          existing.state !== 'RUNNING' && existing.state !== 'PUBLISHED',
          'IMPORT_PUBLICATION_ACTION_CONFLICT',
          409,
        );
        this.db
          .prepare(
            `UPDATE media_publications
             SET state = 'PENDING', media_type = ?, library_id = ?, library_key = ?,
                 library_display_name = ?, container_path = ?, logical_path = ?,
                 read_probe = 'NOT_RUN', jellyfin_notified = NULL, last_error = NULL,
                 updated_at = ? WHERE id = ?`,
          )
          .run(
            request.publication.mediaType,
            library.libraryId,
            library.libraryKey,
            library.displayName,
            library.containerPath,
            request.publication.logicalPath,
            timestamp,
            publicationId,
          );
      }
      this.db
        .prepare(
          `INSERT INTO media_publication_operations(
             idempotency_key, publication_id, operation, request_fingerprint,
             response_json, created_at, updated_at
           ) VALUES (?, ?, 'REQUEST', ?, NULL, ?, ?)`,
        )
        .run(idempotencyKey, publicationId, intentFingerprint, timestamp, timestamp);
      return publicationId;
    })();
  }

  private beginOperation<T>(
    publicationId: string,
    operation: OperationRow['operation'],
    idempotencyKey: string,
    intent: unknown,
    authorize?: () => void,
  ): T | null {
    this.requireRow(publicationId);
    const requestFingerprint = fingerprint(intent);
    const existing = this.db
      .prepare(
        `SELECT publication_id AS publicationId, operation,
                request_fingerprint AS requestFingerprint,
                response_json AS responseJson
         FROM media_publication_operations WHERE idempotency_key = ?`,
      )
      .get(idempotencyKey) as OperationRow | undefined;
    if (existing !== undefined) {
      importInvariant(
        existing.publicationId === publicationId &&
          existing.operation === operation &&
          existing.requestFingerprint === requestFingerprint,
        'IMPORT_IDEMPOTENCY_CONFLICT',
        409,
      );
      const response = operationResponse<T>(existing);
      if (response !== null) return response;
      authorize?.();
      return null;
    }
    authorize?.();
    const timestamp = this.now().getTime();
    this.db
      .prepare(
        `INSERT INTO media_publication_operations(
           idempotency_key, publication_id, operation, request_fingerprint,
           response_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(idempotencyKey, publicationId, operation, requestFingerprint, timestamp, timestamp);
    return null;
  }

  private replayOperation<T>(
    publicationId: string,
    operation: OperationRow['operation'],
    idempotencyKey: string,
    intent: unknown,
  ): T | null {
    const requestFingerprint = fingerprint(intent);
    const existing = this.db
      .prepare(
        `SELECT publication_id AS publicationId, operation,
                request_fingerprint AS requestFingerprint,
                response_json AS responseJson
         FROM media_publication_operations WHERE idempotency_key = ?`,
      )
      .get(idempotencyKey) as OperationRow | undefined;
    importInvariant(existing !== undefined, 'IMPORT_PUBLICATION_RECEIPT_MISSING', 500);
    importInvariant(
      existing.publicationId === publicationId &&
        existing.operation === operation &&
        existing.requestFingerprint === requestFingerprint,
      'IMPORT_IDEMPOTENCY_CONFLICT',
      409,
    );
    return operationResponse<T>(existing);
  }

  private completeOperation(
    publicationId: string,
    operation: OperationRow['operation'],
    idempotencyKey: string,
    intent: unknown,
    response: unknown,
  ): void {
    const changed = this.db
      .prepare(
        `UPDATE media_publication_operations
         SET response_json = ?, updated_at = ?
         WHERE idempotency_key = ? AND publication_id = ? AND operation = ?
           AND request_fingerprint = ? AND response_json IS NULL`,
      )
      .run(
        JSON.stringify(response),
        this.now().getTime(),
        idempotencyKey,
        publicationId,
        operation,
        fingerprint(intent),
      );
    if (changed.changes === 0) {
      const replay = this.beginOperation<unknown>(publicationId, operation, idempotencyKey, intent);
      importInvariant(
        JSON.stringify(replay) === JSON.stringify(response),
        'IMPORT_IDEMPOTENCY_CONFLICT',
        409,
      );
    }
  }
}

export type ImportPublicationController = Pick<
  ImportPublicationService,
  | 'get'
  | 'request'
  | 'retry'
  | 'unpublish'
  | 'runForJob'
  | 'buildFarmPlan'
  | 'buildPublicationFarmPlan'
>;
