import { Client } from '@notionhq/client';
import { VIEWPORTS } from './forms.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunSummary, TestResult, ConsolidatedIssue, Evidence } from './types.js';

let client: Client | null = null;

function getClient(): Client {
  if (!client) {
    const token = process.env.NOTION_TOKEN;
    if (!token) {
      throw new Error('NOTION_TOKEN is not set.');
    }
    client = new Client({ auth: token });
  }
  return client;
}

// Notion's 2025-09-03 API split each database into one or more "data
// sources" — writes now target a data_source_id, not the database_id
// directly (confirmed live: the old database_id-as-parent call fails).
// We resolve NOTION_DATABASE_ID -> its first data source once per process
// and cache it, so the env var setup stays a single ID like before.
let cachedDataSourceId: string | null = null;

async function getDataSourceId(): Promise<string> {
  if (cachedDataSourceId) return cachedDataSourceId;

  const databaseId = process.env.NOTION_DATABASE_ID;
  if (!databaseId) {
    throw new Error('NOTION_DATABASE_ID is not set.');
  }

  const db = await getClient().databases.retrieve({ database_id: databaseId });
  const dataSources = (db as { data_sources?: Array<{ id: string }> }).data_sources;
  if (!dataSources || dataSources.length === 0) {
    throw new Error(`Database ${databaseId} has no data sources.`);
  }

  cachedDataSourceId = dataSources[0].id;
  return cachedDataSourceId;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One page per run. The DATABASE ROW is the at-a-glance verdict (status, urgent / new / known / fixed
 * counts, real-lead result, per-form seconds). The PAGE reads top-down: verdict, what needs action,
 * what is new (with evidence screenshots), what is fixed, device coverage, speed, then everything
 * else collapsed (known issues, full per-check log).
 */
const FIELD_NAMES = {
  title: 'Name',
  status: 'Status',
  urgent: 'Urgent',
  newIssues: 'New issues',
  known: 'Known issues',
  fixed: 'Fixed',
  formsHealthy: 'Forms healthy',
  realLead: 'Real test lead',
  failed: 'Failed',
  atRisk: 'At Risk',
  errored: 'Errored',
  testType: 'Test Type',
  dateTime: 'Date',
  sampleReportTime: 'Sample Report Time (s)',
  customFormTime: 'Custom Form Time (s)',
  talkToUsTime: 'Talk to Us Time (s)',
  discoveryCallTime: 'Book a Discovery Call Time (s)',
};

const TEST_TYPE_VALUE = 'Lead Form';
const FORM_NAMES = ['Sample Report', 'Custom Form', 'Talk to Us', 'Book a Discovery Call'];
const STATUS_ICON: Record<TestResult['status'], string> = { pass: '✅', fail: '🚩', at_risk: '⚠️', error: '❌' };

// Plain-language names and fixes for the axe rules this site keeps hitting.
const RULES: Record<string, { label: string; fix: string }> = {
  'button-name': { label: 'Buttons without a readable name', fix: 'Add an aria-label (or visible text) to each icon-only button.' },
  'color-contrast': { label: 'Low text colour contrast', fix: 'Darken the text (or lighten the background) to at least 4.5:1 contrast.' },
  'link-in-text-block': { label: 'Links not distinguishable from surrounding text', fix: 'Underline in-paragraph links, or give them a 3:1 colour difference.' },
  'landmark-one-main': { label: 'No <main> landmark', fix: 'Wrap the primary page content in a <main> element.' },
  'page-has-heading-one': { label: 'No H1 heading', fix: 'Add exactly one H1 that describes the page.' },
  'heading-order': { label: 'Headings skip a level', fix: 'Use heading levels in order (H1 → H2 → H3) without skipping.' },
  region: { label: 'Content outside page landmarks', fix: 'Place all visible content inside landmarks such as header, main, footer.' },
};

function ruleOf(issue: ConsolidatedIssue): { label: string; fix?: string } {
  const id = issue.ruleId ?? /^\[axe-core\]\s*([\w-]+)/.exec(issue.description)?.[1];
  if (id && RULES[id]) return RULES[id];
  if (/no visible confirmation/i.test(issue.description)) return { label: 'Submit gave no confirmation (possible silent failure)', fix: 'Check the form manually and the CRM for the test lead; the page screenshot below shows the state after submit.' };
  const d = issue.description.replace(/^\[axe-core\]\s*/, '').replace(/\s*\(\d+ element\(s\) affected\)/, '').replace(/\s*\(confirmed on retry\)/, '');
  return { label: d.length > 90 ? d.slice(0, d.lastIndexOf(' ', 90)) + '…' : d };
}

function realLeadOf(summary: RunSummary): string {
  const rs = summary.results.filter((x) => x.description.startsWith('Valid submission'));
  if (!rs.length) return 'Not today';
  if (rs.every((x) => x.status === 'pass')) return 'Submitted ✔';
  return rs.some((x) => x.status === 'fail') ? 'No confirmation ✖' : 'Blocked ⚠';
}

function realLeadText(summary: RunSummary): string {
  const rs = summary.results.filter((x) => x.description.startsWith('Valid submission'));
  const l = summary.realLeads;
  if (!rs.length) return `Real test leads: none this run${l ? ` (${l.today} of ${l.cap} done today)` : ''}.`;
  const ok = rs.filter((x) => x.status === 'pass').length;
  const detail = rs.map((x) => `${x.formName} / ${x.target ?? x.device} ${x.status === 'pass' ? '✔' : x.status === 'at_risk' ? '⚠ blocked by validation' : '✖ no confirmation'}`).join('; ');
  return `Real test leads this run: ${rs.length} (${ok} confirmed)${l ? `, ${l.today} of ${l.cap} today` : ''} — ${detail}.`;
}

function verdict(summary: RunSummary): { status: string; headline: string; icon: string } {
  const issues = summary.consolidatedIssues ?? [];
  const urgent = issues.filter((i) => i.urgent);
  const fresh = issues.filter((i) => i.isNew && !i.urgent);
  if (summary.runFailed) return { status: '⚠️ Run failed', headline: 'run failed — nothing was tested', icon: '⚠️' };
  if (urgent.length) {
    const forms = [...new Set(urgent.map((u) => u.formName))].join(', ');
    return { status: '🔴 Urgent', headline: `URGENT — ${forms} can't submit`, icon: '🔴' };
  }
  if (fresh.length) return { status: '🟡 New issues', headline: `${fresh.length} new issue${fresh.length > 1 ? 's' : ''}`, icon: '🟡' };
  return { status: '🟢 Healthy', headline: 'all forms working', icon: '🟢' };
}

function buildTitle(summary: RunSummary): string {
  const when = new Date(summary.runTimestamp).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  });
  return `${when} — ${verdict(summary).headline}`;
}

