import type { FormDef, Viewport } from './types.js';

export const FORMS: FormDef[] = [
  {
    id: 'sample-report',
    name: 'Sample Report',
    url: 'https://www.kenresearch.com/sample-report/india-canned-market',
  },
  {
    id: 'custom-form',
    name: 'Custom Form',
    url: 'https://www.kenresearch.com/custom-form/india-canned-market',
  },
  {
    id: 'talk-to-us',
    name: 'Talk to Us',
    url: 'https://www.kenresearch.com/talk-to-us',
  },
  {
    id: 'discovery-call',
    name: 'Book a Discovery Call',
    url: 'https://www.kenresearch.com/book-a-discovery-call',
  },
];

// 5 real-world targets (Chromium, Firefox and WebKit/Safari engines). Phones and
// tablets use Playwright's built-in device profiles — real user agent, touch
// input, pixel density and mobile viewport — not just a resized window.
// Caveat: Playwright cannot emulate the on-screen keyboard, so "keyboard hides
// the submit button" remains a manual check.
export const VIEWPORTS: Viewport[] = [
  // Weighted to the GA4 mix (desktop ~92% of users; Chrome ~88%, Edge ~4.6%, Safari ~4.2%, Firefox ~0.8%).
  { device: 'desktop', label: 'Desktop · Chrome', browser: 'chromium', width: 1440, height: 900, a11y: true },
  { device: 'desktop', label: 'Desktop · Chrome 1920×1080', browser: 'chromium', width: 1920, height: 1080, a11y: false },
  { device: 'desktop', label: 'Laptop · Chrome 1366×768', browser: 'chromium', width: 1366, height: 768, a11y: false },
  { device: 'desktop', label: 'Desktop · Edge', browser: 'msedge', width: 1440, height: 900, a11y: false },
  { device: 'desktop', label: 'Desktop · Safari (Mac)', browser: 'webkit', profile: 'Desktop Safari', width: 1280, height: 720, a11y: false },
  { device: 'desktop', label: 'Desktop · Firefox', browser: 'firefox', width: 1440, height: 900, a11y: false },
  { device: 'tablet', label: 'iPad · Safari', browser: 'webkit', profile: 'iPad (gen 7)', width: 810, height: 1080, a11y: true },
  { device: 'mobile', label: 'iPhone 15 · Safari', browser: 'webkit', profile: 'iPhone 15', width: 393, height: 659, a11y: true },
  { device: 'mobile', label: 'iPhone SE · Safari (small)', browser: 'webkit', profile: 'iPhone SE', width: 320, height: 568, a11y: false },
  { device: 'mobile', label: 'Pixel 7 · Chrome', browser: 'chromium', profile: 'Pixel 7', width: 412, height: 839, a11y: false },
];

export const TEST_IDENTITY = {
  // Some live forms validate "letters only" on the name field (confirmed via
  // dry run against the real Talk to Us form), so the tag lives in the
  // designation/requirement fields instead of the name itself.
  name: 'QA Test Automated',
  email: 'qa-test-leadform@kenresearch.com',
  phone: '0000000000',
  designation: 'QA Test — Do Not Contact',
  requirement: 'Automated QA test submission — please disregard.',
};

// Common cookie/consent banner selectors to dismiss before running checks.
// Not exhaustive — extend this list if the live site's banner changes.
export const CONSENT_BANNER_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '.cookie-consent button',
  '[data-testid="cookie-accept"]',
  'button:has-text("Accept All")',
  'button:has-text("Accept Cookies")',
  'button:has-text("I Accept")',
];
