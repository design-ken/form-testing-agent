import type { Page } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import type { TestResult, FormDef, Device } from '../types.js';

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

        results.push(
          baseResult(ctx, {
            status: severity === 'high' ? 'fail' : 'at_risk',
            severity,
            description: `[axe-core] ${violation.id}: ${violation.description} (${violation.nodes.length} element(s) affected)`,
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