function buildProperties(summary: RunSummary): Record<string, unknown> {
  const v = verdict(summary);
  const issues = summary.consolidatedIssues ?? [];
  const urgentForms = new Set(issues.filter((i) => i.urgent).map((i) => i.formName));
  const props: Record<string, unknown> = {
    [FIELD_NAMES.title]: { title: [{ text: { content: buildTitle(summary) } }] },
    [FIELD_NAMES.status]: { select: { name: v.status } },
    [FIELD_NAMES.urgent]: { number: issues.filter((i) => i.urgent).length },
    [FIELD_NAMES.newIssues]: { number: summary.issueDelta?.newCount ?? 0 },
    [FIELD_NAMES.known]: { number: summary.issueDelta?.knownCount ?? 0 },
    [FIELD_NAMES.fixed]: { number: summary.issueDelta?.fixed.length ?? 0 },
    [FIELD_NAMES.formsHealthy]: { rich_text: [{ text: { content: `${FORM_NAMES.length - urgentForms.size} / ${FORM_NAMES.length}` } }] },
    [FIELD_NAMES.realLead]: { select: { name: realLeadOf(summary) } },
    [FIELD_NAMES.failed]: { number: summary.totalFail },
    [FIELD_NAMES.atRisk]: { number: summary.totalAtRisk },
    [FIELD_NAMES.errored]: { number: summary.totalError },
    [FIELD_NAMES.testType]: { select: { name: TEST_TYPE_VALUE } },
    [FIELD_NAMES.dateTime]: { date: { start: summary.runTimestamp } },
  };
  const timeField: Record<string, string> = {
    'Sample Report': FIELD_NAMES.sampleReportTime,
    'Custom Form': FIELD_NAMES.customFormTime,
    'Talk to Us': FIELD_NAMES.talkToUsTime,
    'Book a Discovery Call': FIELD_NAMES.discoveryCallTime,
  };
  for (const m of summary.formMetrics ?? []) {
    if (timeField[m.formName]) props[timeField[m.formName]] = { number: Math.round((m.durationMs / 1000) * 10) / 10 };
  }
  return props;
}

