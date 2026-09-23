import Database from 'better-sqlite3';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Same DB_PATH resolution as db.ts, but opened read-only here — this
// script only reads the already-committed test_runs table to build the
// GitHub Pages dashboard's data.json, never writes to the DB.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '..', 'db', 'test-runs.sqlite');
const OUTPUT_PATH = path.resolve(__dirname, '..', 'docs', 'data.json');

const RUNS_PER_DAY = 3; // matches the current cron schedule (see run-tests.yml)

interface RunRow {
  run_id: string;
  run_timestamp: string;
  pass_count: number;
  fail_count: number;
  at_risk_count: number;
  error_count: number;
  total_count: number;
}

interface IssueOccurrenceRow {
  run_id: string;
  run_timestamp: string;
  form_name: string;
  category: string;
  description: string;
  severity: string | null;
}

interface LeadRow {
  run_timestamp: string;
  form_name: string;
}

/**
 * Exports FULL history (not windowed) — the dashboard's month picker
 * filters this client-side in the browser, so every section (run health,
 * leads recorded, trends) can recompute instantly for any selected month
 * without a second network request or a live backend. Dataset stays small
 * (a few hundred rows even after months of 3x/day runs), so shipping full
 * history as one JSON file is simpler than windowed exports plus
 * per-range re-queries.
 */
function buildDashboardData(db: Database.Database) {
  const generatedAt = new Date().toISOString();

  const runRows = db
    .prepare(
      `SELECT
         run_id, run_timestamp,
         SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) AS pass_count,
         SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) AS fail_count,
         SUM(CASE WHEN status = 'at_risk' THEN 1 ELSE 0 END) AS at_risk_count,
         SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
         COUNT(*) AS total_count
       FROM test_runs
       GROUP BY run_id, run_timestamp
       ORDER BY run_timestamp DESC`
    )
    .all() as RunRow[];

  const runs = runRows.map((r) => ({
    runId: r.run_id,
    runTimestamp: r.run_timestamp,
    passCount: r.pass_count,
    failCount: r.fail_count,
    atRiskCount: r.at_risk_count,
    errorCount: r.error_count,
    totalCount: r.total_count,
    passRatePct: r.total_count > 0 ? Math.round((r.pass_count / r.total_count) * 1000) / 10 : 0,
  }));

  // One row per non-pass check occurrence, carrying its run's timestamp —
  // the dashboard groups/dedupes these client-side per selected month
  // (same formName|category|description key used elsewhere in this repo),
  // rather than baking one fixed "top 20 all-time" list into the export.
  const issueOccurrenceRows = db
    .prepare(
      `SELECT run_id, run_timestamp, form_name, category, description, severity
       FROM test_runs
       WHERE status != 'pass'
       ORDER BY run_timestamp DESC`
    )
    .all() as IssueOccurrenceRow[];

  const issueOccurrences = issueOccurrenceRows.map((r) => ({
    runId: r.run_id,
    runTimestamp: r.run_timestamp,
    formName: r.form_name,
    category: r.category,
    description: r.description,
    severity: r.severity,
  }));

  // Real test leads = actual "Submit" clicks with valid data (see
  // functional.ts's shouldSubmit gating) — the exact description text used
  // there ("Valid submission...") is the marker for a real submission
  // attempt, distinct from the "submission skipped on this device" rows
  // that the 1-device-per-form change (2026-09-17) introduced for the
  // non-chosen devices.
  const leadRows = db
    .prepare(
      `SELECT run_timestamp, form_name
       FROM test_runs
       WHERE category = 'functional' AND description LIKE 'Valid submission%'
       ORDER BY run_timestamp DESC`
    )
    .all() as LeadRow[];

  const leads = leadRows.map((r) => ({ runTimestamp: r.run_timestamp, formName: r.form_name }));

  // Distinct months present in the data, newest first — drives the
  // dashboard's month-picker dropdown so it only ever lists months that
  // actually have runs (no empty months to select).
  const monthsSet = new Set(runs.map((r) => r.runTimestamp.slice(0, 7))); // "YYYY-MM"
  const availableMonths = Array.from(monthsSet).sort().reverse();

  return {
    generatedAt,
    runsPerDay: RUNS_PER_DAY,
    availableMonths,
    runs,
    issueOccurrences,
    leads,
  };
}

async function main(): Promise<void> {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const data = buildDashboardData(db);
    await writeFile(OUTPUT_PATH, JSON.stringify(data), 'utf-8');
    console.log(`[dashboard-export] Wrote ${OUTPUT_PATH} (${data.runs.length} runs, ${data.issueOccurrences.length} issue occurrences, ${data.leads.length} leads)`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error('[dashboard-export] Failed:', (err as Error).message);
  process.exitCode = 1;
});
