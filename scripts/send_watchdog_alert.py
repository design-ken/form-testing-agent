#!/usr/bin/env python3
"""Emails an alert if watchdog.json (from src/watchdog.ts) says something is silently wrong. No alert → no email."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from send_report_email import FONT, esc, format_ist_timestamp, send_email, _footer  # noqa: E402


def main():
    try:
        d = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "watchdog.json", encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as err:
        print(f"[watchdog_alert] Cannot read watchdog.json: {err}", file=sys.stderr)
        return
    if not d.get("alert"):
        print("[watchdog_alert] All clear — no email.")
        return
    key = os.environ.get("RESEND_API_KEY")
    if not key:
        print("[watchdog_alert] RESEND_API_KEY not set — skipping.", file=sys.stderr)
        return
    last = format_ist_timestamp(d["lastRun"]) if d.get("lastRun") else "never"
    items = "".join(f'<li style="margin-bottom:6px;">{esc(r)}</li>' for r in d["reasons"])
    repo = os.environ.get("GITHUB_REPOSITORY", "design-ken/form-testing-agent")
    html = f"""<div style="background:#dc2626;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0;{FONT}"><div style="font-size:18px;font-weight:700;">Watchdog: the testing agent needs attention</div>
      <div style="font-size:13px;opacity:.9;">Last run: {last}</div></div>
      <div style="padding:18px 20px;{FONT}"><ul style="margin:0;padding-left:18px;font-size:13px;color:#334155;">{items}</ul>
      <p style="margin-top:14px;"><a href="https://github.com/{repo}/actions" style="font-size:13px;color:#2563eb;font-weight:600;">Open the Actions tab / run now &rarr;</a></p></div>{_footer()}"""
    subject = f"[Lead Form Tester] ⚠️ Watchdog: {d['reasons'][0][:80]}"
    try:
        send_email(subject, html, "\n".join(d["reasons"]), "smtp.resend.com", 465, "resend", key, os.environ.get("EMAIL_FROM", "onboarding@resend.dev"), os.environ.get("EMAIL_TO", "edwerd@kenresearch.com"))
        print(f"[watchdog_alert] Sent: {subject}")
    except Exception as err:  # noqa: BLE001
        print(f"[watchdog_alert] Failed to send: {err}", file=sys.stderr)


if __name__ == "__main__":
    main()
