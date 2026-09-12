import path from 'node:path';

import type { AppDatabase } from '../db/database.js';
import { RecoveryPreparationCoordinator } from './preparation-coordinator.js';
import { RecoveryMaterialObserver } from './preparation-material.js';
import { RecoveryReadinessService } from './preparation-readiness.js';
import { RecoveryPreparationRequests } from './preparation-requests.js';
import { RecoveryPreparationStore } from './preparation-state.js';
import { RecoveryMaterialWriter } from './preparation-writer.js';
import { RecoveryRepository } from './repository.js';
import { recoveryPreparationCompatibilityReadOnly } from './preparation-compatibility.js';

export function createRecoveryPreparationContext(options: {
  db: AppDatabase;
  stateDirectory: string;
  now?: () => number;
  readOnly?: boolean;
}) {
  const now = options.now ?? Date.now;
  const readOnly = recoveryPreparationCompatibilityReadOnly || options.readOnly === true;
  const coordinator = new RecoveryPreparationCoordinator();
  const repository = new RecoveryRepository(options.db, now);
  const store = new RecoveryPreparationStore(options.db, now);
  const requests = new RecoveryPreparationRequests(options.db, now);
  const observer = new RecoveryMaterialObserver(path.join(options.stateDirectory, 'recovery'));
  const readiness = new RecoveryReadinessService({
    db: options.db,
    repository,
    store,
    coordinator,
    observer,
    now,
    readOnly,
  });
  const writer = new RecoveryMaterialWriter({ store, observer, coordinator, requests });
  return { coordinator, repository, store, requests, observer, readiness, writer, readOnly };
}

export type RecoveryPreparationContext = ReturnType<typeof createRecoveryPreparationContext>;
