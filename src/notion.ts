import { Client } from '@notionhq/client';
import type { TestResult } from './types.js';

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * FIELD MAPPING — EDIT THIS TO MATCH YOUR ACTUAL NOTION DATABASE.
 *
 * These property names are assumed based on the Track B spec (URL/component,
 * device, category, severity, description, screenshot, status, date/time,
 * test-type). Your existing database (ID confirmed as
 * 3d0369df402080758409f3e680b4bb59) may use different exact names/casing —
 * open the database in Notion, check each column header, and update the
 * strings on the right-hand side below to match exactly (Notion property
 * names are case-sensitive and must match exactly or the write will fail).
 */
const FIELD_NAMES = {
  title: 'Name', // Notion databases require exactly one "title" property — update to your DB's title column name
  url: 'URL',
  device: 'Device',
  category: 'Category',
  severity: 'Severity',
  status: 'Status',
  description: 'Description',
  screenshotPath: 'Screenshot',
  testType: 'Test Type',
  dateTime: 'Date',
};

const TEST_TYPE_VALUE = 'Lead Form';

function buildProperties(r: TestResult): Record<string, unknown> {
  return {
    [FIELD_NAMES.title]: {
      title: [{ text: { content: `${r.formName} — ${r.device} — ${r.category}` } }],
    },
    [FIELD_NAMES.url]: { url: r.formUrl },
    [FIELD_NAMES.device]: { select: { name: r.device } },
    [FIELD_NAMES.category]: { select: { name: r.category } },
    [FIELD_NAMES.severity]: r.severity ? { select: { name: r.severity } } : { select: null },
    [FIELD_NAMES.status]: { select: { name: r.status } },
    [FIELD_NAMES.description]: {
      rich_text: [{ text: { content: r.description.slice(0, 2000) } }],
    },
    [FIELD_NAMES.testType]: { select: { name: TEST_TYPE_VALUE } },
    [FIELD_NAMES.dateTime]: { date: { start: r.runTimestamp } },
  };
}

/**
 * Writes one result row to Notion, retrying once after a short delay.
 * Never throws — caller treats Notion failure as non-fatal, per the plan's
 * "don't block email on Notion success" mitigation.
 */
async function writeRow(r: TestResult): Promise<{ ok: boolean; error?: string }> {
  const databaseId = process.env.NOTION_DATABASE_ID;
  if (!databaseId) {
    return { ok: false, error: 'NOTION_DATABASE_ID is not set.' };
  }

  const attempt = async () => {
    await getClient().pages.create({
      parent: { database_id: databaseId },
      properties: buildProperties(r) as never,
    });
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

/**
 * Writes all result rows to Notion sequentially with a small delay between
 * each, to respect Notion's ~3 requests/second rate limit. Returns overall
 * success only if every row succeeded; partial failures are logged but do
 * not abort the batch.
 */
export async function writeAllResults(results: TestResult[]): Promise<{ ok: boolean; failedCount: number }> {
  let failedCount = 0;
  for (const r of results) {
    const outcome = await writeRow(r);
    if (!outcome.ok) {
      failedCount += 1;
    }
    await sleep(350); // ~3 req/sec ceiling
  }
  return { ok: failedCount === 0, failedCount };
}
