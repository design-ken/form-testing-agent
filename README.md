# Lead Form Tester

Automated, unattended Playwright testing of Ken Research's 4 revenue-critical lead-generation forms, running 3x daily on GitHub Actions. Reports to a repo-committed SQLite database, Notion, a compiled HTML email summary after every run, and a browser-viewable status dashboard on GitHub Pages. No dependency on any local machine being on, and no third-party database required.

Part of Project ECHO — Track B (Testing Team). See `plan/track-b-testing-team.md` in the main Project ECHO vault for the full spec this implements.

**Email is the scannable digest; Notion is the detailed record.** After every run, a compiled HTML summary (pass/fail/at-risk/error counts, per-form timing, severity-sorted issues) is emailed to `edwerd@kenresearch.com` via Resend — this is the fast way to see what's wrong at a glance. Notion still holds the full per-form/per-device/per-check breakdown for anyone who needs the detail; the email links straight to that run's Notion page. BUZZ/Slack-style alerting is still not implemented — deferred until BUZZ (Project ECHO Track A) exists (see Deferred to Later).

## ⚠️ Critical Operational Note — Read This

**GitHub automatically disables scheduled workflows (`schedule:` cron triggers) after 60 days of repository inactivity (no commits/pushes).** If nobody touches this repo for two months, the scheduled runs will silently stop — with no warning from GitHub. Since there's no watchdog yet, **nothing will proactively tell you this happened** (the email summary only fires when a run actually happens — if the cron itself is disabled, there's no run to summarize). The only way to notice is checking Notion, your inbox, or the Actions tab and seeing no new activity for a while.

**Mitigation:** either make a small commit to this repo at least once every ~45 days, or set a recurring personal reminder to check `gh workflow list` / the Actions tab / the Notion database periodically. This is a known GitHub platform behavior, not a bug in this code.

## What This Does

Three times a day (5:30 AM, 1:30 PM, and 8:30 PM IST), a GitHub Actions runner:
1. Loads all 4 forms (Sample Report, Custom Form, Talk to Us, Book a Discovery Call) across 3 viewports (desktop, tablet, mobile) — 12 test passes total
2. Runs functional checks (fields load, validation, submission, confirmation), layout checks (cutoff, horizontal scroll, touch targets), a full-page screenshot, and an axe-core accessibility scan for each. Only one randomly-chosen device per form actually submits real test data each run (the other two devices are tested up through locating the submit button, but never click it) — cuts real CRM test-lead volume from 12/run to 4/run while still rotating full submission-path coverage across all 3 devices over multiple runs
3. Writes every individual check result to `db/test-runs.sqlite` (committed back to the repo by the workflow), and writes **one Notion page per run** — the page's properties show the run-level summary (Status, Failed/At Risk/Errored counts, Date, per-form timing), and the full per-form, per-device breakdown lives inside the page as structured content (a heading per form, a sub-heading per device, a bullet per check). **Notion is the detailed record** — open the latest page in the database to see everything about that run in one place
4. Sends a compiled HTML summary email to `edwerd@kenresearch.com` via Resend — leads with pass/fail/at-risk/error counts and per-form timing, then a severity-sorted list of issues, with a direct link to that run's Notion page. This is the scannable digest; it deliberately does not repeat Notion's full per-check breakdown
5. Regenerates `docs/data.json` from the freshly-updated SQLite data, which powers a static status dashboard hosted on GitHub Pages — showing run health (last 7 days), current open issues, and recurring-issue trends across all history
6. Uploads screenshots as a GitHub Actions artifact (90-day retention)

## One-Time Setup

### 1. Database — no signup needed
Results are stored in `db/test-runs.sqlite`, a file committed directly to this repo. The schema is created automatically on first run (see `src/db.ts`) — nothing to sign up for or configure. The GitHub Actions workflow commits the updated file back to `main` after every run, so history accumulates in git itself.

If you ever want to inspect it locally: `sqlite3 db/test-runs.sqlite "SELECT * FROM test_runs ORDER BY run_timestamp DESC LIMIT 20;"`

### 2. Notion
1. This writes to the existing "Testing agent log" database (ID: `3d0369df402080758409f3e680b4bb59`).
2. Create/use a Notion integration token scoped to that database (Notion → Settings → Connections → Develop or manage integrations), and share the database with that integration (database page → `•••` → Connections).
3. **One page per run, not one row per check.** The database columns are run-level summaries — Status (All Passed / Issues Found / Run Failed), Passed, Failed, At Risk, Errored, Date — created directly via the Notion API to match `src/notion.ts`'s `FIELD_NAMES`. The full per-form/per-device/per-check breakdown lives as structured content *inside* each page (headings + bullets), not as separate database rows. If columns are ever renamed in Notion, update `FIELD_NAMES` in `src/notion.ts` to match.
4. **Important — Notion API version note:** as of September 2025, Notion split each database into "data sources"; writes target a `data_source_id`, not the database ID directly. `src/notion.ts` resolves this automatically from `NOTION_DATABASE_ID` and caches it — no extra config needed, but if the Notion SDK version changes again in the future, this is the first place to check.

