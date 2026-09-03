import { Resend } from 'resend';
import type { RunSummary, TestResult } from './types.js';

let resend: Resend | null = null;

function getResend(): Resend {
  if (!resend) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error('RESEND_API_KEY is not set.');
    }
    resend = new Resend(apiKey);
  }
  return resend;
}

function getRecipients(): string[] {
  const raw = process.env.EMAIL_RECIPIENTS;
  if (!raw) {
    throw new Error('EMAIL_RECIPIENTS is not set.');
  }
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function formatIST(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function statusEmoji(status: TestResult['status']): string {
  switch (status) {
    case 'pass':
      return '✅';
    case 'at_risk':
      return '⚠️';
    case 'fail':
      return '🚩';
    case 'error':
      return '❗';
  }
}

function buildResultsTable(results: TestResult[]): string {
  const rows = results
    .map(
      (r) => `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;">${statusEmoji(r.status)} ${r.status}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;">${r.formName}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;">${r.device}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;">${r.category}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;">${r.severity ?? '—'}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;">${escapeHtml(r.description)}</td>
      </tr>`
    )
    .join('');

  return `
    <table style="width:100%;border-collapse:collapse;font-size:13px;font-family:-apple-system,Segoe UI,Roboto,sans-serif;">
      <thead>
        <tr style="background:#f5f5f5;text-align:left;">
          <th style="padding:6px 10px;">Status</th>
          <th style="padding:6px 10px;">Form</th>
          <th style="padding:6px 10px;">Device</th>
          <th style="padding:6px 10px;">Category</th>
          <th style="padding:6px 10px;">Severity</th>
          <th style="padding:6px 10px;">Description</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildSubject(summary: RunSummary): string {
  if (summary.runFailed) {
    return `🚨 Lead Form Tester — RUN FAILED — ${formatIST(summary.runTimestamp)}`;
  }
  if (summary.totalFail > 0) {
    return `🚩 Lead Form Tester — ${summary.totalFail} failure(s) — ${formatIST(summary.runTimestamp)}`;
  }
  if (summary.totalAtRisk > 0 || summary.totalError > 0) {
    return `⚠️ Lead Form Tester — at-risk findings — ${formatIST(summary.runTimestamp)}`;
  }
  return `✅ Lead Form Tester — all passed — ${formatIST(summary.runTimestamp)}`;
}

function buildHtml(summary: RunSummary): string {
  if (summary.runFailed) {
    return `
      <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;">
        <h2 style="color:#B30F26;">Lead Form Tester — Run Failed</h2>
        <p>The scheduled test run did not complete. This is a degraded alert — no test data was collected this run.</p>
        <p><strong>Reason:</strong> ${escapeHtml(summary.runFailureReason ?? 'Unknown error')}</p>
        <p>Run time: ${formatIST(summary.runTimestamp)} IST</p>
        <p>Check the GitHub Actions run log for full details.</p>
      </div>`;
  }

  const warningLines: string[] = [];
  if (summary.dbWriteFailed) {
    warningLines.push('⚠️ Database write to Postgres failed for this run — results below are not persisted in Neon.');
  }
  if (summary.notionWriteFailed) {
    warningLines.push('⚠️ One or more Notion writes failed for this run — check the Notion database for gaps.');
  }

  return `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:720px;margin:0 auto;">
      <h2>Lead Form Tester — Run Summary</h2>
      <p>Run time: ${formatIST(summary.runTimestamp)} IST · Run ID: ${summary.runId}</p>
      <p>
        ✅ ${summary.totalPass} passed &nbsp;
        ⚠️ ${summary.totalAtRisk} at risk &nbsp;
        🚩 ${summary.totalFail} failed &nbsp;
        ❗ ${summary.totalError} error(s)
      </p>
      ${warningLines.length ? `<div style="background:#fff3cd;padding:10px;border-radius:6px;margin-bottom:16px;">${warningLines.map((l) => `<p style="margin:4px 0;">${l}</p>`).join('')}</div>` : ''}
      ${buildResultsTable(summary.results)}
      <p style="margin-top:20px;font-size:12px;color:#888;">
        NOTE: This suite verifies browser-visible form submission success only.
        Whether leads actually reach the CRM/email backend is NOT verified by this agent.
      </p>
      <p style="font-size:12px;color:#888;">
        Screenshots for this run are attached as a GitHub Actions artifact on the workflow run page.
      </p>
    </div>`;
}

/**
 * Sends the run summary email via Resend. This is the last line of alerting
 * defense — it is deliberately NOT gated behind DB/Notion success, per the
 * plan's "email must succeed independently" mitigation. Throws on failure
 * since there is currently no further fallback channel (BUZZ is stubbed).
 */
export async function sendReport(summary: RunSummary): Promise<void> {
  const from = process.env.EMAIL_FROM || 'Lead Form Tester <onboarding@resend.dev>';
  const to = getRecipients();

  const { data, error } = await getResend().emails.send({
    from,
    to,
    subject: buildSubject(summary),
    html: buildHtml(summary),
  });

  // The Resend SDK returns errors in the response object rather than
  // throwing — without this check, a rejected send (bad API key, invalid
  // recipient, etc.) would silently look like a success to the caller.
  if (error) {
    throw new Error(`Resend send failed: ${error.name} — ${error.message}`);
  }

  if (!data?.id) {
    throw new Error('Resend send returned no error but also no email ID — treating as failed.');
  }
}
