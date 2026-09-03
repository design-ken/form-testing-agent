import type { Page } from 'playwright';
import type { TestResult, FormDef, Device } from '../types.js';
import { CONSENT_BANNER_SELECTORS } from '../forms.js';

interface LayoutCheckContext {
  page: Page;
  form: FormDef;
  device: Device;
  runId: string;
  runTimestamp: string;
}

function baseResult(ctx: LayoutCheckContext, overrides: Partial<TestResult>): TestResult {
  return {
    runId: ctx.runId,
    runTimestamp: ctx.runTimestamp,
    formId: ctx.form.id,
    formName: ctx.form.name,
    formUrl: ctx.form.url,
    device: ctx.device,
    category: 'layout',
    status: 'pass',
    severity: null,
    description: '',
    screenshotPath: null,
    ...overrides,
  };
}

/**
 * Attempts to dismiss a cookie/consent banner if present. Never throws —
 * absence of a banner is the expected common case, not an error.
 */
export async function dismissConsentBanner(page: Page): Promise<void> {
  for (const selector of CONSENT_BANNER_SELECTORS) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 1000 })) {
        await el.click({ timeout: 2000 });
        await page.waitForTimeout(300);
        return;
      }
    } catch {
      // Selector not present or not clickable — try the next one.
    }
  }
}

export async function runLayoutChecks(ctx: LayoutCheckContext): Promise<TestResult[]> {
  const { page, device } = ctx;
  const results: TestResult[] = [];

  // 1. No horizontal scroll required.
  try {
    const hasHorizontalScroll = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    });
    results.push(
      baseResult(ctx, {
        status: hasHorizontalScroll ? 'fail' : 'pass',
        severity: hasHorizontalScroll ? 'medium' : null,
        description: hasHorizontalScroll
          ? 'Page requires horizontal scrolling to view fully.'
          : 'No horizontal scroll detected.',
      })
    );
  } catch (err) {
    results.push(
      baseResult(ctx, {
        status: 'error',
        severity: 'low',
        description: `Error checking horizontal scroll: ${(err as Error).message}`,
      })
    );
  }

  // 2. Submit button is fully visible within the viewport (not cut off).
  try {
    const submitButton = page.getByRole('button', { name: /submit|send|book|request|talk/i }).first();
    const exists = await submitButton.count();
    if (exists > 0) {
      const box = await submitButton.boundingBox();
      const viewport = page.viewportSize();
      if (box && viewport) {
        const cutOff = box.x < 0 || box.y < 0 || box.x + box.width > viewport.width;
        results.push(
          baseResult(ctx, {
            status: cutOff ? 'fail' : 'pass',
            severity: cutOff ? 'high' : null,
            description: cutOff
              ? 'Submit button appears cut off or positioned outside the visible viewport width.'
              : 'Submit button renders fully within the viewport.',
          })
        );
      } else {
        results.push(
          baseResult(ctx, {
            status: 'at_risk',
            severity: 'low',
            description: 'Could not determine submit button bounding box.',
          })
        );
      }
    } else {
      results.push(
        baseResult(ctx, {
          status: 'at_risk',
          severity: 'medium',
          description: 'Submit button not found for layout check.',
        })
      );
    }
  } catch (err) {
    results.push(
      baseResult(ctx, {
        status: 'error',
        severity: 'low',
        description: `Error checking submit button visibility: ${(err as Error).message}`,
      })
    );
  }

  // 3. Touch target size on tablet/mobile (WCAG-adjacent: 44x44px minimum).
  if (device === 'tablet' || device === 'mobile') {
    try {
      const submitButton = page.getByRole('button', { name: /submit|send|book|request|talk/i }).first();
      const box = await submitButton.boundingBox();
      if (box) {
        const tooSmall = box.width < 44 || box.height < 44;
        results.push(
          baseResult(ctx, {
            status: tooSmall ? 'at_risk' : 'pass',
            severity: tooSmall ? 'medium' : null,
            description: tooSmall
              ? `Submit button touch target is ${Math.round(box.width)}x${Math.round(box.height)}px (spec: 44x44px minimum).`
              : `Submit button touch target is ${Math.round(box.width)}x${Math.round(box.height)}px — meets minimum.`,
          })
        );
      }
    } catch (err) {
      results.push(
        baseResult(ctx, {
          status: 'error',
          severity: 'low',
          description: `Error checking touch target size: ${(err as Error).message}`,
        })
      );
    }
  }

  // 4. Mobile keyboard obscuring submit button — approximated by checking
  // whether the submit button sits in the bottom ~40% of a mobile viewport,
  // where a virtual keyboard commonly overlaps content (best-effort heuristic,
  // real virtual keyboard behavior isn't simulable in headless Chromium).
  if (device === 'mobile') {
    try {
      const submitButton = page.getByRole('button', { name: /submit|send|book|request|talk/i }).first();
      const box = await submitButton.boundingBox();
      const viewport = page.viewportSize();
      if (box && viewport) {
        const inBottomZone = box.y > viewport.height * 0.6;
        results.push(
          baseResult(ctx, {
            status: inBottomZone ? 'at_risk' : 'pass',
            severity: inBottomZone ? 'low' : null,
            description: inBottomZone
              ? 'Submit button sits low on the mobile viewport — verify manually that the virtual keyboard does not obscure it.'
              : 'Submit button position unlikely to be obscured by a mobile virtual keyboard.',
          })
        );
      }
    } catch (err) {
      results.push(
        baseResult(ctx, {
          status: 'error',
          severity: 'low',
          description: `Error checking mobile keyboard overlap risk: ${(err as Error).message}`,
        })
      );
    }
  }

  return results;
}
