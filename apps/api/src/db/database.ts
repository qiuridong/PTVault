import Database from 'better-sqlite3';

import { migrations } from './migrations.js';

export type AppDatabase = Database.Database;

export function openDatabase(filename: string): AppDatabase {
  const db = new Database(filename);

  db.pragma('busy_timeout = 5000');
  if (filename !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }

  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (' +
      'version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
  );

  const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
  const mark = db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)');
  const pending = migrations.filter((migration) => !applied.get(migration.version));
  const needsParentTableRebuild = pending.some((migration) => migration.version === 14);

  // Migration 14 widens the CHECK constraint on `torrents.cloud_state`.
  // `torrents` is a parent of several populated tables, and SQLite refuses to
  // drop/rebuild a referenced parent while FK enforcement is enabled. Disable it
  // only for this migration window, keep legacy rename semantics so child FKs
  // continue to name `torrents`, then prove the resulting graph is valid before
  // re-enabling enforcement. PRAGMA foreign_keys cannot be changed inside a
  // transaction, so this must happen before `migrate()` starts.
  if (needsParentTableRebuild) {
    db.pragma('foreign_keys = OFF');
    db.pragma('legacy_alter_table = ON');
  } else {
    db.pragma('foreign_keys = ON');
  }

  const migrate = db.transaction(() => {
    for (const migration of pending) {
      db.exec(migration.sql);
      mark.run(migration.version, Date.now());
    }
    if (needsParentTableRebuild) {
      const violations = db.pragma('foreign_key_check') as Array<Record<string, unknown>>;
      if (violations.length > 0) throw new Error('DATABASE_FOREIGN_KEY_CHECK_FAILED');
    }
  });

  try {
    migrate();
  } finally {
    if (needsParentTableRebuild) {
      db.pragma('legacy_alter_table = OFF');
      db.pragma('foreign_keys = ON');
    }
  }
  return db;
}
