#!/usr/bin/env python3
"""Emails the weekly accessibility/layout digest built by src/weekly-digest.ts (weekly-digest.json).
Non-fatal on every failure, like send_report_email.py (whose SMTP helper it reuses)."""
import json
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(__file__))
from send_report_email import FONT, SEVERITY_COLOR, esc, format_ist_timestamp, send_email, _footer  # noqa: E402


def spark(trend):
    top = max(trend) or 1
    bars = "".join(
        f'<td valign="bottom" style="padding:0 2px;"><div style="width:14px;height:{max(4, round(v / top * 34))}px;background:{"#7b61d9" if i == len(trend) - 1 else "#cfc8f0"};border-radius:2px;"></div></td>'
        for i, v in enumerate(trend)
    )
    return f'<table style="border-collapse:collapse;"><tr>{bars}</tr></table>'


def build_html(d):
    def k(label, val, color="#1e293b"):
        return f'<td style="padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;text-align:center;"><div style="font-size:22px;font-weight:700;color:{color};{FONT}">{val}</div><div style="font-size:12px;color:#64748b;{FONT}">{label}</div></td>'

    rows = "".join(
        f'<tr><td style="padding:8px;border-bottom:1px solid #e2e8f0;font-size:13px;{FONT}"><b style="color:{SEVERITY_COLOR.get(t["severity"], "#6b7280")};">{(t["severity"] or "").upper()}</b> {esc(t["issue"])}</td>'
        f'<td style="padding:8px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#475569;{FONT}">{esc(t["where"])}</td>'
        f'<td style="padding:8px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#334155;{FONT}">{esc(t["fix"])}</td></tr>'
        for t in d["top"]
    )
    fixed = "".join(f"<li>✔ {esc(x)}</li>" for x in d["fixedList"]) or "<li>Nothing fixed this week.</li>"
    arrow = "trending down" if d["trend"][-1] < d["trend"][0] else ("flat" if d["trend"][-1] == d["trend"][0] else "trending up")
    return f"""
    <div style="background:#7b61d9;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0;{FONT}"><div style="font-size:18px;font-weight:700;">Weekly accessibility digest</div>
      <div style="font-size:13px;opacity:.9;">Lead forms — as of {format_ist_timestamp(d['periodEnd'])}</div></div>
    <div style="padding:18px 20px;"><table style="width:100%;border-collapse:separate;border-spacing:8px 0;"><tr>
      {k('open issues', d['openIssues'])}{k('fixed this week', d['fixedThisWeek'], '#16a34a')}{k('new', d['newThisWeek'], '#d97706')}{k('high severity', d['highSeverity'], '#dc2626')}</tr></table>
      <div style="margin-top:14px;">{spark(d['trend'])}<div style="font-size:12px;color:#64748b;{FONT}">Open issues, last 5 weeks — {arrow}</div></div>
      <div style="font-size:13px;font-weight:700;margin:18px 0 6px;{FONT}">Fix these first</div>
      <table style="width:100%;border-collapse:collapse;"><tr><th align="left" style="font-size:11px;color:#64748b;padding:6px 8px;border-bottom:1px solid #e2e8f0;">Issue</th><th align="left" style="font-size:11px;color:#64748b;padding:6px 8px;border-bottom:1px solid #e2e8f0;">Where</th><th align="left" style="font-size:11px;color:#64748b;padding:6px 8px;border-bottom:1px solid #e2e8f0;">Suggested fix</th></tr>{rows}</table>
      <div style="font-size:13px;font-weight:700;margin:18px 0 6px;{FONT}">Fixed since last week</div>
      <ul style="margin:0;padding-left:18px;font-size:13px;color:#334155;{FONT}">{fixed}</ul></div>{_footer()}"""


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "weekly-digest.json"
    try:
        d = json.load(open(path, encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as err:
        print(f"[weekly_digest] Cannot read {path}: {err}", file=sys.stderr)
        return
    key = os.environ.get("RESEND_API_KEY")
    if not key:
        print("[weekly_digest] RESEND_API_KEY not set — skipping.", file=sys.stderr)
        return
    subject = f"[Lead Form Tester] Weekly accessibility digest · {datetime.now().strftime('%d %b %Y')}"
    text = f"Open issues: {d['openIssues']} | fixed: {d['fixedThisWeek']} | new: {d['newThisWeek']} | high: {d['highSeverity']}\n" + "\n".join(f"- {t['issue']} ({t['where']}): {t['fix']}" for t in d["top"])
    try:
        send_email(subject, build_html(d), text, "smtp.resend.com", 465, "resend", key, os.environ.get("EMAIL_FROM", "onboarding@resend.dev"), os.environ.get("EMAIL_TO", "edwerd@kenresearch.com"))
        print(f"[weekly_digest] Sent: {subject}")
    except Exception as err:  # noqa: BLE001 - never fail the workflow over email
        print(f"[weekly_digest] Failed to send: {err}", file=sys.stderr)


if __name__ == "__main__":
    main()
