# Lead Form Tester

Automated, unattended Playwright testing of Ken Research's 4 revenue-critical lead-generation forms, running twice daily on GitHub Actions. Reports to a repo-committed SQLite database, Notion, and email (Resend). No dependency on any local machine being on, and no third-party database account required.

Part of Project ECHO — Track B (Testing Team). See `plan/track-b-testing-team.md` in the main Project ECHO vault for the full spec this implements.

## ⚠️ Critical Operational Note — Read This

**GitHub automatically disables scheduled workflows (`schedule:` cron triggers) after 60 days of repository inactivity (no commits/pushes).** If nobody touches this repo for two months, the twice-daily emails will silently stop — with no warning from GitHub, and the watchdog workflow (below) is *also* a scheduled workflow, so it is subject to the exact same 60-day rule and cannot warn you about this specific failure mode.

**Mitigation:** either make a small commit to this repo at least once every ~45 days, or set a recurring personal reminder to check `gh workflow list` / the Actions tab periodically. This is a known GitHub platform behavior, not a bug in this code.

## What This Does

Twice a day (8 AM and 6 PM IST), a GitHub Actions runner:
1. Loads all 4 forms (Sample Report, Custom Form, Talk to Us, Book a Discovery Call) across 3 viewports (desktop, tablet, mobile) — 12 test passes total
2. Runs functional checks (fields load, validation, submission, confirmation), layout checks (cutoff, horizontal scroll, touch targets), a full-page screenshot, and an axe-core accessibility scan for each
3. Writes every result row to `db/test-runs.sqlite` (committed back to the repo by the workflow) and to a Notion database
4. Emails a summary report to the configured recipient list via Resend
5. Uploads screenshots as a GitHub Actions artifact (90-day retention)

A separate daily watchdog workflow checks whether the main workflow actually ran in the last ~20 hours and sends a warning email if not (catching a silently-skipped cron trigger — a real, documented GitHub Actions behavior under platform load).

## One-Time Setup

### 1. Database — no signup needed
Results are stored in `db/test-runs.sqlite`, a file committed directly to this repo. The schema is created automatically on first run (see `src/db.ts`) — nothing to sign up for or configure. The GitHub Actions workflow commits the updated file back to `main` after every run, so history accumulates in git itself.

If you ever want to inspect it locally: `sqlite3 db/test-runs.sqlite "SELECT * FROM test_runs ORDER BY run_timestamp DESC LIMIT 20;"`

### 2. Resend (free tier, email delivery)
1. Sign up at [resend.com](https://resend.com).
2. Grab an API key from the dashboard.
3. Using the free `onboarding@resend.dev` test sender — no domain verification needed. If reports land in spam during initial testing, check the spam folder explicitly; verifying a real `kenresearch.com` sending domain later is a one-line env var change (`EMAIL_FROM`), not a rebuild.

### 3. Notion
1. This writes to the existing "Testing agent log" database (ID: `3d0369df402080758409f3e680b4bb59`).
2. Create/use a Notion integration token scoped to that database (Notion → Settings → Connections → Develop or manage integrations), and share the database with that integration (database page → `•••` → Connections).
3. **Field mapping is live-verified**, not guessed: the columns (URL, Device, Category, Severity, Status, Description, Screenshot, Test Type, Date) were created directly via the Notion API to match `src/notion.ts`'s `FIELD_NAMES`. If columns are ever renamed in Notion, update `FIELD_NAMES` in `src/notion.ts` to match.
4. **Important — Notion API version note:** as of September 2025, Notion split each database into "data sources"; writes target a `data_source_id`, not the database ID directly. `src/notion.ts` resolves this automatically from `NOTION_DATABASE_ID` and caches it — no extra config needed, but if the Notion SDK version changes again in the future, this is the first place to check.

### 4. GitHub Secrets
In the repo: **Settings → Secrets and variables → Actions → New repository secret**. Add:

| Secret | Value |
|---|---|
| `NOTION_TOKEN` | Notion integration token |
| `NOTION_DATABASE_ID` | `3d0369df402080758409f3e680b4bb59` |
| `RESEND_API_KEY` | Resend API key |
| `EMAIL_FROM` | (optional) defaults to `Lead Form Tester <onboarding@resend.dev>` if unset |
| `EMAIL_RECIPIENTS` | `edwerd@kenresearch.com` (comma-separate for multiple) |

No `DATABASE_URL` secret — the SQLite file needs no credentials, just the `contents: write` permission already configured in the workflow so it can commit results back.

## Local Development

```bash
npm install
npx playwright install chromium

# Create a .env file (gitignored) with the same variables as the GitHub Secrets table above:
# NOTION_TOKEN=...
# NOTION_DATABASE_ID=...
# RESEND_API_KEY=...
# EMAIL_RECIPIENTS=...

npm run test:forms   # runs the full 12-pass suite locally
npm run watchdog     # runs the watchdog check locally
npm run typecheck    # TypeScript type-check with no emit
```

## Manually Triggering a Run

From the GitHub Actions tab: select "Lead Form Tester" → "Run workflow". Or via CLI if `gh` is installed: `gh workflow run "Lead Form Tester"`.

## Known Limitations (By Design)

- **Backend/CRM delivery is not verified.** This suite only confirms browser-visible submission success (a confirmation message or redirect). Whether the lead actually reaches the CRM/email backend requires backend access this agent doesn't have — flagged in every report.
- **CRM test-data filtering is not configured.** Test submissions use a tagged fake identity (`QA Test Automated` / `qa-test-leadform@kenresearch.com`) but no automatic CRM-side filtering has been set up (confirmed not required for now). Note: real tagged test leads **will** land in the actual CRM/consulting queue each time this runs — this is expected, not a bug.
- **No backup alert channel in v1.** If Resend itself fails silently, the GitHub Actions run log is the only fallback — check the Actions tab periodically. This gap will close once BUZZ (Project ECHO Track A) exists and `src/buzz.ts` is wired to a real endpoint.
- **SQLite is single-writer.** Fine for this use case (one scheduled run at a time, ~12 rows per run), but don't add concurrent/overlapping workflow triggers without reworking `src/db.ts` — two Actions runs committing to the same file at once would conflict.
- **Client-side hydration timing.** The live site doesn't fully respond to clicks until its JS framework hydrates after `domcontentloaded` (confirmed live — `networkidle` never resolves on this site, likely due to a persistent background connection). `functional.ts` and `run.ts` use a fixed ~2s settle delay instead. If the real site becomes slower to hydrate, this delay may need increasing.

## Deferred to Later

- Real BUZZ posting (swap the `notifyBuzz()` stub in `src/buzz.ts`)
- Verified `kenresearch.com` sending domain for a more professional "from" address
- Component Audit & Clean-up agent (separate build, can reuse this repo's Playwright setup pattern)
