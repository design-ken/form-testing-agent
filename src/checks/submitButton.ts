import type { Locator, Page } from 'playwright';

// Ken Research's 4 forms use different call-to-action copy ("Submit",
// "Book a Call", "Download Sample Report", etc.) — confirmed live that a
// name-only regex missed the Sample Report form's "Download Sample Report"
// button entirely (false "at_risk": submit button not found). Falling back
// to the structural `type="submit"` attribute is far more robust than
// trying to enumerate every possible CTA verb across current and future
// forms.
const SUBMIT_NAME_PATTERN = /submit|send|book|request|talk|download|continue|next|get/i;

/**
 * Finds the form's submit control: first by common CTA wording, then by
 * falling back to the structural `type="submit"` attribute if no name match
 * is visible. Returns a Locator that may resolve to zero elements if truly
 * nothing is found — callers should still check visibility/count.
 */
export async function findSubmitButton(page: Page): Promise<Locator> {
  const byName = page.getByRole('button', { name: SUBMIT_NAME_PATTERN }).first();
  if (await byName.isVisible({ timeout: 2000 }).catch(() => false)) {
    return byName;
  }

  const byType = page.locator('button[type="submit"], input[type="submit"]').first();
  if (await byType.isVisible({ timeout: 2000 }).catch(() => false)) {
    return byType;
  }

  // Neither matched — return the name-based locator anyway so callers'
  // existing "count() === 0 / not visible" handling still applies uniformly.
  return byName;
}
