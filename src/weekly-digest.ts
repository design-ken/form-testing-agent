import Database from 'better-sqlite3';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint } from './analysis.js';

// Builds weekly-digest.json (read by scripts/send_weekly_digest.py). Read-only on the DB.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '..', 'db', 'test-runs.sqlite');
const OUT = path.resolve(__dirname, '..', 'weekly-digest.json');

interface Row { form_name: string; device: string; category: string; status: string; severity: string | null; description: string }

// Plain-language fix suggestions keyed by axe rule id (extend as new rules show up).
const FIXES: Record<string, string> = {
  'color-contrast': 'Darken the grey helper/placeholder text (or lighten its background) to at least 4.5:1 contrast.',
  'link-in-text-block': 'Underline in-paragraph links, or give them a 3:1 colour difference from the surrounding text.',
  'button-name': 'Give each icon-only button an accessible name (aria-label or visible text).',
  'landmark-one-main': 'Wrap the main page content in a single <main> element.',
  'page-has-heading-one': 'Add exactly one H1 describing the page.',
  'heading-order': 'Keep heading levels sequential (H1 → H2 → H3); do not skip levels.',
  region: 'Put all visible content inside landmarks (header, main, nav, footer).',
  label: 'Associate every form field with a visible <label>.',
  'image-alt': 'Add meaningful alt text (or alt="" for decorative images).',
  'duplicate-id': 'Make element IDs unique on the page.',
  'select-name': 'Give every dropdown an accessible name.',
};

const ruleOf = (d: string) => /^\[axe-core\]\s+([\w-]+):/.exec(d)?.[1] ?? null;
const pretty = (rule: string | null, d: string) => (rule ? rule.replace(/-/g, ' ') : d.slice(0, 80));

function main(): void {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    // Full runs only (at least one pass) — crashed/empty runs must not look like "all fixed".
    const runs = db
      .prepare(`SELECT run_id, MAX(run_timestamp) AS ts FROM test_runs GROUP BY run_id HAVING SUM(status='pass') > 0 ORDER BY ts DESC`)
      .all() as { run_id: string; ts: string }[];
    if (!runs.length) throw new Error('No full runs in DB');

    const issuesOf = (runId: string) => db.prepare(`SELECT form_name, device, category, status, severity, description FROM test_runs WHERE run_id = ? AND status != 'pass'`).all(runId) as Row[];
    const keysOf = (rows: Row[]) => new Set(rows.map((r) => fingerprint(r.form_name, r.category, r.description)));

    const latest = runs[0];
    const latestRows = issuesOf(latest.run_id);
    const latestKeys = keysOf(latestRows);
    const msWeek = 7 * 86400000;
    const latestT = Date.parse(latest.ts);

    // Open-issue count at the last full run of each of the last 5 weeks (oldest first).
    const trend: number[] = [];
    for (let w = 4; w >= 0; w--) {
      const cutoff = latestT - w * msWeek;
      const run = runs.find((r) => Date.parse(r.ts) <= cutoff);
      trend.push(run ? keysOf(issuesOf(run.run_id)).size : 0);
    }

    const weekAgoRun = runs.find((r) => Date.parse(r.ts) <= latestT - msWeek);
    const weekAgoKeys = weekAgoRun ? keysOf(issuesOf(weekAgoRun.run_id)) : new Set<string>();
    const everBefore = new Set(
      (db.prepare(`SELECT form_name, category, description FROM test_runs WHERE status != 'pass' AND run_timestamp < ?`).all(new Date(latestT - msWeek).toISOString()) as Row[]).map((r) =>
        fingerprint(r.form_name, r.category, r.description)
      )
    );
    const newThisWeek = [...latestKeys].filter((k) => !everBefore.has(k)).length;
    const fixedRows = weekAgoRun ? issuesOf(weekAgoRun.run_id).filter((r) => !latestKeys.has(fingerprint(r.form_name, r.category, r.description))) : [];
    const fixedList = [...new Set(fixedRows.map((r) => `${r.form_name} — ${pretty(ruleOf(r.description), r.description)}`))].slice(0, 10);

    // Group today's issues by rule across forms for the "fix these first" table.
    const groups = new Map<string, { rule: string | null; label: string; severity: string | null; forms: Set<string>; spots: number; category: string }>();
    const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
    for (const r of latestRows) {
      const rule = ruleOf(r.description);
      const key = rule ?? `${r.category}:${r.description}`;
      const spots = Number(/\((\d+) element\(s\) affected\)/.exec(r.description)?.[1] ?? 1);
      const g = groups.get(key) ?? { rule, label: pretty(rule, r.description), severity: r.severity, forms: new Set<string>(), spots: 0, category: r.category };
      g.forms.add(r.form_name);
      g.spots += spots;
      if ((rank[r.severity ?? ''] ?? 3) < (rank[g.severity ?? ''] ?? 3)) g.severity = r.severity;
      groups.set(key, g);
    }
    const top = [...groups.values()]
      .sort((a, b) => (rank[a.severity ?? ''] ?? 3) - (rank[b.severity ?? ''] ?? 3) || b.forms.size - a.forms.size || b.spots - a.spots)
      .slice(0, 8)
      .map((g) => ({
        issue: g.label,
        severity: g.severity,
        where: `${g.forms.size === 4 ? 'All 4 forms' : [...g.forms].join(', ')} · ${g.spots} spot${g.spots === 1 ? '' : 's'}`,
        fix: (g.rule && FIXES[g.rule]) || (g.category === 'layout' ? 'Check this on a real device and adjust spacing/positioning.' : 'Review with the page owner.'),
      }));

    const out = {
      generatedAt: new Date().toISOString(),
      periodEnd: latest.ts,
      openIssues: latestKeys.size,
      highSeverity: new Set(latestRows.filter((r) => r.severity === 'high').map((r) => fingerprint(r.form_name, r.category, r.description))).size,
      newThisWeek,
      fixedThisWeek: fixedList.length,
      fixedList,
      trend,
      top,
    };
    return void writeFile(OUT, JSON.stringify(out, null, 2), 'utf-8').then(() => console.log(`[weekly-digest] Wrote ${OUT}: ${out.openIssues} open, ${newThisWeek} new, ${out.fixedThisWeek} fixed`));
  } finally {
    db.close();
  }
}
main();
