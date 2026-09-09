import { Client } from '@notionhq/client';
import type { RunSummary, TestResult, Device } from './types.js';

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
 * One page per run (not one row per check) — these are the page-level
 * properties, visible as columns in the Notion database view. Per-check
 * detail (all 4 forms x 3 devices) lives in the page's block content
 * instead (see buildPageContent), keeping the database view itself scannable.
 */
const FIELD_NAMES = {
  title: 'Name',
  status: 'Status',
  failed: 'Failed',
  atRisk: 'At Risk',
  errored: 'Errored',
  testType: 'Test Type',
  dateTime: 'Date',
  sampleReportTime: 'Sample Report Time (ms)',
  customFormTime: 'Custom Form Time (ms)',
  talkToUsTime: 'Talk to Us Time (ms)',
  discoveryCallTime: 'Book a Discovery Call Time (ms)',
};

const TEST_TYPE_VALUE = 'Lead Form';
const STATUS_ICON: Record<TestResult['status'], string> = {
  pass: '✅',
  fail: '🚩',
  at_risk: '⚠️',
  error: '❌',
};

function overallStatus(summary: RunSummary): string {
  if (summary.runFailed) return 'Run Failed';
  if (summary.totalFail > 0 || summary.totalError > 0 || summary.totalAtRisk > 0) return 'Issues Found';
  return 'All Passed';
}

function buildTitle(summary: RunSummary): string {
  const date = new Date(summary.runTimestamp);
  const formatted = date.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return `Lead Form Tester — ${formatted}`;
}

function buildProperties(summary: RunSummary): Record<string, unknown> {
  const props: Record<string, unknown> = {
    [FIELD_NAMES.title]: {
      title: [{ text: { content: buildTitle(summary) } }],
    },
    [FIELD_NAMES.status]: { select: { name: overallStatus(summary) } },
    [FIELD_NAMES.failed]: { number: summary.totalFail },
    [FIELD_NAMES.atRisk]: { number: summary.totalAtRisk },
    [FIELD_NAMES.errored]: { number: summary.totalError },
    [FIELD_NAMES.testType]: { select: { name: TEST_TYPE_VALUE } },
    [FIELD_NAMES.dateTime]: { date: { start: summary.runTimestamp } },
  };

  // Add per-form timing if available
  if (summary.formMetrics) {
    for (const metric of summary.formMetrics) {
      if (metric.formName === 'Sample Report') {
        props[FIELD_NAMES.sampleReportTime] = { number: metric.durationMs };
      } else if (metric.formName === 'Custom Form') {
        props[FIELD_NAMES.customFormTime] = { number: metric.durationMs };
      } else if (metric.formName === 'Talk to Us') {
        props[FIELD_NAMES.talkToUsTime] = { number: metric.durationMs };
      } else if (metric.formName === 'Book a Discovery Call') {
        props[FIELD_NAMES.discoveryCallTime] = { number: metric.durationMs };
      }
    }
  }

  return props;
}

// Notion block content has hard limits: max 100 blocks per API call, and
// max 2000 characters per rich_text content string — both enforced live by
// the API, not just documented. Long descriptions get truncated defensively;
// callers batch block arrays into chunks of BLOCK_BATCH_SIZE.
const MAX_RICH_TEXT_LENGTH = 2000;
const BLOCK_BATCH_SIZE = 90; // stay under Notion's 100-block-per-call limit with headroom

function truncate(text: string): string {
  return text.length > MAX_RICH_TEXT_LENGTH ? text.slice(0, MAX_RICH_TEXT_LENGTH - 1) + '…' : text;
}

function heading2(text: string) {
  return {
    object: 'block' as const,
    type: 'heading_2' as const,
    heading_2: { rich_text: [{ type: 'text' as const, text: { content: truncate(text) } }] },
  };
}

function heading3(text: string) {
  return {
    object: 'block' as const,
    type: 'heading_3' as const,
    heading_3: { rich_text: [{ type: 'text' as const, text: { content: truncate(text) } }] },
  };
}

function bulletItem(text: string) {
  return {
    object: 'block' as const,
    type: 'bulleted_list_item' as const,
    bulleted_list_item: { rich_text: [{ type: 'text' as const, text: { content: truncate(text) } }] },
  };
}

function paragraph(text: string) {
  return {
    object: 'block' as const,
    type: 'paragraph' as const,
    paragraph: { rich_text: [{ type: 'text' as const, text: { content: truncate(text) } }] },
  };
}

