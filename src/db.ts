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

export function getDb(): Database.Database {
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
      CREATE TABLE IF NOT EXISTS form_timings (
        run_id TEXT NOT NULL,
        run_timestamp TEXT NOT NULL,
        form_name TEXT NOT NULL,
        duration_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_form_timings_form ON form_timings (form_name, run_timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_test_runs_run_id ON test_runs (run_id);
      CREATE INDEX IF NOT EXISTS idx_test_runs_run_timestamp ON test_runs (run_timestamp DESC);
    `);
    // Additive migration: which concrete target (browser + device profile) a row came from.
    const cols = db.prepare('PRAGMA table_info(test_runs)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'target')) db.exec('ALTER TABLE test_runs ADD COLUMN target TEXT');
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
      (run_id, run_timestamp, form_url, form_name, device, category, status, severity, description, screenshot_path, target)
    VALUES (@runId, @runTimestamp, @formUrl, @formName, @device, @category, @status, @severity, @description, @screenshotPath, @target)
  `);

  const insertMany = getDb().transaction((rows: TestResult[]) => {
    for (const r of rows) insert.run({ ...r, target: r.target ?? null });
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

/**
 * True if a real ("Valid submission...") lead has already been submitted
 * today, in IST — the user's cap is 1 real submission per calendar day
 * across all forms combined, so every run after the first one that
 * day must skip the actual Submit click entirely. run_timestamp is stored
 * in UTC; shifted by +5:30 to get the IST calendar date before comparing
 * to 'now' (also shifted +5:30), matching the IST convention already used
 * for display elsewhere (see notion.ts).
 */
/** Max real (lead-creating) test submissions per IST day, across all forms and targets. */
export const DAILY_LEAD_CAP = 10;

export interface SubmittedCombo { formName: string; target: string }

/** Real submissions already recorded for today's IST date (each real submit leaves one 'Valid submission…' row, pass or fail). */
export function submissionsToday(): SubmittedCombo[] {
  return (getDb()
    .prepare(
      `SELECT form_name AS formName, COALESCE(target, device) AS target FROM test_runs
       WHERE description LIKE 'Valid submission%'
       AND date(run_timestamp, '+5 hours', '+30 minutes') = date('now', '+5 hours', '+30 minutes')`
    )
    .all() as SubmittedCombo[]);
}

/** Days since each form+target combo last had a real submission (for rotating coverage). Missing = never. */
export function daysSinceLastSubmission(): Map<string, number> {
  const rows = getDb()
    .prepare(
      `SELECT form_name AS formName, COALESCE(target, device) AS target,
              julianday('now') - julianday(MAX(run_timestamp)) AS days
       FROM test_runs WHERE description LIKE 'Valid submission%' GROUP BY form_name, COALESCE(target, device)`
    )
    .all() as Array<{ formName: string; target: string; days: number }>;
  return new Map(rows.map((r) => [`${r.formName}|${r.target}`, r.days]));
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** Persists per-form test duration so trends/baselines exist (was in-memory only). */
export function insertTimings(runId: string, runTimestamp: string, metrics: { formName: string; durationMs: number }[]): void {
  try {
    const ins = getDb().prepare('INSERT INTO form_timings (run_id, run_timestamp, form_name, duration_ms) VALUES (?, ?, ?, ?)');
    getDb().transaction(() => { for (const m of metrics) ins.run(runId, runTimestamp, m.formName, Math.round(m.durationMs)); })();
  } catch (err) {
    console.error('[db] Timing insert failed:', (err as Error).message);
  }
}

// Test time per form roughly doubled when the 5-target device/browser matrix
// replaced the 3 resized windows; only compare against runs from the new matrix.
const MATRIX_CUTOVER = '2026-11-26T09:10:45';

/** Average per-form duration over the last 7 days (excludes the run being written). */
export function getTimingBaseline(): Record<string, number> {
  const rows = getDb()
    .prepare(`SELECT form_name, AVG(duration_ms) AS avg_ms FROM form_timings WHERE run_timestamp >= MAX(strftime('%Y-%m-%dT%H:%M:%S', 'now', '-7 days'), ?) GROUP BY form_name`)
    .all(MATRIX_CUTOVER) as { form_name: string; avg_ms: number }[];
  return Object.fromEntries(rows.map((r) => [r.form_name, Math.round(r.avg_ms)]));
}
