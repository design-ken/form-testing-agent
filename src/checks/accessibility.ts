import type { Page } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { TestResult, FormDef, Device, Evidence } from '../types.js';

// Evidence is captured once per (form, rule) per run — the first target that hits it —
// and capped, so a run never turns into hundreds of images.
const captured = new Set<string>();
let capturedTotal = 0;
const MAX_NODES_PER_RULE = 2;
// Page-level rules point at <html>/whole sections — a crop would show nothing useful.
const NO_EVIDENCE_RULES = new Set(['landmark-one-main', 'page-has-heading-one', 'region']);
const MAX_EVIDENCE_PER_RUN = 36;
const EVIDENCE_DIR = path.resolve(process.cwd(), 'screenshots', 'evidence');

async function captureEvidence(
  page: Page,
  formId: string,
  ruleId: string,
  nodes: Array<{ target: unknown[]; html?: string }>
): Promise<Evidence[]> {
  const key = `${formId}|${ruleId}`;
  if (NO_EVIDENCE_RULES.has(ruleId) || captured.has(key) || capturedTotal >= MAX_EVIDENCE_PER_RUN) return [];
  captured.add(key);
  const out: Evidence[] = [];
  await mkdir(EVIDENCE_DIR, { recursive: true }).catch(() => {});
  for (const node of nodes.slice(0, MAX_NODES_PER_RULE)) {
    const selector = node.target.find((t) => typeof t === 'string') as string | undefined;
    if (!selector || node.target.length !== 1) continue; // skip iframe/shadow-piercing selectors
    try {
      const loc = page.locator(selector).first();
      await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
      await loc.evaluate((el) => { (el as HTMLElement).dataset.qaPrevOutline = (el as HTMLElement).style.outline; (el as HTMLElement).style.outline = '3px solid #e11d48'; (el as HTMLElement).style.outlineOffset = '2px'; });
      const box = await loc.boundingBox({ timeout: 3000 });
      const vp = page.viewportSize();
      if (!box || !vp) continue;
      // Crop with context around the element so a small icon is still understandable.
      const padX = 120, padY = 80;
      const x = Math.max(0, box.x - padX), y = Math.max(0, box.y - padY);
      const width = Math.min(vp.width - x, Math.max(box.width, 40) + padX * 2);
      const height = Math.min(vp.height - y, Math.max(box.height, 24) + padY * 2);
      if (width < 20 || height < 20) continue;
      const file = path.join(EVIDENCE_DIR, `${formId}-${ruleId}-${out.length + 1}-${Date.now()}.png`);
      await page.screenshot({ path: file, clip: { x, y, width, height }, timeout: 5000 });
      await loc.evaluate((el) => { (el as HTMLElement).style.outline = (el as HTMLElement).dataset.qaPrevOutline ?? ''; }).catch(() => {});
      out.push({ path: file, selector, html: String(node.html ?? '').replace(/\s+/g, ' ').slice(0, 160) });
      capturedTotal++;
    } catch {
      // Evidence is best-effort — never let it affect the check result.
    }
  }
  return out;
}

interface AccessibilityCheckContext {
  page: Page;
  form: FormDef;
  device: Device;
  runId: string;
  runTimestamp: string;
}

function baseResult(ctx: AccessibilityCheckContext, overrides: Partial<TestResult>): TestResult {
  return {
    runId: ctx.runId,
    runTimestamp: ctx.runTimestamp,
    formId: ctx.form.id,
    formName: ctx.form.name,
    formUrl: ctx.form.url,
    device: ctx.device,
    category: 'accessibility',
    status: 'pass',
    severity: null,
    description: '',
    screenshotPath: null,
    ...overrides,
  };
}

export async function runAccessibilityChecks(ctx: AccessibilityCheckContext): Promise<TestResult[]> {
  const { page } = ctx;
  const results: TestResult[] = [];

  try {
    // Cast to `any` at this boundary: @axe-core/playwright resolves its own
    // playwright-core type copy which can structurally mismatch the one this
    // project's `playwright` package bundles, even though both are
    // runtime-compatible Page objects. This is a type-only workaround.
    const axeResults = await new AxeBuilder({ page: page as never }).analyze();
    const violations = axeResults.violations;

    if (violations.length === 0) {
      results.push(
        baseResult(ctx, {
          status: 'pass',
          description: 'No axe-core accessibility violations detected.',
        })
      );
    } else {
      for (const violation of violations) {
        const severity =
          violation.impact === 'critical' || violation.impact === 'serious'
            ? 'high'
            : violation.impact === 'moderate'
              ? 'medium'
              : 'low';

        const evidence = await captureEvidence(page, ctx.form.id, violation.id, violation.nodes as never);
        results.push(
          baseResult(ctx, {
            status: severity === 'high' ? 'fail' : 'at_risk',
            severity,
            description: `[axe-core] ${violation.id}: ${violation.description} (${violation.nodes.length} element(s) affected)`,
            ruleId: violation.id,
            evidence: evidence.length ? evidence : undefined,
          })
        );
      }
    }
  } catch (err) {
    results.push(
      baseResult(ctx, {
        status: 'error',
        severity: 'low',
        description: `Error running axe-core accessibility scan: ${(err as Error).message}`,
      })
    );
  }

  return results;
}
