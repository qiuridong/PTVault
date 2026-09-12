import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MediaCatalog } from '../media/catalog.js';
import { createBlobResolver } from '../media/blob-resolver.js';
import { planFarm } from '../media/symlink-farm.js';

// Offline evidence only: no migrations, mounts, symlinks, notifications or writes.
const [database, hotRoot] = process.argv.slice(2);
if (!database || !hotRoot) throw new Error('Usage: media-farm-dry-run DATABASE_COPY HOT_ROOT');
const digest = () => createHash('sha256').update(readFileSync(database)).digest('hex');
const before = digest();
const db = new Database(database, { readonly: true, fileMustExist: true });
try {
  db.pragma('query_only = ON');
  const entries = new MediaCatalog({ db, hotRoot }).list(() => true);
  const resolve = createBlobResolver({ db, isAccountHealthy: () => true });
  const plan = planFarm(entries, resolve);
  const titles = entries.map((entry) => ({
    instanceId: entry.instanceId,
    torrentHash: entry.torrentHash,
    logicalPath: entry.logicalPath,
    plannedFiles: plan.filter(
      (file) =>
        file.linkRelativePath === entry.logicalPath ||
        file.linkRelativePath.startsWith(`${entry.logicalPath}/`),
    ).length,
  }));
  const after = digest();
  if (after !== before) throw new Error('DATABASE_COPY_CHANGED');
  console.log(
    JSON.stringify(
      {
        mode: 'DRY_RUN',
        databaseSha256: before,
        databaseUnchanged: true,
        assumptions: [
          'All accounts treated as eligible and healthy for offline structure comparison only.',
          'Live connection/profile/mount authority must be rechecked before applying; this command never applies.',
        ],
        catalogTitles: entries.length,
        plannedFiles: plan.length,
        titles,
        plan,
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
}
