import type { Page } from 'playwright';
import type { TestResult, FormDef, Device } from '../types.js';
import { TEST_IDENTITY } from '../forms.js';
import { findSubmitButton } from './submitButton.js';

const NAV_TIMEOUT_MS = 15000;
const ACTION_TIMEOUT_MS = 5000;
const HYDRATION_SETTLE_MS = 2000;

interface FunctionalCheckContext {
  page: Page;
  form: FormDef;
  device: Device;
  runId: string;
  runTimestamp: string;
}

function baseResult(ctx: FunctionalCheckContext, overrides: Partial<TestResult>): TestResult {
  return {
    runId: ctx.runId,
    runTimestamp: ctx.runTimestamp,
    formId: ctx.form.id,
    formName: ctx.form.name,
    formUrl: ctx.form.url,
    device: ctx.device,
    category: 'functional',
    status: 'pass',
    severity: null,
    description: '',
    screenshotPath: null,
    ...overrides,
  };
}

/**
 * Runs the functional checklist for one form on one device.
 * Never throws — every failure mode is captured as a result row, per the
 * plan's "one form's test crashes the whole run" mitigation.
 */
export async function runFunctionalChecks(ctx: FunctionalCheckContext): Promise<TestResult[]> {
  const { page, form } = ctx;
  const results: TestResult[] = [];

  // 1. Page/site reachability — the most important check to degrade gracefully.
  try {
    const response = await page.goto(form.url, {
      timeout: NAV_TIMEOUT_MS,
      waitUntil: 'domcontentloaded',
    });
    // The live site is a client-rendered app (React/Next-style hydration)
    // with what appears to be a persistent background connection (chat
    // widget/analytics), so 'networkidle' never resolves — confirmed via
    // dry run (15s timeout with no idle period). A fixed settle delay after
    // domcontentloaded is used instead so custom checkboxes/dropdowns have
    // time to hydrate before being interacted with.
    await page.waitForTimeout(HYDRATION_SETTLE_MS);
    if (!response || !response.ok()) {
      results.push(
        baseResult(ctx, {
          category: 'availability',
          status: 'fail',
          severity: 'high',
          description: `Site returned ${response ? response.status() : 'no response'} for ${form.url}`,
        })
      );
      return results; // nothing else can be tested if the page didn't load
    }
  } catch (err) {
    results.push(
      baseResult(ctx, {
        category: 'availability',
        status: 'fail',
        severity: 'high',
        description: `Navigation failed/timed out: ${(err as Error).message}`,
      })
    );
    return results;
  }

  // 2. Fields load correctly — look for at least one visible text/email/tel input or textarea.
  let fieldsFound = 0;
  try {
    const inputs = page.locator('input:not([type="hidden"]), textarea, select');
    fieldsFound = await inputs.count();
    if (fieldsFound === 0) {
      results.push(
        baseResult(ctx, {
          status: 'fail',
          severity: 'high',
          description: 'No visible form fields found on the page.',
        })
      );
    } else {
      results.push(
        baseResult(ctx, {
          status: 'pass',
          description: `${fieldsFound} form field(s) detected and rendered.`,
        })
      );
    }
  } catch (err) {
    results.push(
      baseResult(ctx, {
        status: 'error',
        severity: 'medium',
        description: `Error while checking field presence: ${(err as Error).message}`,
      })
    );
  }

  if (fieldsFound === 0) {
    return results; // can't test validation/submission with no fields
  }

  // 3. Required-field validation — attempt to submit empty, expect it to be blocked.
  try {
    const submitButton = await findSubmitButton(page);
    const submitVisible = await submitButton.isVisible({ timeout: ACTION_TIMEOUT_MS }).catch(() => false);

    if (submitVisible) {
      const urlBefore = page.url();
      await submitButton.click({ timeout: ACTION_TIMEOUT_MS }).catch(() => {});
      await page.waitForTimeout(1000);
      const urlAfter = page.url();

      // A naive heuristic: if the URL changed after clicking submit with empty
      // required fields, validation likely did NOT block the empty submission.
      if (urlAfter !== urlBefore) {
        results.push(
          baseResult(ctx, {
            status: 'at_risk',
            severity: 'medium',
            description:
              'Submitting the form with empty fields appeared to proceed (URL changed) — verify required-field validation manually.',
          })
        );
      } else {
        results.push(
          baseResult(ctx, {
            status: 'pass',
            description: 'Empty submission did not navigate away — validation likely blocked it as expected.',
          })
        );
      }
    } else {
      results.push(
        baseResult(ctx, {
          status: 'at_risk',
          severity: 'low',
          description: 'Could not locate a submit button by common role/name patterns — validation check skipped.',
        })
      );
    }
  } catch (err) {
    results.push(
      baseResult(ctx, {
        status: 'error',
        severity: 'medium',
        description: `Error during empty-submission validation check: ${(err as Error).message}`,
      })
    );
  }

  // 4. Reload the form fresh, then attempt a full valid submission with tagged test data.
  try {
    await page.goto(form.url, { timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(HYDRATION_SETTLE_MS);
    await fillKnownFields(page);

    const urlBefore = page.url();
    const submitButton = await findSubmitButton(page);
    const submitExists = await submitButton.count();

    if (submitExists === 0) {
      results.push(
        baseResult(ctx, {
          status: 'at_risk',
          severity: 'medium',
          description: 'No submit button found for full-submission test.',
        })
      );
    } else {
      await submitButton.click({ timeout: ACTION_TIMEOUT_MS }).catch(() => {});

      // Wait for the submit button's own "Submitting..." transient state to
      // clear before checking for confirmation — otherwise a screenshot/check
      // can land mid-submission and produce a false failure (confirmed via
      // dry run against the real form, which shows a "Submitting..." state).
      await page
        .getByRole('button', { name: /submitting/i })
        .waitFor({ state: 'hidden', timeout: 8000 })
        .catch(() => {});

      const urlAfter = page.url();
      const successTextVisible = await page
        .getByText(/thank you|success|we('| )ll be in touch|confirmation|submitted/i)
        .first()
        .waitFor({ state: 'visible', timeout: 8000 })
        .then(() => true)
        .catch(() => false);

      // Accept EITHER an inline success message OR a URL/route change as valid
      // confirmation, per the Track B spec ("success message and/or redirect,
      // whichever this form uses") — do not hardcode a single pattern.
      if (successTextVisible || urlAfter !== urlBefore) {
        results.push(
          baseResult(ctx, {
            status: 'pass',
            description: successTextVisible
              ? 'Valid submission showed an inline confirmation message.'
              : 'Valid submission triggered a redirect/URL change (treated as confirmation).',
          })
        );
      } else {
        results.push(
          baseResult(ctx, {
            status: 'fail',
            severity: 'high',
            description:
              'Valid submission with test data produced no visible confirmation message and no redirect — possible silent failure.',
          })
        );
      }
    }
  } catch (err) {
    results.push(
      baseResult(ctx, {
        status: 'error',
        severity: 'high',
        description: `Error during full-submission test: ${(err as Error).message}`,
      })
    );
  }

  // 5. Backend/CRM delivery is explicitly out of scope — always noted, per the
  // Track B spec's standing limitation, so it stays visible in every report.
  results.push(
    baseResult(ctx, {
      status: 'pass',
      severity: null,
      description:
        'NOTE: This suite verifies browser-visible submission success only. Whether the lead actually reached the CRM/email backend is NOT verified by this agent.',
    })
  );

  return results;
}

/**
 * Best-effort fill of common field types using label/placeholder/name-based
 * heuristics — deliberately generic since we don't have the live DOM sourced
 * ahead of time. Extend with form-specific selectors once real markup is known.
 */
async function fillKnownFields(page: Page): Promise<void> {
  const tryFill = async (locator: ReturnType<Page['locator']>, value: string) => {
    try {
      if ((await locator.count()) > 0 && (await locator.first().isVisible())) {
        await locator.first().fill(value, { timeout: ACTION_TIMEOUT_MS });
      }
    } catch {
      // Field not present or not fillable — skip silently, this is best-effort.
    }
  };

  const trySelectFirstOption = async (locator: ReturnType<Page['locator']>) => {
    try {
      const el = locator.first();
      if ((await locator.count()) === 0 || !(await el.isVisible())) return;

      const tagName = await el.evaluate((node) => node.tagName.toLowerCase());
      if (tagName === 'select') {
        const options = await el.locator('option').all();
        for (const opt of options) {
          const value = await opt.getAttribute('value');
          if (value && value.trim() !== '') {
            await el.selectOption(value, { timeout: ACTION_TIMEOUT_MS });
            return;
          }
        }
      } else {
        // Custom (non-native) dropdown: click to open, then pick the first
        // visible option-like element. Best-effort — real dropdown widgets
        // vary too much for one generic strategy to always work.
        await el.click({ timeout: ACTION_TIMEOUT_MS });
        const option = page.getByRole('option').first();
        if (await option.isVisible({ timeout: 2000 }).catch(() => false)) {
          await option.click({ timeout: ACTION_TIMEOUT_MS });
        } else {
          await page.keyboard.press('Escape').catch(() => {});
        }
      }
    } catch {
      // Dropdown not present or not interactable — skip silently.
    }
  };

  const tryCheckConsent = async () => {
    // Prefer the ARIA role="checkbox" element — many modern forms use a
    // styled button/div for the visible checkbox with a hidden native
    // <input> behind it that doesn't respond to programmatic .check().
    try {
      const roleCheckbox = page.getByRole('checkbox').first();
      if ((await roleCheckbox.count()) > 0 && (await roleCheckbox.isVisible())) {
        const alreadyChecked = (await roleCheckbox.getAttribute('aria-checked')) === 'true';
        if (!alreadyChecked) {
          await roleCheckbox.click({ timeout: ACTION_TIMEOUT_MS });
        }
        return;
      }
    } catch {
      // Fall through to the native-input attempt below.
    }

    try {
      const checkbox = page.locator('input[type="checkbox"]').first();
      if ((await checkbox.count()) > 0 && (await checkbox.isVisible())) {
        await checkbox.check({ timeout: ACTION_TIMEOUT_MS });
      }
    } catch {
      // No checkbox present, or not interactable — skip silently.
    }
  };

  await tryFill(page.getByLabel(/^name|full name/i), TEST_IDENTITY.name);
  await tryFill(page.getByPlaceholder(/name/i), TEST_IDENTITY.name);
  await tryFill(page.locator('input[name*="name" i]'), TEST_IDENTITY.name);

  await tryFill(page.getByLabel(/email/i), TEST_IDENTITY.email);
  await tryFill(page.getByPlaceholder(/email/i), TEST_IDENTITY.email);
  await tryFill(page.locator('input[type="email"]'), TEST_IDENTITY.email);

  await tryFill(page.getByLabel(/phone|mobile/i), TEST_IDENTITY.phone);
  await tryFill(page.getByPlaceholder(/phone|mobile/i), TEST_IDENTITY.phone);
  await tryFill(page.locator('input[type="tel"]'), TEST_IDENTITY.phone);

  await tryFill(page.getByLabel(/designation|role|title/i), TEST_IDENTITY.designation);
  await tryFill(page.getByPlaceholder(/designation|role|title/i), TEST_IDENTITY.designation);

  await tryFill(page.locator('textarea'), TEST_IDENTITY.requirement);

  // Best-effort: pick the first real option in any dropdowns/selects
  // (e.g. "Country / geography", "Interest") so required-select validation
  // doesn't block a submission that would otherwise be valid.
  const selects = page.locator('select, [role="combobox"], [role="listbox"]');
  const selectCount = await selects.count().catch(() => 0);
  for (let i = 0; i < selectCount; i++) {
    await trySelectFirstOption(selects.nth(i));
  }

  await tryCheckConsent();
}
