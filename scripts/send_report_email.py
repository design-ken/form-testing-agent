#!/usr/bin/env python3
"""
Sends a compiled HTML summary email after every Lead Form Tester run.

Reads run-summary.json (written by src/run.ts at the end of main()) and
sends a scannable digest via Resend's SMTP relay. This is deliberately NOT
a duplicate of the Notion report: it leads with counts and severity-sorted
issues, and omits the full per-check "Detailed Results" dump (that stays
Notion-only) — the email's whole purpose is to be readable at a glance,
with a link back to Notion for anyone who needs the full breakdown.

Never exits non-zero on a failure to read/parse/send — every failure mode
here is logged to stderr and treated as non-fatal, since losing the email
notification must never block the workflow's DB-commit step that runs
after this one. The workflow invokes this with `if: always()` specifically
so it still runs (and still degrades gracefully) even when test:forms
itself failed.
"""

import json
import os
import smtplib
import sys
from datetime import datetime, timezone, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2, None: 3}
SEVERITY_COLOR = {"high": "#dc2626", "medium": "#d97706", "low": "#6b7280", None: "#6b7280"}
IST = timezone(timedelta(hours=5, minutes=30))


def load_summary(path):
    if not os.path.isfile(path):
        print(f"[send_report_email] No summary file at {path} — skipping email (nothing to report).", file=sys.stderr)
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as err:
        print(f"[send_report_email] Failed to read/parse {path}: {err}", file=sys.stderr)
        return None


def overall_status(summary):
    # Mirrors notion.ts's overallStatus() exactly so the email and Notion
    # report never disagree on the headline status word.
    if summary.get("runFailed"):
        return "RUN FAILED", "#dc2626"
    if summary.get("totalFail", 0) > 0 or summary.get("totalError", 0) > 0 or summary.get("totalAtRisk", 0) > 0:
        return "Issues Found", "#d97706"
    return "All Passed", "#16a34a"


def format_ist_timestamp(iso_timestamp):
    try:
        dt = datetime.fromisoformat(iso_timestamp.replace("Z", "+00:00")).astimezone(IST)
        return dt.strftime("%d %b %Y, %I:%M %p IST")
    except (ValueError, AttributeError):
        return iso_timestamp or "unknown time"


def build_subject(summary, status_word):
    date_str = format_ist_timestamp(summary.get("runTimestamp", ""))
    return (
        f"[Lead Form Tester] {status_word} — "
        f"{summary.get('totalPass', 0)} pass / {summary.get('totalFail', 0)} fail / "
        f"{summary.get('totalAtRisk', 0)} at risk / {summary.get('totalError', 0)} error — {date_str}"
    )


def stat_box(label, value, color):
    return f"""
    <td style="padding:12px 16px;text-align:center;background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
      <div style="font-size:28px;font-weight:700;color:{color};font-family:-apple-system,Helvetica,Arial,sans-serif;">{value}</div>
      <div style="font-size:12px;color:#64748b;font-family:-apple-system,Helvetica,Arial,sans-serif;text-transform:uppercase;letter-spacing:0.5px;">{label}</div>
    </td>
    """


def build_issue_card(issue):
    severity = issue.get("severity")
    color = SEVERITY_COLOR.get(severity, SEVERITY_COLOR[None])
    severity_label = (severity or "unranked").upper()
    devices = ", ".join(issue.get("affectedDevices", []) or [])
    return f"""
    <div style="border-left:4px solid {color};background-color:#f8fafc;padding:12px 16px;margin-bottom:10px;border-radius:0 6px 6px 0;font-family:-apple-system,Helvetica,Arial,sans-serif;">
      <div style="font-size:11px;font-weight:700;color:{color};letter-spacing:0.5px;margin-bottom:4px;">{severity_label}</div>
      <div style="font-size:14px;font-weight:600;color:#1e293b;margin-bottom:4px;">{issue.get('formName', '')} — {issue.get('category', '')}</div>
      <div style="font-size:13px;color:#334155;margin-bottom:6px;">{issue.get('description', '')}</div>
      <div style="font-size:11px;color:#64748b;">Affected: {devices or 'unknown'}</div>
    </div>
    """