// ---- block helpers (Notion limits: 100 blocks/call, 2000 chars per rich_text) ----
const MAX_RICH_TEXT_LENGTH = 2000;
const BLOCK_BATCH_SIZE = 90;
const truncate = (t: string) => (t.length > MAX_RICH_TEXT_LENGTH ? t.slice(0, MAX_RICH_TEXT_LENGTH - 1) + '…' : t);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NotionBlock = any;
const rt = (t: string, bold = false) => ({ type: 'text', text: { content: truncate(t) }, ...(bold ? { annotations: { bold: true } } : {}) });
const heading2 = (t: string): NotionBlock => ({ object: 'block', type: 'heading_2', heading_2: { rich_text: [rt(t)] } });
const heading3 = (t: string): NotionBlock => ({ object: 'block', type: 'heading_3', heading_3: { rich_text: [rt(t)] } });
const paragraph = (t: string): NotionBlock => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [rt(t)] } });
const bullet = (t: string): NotionBlock => ({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [rt(t)] } });
const callout = (icon: string, t: string, color = 'gray_background'): NotionBlock => ({
  object: 'block', type: 'callout', callout: { rich_text: [rt(t, true)], icon: { type: 'emoji', emoji: icon }, color },
});
const toggle = (title: string, children: NotionBlock[]): NotionBlock => ({
  object: 'block', type: 'toggle', toggle: { rich_text: [rt(title, true)], children: children.slice(0, 95) },
});
const table = (header: string[], rows: string[][]): NotionBlock => ({
  object: 'block', type: 'table',
  table: {
    table_width: header.length, has_column_header: true, has_row_header: false,
    children: [header, ...rows].map((cells) => ({ object: 'block', type: 'table_row', table_row: { cells: cells.map((c) => [rt(c)]) } })),
  },
});

/** Uploads an evidence crop to Notion (no public hosting needed). Returns an image block, or null on any failure. */
async function imageBlock(ev: Evidence, caption: string): Promise<NotionBlock | null> {
  try {
    const data = new Blob([await readFile(ev.path)], { type: 'image/png' });
    const up = await getClient().fileUploads.create({ mode: 'single_part', filename: path.basename(ev.path), content_type: 'image/png' } as never);
    await getClient().fileUploads.send({ file_upload_id: up.id, file: { data, filename: path.basename(ev.path) } } as never);
    await sleep(250);
    return { object: 'block', type: 'image', image: { type: 'file_upload', file_upload: { id: up.id }, caption: [rt(caption)] } };
  } catch (err) {
    console.error('[notion] Evidence upload failed (skipping image):', (err as Error).message);
    return null;
  }
}

async function issueBlocks(issue: ConsolidatedIssue, withEvidence: boolean, pageShot?: string): Promise<NotionBlock[]> {
  const r = ruleOf(issue);
  const sev = issue.severity ? ` [${issue.severity.toUpperCase()}]` : '';
  const blocks: NotionBlock[] = [heading3(`${STATUS_ICON[issue.status === 'fail' ? 'fail' : 'at_risk']} ${r.label} — ${issue.formName}${sev}`)];
  blocks.push(bullet(`Seen on: ${issue.affectedDevices.join(', ')}`));
  if (r.fix) blocks.push(bullet(`Fix: ${r.fix}`));
  if (issue.urgent) blocks.push(bullet(`Details: ${issue.description}${issue.confirmedOnRetry ? '' : ''}`));
  if (withEvidence) {
    const evs: Evidence[] = (issue.evidence ?? []).slice(0, 2);
    if (!evs.length && issue.urgent && pageShot) evs.push({ path: pageShot, selector: '', html: '' });
    for (const ev of evs) {
      const img = await imageBlock(ev, `${issue.formName} — ${r.label}${ev.html ? ' · ' + ev.html.slice(0, 100) : ''}`);
      if (img) blocks.push(img);
    }
  }
  return blocks;
}

