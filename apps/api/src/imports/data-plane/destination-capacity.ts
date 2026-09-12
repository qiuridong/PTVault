import type { AppDatabase } from '../../db/database.js';
import { StorageAccountRepository } from '../../storage/accounts.js';
import { NoAccountCapacityError } from '../../storage/selector.js';
import { ImportDataPlaneError } from './errors.js';

/** Durable destination admission, distinct from local spool admission. */
export class ImportDestinationCapacityGate {
  private readonly accounts: StorageAccountRepository;
  constructor(
    private readonly db: AppDatabase,
    now: () => number,
  ) {
    this.accounts = new StorageAccountRepository(db, now, {
      legacyRcloneConfigured: true,
      webOAuthRuntimeConfigured: true,
    });
  }

  reserve(jobId: string, attempt: number, minimumUploadBytes?: string): void {
    this.db
      .transaction(() => {
        const job = this.db
          .prepare(
            `SELECT destination_account_id AS accountId, destination_id AS destinationId,
        job_bytes_total AS bytes, attempt, state FROM import_jobs WHERE id=?`,
          )
          .get(jobId) as
          | {
              accountId: string | null;
              destinationId: string;
              bytes: string;
              attempt: number;
              state: string;
            }
          | undefined;
        if (job === undefined || job.state !== 'RUNNING' || job.attempt !== attempt)
          throw new ImportDataPlaneError('IMPORT_WORKER_ATTEMPT_STALE');
        const accountId =
          job.accountId ?? job.destinationId.replace(/^onedrive-(?:raw|crypt):/, '');
        const uploaded = this.db
          .prepare(
            `SELECT object.source_size AS bytes FROM import_objects AS object
        WHERE object.job_id=? AND object.destination_account_id=? AND EXISTS (
          SELECT 1 FROM destination_commits AS destination
          JOIN import_receipts AS receipt ON receipt.job_id=destination.job_id AND receipt.object_id=destination.object_id
          WHERE destination.job_id=object.job_id AND destination.object_id=object.id
            AND destination.destination_account_id=object.destination_account_id AND destination.staging_key=object.staging_key
            AND destination.commit_state IN ('STAGING_UPLOADED','STAGING_VERIFIED','COMMITTED','COMMITTED_VERIFIED')
            AND receipt.kind='STAGING_UPLOADED' AND receipt.size=object.source_size
        )`,
          )
          .all(jobId, accountId) as Array<{ bytes: string }>;
        const remaining =
          BigInt(job.bytes) - uploaded.reduce((sum, row) => sum + BigInt(row.bytes), 0n);
        if (
          remaining < 0n ||
          (minimumUploadBytes !== undefined && !/^(?:0|[1-9]\d*)$/.test(minimumUploadBytes))
        ) {
          throw new ImportDataPlaneError('IMPORT_DESTINATION_CAPACITY_EVIDENCE_INVALID');
        }
        const minimum = BigInt(minimumUploadBytes ?? '0');
        const required = remaining > minimum ? remaining : minimum;
        // Readback/move/finalization need no additional object allocation. A stale
        // staging receipt never authorizes a re-upload: the actual upload boundary
        // supplies a minimum, including a zero-byte claim for an empty object.
        if (required === 0n && minimumUploadBytes === undefined) return;
        try {
          this.accounts.reserveCapacity({
            ownerKind: 'IMPORT',
            ownerId: jobId,
            accountId,
            requiredBytes: required.toString(),
            generation: attempt,
          });
        } catch (error) {
          if (error instanceof NoAccountCapacityError)
            throw new ImportDataPlaneError('DESTINATION_CAPACITY_WAIT');
          throw error;
        }
      })
      .immediate();
  }

  beforeUpload(jobId: string, attempt: number, sourceSize: string): void {
    this.reserve(jobId, attempt, sourceSize);
    this.accounts.beginCapacityWrite('IMPORT', jobId, attempt);
  }

  release(jobId: string, attempt: number): void {
    this.accounts.releaseCapacity('IMPORT', jobId, attempt);
  }

  reconcile(): void {
    const rows = this.db
      .prepare(
        `SELECT owner_id AS id, generation FROM storage_capacity_reservations AS claim
      WHERE owner_kind='IMPORT' AND NOT EXISTS (SELECT 1 FROM import_jobs WHERE id=claim.owner_id AND state='RUNNING' AND attempt=claim.generation)`,
      )
      .all() as Array<{ id: string; generation: number }>;
    for (const row of rows) this.release(row.id, row.generation);
  }
}
