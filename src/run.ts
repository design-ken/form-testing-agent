import { chromium } from 'playwright';
import { v4 as uuidv4 } from 'uuid';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { FORMS, VIEWPORTS } from './forms.js';
import { runFunctionalChecks } from './checks/functional.js';
import { runLayoutChecks, dismissConsentBanner } from './checks/layout.js';
import { runAccessibilityChecks } from './checks/accessibility.js';
import { insertResults, closePool } from './db.js';
import { writeAllResults } from './notion.js';
import { sendReport } from './email.js';
import { notifyBuzz } from './buzz.js';
import type { TestResult, RunSummary } from './types.js';

const REQUIRED_ENV_VARS = ['RESEND_API_KEY', 'EMAIL_RECIPIENTS'];
const RECOMMENDED_ENV_VARS = ['DATABASE_URL', 'NOTION_TOKEN', 'NOTION_DATABASE_ID'];
const SCREENSHOT_DIR = path.resolve(process.cwd(), 'screenshots');
const OVERALL_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes, per the plan's hard timeout mitigation

function validateEnv(): void {
  const missing = REQUIRED_ENV_VARS.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. Cannot send alerts without these.`
    );
  }
  const missingRecommended = RECOMMENDED_ENV_VARS.filter((v) => !process.env[v]);
  if (missingRecommended.length > 0) {
    console.warn(
      `[run] Warning: missing recommended env var(s): ${missingRecommended.join(', ')} — DB/Notion writes will be skipped or fail for this run.`
    );
  }
}

async function testOneFormDevice(
  form: (typeof FORMS)[number],
  viewport: (typeof VIEWPORTS)[number],
  runId: string,
  runTimestamp: string
): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
    });
    const page = await context.newPage();

    try {
      await page.goto(form.url, { timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => {});
      // 'networkidle' never resolves on this site (persistent background
      // connection, e.g. chat widget) — a fixed settle delay is used instead
      // so client-hydrated elements (custom checkboxes/dropdowns) are ready
      // before layout/a11y checks run.
      await page.waitForTimeout(2000);
      await dismissConsentBanner(page);

      const ctx = { page, form, device: viewport.device, runId, runTimestamp };

      const functionalResults = await runFunctionalChecks(ctx);
      results.push(...functionalResults);

      // Only continue with layout/screenshot/a11y if the page was reachable
      // (functional checks return early with an 'availability' failure if not).
      const siteUnreachable = functionalResults.some((r) => r.category === 'availability' && r.status === 'fail');

      if (!siteUnreachable) {
        const layoutResults = await runLayoutChecks(ctx);
        results.push(...layoutResults);

        let screenshotPath: string | null = null;
        try {
          await mkdir(SCREENSHOT_DIR, { recursive: true });
          const fileName = `${form.id}-${viewport.device}-${runId}.png`;
          screenshotPath = path.join(SCREENSHOT_DIR, fileName);
          await page.screenshot({ path: screenshotPath, fullPage: true });
        } catch (err) {
          console.error(`[run] Screenshot failed for ${form.id}/${viewport.device}:`, (err as Error).message);
        }

        results.push({
          runId,
          runTimestamp,
          formId: form.id,
          formName: form.name,
          formUrl: form.url,
          device: viewport.device,
          category: 'visual',
          status: screenshotPath ? 'pass' : 'error',
          severity: screenshotPath ? null : 'low',
          description: screenshotPath
            ? 'Full-page screenshot captured for visual review.'
            : 'Screenshot capture failed.',
          screenshotPath,
        });

        const a11yResults = await runAccessibilityChecks(ctx);
        results.push(...a11yResults);
      }
    } finally {
      await context.close().catch(() => {});
    }
  } catch (err) {
    // Catch-all per form+device — per the plan's "one form's test crashes
    // the whole run" mitigation, this becomes a single error row, not a
    // fatal exit that kills the other 11 combinations.
    results.push({
      runId,
      runTimestamp,
      formId: form.id,
      formName: form.name,
      formUrl: form.url,
      device: viewport.device,
      category: 'availability',
      status: 'error',
      severity: 'high',
      description: `Uncaught error testing this form/device combination: ${(err as Error).message}`,
      screenshotPath: null,
    });
  } finally {
    await browser.close().catch(() => {});
  }

  return results;
}

async function runAllTests(): Promise<RunSummary> {
  const runId = uuidv4();
  const runTimestamp = new Date().toISOString();
  const allResults: TestResult[] = [];

  for (const form of FORMS) {
    for (const viewport of VIEWPORTS) {
      const results = await testOneFormDevice(form, viewport, runId, runTimestamp);
      allResults.push(...results);
    }
  }

  const dbOutcome = await insertResults(allResults);
  const notionOutcome = await writeAllResults(allResults);

  const summary: RunSummary = {
    runId,
    runTimestamp,
    results: allResults,
    totalPass: allResults.filter((r) => r.status === 'pass').length,
    totalFail: allResults.filter((r) => r.status === 'fail').length,
    totalAtRisk: allResults.filter((r) => r.status === 'at_risk').length,
    totalError: allResults.filter((r) => r.status === 'error').length,
    runFailed: false,
    dbWriteFailed: !dbOutcome.ok,
    notionWriteFailed: !notionOutcome.ok,
  };

  return summary;
}

async function main(): Promise<void> {
  validateEnv();

  let summary: RunSummary;
  try {
    summary = await Promise.race([
      runAllTests(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Run exceeded 15-minute internal timeout.')), OVERALL_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    // Total run failure — still send a degraded alert email, per the plan's
    // "silence never means everything's fine" guarantee.
    summary = {
      runId: uuidv4(),
      runTimestamp: new Date().toISOString(),
      results: [],
      totalPass: 0,
      totalFail: 0,
      totalAtRisk: 0,
      totalError: 0,
      runFailed: true,
      runFailureReason: (err as Error).message,
    };
  }

  try {
    await sendReport(summary);
    console.log('[run] Report email sent successfully.');
  } catch (err) {
    console.error('[run] FAILED TO SEND REPORT EMAIL:', (err as Error).message);
    // No further fallback channel exists in v1 — this is the one accepted
    // silent-failure gap per the plan's Open Questions decision.
  }

  await notifyBuzz(summary).catch((err) => console.error('[run] BUZZ stub notify failed:', err.message));
  await closePool().catch(() => {});

  if (summary.runFailed) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[run] Unhandled top-level error:', err);
  process.exitCode = 1;
});
