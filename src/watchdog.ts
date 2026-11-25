import Database from 'better-sqlite3';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Silent-failure check, independent of the test runs themselves: a skipped
// cron, a disabled schedule, a green-but-empty run, or a missing daily lead
// produce NO signal from the run's own email. Writes watchdog.json.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '..', 'db', 'test-runs.sqlite');
const OUT = path.resolve(__dirname, '..', 'watchdog.json');
const STALE_HOURS = 11;
const LEAD_CHECK_AFTER_IST_HOUR = 22; // evening run (8:30 PM IST) has finished by now

const db = new Database(DB_PATH, { readonly: true });
const reasons: string[] = [];
const now = Date.now();
const istNow = new Date(now + 5.5 * 3600000);
const istDay = istNow.toISOString().slice(0, 10);

const latest = db.prepare(`SELECT run_id, MAX(run_timestamp) AS ts FROM test_runs GROUP BY run_id ORDER BY ts DESC LIMIT 1`).get() as { run_id: string; ts: string } | undefined;
if (!latest) {
  reasons.push('No test runs found in the database at all.');
} else {
  const hours = (now - Date.parse(latest.ts)) / 3600000;
  if (hours > STALE_HOURS) {
    reasons.push(`No test run completed in ${Math.floor(hours)} hours (last: ${latest.ts}). GitHub may have skipped the schedule, disabled it after 60 days idle, or the workflow is failing before tests start.`);
  }
  const c = db.prepare(`SELECT SUM(status='pass') AS passes, COUNT(*) AS total FROM test_runs WHERE run_id = ?`).get(latest.run_id) as { passes: number; total: number };
  if (!c.passes) reasons.push(`The latest run (${latest.ts}) had 0 passing checks out of ${c.total} — it tested nothing (browser failed to start?).`);
}
if (istNow.getUTCHours() >= LEAD_CHECK_AFTER_IST_HOUR) {
  const lead = db.prepare(`SELECT COUNT(*) AS n FROM test_runs WHERE description LIKE 'Valid submission%' AND date(run_timestamp, '+5 hours', '+30 minutes') = ?`).get(istDay) as { n: number };
  if (!lead.n) reasons.push(`Today's (${istDay}) one real test lead was never submitted.`);
}
db.close();

const out = { alert: reasons.length > 0, reasons, lastRun: latest?.ts ?? null, checkedAt: new Date(now).toISOString() };
await writeFile(OUT, JSON.stringify(out, null, 2), 'utf-8');
console.log(`[watchdog] ${out.alert ? 'ALERT' : 'ok'}: ${reasons.join(' | ') || 'all clear'}`);