### 3. Email (Resend)
1. Sign up at [resend.com](https://resend.com) **using `edwerd@kenresearch.com` as the account's own login email.** This matters: Resend's free sandbox sender (`onboarding@resend.dev`) can only deliver to the email address the account itself is registered under — using any other login email means sending to `edwerd@kenresearch.com` will fail with a 403 error unless a real domain is separately verified (DNS/SPF/DKIM records, outside this repo's scope). Signing up with that exact address is what makes the free tier work with zero extra setup.
2. From the Resend dashboard, grab the API key (Settings → API Keys) — this is used as the SMTP password, not a separate API integration; `scripts/send_report_email.py` sends via plain `smtplib` against `smtp.resend.com`.
3. Free tier is generously sized for this use case (far more than 3 emails/day).

### 4. GitHub Secrets
In the repo: **Settings → Secrets and variables → Actions → New repository secret**. Add:

| Secret | Value |
|---|---|
| `NOTION_TOKEN` | Notion integration token |
| `NOTION_DATABASE_ID` | `3d0369df402080758409f3e680b4bb59` |
| `RESEND_API_KEY` | Resend API key (used as the SMTP password) |
| `EMAIL_FROM` | `onboarding@resend.dev` (Resend's free sandbox sender) |

No `DATABASE_URL` — the SQLite file needs no credentials, just the `contents: write` permission already configured in the workflow so it can commit results back.

### 5. Dashboard (GitHub Pages) — one-time manual step
The dashboard's HTML/data files are already in the repo (`docs/`), but GitHub Pages hosting itself has to be turned on once, by hand — no workflow change can do this part:
1. Go to **Settings → Pages** in the repo (`https://github.com/design-ken/form-testing-agent/settings/pages`)
2. Under "Build and deployment" → "Source," select **"Deploy from a branch"**
3. Branch: **`main`**, folder: **`/docs`** → Save
4. First deploy takes about a minute; the dashboard is then live at **`https://design-ken.github.io/form-testing-agent/`** and auto-redeploys every time `docs/` changes on `main` (i.e., after every scheduled test run, per step 5 above)

No secrets or extra permissions needed — this reuses the same `contents: write` git commit that already saves `db/test-runs.sqlite` after every run.

## Local Development

```bash
npm install
npx playwright install chromium

# Create a .env file (gitignored) with the same variables as the GitHub Secrets table above:
# NOTION_TOKEN=...
# NOTION_DATABASE_ID=...

npm run test:forms   # runs the full 12-pass suite locally, writes run-summary.json
npm run typecheck    # TypeScript type-check with no emit

# To test the email step locally (needs Python 3.9+, stdlib only, no pip installs):
export RESEND_API_KEY=...
export EMAIL_FROM=onboarding@resend.dev
export EMAIL_TO=edwerd@kenresearch.com
python3 scripts/send_report_email.py   # reads run-summary.json from the repo root by default

# To regenerate and preview the dashboard locally:
npm run dashboard:export   # queries db/test-runs.sqlite, writes docs/data.json
npx serve docs              # or: python3 -m http.server --directory docs 8000
```

## Manually Triggering a Run

From the GitHub Actions tab: select "Lead Form Tester" → "Run workflow". Or via CLI if `gh` is installed: `gh workflow run "Lead Form Tester"`.

## Known Limitations (By Design)

- **Email covers every run, not a watchdog.** The email summary fires as part of a run — it tells you what happened, not whether a run *should* have happened but didn't. A silently-disabled cron (see the 60-day note above) produces zero signal, since there's no run to email about. BUZZ/Slack-style alerting and a dedicated watchdog are both still not implemented — see Deferred to Later.
- **Dashboard's "run health" can't see a fully-crashed run.** If a run dies before `insertResults()` runs (e.g. a Chromium segfault or timeout), it leaves zero rows in SQLite — invisible to the dashboard except as an aggregate gap between the expected (~3/day) and actual run count over the last 7 days. The dashboard can tell you "fewer runs happened than expected" but not which run or why — check the GitHub Actions tab for that.
- **Dashboard has no per-form timing trends.** That data (`FormTestMetrics.durationMs`) is only ever computed in-memory per run and isn't persisted to SQLite — only the latest run's timing shows up in Notion/email, no historical trend exists. Would need a schema change (a new column) to start tracking; not done in this version.
- **Backend/CRM delivery is not verified.** This suite only confirms browser-visible submission success (a confirmation message or redirect). Whether the lead actually reaches the CRM/email backend requires backend access this agent doesn't have — flagged in every report.
- **CRM test-data filtering is not configured.** Test submissions use a tagged fake identity (`QA Test Automated` / `qa-test-leadform@kenresearch.com`) but no automatic CRM-side filtering has been set up (confirmed not required for now). Note: real tagged test leads **will** land in the actual CRM/consulting queue each time this runs — this is expected, not a bug.
- **SQLite is single-writer.** Fine for this use case (one scheduled run at a time, ~12 rows per run), but don't add concurrent/overlapping workflow triggers without reworking `src/db.ts` — two Actions runs committing to the same file at once would conflict.
- **Client-side hydration timing.** The live site doesn't fully respond to clicks until its JS framework hydrates after `domcontentloaded` (confirmed live — `networkidle` never resolves on this site, likely due to a persistent background connection). `functional.ts` and `run.ts` use a fixed ~2s settle delay instead. If the real site becomes slower to hydrate, this delay may need increasing.

## Deferred to Later

- **BUZZ/Slack-style alerting** — real BUZZ posting once Project ECHO's Track A exists. `src/buzz.ts` is already a stub (`notifyBuzz()`) ready to be wired to a real endpoint — swapping that in is the fastest path back to a second notification channel when it's time. (Email alerting via Resend already ships, per above.)
- A watchdog to detect a silently-skipped/disabled cron trigger — not worth rebuilding until there's an alert channel for it to use.
- Component Audit & Clean-up agent (separate build, can reuse this repo's Playwright setup pattern)
