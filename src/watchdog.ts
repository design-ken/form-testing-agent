import { Resend } from 'resend';
import { getLatestRunTimestamp, closeDb } from './db.js';

const STALE_THRESHOLD_HOURS = 20;

function getRecipients(): string[] {
  const raw = process.env.EMAIL_RECIPIENTS;
  if (!raw) throw new Error('EMAIL_RECIPIENTS is not set.');
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

async function sendWarningEmail(reason: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not set.');

  const resend = new Resend(apiKey);
  const from = process.env.EMAIL_FROM || 'Lead Form Tester <onboarding@resend.dev>';

  await resend.emails.send({
    from,
    to: getRecipients(),
    subject: '🚨 Lead Form Tester Watchdog — possible missed run',
    html: `
      <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#B30F26;">Watchdog Alert</h2>
        <p>${reason}</p>
        <p>Check the GitHub Actions tab for the "Lead Form Tester" workflow to confirm
        whether the scheduled run fired and completed.</p>
        <p style="font-size:12px;color:#888;">
          Note: this watchdog is itself a scheduled GitHub Actions workflow and is subject
          to the same 60-day repo-inactivity auto-disable rule as the main workflow — it
          cannot detect that specific failure mode. See README for details.
        </p>
      </div>`,
  });
}

async function main(): Promise<void> {
  try {
    const latest = getLatestRunTimestamp();

    if (!latest) {
      console.warn('[watchdog] No test_runs rows found at all — sending warning.');
      await sendWarningEmail('No test run data exists in the database yet, or the table is empty.');
      return;
    }

    const hoursSinceLastRun = (Date.now() - latest.getTime()) / (1000 * 60 * 60);

    if (hoursSinceLastRun > STALE_THRESHOLD_HOURS) {
      console.warn(`[watchdog] Last run was ${hoursSinceLastRun.toFixed(1)}h ago — sending warning.`);
      await sendWarningEmail(
        `Lead Form Tester hasn't reported in over ${STALE_THRESHOLD_HOURS} hours (last run: ${latest.toISOString()}). The scheduled run may have silently failed to trigger.`
      );
    } else {
      console.log(`[watchdog] OK — last run was ${hoursSinceLastRun.toFixed(1)}h ago. No action needed.`);
    }
  } finally {
    closeDb();
  }
}

main().catch((err) => {
  console.error('[watchdog] Unhandled error:', err);
  process.exitCode = 1;
});
