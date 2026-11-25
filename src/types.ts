export type Device = 'desktop' | 'tablet' | 'mobile';

export type Category = 'functional' | 'layout' | 'visual' | 'accessibility' | 'availability';

export type Status = 'pass' | 'fail' | 'at_risk' | 'error';

export type Severity = 'low' | 'medium' | 'high';

export interface Viewport {
  device: Device;
  width: number;
  height: number;
}

export interface FormDef {
  id: string;
  name: string;
  url: string;
}

export interface TestResult {
  runId: string;
  runTimestamp: string; // ISO 8601, UTC
  formId: string;
  formName: string;
  formUrl: string;
  device: Device;
  category: Category;
  status: Status;
  severity: Severity | null;
  description: string;
  screenshotPath: string | null;
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
  affectedDevices: Device[]; // which viewports had this issue
  isNew?: boolean; // not seen in any run in the baseline window (see analysis.ts)
  urgent?: boolean; // functional/availability failure — revenue-critical
  confirmedOnRetry?: boolean;
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
  notionPageUrl?: string; // URL of this run's Notion page, for linking from the email summary
}
