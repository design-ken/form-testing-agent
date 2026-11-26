export type Device = 'desktop' | 'tablet' | 'mobile';

export type Category = 'functional' | 'layout' | 'visual' | 'accessibility' | 'availability';

export type Status = 'pass' | 'fail' | 'at_risk' | 'error';

export type Severity = 'low' | 'medium' | 'high';

export type BrowserName = 'chromium' | 'msedge' | 'webkit' | 'firefox';

/**
 * One test target: a device CLASS (drives class-specific checks and keeps the
 * DB's historic desktop/tablet/mobile values), plus the real browser engine
 * and, for phones/tablets, a Playwright device profile (user agent, touch,
 * pixel density, mobile viewport). `label` is the human-readable name used in
 * reports and is unique per target.
 */
export interface Viewport {
  device: Device;
  label: string;
  browser: BrowserName;
  profile?: string; // key into playwright.devices; omit for desktop (uses width/height)
  width: number;
  height: number;
  a11y: boolean; // run the axe scan here? (findings are mostly viewport-agnostic — avoid duplicates)
}

export interface FormDef {
  id: string;
  name: string;
  url: string;
}

/** A cropped screenshot of the offending element, outlined, captured while the page was open. */
export interface Evidence {
  path: string; // local png
  selector: string; // axe target selector (for the caption)
  html: string; // trimmed outerHTML snippet of the element
}

export interface TestResult {
  runId: string;
  runTimestamp: string; // ISO 8601, UTC
  formId: string;
  formName: string;
  formUrl: string;
  device: Device;
  target?: string; // Viewport.label, e.g. "iPhone 15 · Safari"
  category: Category;
  status: Status;
  severity: Severity | null;
  description: string;
  screenshotPath: string | null;
  ruleId?: string; // axe rule id for accessibility results
  evidence?: Evidence[]; // outlined element crops (accessibility results only)
}

export interface FormTestMetrics {
  formName: string;
  durationMs: number; // total time spent testing this form across all 3 devices
}

export interface ConsolidatedIssue {
  formName: string;
  category: Category;
  description: string;
  severity: Severity | null;
  affectedDevices: string[]; // target labels (e.g. "iPhone 15 · Safari") that had this issue
  isNew?: boolean; // not seen in any run in the baseline window (see analysis.ts)
  urgent?: boolean; // functional/availability failure — revenue-critical
  confirmedOnRetry?: boolean;
  ruleId?: string;
  evidence?: Evidence[];
  status: Status; // pass | fail | at_risk | error
}

export interface FixedIssue {
  formName: string;
  category: Category;
  description: string;
  severity: Severity | null;
}

export interface IssueDelta {
  newCount: number;
  knownCount: number;
  fixed: FixedIssue[]; // present in the previous full run, gone now
}

export interface RunSummary {
  runId: string;
  runTimestamp: string;
  results: TestResult[];
  totalPass: number;
  totalFail: number;
  totalAtRisk: number;
  totalError: number;
  runFailed: boolean; // true if the whole run crashed before completing
  runFailureReason?: string;
  dbWriteFailed?: boolean;
  notionWriteFailed?: boolean;
  formMetrics?: FormTestMetrics[]; // time per form
  consolidatedIssues?: ConsolidatedIssue[]; // deduplicated issue list
  issueDelta?: IssueDelta;
  timingBaselineMs?: Record<string, number>; // 7-day average per form, for 'vs normal' in the email
  urgentScreenshots?: string[]; // paths of page screenshots for urgent failures (attached to the email)
  includeKnownEvidence?: boolean; // first run of the IST day: attach evidence for known issues too
  notionPageUrl?: string; // URL of this run's Notion page, for linking from the email summary
}
