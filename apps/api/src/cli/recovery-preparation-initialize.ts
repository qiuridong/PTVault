import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Sha256Schema } from '@ptvault/contracts';
import { openDatabase } from '../db/database.js';
import { initializeApprovedRecoveryBaseline } from '../recovery/preparation-bootstrap.js';

export async function runRecoveryPreparationInitialization(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      database: { type: 'string' },
      'state-directory': { type: 'string' },
      version: { type: 'string' },
      'bundle-sha256': { type: 'string' },
      'escrow-sha256': { type: 'string' },
      'admin-id': { type: 'string' },
      'expected-baseline-revision': { type: 'string' },
    },
  });
  const filename = path.resolve(z.string().min(1).parse(values.database));
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error('RECOVERY_DATABASE_PATH_INVALID');
  const stateDirectory = path.resolve(z.string().min(1).parse(values['state-directory']));
  const version = z.coerce.number().int().positive().safe().parse(values.version);
  if (values['expected-baseline-revision'] !== '0')
    throw new Error('RECOVERY_BASELINE_BOOTSTRAP_UNAVAILABLE');
  const bundleSha256 = Sha256Schema.parse(values['bundle-sha256']);
  const escrowSha256 = Sha256Schema.parse(values['escrow-sha256']);
  const adminId = z.string().min(1).max(128).parse(values['admin-id']);
  const db = openDatabase(filename);
  try {
    const status = await initializeApprovedRecoveryBaseline({
      db,
      stateDirectory,
      version,
      bundleSha256,
      escrowSha256,
      adminId,
      expectedBaselineRevision: 0,
    });
    process.stdout.write(
      `${JSON.stringify({
        version: status.version,
        baselineRevision: status.baselineRevision,
        materialRevision: status.materialRevision,
        latestSnapshotVersion: status.latestSnapshotVersion,
        deletionUnlocked: status.deletionUnlocked,
      })}\n`,
    );
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runRecoveryPreparationInitialization(process.argv.slice(2)).catch(() => {
    process.stderr.write('RECOVERY_PREPARATION_INITIALIZATION_FAILED\n');
    process.exitCode = 1;
  });
}