function coverageTable(summary: RunSummary): NotionBlock {
  const order = VIEWPORTS.map((v) => v.label);
  const counts = new Map<string, { pass: number; risk: number; bad: number }>();
  for (const r of summary.results) {
    const t = r.target ?? r.device;
    const c = counts.get(t) ?? { pass: 0, risk: 0, bad: 0 };
    if (r.status === 'pass') c.pass++; else if (r.status === 'at_risk') c.risk++; else c.bad++;
    counts.set(t, c);
  }
  const names = [...order.filter((n) => counts.has(n)), ...[...counts.keys()].filter((n) => !order.includes(n))];
  return table(['Device · browser', 'Passed', 'At risk', 'Failed'], names.map((n) => {
    const c = counts.get(n)!;
    return [n, String(c.pass), String(c.risk), c.bad ? `${c.bad}` : '0'];
  }));
}

async function buildPageContent(summary: RunSummary): Promise<NotionBlock[]> {
  const blocks: NotionBlock[] = [];
  const v = verdict(summary);
  const issues = summary.consolidatedIssues ?? [];
  const delta = summary.issueDelta;

  if (summary.runFailed) {
    blocks.push(callout('⚠️', `Run failed to complete: ${summary.runFailureReason ?? 'unknown error'}`, 'red_background'));
    return blocks;
  }

  const color = v.icon === '🔴' ? 'red_background' : v.icon === '🟡' ? 'yellow_background' : 'green_background';
  blocks.push(callout(v.icon, `${v.headline[0].toUpperCase()}${v.headline.slice(1)} · ${delta?.newCount ?? 0} new · ${delta?.knownCount ?? 0} known · ${delta?.fixed.length ?? 0} fixed`, color));
  blocks.push(paragraph(`${realLeadText(summary)} ${summary.totalPass} checks passed across ${new Set(summary.results.map((r) => r.target ?? r.device)).size} devices/browsers (emulated, not physical devices).`));

  // Every real submission this run, with what the page actually showed afterwards.
  const leads = summary.results.filter((x) => x.description.startsWith('Valid submission'));
  if (leads.length) {
    blocks.push(heading2('Real test leads this run'));
    for (const x of leads) {
      const ok = x.status === 'pass';
      const ev = x.evidence?.[0];
      blocks.push(bullet(`${ok ? '✔ Confirmed' : x.status === 'at_risk' ? '⚠ Blocked by form validation (no lead created)' : '✖ No confirmation detected'} — ${x.formName} / ${x.target ?? x.device}${ev ? `. ${ev.selector}. Page text: ${ev.html}` : ''}`));
      if (ev) {
        const img = await imageBlock(ev, `${x.formName} / ${x.target ?? x.device} — page right after submit`);
        if (img) blocks.push(img);
      }
    }
  }

  const urgent = issues.filter((i) => i.urgent);
  if (urgent.length) {
    blocks.push(heading2('🔴 Needs action now'));
    for (const i of urgent) {
      const shot = summary.results.find((x) => x.formName === i.formName && (x.target ?? x.device) === i.affectedDevices[0] && x.screenshotPath)?.screenshotPath ?? undefined;
      blocks.push(...(await issueBlocks(i, !i.description.startsWith('Valid submission'), shot)));
    }
  }

  const fresh = issues.filter((i) => i.isNew && !i.urgent);
  if (fresh.length) {
    blocks.push(heading2('🆕 New this run'));
    for (const i of fresh) blocks.push(...(await issueBlocks(i, true)));
  }

  if (delta?.fixed.length) {
    blocks.push(heading2('✔ Fixed since last run'));
    for (const f of delta.fixed.slice(0, 10)) blocks.push(bullet(`${f.formName} — ${f.description.replace(/^\[axe-core\]\s*/, '').slice(0, 120)}`));
  }

  blocks.push(heading2('Devices & browsers tested'));
  blocks.push(coverageTable(summary));

  if (summary.formMetrics?.length) {
    const base = summary.timingBaselineMs ?? {};
    blocks.push(heading2('Speed'));
    blocks.push(table(['Form', 'Test time', 'vs 7-day avg'], summary.formMetrics.map((m) => {
      const b = base[m.formName];
      return [m.formName, `${(m.durationMs / 1000).toFixed(0)}s`, b ? `${Math.round(((m.durationMs - b) / b) * 100) >= 0 ? '+' : ''}${Math.round(((m.durationMs - b) / b) * 100)}%` : '—'];
    })));
  }

  // Known issues: collapsed, grouped by problem (not repeated per device). Evidence only on the day's first run.
  const known = issues.filter((i) => !i.isNew && !i.urgent);
  if (known.length) {
    const groups = new Map<string, { label: string; fix?: string; forms: Map<string, ConsolidatedIssue> }>();
    for (const i of known) {
      const r = ruleOf(i);
      const g = groups.get(r.label) ?? { label: r.label, fix: r.fix, forms: new Map() };
      if (!g.forms.has(i.formName) || (i.evidence?.length && !g.forms.get(i.formName)!.evidence?.length)) g.forms.set(i.formName, i);
      groups.set(r.label, g);
    }
    const children: NotionBlock[] = [];
    for (const g of groups.values()) {
      children.push(bullet(`${g.label} — ${[...g.forms.keys()].join(', ')}${g.fix ? `. Fix: ${g.fix}` : ''}`));
      if (summary.includeKnownEvidence) {
        for (const issue of g.forms.values()) {
          const ev = issue.evidence?.[0];
          if (ev) { const img = await imageBlock(ev, `${issue.formName} — ${g.label}${ev.html ? ' · ' + ev.html.slice(0, 100) : ''}`); if (img) children.push(img); }
        }
      }
    }
    blocks.push(toggle(`Known issues (${known.length}) — unchanged, already tracked`, children));
  }

  // Full per-check log: one collapsed toggle per form, every check on every target.
  blocks.push(heading2('Full per-check log'));
  for (const form of FORM_NAMES) {
    const rows = summary.results.filter((r) => r.formName === form);
    if (!rows.length) continue;
    const byTarget = new Map<string, TestResult[]>();
    for (const r of rows) byTarget.set(r.target ?? r.device, [...(byTarget.get(r.target ?? r.device) ?? []), r]);
    const children: NotionBlock[] = [];
    for (const [t, rs] of byTarget) {
      children.push(bullet(`${t}: ${rs.filter((r) => r.status === 'pass').length} passed` + rs.filter((r) => r.status !== 'pass').map((r) => `\n${STATUS_ICON[r.status]} ${r.description.replace(/^\[axe-core\]\s*/, '')}`).join('')));
    }
    blocks.push(toggle(form, children));
  }
  return blocks;
}