/**
 * Builds the full report as Notion blocks: a run-level summary, then one
 * heading per form, one sub-heading per device, and one bullet per check
 * result — grouped so the page reads like a structured report rather than
 * a flat dump of 138 rows.
 */
type NotionBlock = ReturnType<typeof paragraph | typeof heading2 | typeof heading3 | typeof bulletItem>;

function buildPageContent(summary: RunSummary): NotionBlock[] {
  const blocks: NotionBlock[] = [];

  blocks.push(
    paragraph(
      `${summary.totalPass} passed · ${summary.totalFail} failed · ${summary.totalAtRisk} at risk · ${summary.totalError} errored`
    )
  );

  // Add per-form timing if available
  if (summary.formMetrics && summary.formMetrics.length > 0) {
    blocks.push(heading2('Test Duration per Form'));
    for (const metric of summary.formMetrics) {
      blocks.push(bulletItem(`${metric.formName}: ${(metric.durationMs / 1000).toFixed(2)}s`));
    }
  }

  if (summary.runFailed) {
    blocks.push(paragraph(`⚠️ Run failed to complete: ${summary.runFailureReason ?? 'unknown error'}`));
    return blocks;
  }

  // Add consolidated issues list if there are any failures/at-risk
  if (summary.consolidatedIssues && summary.consolidatedIssues.length > 0) {
    blocks.push(heading2('Issues to Fix'));
    for (const issue of summary.consolidatedIssues) {
      const devices = issue.affectedDevices.join(', ');
      const severityTag = issue.severity ? ` [${issue.severity.toUpperCase()}]` : '';
      blocks.push(
        bulletItem(
          `${STATUS_ICON[issue.status === 'fail' ? 'fail' : 'at_risk']} ${issue.formName} (${issue.category})${severityTag} — ${issue.description} (affected: ${devices})`
        )
      );
    }
  }

  const byForm = new Map<string, TestResult[]>();
  for (const r of summary.results) {
    const list = byForm.get(r.formName) ?? [];
    list.push(r);
    byForm.set(r.formName, list);
  }

  blocks.push(heading2('Detailed Results'));
  for (const [formName, formResults] of byForm) {
    blocks.push(heading3(formName));

    const byDevice = new Map<Device, TestResult[]>();
    for (const r of formResults) {
      const list = byDevice.get(r.device) ?? [];
      list.push(r);
      byDevice.set(r.device, list);
    }

    const deviceOrder: Device[] = ['desktop', 'tablet', 'mobile'];
    for (const device of deviceOrder) {
      const deviceResults = byDevice.get(device);
      if (!deviceResults) continue;

      blocks.push(heading3(device.charAt(0).toUpperCase() + device.slice(1)));
      for (const r of deviceResults) {
        blocks.push(bulletItem(`${STATUS_ICON[r.status]} ${r.description}`));
      }
    }
  }

  return blocks;
}

/**
 * Writes one page per run (not one row per check), with the full 4-forms x
 * 3-devices breakdown as structured block content inside that page.
 * Retries once on failure. Never throws — caller treats Notion failure as
 * non-fatal.
 */
export async function writeRunSummary(summary: RunSummary): Promise<{ ok: boolean; error?: string }> {
  const attempt = async () => {
    const dataSourceId = await getDataSourceId();
    const page = await getClient().pages.create({
      parent: { data_source_id: dataSourceId },
      properties: buildProperties(summary) as never,
    });

    const blocks = buildPageContent(summary);
    for (let i = 0; i < blocks.length; i += BLOCK_BATCH_SIZE) {
      const batch = blocks.slice(i, i + BLOCK_BATCH_SIZE);
      await getClient().blocks.children.append({ block_id: page.id, children: batch as never });
      if (i + BLOCK_BATCH_SIZE < blocks.length) await sleep(350); // ~3 req/sec ceiling
    }
  };

  try {
    await attempt();
    return { ok: true };
  } catch (firstErr) {
    console.error('[notion] First write attempt failed, retrying in 2s:', (firstErr as Error).message);
    await sleep(2000);
    try {
      await attempt();
      return { ok: true };
    } catch (secondErr) {
      const message = (secondErr as Error).message;
      console.error('[notion] Retry also failed:', message);
      return { ok: false, error: message };
    }
  }
}
