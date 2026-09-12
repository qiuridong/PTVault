import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { Sha256Schema } from '@ptvault/contracts';

import type { AppDatabase } from '../db/database.js';
import { AuditRepository } from '../audit/repository.js';

const IdentitySchema = z.object({
  adminId: z.string().min(1).max(128),
  key: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[\x21-\x7e]+$/),
  operation: z.enum(['BASELINE_SELECT', 'RECIPIENT_SET', 'ESCROW_REPLACE']),
  fingerprint: Sha256Schema,
});
const ResultSchema = z
  .object({
    version: z.number().int().positive().optional(),
    baselineRevision: z.number().int().nonnegative().optional(),
    materialRevision: z.number().int().nonnegative().optional(),
    escrowSha256: Sha256Schema.optional(),
    error: z
      .string()
      .regex(/^RECOVERY_[A-Z_]+$/)
      .max(128)
      .optional(),
  })
  .strict();
export type PreparationRequestIdentity = z.infer<typeof IdentitySchema>;
export type PreparationReceiptResult = z.infer<typeof ResultSchema>;
export type PreparationRequestReceipt = {
  operationId: string;
  operation: PreparationRequestIdentity['operation'];
  state: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'UNRESOLVED';
  result: PreparationReceiptResult | null;
};

export class RecoveryPreparationRequests {
  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  atomic<T>(operation: () => T): T {
    return this.db.transaction(operation).immediate();
  }

  operation(operationId: string): (PreparationRequestReceipt & { adminId: string }) | null {
    const row = this.db
      .prepare(
        `SELECT admin_id AS adminId, operation_id AS operationId, operation, state,
      result_json AS resultJson FROM recovery_preparation_requests WHERE operation_id = ?`,
      )
      .get(operationId) as
      | (Omit<PreparationRequestReceipt, 'result'> & { adminId: string; resultJson: string | null })
      | undefined;
    return row
      ? {
          adminId: row.adminId,
          operationId: row.operationId,
          operation: row.operation,
          state: row.state,
          result: row.resultJson === null ? null : ResultSchema.parse(JSON.parse(row.resultJson)),
        }
      : null;
  }

  failUnpublishedStartup(pendingOperationId: string | null): void {
    this.atomic(() => {
      const rows = this.db
        .prepare(
          `SELECT operation_id AS operationId FROM recovery_preparation_requests
        WHERE state IN ('PENDING', 'UNRESOLVED') AND (? IS NULL OR operation_id != ?)`,
        )
        .all(pendingOperationId, pendingOperationId) as Array<{ operationId: string }>;
      for (const row of rows)
        this.fail(row.operationId, 'FAILED', 'RECOVERY_MATERIAL_NOT_PUBLISHED');
    });
  }

  find(identity: PreparationRequestIdentity): PreparationRequestReceipt | null {
    const parsed = IdentitySchema.parse(identity);
    const row = this.db
      .prepare(
        `SELECT operation_id AS operationId, operation, request_fingerprint AS fingerprint,
      state, result_json AS resultJson FROM recovery_preparation_requests WHERE admin_id = ? AND idempotency_key = ?`,
      )
      .get(parsed.adminId, parsed.key) as
      | (Omit<PreparationRequestReceipt, 'result'> & {
          fingerprint: string;
          resultJson: string | null;
        })
      | undefined;
    if (!row) return null;
    if (row.operation !== parsed.operation || row.fingerprint !== parsed.fingerprint)
      throw new Error('RECOVERY_REQUEST_CONFLICT');
    return {
      operationId: row.operationId,
      operation: row.operation,
      state: row.state,
      result: row.resultJson === null ? null : ResultSchema.parse(JSON.parse(row.resultJson)),
    };
  }

  begin(identity: PreparationRequestIdentity): PreparationRequestReceipt {
    return this.atomic(() => {
      if (this.find(identity)) throw new Error('RECOVERY_REQUEST_ALREADY_EXISTS');
      const operationId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO recovery_preparation_requests(admin_id, idempotency_key, operation,
        request_fingerprint, operation_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
        )
        .run(
          identity.adminId,
          identity.key,
          identity.operation,
          identity.fingerprint,
          operationId,
          this.now(),
          this.now(),
        );
      return { operationId, operation: identity.operation, state: 'PENDING', result: null };
    });
  }

  succeed(operationId: string, result: unknown): void {
    this.finish(operationId, 'SUCCEEDED', result);
  }

  fail(operationId: string, state: 'FAILED' | 'UNRESOLVED', error: string): void {
    this.finish(operationId, state, { error });
  }

  private finish(
    operationId: string,
    state: PreparationRequestReceipt['state'],
    result: unknown,
  ): void {
    this.atomic(() => {
      const parsed = ResultSchema.safeParse(result);
      if (!parsed.success) throw new Error('RECOVERY_REQUEST_RESULT_INVALID');
      const previous = this.operation(operationId);
      if (!previous) throw new Error('RECOVERY_REQUEST_NOT_FOUND');
      if (
        previous.state === state &&
        JSON.stringify(previous.result) === JSON.stringify(parsed.data)
      )
        return;
      const changed = this.db
        .prepare(
          `UPDATE recovery_preparation_requests SET state = ?, result_json = ?, updated_at = ?
      WHERE operation_id = ? AND state IN ('PENDING', 'UNRESOLVED')`,
        )
        .run(state, JSON.stringify(parsed.data), this.now(), operationId);
      if (changed.changes !== 1) throw new Error('RECOVERY_REQUEST_NOT_FOUND');
      new AuditRepository(this.db, () => new Date(this.now())).append({
        actorAdminId: previous.adminId,
        sourceIp: 'recovery-journal',
        action:
          previous.operation === 'BASELINE_SELECT'
            ? 'RECOVERY_BASELINE_SELECTED'
            : previous.operation === 'RECIPIENT_SET'
              ? 'RECOVERY_RECIPIENT_SET'
              : 'RECOVERY_ESCROW_UPLOADED',
        subject: 'recovery-preparation',
        outcome: state === 'SUCCEEDED' ? 'SUCCESS' : 'ERROR',
        correlationId: operationId,
        detail: { operationId, operation: previous.operation, settlement: state },
      });
    });
  }
}
