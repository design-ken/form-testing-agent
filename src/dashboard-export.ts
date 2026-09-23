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

const RUN_HEALTH_WINDOW_DAYS = 7;
const RUNS_PER_DAY = 3; // matches the current cron schedule (see run-tests.yml)
const RECURRING_ISSUES_LIMIT = 20;

interface RunHealthRow {
  run_id: string;
  run_timestamp: string;
  pass_count: number;
  fail_count: number;
  at_risk_count: number;
  error_count: number;
  total_count: number;
}

interface CurrentIssueRow {
  form_name: string;
  category: string;
  description: string;
  severity: string | null;
  affected_devices: string;
}

interface RecurringIssueRow {
  form_name: string;
  category: string;
  description: string;
  first_seen: string;
  last_seen: string;
  occurrence_count: number;
}

function buildDashboardData(db: Database.Database) {
  const generatedAt = new Date().toISOString();

  const runHealthRows = db
    .prepare(
      `SELECT
         run_id, run_timestamp,
         SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) AS pass_count,
         SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) AS fail_count,
         SUM(CASE WHEN status = 'at_risk' THEN 1 ELSE 0 END) AS at_risk_count,
         SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
         COUNT(*) AS total_count
       FROM test_runs
       WHERE run_timestamp >= datetime('now', '-${RUN_HEALTH_WINDOW_DAYS} days')
       GROUP BY run_id, run_timestamp
       ORDER BY run_timestamp DESC`
    )
    .all() as RunHealthRow[];

  const runHealth = runHealthRows.map((r) => ({
    runId: r.run_id,
    runTimestamp: r.run_timestamp,
    passCount: r.pass_count,
    failCount: r.fail_count,
    atRiskCount: r.at_risk_count,
    errorCount: r.error_count,
    totalCount: r.total_count,
    passRatePct: r.total_count > 0 ? Math.round((r.pass_count / r.total_count) * 1000) / 10 : 0,
  }));

  const latestRunRow = db
    .prepare('SELECT run_id, run_timestamp FROM test_runs ORDER BY run_timestamp DESC LIMIT 1')
    .get() as { run_id: string; run_timestamp: string } | undefined;

  let latestRun = null;
  let currentIssues: ReturnType<typeof mapCurrentIssue>[] = [];

  if (latestRunRow) {
    const latestHealth = runHealth.find((r) => r.runId === latestRunRow.run_id);
    latestRun = latestHealth ?? {
      runId: latestRunRow.run_id,
      runTimestamp: latestRunRow.run_timestamp,
      passCount: 0,
      failCount: 0,
      atRiskCount: 0,
      errorCount: 0,
      totalCount: 0,
      passRatePct: 0,
    };

    const currentIssueRows = db
      .prepare(
        `SELECT
           form_name, category, description, severity,
           GROUP_CONCAT(DISTINCT device) AS affected_devices
         FROM test_runs
         WHERE run_id = ? AND status != 'pass'
         GROUP BY form_name, category, description, severity
         ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END`
      )
      .all(latestRunRow.run_id) as CurrentIssueRow[];

    currentIssues = currentIssueRows.map(mapCurrentIssue);
  }

  const recurringIssueRows = db
    .prepare(
      `SELECT
         form_name, category, description,
         MIN(run_timestamp) AS first_seen, MAX(run_timestamp) AS last_seen,
         COUNT(DISTINCT run_id) AS occurrence_count
       FROM test_runs
       WHERE status != 'pass'
       GROUP BY form_name, category, description
       ORDER BY occurrence_count DESC
       LIMIT ${RECURRING_ISSUES_LIMIT}`
    )
    .all() as RecurringIssueRow[];

  const recurringIssues = recurringIssueRows.map((r) => ({
    formName: r.form_name,
    category: r.category,
    description: r.description,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    occurrenceCount: r.occurrence_count,
  }));

  // Expected-vs-actual is an approximation, not a precise "N runs missing"
  // count — a run that crashed before insertResults() left zero rows, so
  // this can only show an aggregate gap against the ~3/day cadence, not
  // identify which specific run is missing or why. Surfaced on the
  // dashboard with that caveat rather than presented as exact.
  const expectedRunsInWindow = RUN_HEALTH_WINDOW_DAYS * RUNS_PER_DAY;
  const actualRunsInWindow = runHealth.length;

  return {
    generatedAt,
    latestRun,
    runHealth,
    expectedRunsInWindow,
    actualRunsInWindow,
    currentIssues,
    recurringIssues,
  };
}

function mapCurrentIssue(r: CurrentIssueRow) {
  return {
    formName: r.form_name,
    category: r.category,
    description: r.description,
    severity: r.severity,
    affectedDevices: r.affected_devices ? r.affected_devices.split(',') : [],
  };
}

async function main(): Promise<void> {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const data = buildDashboardData(db);
    await writeFile(OUTPUT_PATH, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`[dashboard-export] Wrote ${OUTPUT_PATH}`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error('[dashboard-export] Failed:', (err as Error).message);
  process.exitCode = 1;
});
