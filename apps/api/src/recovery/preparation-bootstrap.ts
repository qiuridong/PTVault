import { randomUUID } from 'node:crypto';
import type { RecoveryStatus } from '@ptvault/contracts';
import { AuditRepository } from '../audit/repository.js';
import type { AppDatabase } from '../db/database.js';
import { createRecoveryPreparationContext } from './preparation-context.js';
import type { BaselineSelection } from './preparation-state.js';

/** Deployment-only one-shot selection: target and both hashes come from the reviewed manifest. */
export async function initializeApprovedRecoveryBaseline(
  input: Omit<BaselineSelection, 'expectedMaterialRevision'> & {
    db: AppDatabase;
    stateDirectory: string;
  },
): Promise<RecoveryStatus> {
  const context = createRecoveryPreparationContext(input);
  if (context.readOnly) throw new Error('RECOVERY_COMPATIBILITY_READ_ONLY');
  await context.coordinator.withWrite(async () => {
    if (!input.db.prepare('SELECT 1 FROM admins WHERE id = ?').get(input.adminId))
      throw new Error('RECOVERY_BASELINE_ADMIN_REQUIRED');
    const material = await context.observer.read();
    input.db
      .transaction(() => {
        if (context.store.get().escrowState === 'UNINITIALIZED')
          context.store.initializeEscrow(material.sha256);
        context.store.bootstrap(input);
        new AuditRepository(input.db).append({
          actorAdminId: input.adminId,
          sourceIp: 'approved-migration',
          action: 'RECOVERY_BASELINE_SELECTED',
          subject: 'recovery-preparation',
          outcome: 'SUCCESS',
          correlationId: randomUUID(),
          detail: {
            version: input.version,
            source: 'MIGRATION_APPROVED',
            baselineRevision: context.store.get().baselineRevision,
          },
        });
      })
      .immediate();
  });
  return context.readiness.currentStatus();
}
