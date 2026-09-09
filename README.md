# Lead Form Tester

Automated, unattended Playwright testing of Ken Research's 4 revenue-critical lead-generation forms, running twice daily on GitHub Actions. Reports to a repo-committed SQLite database and Notion. No dependency on any local machine being on, and no third-party database or email account required.

Part of Project ECHO — Track B (Testing Team). See `plan/track-b-testing-team.md` in the main Project ECHO vault for the full spec this implements.

**No alerting in this version — check Notion to see results.** There is no email, no push notification, no watchdog. If you want to know whether a run happened or a form broke, open the Notion database. This was a deliberate scope cut to prioritize getting autonomous deployment working first; alerting is deferred until BUZZ (Project ECHO Track A) exists (see Deferred to Later).

## ⚠️ Critical Operational Note — Read This

**GitHub automatically disables scheduled workflows (`schedule:` cron triggers) after 60 days of repository inactivity (no commits/pushes).** If nobody touches this repo for two months, the twice-daily runs will silently stop — with no warning from GitHub, and with no email/watchdog layer in this version, **nothing will tell you this happened.** The only way to notice is checking Notion (or the Actions tab) and seeing no new rows for a while.

**Mitigation:** either make a small commit to this repo at least once every ~45 days, or set a recurring personal reminder to check `gh workflow list` / the Actions tab / the Notion database periodically. This is a known GitHub platform behavior, not a bug in this code.

## What This Does

Twice a day (8 AM and 6 PM IST), a GitHub Actions runner:
1. Loads all 4 forms (Sample Report, Custom Form, Talk to Us, Book a Discovery Call) across 3 viewports (desktop, tablet, mobile) — 12 test passes total
2. Runs functional checks (fields load, validation, submission, confirmation), layout checks (cutoff, horizontal scroll, touch targets), a full-page screenshot, and an axe-core accessibility scan for each
3. Writes every individual check result to `db/test-runs.sqlite` (committed back to the repo by the workflow), and writes **one Notion page per run** — the page's properties show the run-level summary (Status, Passed/Failed/At Risk/Errored counts, Date), and the full per-form, per-device breakdown lives inside the page as structured content (a heading per form, a sub-heading per device, a bullet per check). **Notion is the primary place to check results** — open the latest page in the database to see everything about that run in one place
4. Uploads screenshots as a GitHub Actions artifact (90-day retention)

## One-Time Setup

### 1. Database — no signup needed
Results are stored in `db/test-runs.sqlite`, a file committed directly to this repo. The schema is created automatically on first run (see `src/db.ts`) — nothing to sign up for or configure. The GitHub Actions workflow commits the updated file back to `main` after every run, so history accumulates in git itself.

If you ever want to inspect it locally: `sqlite3 db/test-runs.sqlite "SELECT * FROM test_runs ORDER BY run_timestamp DESC LIMIT 20;"`

### 2. Notion
1. This writes to the existing "Testing agent log" database (ID: `3d0369df402080758409f3e680b4bb59`).
2. Create/use a Notion integration token scoped to that database (Notion → Settings → Connections → Develop or manage integrations), and share the database with that integration (database page → `•••` → Connections).
3. **One page per run, not one row per check.** The database columns are run-level summaries — Status (All Passed / Issues Found / Run Failed), Passed, Failed, At Risk, Errored, Date — created directly via the Notion API to match `src/notion.ts`'s `FIELD_NAMES`. The full per-form/per-device/per-check breakdown lives as structured content *inside* each page (headings + bullets), not as separate database rows. If columns are ever renamed in Notion, update `FIELD_NAMES` in `src/notion.ts` to match.
4. **Important — Notion API version note:** as of September 2025, Notion split each database into "data sources"; writes target a `data_source_id`, not the database ID directly. `src/notion.ts` resolves this automatically from `NOTION_DATABASE_ID` and caches it — no extra config needed, but if the Notion SDK version changes again in the future, this is the first place to check.

### 3. GitHub Secrets
In the repo: **Settings → Secrets and variables → Actions → New repository secret**. Add:

| Secret | Value |
|---|---|
| `NOTION_TOKEN` | Notion integration token |
| `NOTION_DATABASE_ID` | `3d0369df402080758409f3e680b4bb59` |

That's the only setup required. No `DATABASE_URL`, no email provider — the SQLite file needs no credentials, just the `contents: write` permission already configured in the workflow so it can commit results back.

## Local Development

```bash
npm install
npx playwright install chromium

# Create a .env file (gitignored) with the same variables as the GitHub Secrets table above:
# NOTION_TOKEN=...
# NOTION_DATABASE_ID=...

npm run test:forms   # runs the full 12-pass suite locally
npm run typecheck    # TypeScript type-check with no emit
```

## Manually Triggering a Run

From the GitHub Actions tab: select "Lead Form Tester" → "Run workflow". Or via CLI if `gh` is installed: `gh workflow run "Lead Form Tester"`.

## Known Limitations (By Design)

- **No alerting at all.** This is the biggest one — there is no email, no push notification, no watchdog. A broken form, a failed run, or a silently-disabled cron (see the 60-day note above) produces no signal anywhere except Notion/the Actions tab. This was an explicit scope decision to prioritize getting autonomous deployment working first — see Deferred to Later.
- **Backend/CRM delivery is not verified.** This suite only confirms browser-visible submission success (a confirmation message or redirect). Whether the lead actually reaches the CRM/email backend requires backend access this agent doesn't have — flagged in every report.
- **CRM test-data filtering is not configured.** Test submissions use a tagged fake identity (`QA Test Automated` / `qa-test-leadform@kenresearch.com`) but no automatic CRM-side filtering has been set up (confirmed not required for now). Note: real tagged test leads **will** land in the actual CRM/consulting queue each time this runs — this is expected, not a bug.
- **SQLite is single-writer.** Fine for this use case (one scheduled run at a time, ~12 rows per run), but don't add concurrent/overlapping workflow triggers without reworking `src/db.ts` — two Actions runs committing to the same file at once would conflict.
- **Client-side hydration timing.** The live site doesn't fully respond to clicks until its JS framework hydrates after `domcontentloaded` (confirmed live — `networkidle` never resolves on this site, likely due to a persistent background connection). `functional.ts` and `run.ts` use a fixed ~2s settle delay instead. If the real site becomes slower to hydrate, this delay may need increasing.

## Deferred to Later

- **Alerting of any kind** — email, Slack, or (preferred, per the Track B spec) real BUZZ posting once Project ECHO's Track A exists. `src/buzz.ts` is already a stub (`notifyBuzz()`) ready to be wired to a real endpoint — swapping that in is the fastest path back to notifications when it's time.
- A watchdog to detect a silently-skipped/disabled cron trigger — not worth rebuilding until there's an alert channel for it to use.
- Component Audit & Clean-up agent (separate build, can reuse this repo's Playwright setup pattern)
