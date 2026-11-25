import { chromium, firefox, webkit, devices, type Browser, type BrowserType } from 'playwright';
import { v4 as uuidv4 } from 'uuid';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FORMS, VIEWPORTS } from './forms.js';
import { runFunctionalChecks } from './checks/functional.js';
import { runLayoutChecks, dismissConsentBanner } from './checks/layout.js';
import { runAccessibilityChecks } from './checks/accessibility.js';
import { insertResults, closeDb, hasSubmittedToday, getDb, insertTimings, getTimingBaseline } from './db.js';
import { computeDelta, fingerprint, isUrgent } from './analysis.js';
import { writeRunSummary } from './notion.js';
import { notifyBuzz } from './buzz.js';
import type { TestResult, RunSummary } from './types.js';

const REQUIRED_ENV_VARS = ['NOTION_TOKEN', 'NOTION_DATABASE_ID'];
const SCREENSHOT_DIR = path.resolve(process.cwd(), 'screenshots');
const OVERALL_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes, per the plan's hard timeout mitigation

function validateEnv(): void {
  const missing = REQUIRED_ENV_VARS.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}. Cannot log results without these.`);
  }
}

// Chromium launch is the first thing that can fail on a flaky CI runner. It
// used to sit outside the per-combination try/catch, so a single failed launch
// killed the whole run in under a second with no error logged. Retry once, and
// let any remaining failure become a normal per-form/device error row.
const ENGINES: Record<string, BrowserType> = { chromium, firefox, webkit };

async function launchBrowser(name: string): Promise<Browser> {
  // The sandbox/gpu flags are Chromium-specific (see note below); Firefox/WebKit reject them.
  const opts = name === 'chromium' ? { headless: true, args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu'] } : { headless: true };
  try {
    return await ENGINES[name].launch(opts);
  } catch (err) {
    console.error(`[run] ${name} launch failed, retrying once:`, (err as Error).message);
    await new Promise((r) => setTimeout(r, 3000));
    return await ENGINES[name].launch(opts);
  }
}

const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function testOneFormDevice(
  form: (typeof FORMS)[number],
  viewport: (typeof VIEWPORTS)[number],
  runId: string,
  runTimestamp: string,
  shouldSubmit: boolean
): Promise<TestResult[]> {
  const results: TestResult[] = [];
  // GitHub Actions' Ubuntu runners segfault Chromium (exit 139) even with
  // --disable-dev-shm-usage alone — confirmed live across every scheduled
  // run since this repo's first commit, always exit 139, both with and
  // without that flag. This is the standard flag set for running Chromium
  // inside a CI container: --no-sandbox because GitHub's runners don't
  // support Chromium's full sandboxing model (missing user namespace
  // permissions in the container), and --disable-gpu since there's no real
  // GPU to accelerate against. All three are harmless locally.
  let browser: Browser | undefined;
  try {
    browser = await launchBrowser(viewport.browser);
    // Phones/tablets: the full Playwright device profile (UA, touch, DPR, mobile viewport).
    // `defaultBrowserType` is informational and rejected by newContext, so strip it.
    const { defaultBrowserType: _ignored, ...profileOpts } = viewport.profile ? devices[viewport.profile] : ({} as Record<string, unknown>);
    const context = await browser.newContext(
      viewport.profile ? profileOpts : { viewport: { width: viewport.width, height: viewport.height } }
    );
    const page = await context.newPage();

    try {
      await page.goto(form.url, { timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => {});
      // 'networkidle' never resolves on this site (persistent background
      // connection, e.g. chat widget) — a fixed settle delay is used instead
      // so client-hydrated elements (custom checkboxes/dropdowns) are ready
      // before layout/a11y checks run.
      await page.waitForTimeout(2000);
      await dismissConsentBanner(page);

      const ctx = { page, form, device: viewport.device, runId, runTimestamp, shouldSubmit };

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
          const fileName = `${form.id}-${slug(viewport.label)}-${runId}.png`;
          screenshotPath = path.join(SCREENSHOT_DIR, fileName);
          await page.screenshot({ path: screenshotPath, fullPage: true });
        } catch (err) {
          console.error(`[run] Screenshot failed for ${form.id}/${viewport.label}:`, (err as Error).message);
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

        if (viewport.a11y) {
          const a11yResults = await runAccessibilityChecks(ctx);
          results.push(...a11yResults);
        }
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
    await browser?.close().catch(() => {});
  }

  for (const r of results) r.target = viewport.label;
  return results;
}

async function runAllTests(): Promise<RunSummary> {
  const runId = uuidv4();
  const runTimestamp = new Date().toISOString();
  const allResults: TestResult[] = [];
  const formMetrics = new Map<string, { startTime: number; results: TestResult[] }>();

  // Cap: at most 1 real ("Valid submission...") lead per calendar day (IST),
  // across ALL forms combined — not per form, not per run. Whichever
  // scheduled run happens to go first each day performs the single real
  // submission (on one randomly-chosen form+device pair); every other run
  // that day, and every other form/device within the winning run, is tested
  // up through locating the submit button but the button is never clicked.
  // This replaces the earlier "1 random device per form per run" scheme
  // (4 real submissions/run) with a stricter daily cap, per explicit
  // request to minimize real CRM test-lead volume further.
  const alreadySubmittedToday = hasSubmittedToday();
  const winningFormIndex = Math.floor(Math.random() * FORMS.length);
  // Chosen by unique target LABEL, not device class: two targets share the 'mobile' class,
  // and matching on class would submit twice and break the 1-lead-per-day cap.
  const winningTarget = VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)].label;

  for (const [formIndex, form] of FORMS.entries()) {
    const formStartTime = Date.now();
    const formResults: TestResult[] = [];

    for (const viewport of VIEWPORTS) {
      const shouldSubmit =
        !alreadySubmittedToday && formIndex === winningFormIndex && viewport.label === winningTarget;
      let results = await testOneFormDevice(form, viewport, runId, runTimestamp, shouldSubmit);
      // One retry before a revenue-critical failure counts, so one-off blips
      // (slow hydration, network hiccup) don't page anyone. Never retried on
      // the real-submission slot: a retry there would risk a second lead,
      // breaking the 1-per-day cap.
      if (!shouldSubmit && results.some((r) => isUrgent(r.category, r.status))) {
        console.error(`[run] ${form.name}/${viewport.label}: functional failure, retrying once.`);
        const retry = await testOneFormDevice(form, viewport, runId, runTimestamp, false);
        const stillBad = retry.some((r) => isUrgent(r.category, r.status));
        if (stillBad) retry.filter((r) => isUrgent(r.category, r.status)).forEach((r) => { r.description += ' (confirmed on retry)'; });
        else console.error(`[run] ${form.name}/${viewport.label}: passed on retry — treating first failure as a one-off.`);
        results = retry;
      }
      allResults.push(...results);
      formResults.push(...results);
    }

    formMetrics.set(form.name, { startTime: formStartTime, results: formResults });
  }

  // History comparisons must run BEFORE this run is written, so "known"
  // never includes the run itself.
  const { delta, newKeys } = computeDelta(getDb(), allResults);
  // First run of the IST day? Then known issues also get their evidence refreshed in Notion.
  const includeKnownEvidence = !getDb()
    .prepare(`SELECT 1 FROM test_runs WHERE date(run_timestamp,'+330 minutes') = date('now','+330 minutes') LIMIT 1`)
    .get();
  const timingBaselineMs = getTimingBaseline();
  const dbOutcome = insertResults(allResults);

  // Build per-form timing metrics
  const timing = Array.from(formMetrics.entries()).map(([formName, { startTime }]) => ({
    formName,
    durationMs: Date.now() - startTime,
  }));
  insertTimings(runId, runTimestamp, timing);

  // Build consolidated issue list (dedup by description, track affected devices)
  const issuesByDesc = new Map<string, typeof allResults>();
  for (const result of allResults) {
    if (result.status !== 'pass') {
      const key = `${result.formName}|${result.category}|${result.description}`;
      if (!issuesByDesc.has(key)) {
        issuesByDesc.set(key, []);
      }
      issuesByDesc.get(key)!.push(result);
    }
  }

  const consolidatedIssues = Array.from(issuesByDesc.values()).map((results) => ({
    ruleId: results.find((r) => r.ruleId)?.ruleId,
    evidence: results.find((r) => r.evidence?.length)?.evidence,
    formName: results[0].formName,
    category: results[0].category,
    description: results[0].description,
    severity: results[0].severity,
    status: results[0].status,
    affectedDevices: [...new Set(results.map((r) => r.target ?? r.device))],
    isNew: newKeys.has(fingerprint(results[0].formName, results[0].category, results[0].description)),
    urgent: isUrgent(results[0].category, results[0].status),
    confirmedOnRetry: results[0].description.includes('(confirmed on retry)'),
  }));

  // Page screenshots for the urgent failures' form/device combos, attached to the email.
  const urgentScreenshots = [
    ...new Set(
      allResults
        .filter((r) => isUrgent(r.category, r.status))
        .flatMap((u) => allResults.filter((v) => v.formId === u.formId && v.target === u.target && v.screenshotPath).map((v) => v.screenshotPath as string))
    ),
  ].slice(0, 3);

  const summary: RunSummary = {
    runId,
    runTimestamp,
    results: allResults,
    totalPass: allResults.filter((r) => r.status === 'pass').length,
    totalFail: allResults.filter((r) => r.status === 'fail').length,
    totalAtRisk: allResults.filter((r) => r.status === 'at_risk').length,
    totalError: allResults.filter((r) => r.status === 'error').length,
    // A run where nothing passed tested nothing (e.g. browser failed to install/launch) —
    // that must never look green. Surface it as a failed run.
    runFailed: allResults.length > 0 && !allResults.some((r) => r.status === 'pass'),
    runFailureReason: allResults.some((r) => r.status === 'pass') ? undefined : 'No check passed in this run — the browser likely failed to start, so nothing was actually tested.',
    issueDelta: delta,
    includeKnownEvidence,
    timingBaselineMs,
    urgentScreenshots,
    dbWriteFailed: !dbOutcome.ok,
    formMetrics: timing,
    consolidatedIssues,
  };

  // Notion write happens after the summary is built (not per-check like the
  // old per-row model) since it now writes ONE page per run containing the
  // full breakdown as block content — needs the complete summary object,
  // not individual TestResult rows, to build that structured report.
  const notionOutcome = await writeRunSummary(summary);
  summary.notionWriteFailed = !notionOutcome.ok;
  summary.notionPageUrl = notionOutcome.pageUrl;

  return summary;
}

async function main(): Promise<void> {
  validateEnv();

  let summary: RunSummary;
  let timer: NodeJS.Timeout | undefined;
  try {
    summary = await Promise.race([
      runAllTests(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Run exceeded 15-minute internal timeout.')), OVERALL_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
  } catch (err) {
    clearTimeout(timer);
    console.error('[run] RUN FAILED:', (err as Error).stack || (err as Error).message);
    // Total run failure (e.g. site down, Chromium crash, timeout). No
    // results to log anywhere in this case — the non-zero exit code below
    // and GitHub's own workflow-failure notification are the only signal.
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

  console.log(
    `[run] Done — ${summary.totalPass} passed, ${summary.totalFail} failed, ${summary.totalAtRisk} at risk, ${summary.totalError} errored.`
  );
  if (summary.notionWriteFailed) {
    console.error('[run] WARNING: one or more Notion writes failed — results may be incomplete in Notion for this run.');
  }

  await notifyBuzz(summary).catch((err) => console.error('[run] BUZZ stub notify failed:', err.message));

  // Serialize the completed summary (happy-path or crash-path — both are
  // covered since this runs on the same `summary` variable regardless of
  // which branch above produced it) so the separate Python email-notify
  // step (scripts/send_report_email.py) can read it without needing to
  // import TypeScript types. Non-fatal: a write failure here must not stop
  // closeDb()/exit-code handling below.
  try {
    await writeFile(path.resolve(process.cwd(), 'run-summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
  } catch (err) {
    console.error('[run] Failed to write run-summary.json:', (err as Error).message);
  }

  closeDb();

  // BUZZ/Slack-style alerting is deferred until BUZZ exists (per plan) — but
  // an email summary now ships after every run via scripts/send_report_email.py
  // (invoked as a separate GitHub Actions step, not from here) using this
  // run-summary.json. A non-zero exit code remains the CI-level failure signal.
  if (summary.runFailed) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[run] Unhandled top-level error:', err);
  process.exitCode = 1;
});
