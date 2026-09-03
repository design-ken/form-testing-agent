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

export const VIEWPORTS: Viewport[] = [
  { device: 'desktop', width: 1440, height: 900 },
  { device: 'tablet', width: 768, height: 1024 },
  { device: 'mobile', width: 375, height: 812 },
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
