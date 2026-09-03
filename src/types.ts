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
}
