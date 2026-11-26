import type Database from 'better-sqlite3';
import type { Category, FixedIssue, IssueDelta, Severity, Status, TestResult } from './types.js';

// Shared issue logic for run reports, the weekly digest and the dashboard:
// what is NEW vs KNOWN vs FIXED, and what counts as URGENT.

/** How far back a prior occurrence still counts as "known" rather than new. */
export const KNOWN_WINDOW_DAYS = 14;

/** Revenue-critical = a form that can't load or can't submit. Everything else (a11y, layout) is backlog. */
export function isUrgent(category: Category | string, status: Status | string): boolean {
  return (category === 'functional' || category === 'availability') && (status === 'fail' || status === 'error');
}

/** Stable identity for an issue across runs: axe's "(N element(s) affected)" count varies run to run, so strip it. */
export function fingerprint(formName: string, category: string, description: string): string {
  const d = description.replace(/\(\d+ element\(s\) affected\)/g, '').replace(/\s+/g, ' ').trim();
  return `${formName}|${category}|${d}`;
}

interface Row { run_id: string; form_name: string; category: string; description: string; severity: string | null }

/**
 * Compares this run's non-pass results with history. Call BEFORE inserting
 * this run into the DB so "history" never includes the run itself.
 */
export function computeDelta(db: Database.Database, current: TestResult[]): { delta: IssueDelta; newKeys: Set<string> } {
  const known = new Set(
    (db
      .prepare(
        `SELECT form_name, category, description FROM test_runs
         WHERE status != 'pass' AND run_timestamp >= datetime('now', ?)`
      )
      .all(`-${KNOWN_WINDOW_DAYS} days`) as Row[]).map((r) => fingerprint(r.form_name, r.category, r.description))
  );

  const nowKeys = new Map<string, TestResult>();
  for (const r of current) if (r.status !== 'pass') nowKeys.set(fingerprint(r.formName, r.category, r.description), r);

  const newKeys = new Set<string>();
  let knownCount = 0;
  for (const k of nowKeys.keys()) (known.has(k) ? knownCount++ : newKeys.add(k));

  // "Fixed" = in the most recent earlier run that actually tested things (>0 passes), absent now.
  const prev = db
    .prepare(
      `SELECT run_id FROM test_runs GROUP BY run_id
       HAVING SUM(status = 'pass') > 0
       ORDER BY MAX(run_timestamp) DESC LIMIT 1`
    )
    .get() as { run_id: string } | undefined;

  const fixed: FixedIssue[] = [];
  if (prev && current.some((r) => r.status === 'pass')) {
    const prevRows = db
      .prepare(`SELECT form_name, category, description, severity FROM test_runs WHERE run_id = ? AND status != 'pass'`)
      .all(prev.run_id) as Row[];
    const seen = new Set<string>();
    for (const r of prevRows) {
      const k = fingerprint(r.form_name, r.category, r.description);
      // A real-submission check only exists in runs that drew a submission slot, so its absence isn't a fix.
      if (nowKeys.has(k) || seen.has(k) || r.description.startsWith('Valid submission')) continue;
      seen.add(k);
      fixed.push({ formName: r.form_name, category: r.category as Category, description: r.description, severity: r.severity as Severity | null });
    }
  }

  return { delta: { newCount: newKeys.size, knownCount, fixed }, newKeys };
}