def build_html(summary):
    status_word, status_color = overall_status(summary)
    timestamp_str = format_ist_timestamp(summary.get("runTimestamp", ""))

    header = f"""
    <div style="background-color:{status_color};color:#ffffff;padding:16px 20px;border-radius:8px 8px 0 0;font-family:-apple-system,Helvetica,Arial,sans-serif;">
      <div style="font-size:18px;font-weight:700;">{status_word}</div>
      <div style="font-size:13px;opacity:0.9;margin-top:2px;">Lead Form Tester — {timestamp_str}</div>
    </div>
    """

    body_parts = [header]

    if summary.get("runFailed"):
        reason = summary.get("runFailureReason", "unknown error")
        body_parts.append(f"""
        <div style="padding:20px;">
          <div style="background-color:#fef2f2;border:1px solid #dc2626;border-radius:8px;padding:16px;font-family:-apple-system,Helvetica,Arial,sans-serif;">
            <div style="font-weight:700;color:#dc2626;margin-bottom:6px;">Run failed to complete</div>
            <div style="font-size:13px;color:#334155;">{reason}</div>
          </div>
        </div>
        """)
        return "".join(body_parts) + _footer()

    stats = "".join([
        stat_box("Passed", summary.get("totalPass", 0), "#16a34a"),
        stat_box("Failed", summary.get("totalFail", 0), "#dc2626"),
        stat_box("At Risk", summary.get("totalAtRisk", 0), "#d97706"),
        stat_box("Errored", summary.get("totalError", 0), "#6b7280"),
    ])
    body_parts.append(f"""
    <div style="padding:20px 20px 0 20px;">
      <table style="width:100%;border-collapse:separate;border-spacing:8px 0;">
        <tr>{stats}</tr>
      </table>
    </div>
    """)

    form_metrics = summary.get("formMetrics") or []
    if form_metrics:
        rows = "".join(
            f"""<tr>
                  <td style="padding:6px 12px;font-size:13px;color:#334155;border-bottom:1px solid #e2e8f0;">{m.get('formName', '')}</td>
                  <td style="padding:6px 12px;font-size:13px;color:#334155;border-bottom:1px solid #e2e8f0;text-align:right;">{round(m.get('durationMs', 0) / 1000, 2)}s</td>
                </tr>"""
            for m in form_metrics
        )
        body_parts.append(f"""
        <div style="padding:20px;font-family:-apple-system,Helvetica,Arial,sans-serif;">
          <div style="font-size:13px;font-weight:700;color:#1e293b;margin-bottom:8px;">Test Duration per Form</div>
          <table style="width:100%;border-collapse:collapse;">{rows}</table>
        </div>
        """)

    issues = summary.get("consolidatedIssues") or []
    body_parts.append('<div style="padding:0 20px 20px 20px;font-family:-apple-system,Helvetica,Arial,sans-serif;">')
    body_parts.append('<div style="font-size:13px;font-weight:700;color:#1e293b;margin-bottom:10px;">Issues to Fix</div>')
    if issues:
        sorted_issues = sorted(issues, key=lambda i: SEVERITY_ORDER.get(i.get("severity"), 3))
        body_parts.append("".join(build_issue_card(i) for i in sorted_issues))
    else:
        body_parts.append('<div style="font-size:13px;color:#16a34a;">No issues found — all checks passed.</div>')
    body_parts.append("</div>")

    notion_url = summary.get("notionPageUrl")
    if notion_url:
        body_parts.append(f"""
        <div style="padding:0 20px 20px 20px;font-family:-apple-system,Helvetica,Arial,sans-serif;">
          <a href="{notion_url}" style="display:inline-block;font-size:13px;color:#2563eb;text-decoration:none;font-weight:600;">View full per-check results in Notion &rarr;</a>
        </div>
        """)
    else:
        body_parts.append("""
        <div style="padding:0 20px 20px 20px;font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:13px;color:#64748b;">
          See today's Notion page for full per-check results.
        </div>
        """)

    body_parts.append(_footer())
    return "".join(body_parts)


def _footer():
    return """
    <div style="padding:12px 20px;border-top:1px solid #e2e8f0;font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:11px;color:#94a3b8;">
      Automated message from the Lead Form Tester agent.
    </div>
    """


def build_plain_text(summary):
    status_word, _ = overall_status(summary)
    lines = [
        f"Lead Form Tester — {status_word}",
        f"Run: {format_ist_timestamp(summary.get('runTimestamp', ''))}",
        "",
    ]
    if summary.get("runFailed"):
        lines.append(f"Run failed: {summary.get('runFailureReason', 'unknown error')}")
        return "\n".join(lines)

    lines.append(
        f"{summary.get('totalPass', 0)} passed, {summary.get('totalFail', 0)} failed, "
        f"{summary.get('totalAtRisk', 0)} at risk, {summary.get('totalError', 0)} errored"
    )
    lines.append("")
    issues = summary.get("consolidatedIssues") or []
    if issues:
        lines.append("Issues to Fix:")
        for issue in sorted(issues, key=lambda i: SEVERITY_ORDER.get(i.get("severity"), 3)):
            severity = (issue.get("severity") or "unranked").upper()
            devices = ", ".join(issue.get("affectedDevices", []) or [])
            lines.append(f"- [{severity}] {issue.get('formName', '')} ({issue.get('category', '')}): {issue.get('description', '')} (affected: {devices})")
    else:
        lines.append("No issues found — all checks passed.")

    notion_url = summary.get("notionPageUrl")
    lines.append("")
    lines.append(f"Full details: {notion_url}" if notion_url else "See today's Notion page for full per-check results.")
    return "\n".join(lines)


def send_email(subject, html_body, text_body, smtp_host, smtp_port, username, password, sender, recipient):
    message = MIMEMultipart("alternative")
    message["Subject"] = subject
    message["From"] = sender
    message["To"] = recipient
    message.attach(MIMEText(text_body, "plain"))
    message.attach(MIMEText(html_body, "html"))

    with smtplib.SMTP_SSL(smtp_host, smtp_port) as server:
        server.login(username, password)
        server.send_message(message)


def main():
    summary_path = sys.argv[1] if len(sys.argv) > 1 else "run-summary.json"
    summary = load_summary(summary_path)
    if summary is None:
        return  # already logged, exit 0

    api_key = os.environ.get("RESEND_API_KEY")
    if not api_key:
        print("[send_report_email] RESEND_API_KEY not set — skipping email.", file=sys.stderr)
        return

    email_from = os.environ.get("EMAIL_FROM", "onboarding@resend.dev")
    email_to = os.environ.get("EMAIL_TO", "edwerd@kenresearch.com")

    status_word, _ = overall_status(summary)
    subject = build_subject(summary, status_word)
    html_body = build_html(summary)
    text_body = build_plain_text(summary)

    try:
        send_email(
            subject=subject,
            html_body=html_body,
            text_body=text_body,
            smtp_host="smtp.resend.com",
            smtp_port=465,
            username="resend",
            password=api_key,
            sender=email_from,
            recipient=email_to,
        )
    except (smtplib.SMTPException, OSError) as err:
        print(f"[send_report_email] Failed to send email: {err}", file=sys.stderr)
        return

    print(f"[send_report_email] Sent: {subject}")


if __name__ == "__main__":
    main()
