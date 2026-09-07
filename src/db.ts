import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestResult } from './types.js';

// The DB is a file committed to the repo (db/test-runs.sqlite), not a
// hosted service — the GitHub Actions workflow commits it back after each
// run so history persists across runs without a third-party DB account.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '..', 'db', 'test-runs.sqlite');

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    // Plain rollback-journal mode (the default), not WAL — this file is
    // committed to git as a single artifact after each short-lived Action
    // run, and WAL's separate -wal/-shm sidecar files would either need
    // committing too (messy) or risk losing uncheckpointed writes if
    // ignored. A single process doing one transaction has no need for WAL's
    // concurrent-reader benefit anyway.
    db.exec(`
      CREATE TABLE IF NOT EXISTS test_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        run_timestamp TEXT NOT NULL,
        form_url TEXT NOT NULL,
        form_name TEXT NOT NULL,
        device TEXT NOT NULL,
        category TEXT NOT NULL,
        status TEXT NOT NULL,
        severity TEXT,
        description TEXT,
        screenshot_path TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_test_runs_run_id ON test_runs (run_id);
      CREATE INDEX IF NOT EXISTS idx_test_runs_run_timestamp ON test_runs (run_timestamp DESC);
    `);
  }
  return db;
}

/**
 * Inserts all result rows for a run inside a single transaction. Local
 * SQLite has no network/cold-start to retry against, so unlike the old
 * Postgres version this either succeeds outright or fails once — no retry
 * loop. Never throws — caller (run.ts) treats a DB failure as non-fatal so
 * email/Notion can still proceed.
 */
export function insertResults(results: TestResult[]): { ok: boolean; error?: string } {
  const insert = getDb().prepare(`
    INSERT INTO test_runs
      (run_id, run_timestamp, form_url, form_name, device, category, status, severity, description, screenshot_path)
    VALUES (@runId, @runTimestamp, @formUrl, @formName, @device, @category, @status, @severity, @description, @screenshotPath)
  `);

  const insertMany = getDb().transaction((rows: TestResult[]) => {
    for (const r of rows) insert.run(r);
  });

  try {
    insertMany(results);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[db] Insert failed:', message);
    return { ok: false, error: message };
  }
}

/**
 * Returns the most recent run_timestamp across all rows, or null if the
 * table is empty. Used by the watchdog to detect a silently-skipped cron run.
 */
export function getLatestRunTimestamp(): Date | null {
  const row = getDb().prepare('SELECT MAX(run_timestamp) AS latest FROM test_runs').get() as
    | { latest: string | null }
    | undefined;
  return row?.latest ? new Date(row.latest) : null;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