/**
 * Writes one page per run. Retries once on failure. Never throws — the caller treats a Notion failure as non-fatal.
 */
export async function writeRunSummary(
  summary: RunSummary
): Promise<{ ok: boolean; error?: string; pageUrl?: string }> {
  const attempt = async (): Promise<string | undefined> => {
    const dataSourceId = await getDataSourceId();
    const page = await getClient().pages.create({
      parent: { data_source_id: dataSourceId },
      properties: buildProperties(summary) as never,
    });

    const blocks = await buildPageContent(summary);
    for (let i = 0; i < blocks.length; i += BLOCK_BATCH_SIZE) {
      await getClient().blocks.children.append({ block_id: page.id, children: blocks.slice(i, i + BLOCK_BATCH_SIZE) as never });
      if (i + BLOCK_BATCH_SIZE < blocks.length) await sleep(350);
    }
    return (page as { url?: string }).url;
  };

  try {
    return { ok: true, pageUrl: await attempt() };
  } catch (firstErr) {
    console.error('[notion] First write attempt failed, retrying in 2s:', (firstErr as Error).message);
    await sleep(2000);
    try {
      return { ok: true, pageUrl: await attempt() };
    } catch (secondErr) {
      const message = (secondErr as Error).message;
      console.error('[notion] Retry also failed:', message);
      return { ok: false, error: message };
    }
  }
}
