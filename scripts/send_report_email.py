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


FORMS = ["Sample Report", "Custom Form", "Talk to Us", "Book a Discovery Call"]
FONT = "font-family:-apple-system,Helvetica,Arial,sans-serif;"


def split_issues(summary):
    issues = summary.get("consolidatedIssues") or []
    urgent = [i for i in issues if i.get("urgent")]
    new_other = [i for i in issues if i.get("isNew") and not i.get("urgent")]
    return urgent, new_other


def overall_status(summary):
    # Headline word + colour. Urgent (a form that cannot submit/load) outranks
    # everything; known backlog alone never turns the headline amber.
    if summary.get("runFailed"):
        return "RUN FAILED", "#dc2626"
    urgent, new_other = split_issues(summary)
    if urgent:
        return "URGENT", "#dc2626"
    if new_other:
        return "New issues", "#d97706"
    return "All clear", "#16a34a"


def format_ist_timestamp(iso_timestamp):
    try:
        dt = datetime.fromisoformat(iso_timestamp.replace("Z", "+00:00")).astimezone(IST)
        return dt.strftime("%d %b %Y, %I:%M %p IST")
    except (ValueError, AttributeError):
        return iso_timestamp or "unknown time"


def build_subject(summary, status_word):
    when = format_ist_timestamp(summary.get("runTimestamp", ""))
    urgent, new_other = split_issues(summary)
    if summary.get("runFailed"):
        return f"[Lead Form Tester] \U0001F534 RUN FAILED \u2014 nothing was tested \u00b7 {when}"
    if urgent:
        u = urgent[0]
        devs = ", ".join(u.get("affectedDevices") or [])
        extra = f" (+{len(urgent) - 1} more)" if len(urgent) > 1 else ""
        return f"[Lead Form Tester] \U0001F534 URGENT \u2014 \"{u.get('formName')}\" cannot submit/load on {devs}{extra} \u00b7 {when}"
    if new_other:
        n = len(new_other)
        return f"[Lead Form Tester] \U0001F7E1 {n} new issue{'s' if n != 1 else ''} \u2014 all forms still submitting \u00b7 {when}"
    return f"[Lead Form Tester] \u2705 All lead forms working \u2014 no new issues \u00b7 {when}"


def stat_box(label, value, color):
    return f"""
    <td style="padding:12px 16px;text-align:center;background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
      <div style="font-size:26px;font-weight:700;color:{color};{FONT}">{value}</div>
      <div style="font-size:12px;color:#64748b;{FONT}">{label}</div>
    </td>
    """


def esc(t):
    return str(t).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build_issue_card(issue, tag=None):
    severity = issue.get("severity")
    color = SEVERITY_COLOR.get(severity, SEVERITY_COLOR[None])
    devices = ", ".join(issue.get("affectedDevices", []) or [])
    badge = f'<span style="background:#ede9fe;color:#6d28d9;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700;margin-left:6px;">{tag}</span>' if tag else ""
    retry = ' <span style="color:#dc2626;font-size:11px;">\u00b7 confirmed on retry</span>' if issue.get("confirmedOnRetry") else ""
    desc = esc(issue.get("description", "").replace(" (confirmed on retry)", ""))
    return f"""
    <div style="border-left:4px solid {color};background-color:#f8fafc;padding:12px 16px;margin-bottom:10px;border-radius:0 6px 6px 0;{FONT}">
      <div style="font-size:11px;font-weight:700;color:{color};letter-spacing:0.5px;margin-bottom:4px;">{(severity or 'unranked').upper()}{badge}</div>
      <div style="font-size:14px;font-weight:600;color:#1e293b;margin-bottom:4px;">{esc(issue.get('formName', ''))} \u2014 {esc(issue.get('category', ''))}</div>
      <div style="font-size:13px;color:#334155;margin-bottom:6px;">{desc}{retry}</div>
      <div style="font-size:11px;color:#64748b;">Affected: {esc(devices or 'unknown')}</div>
    </div>
    """


def lead_line(summary):
    rs = [r for r in (summary.get("results") or []) if str(r.get("description", "")).startswith("Valid submission")]
    l = summary.get("realLeads") or {}
    today = f" \u00b7 {l['today']} of {l['cap']} today" if l else ""
    if not rs:
        return f"No real test leads in this run{today}."
    ok = sum(1 for r in rs if r.get("status") == "pass")
    detail = "; ".join(f"{r.get('formName')} / {r.get('target') or r.get('device')} " + ("\u2714" if r.get("status") == "pass" else "\u2718 no confirmation") for r in rs)
    return f"Real test leads this run: {len(rs)} ({ok} confirmed){today} \u2014 {detail}"


def timing_table(summary, urgent):
    metrics = {m.get("formName"): m.get("durationMs", 0) for m in (summary.get("formMetrics") or [])}
    base = summary.get("timingBaselineMs") or {}
    bad_forms = {u.get("formName") for u in urgent}
    rows = ""
    for name in FORMS:
        if name not in metrics:
            continue
        ms = metrics[name]
        b = base.get(name)
        delta = f"{round((ms - b) / b * 100):+d}%" if b else "\u2014"
        slow = b and ms > b * 1.5
        ok = '<span style="color:#dc2626;font-weight:700;">BROKEN</span>' if name in bad_forms else '<span style="color:#16a34a;font-weight:700;">OK</span>'
        dcol = "#d97706" if slow else "#334155"
        rows += f"""<tr>
          <td style="padding:7px 10px;font-size:13px;border-bottom:1px solid #e2e8f0;">{name}</td>
          <td style="padding:7px 10px;font-size:13px;border-bottom:1px solid #e2e8f0;">{ok}</td>
          <td style="padding:7px 10px;font-size:13px;border-bottom:1px solid #e2e8f0;text-align:right;">{round(ms / 1000, 1)}s</td>
          <td style="padding:7px 10px;font-size:13px;border-bottom:1px solid #e2e8f0;text-align:right;color:{dcol};">{delta}</td></tr>"""
    head = "".join(f'<th style="text-align:{a};font-size:11px;color:#64748b;padding:6px 10px;border-bottom:1px solid #e2e8f0;font-weight:500;">{h}</th>' for h, a in [("Form", "left"), ("Submit / load", "left"), ("Test time", "right"), ("vs 7-day avg", "right")])
    return f'<table style="width:100%;border-collapse:collapse;{FONT}"><tr>{head}</tr>{rows}</table>'


TARGET_ORDER = [
    ("Desktop \u00b7 Chrome", "Chrome, 1440\u00d7900 (main desktop)"),
    ("Desktop \u00b7 Chrome 1920\u00d71080", "Chrome, full-HD monitor"),
    ("Laptop \u00b7 Chrome 1366\u00d7768", "Chrome, small laptop"),
    ("Desktop \u00b7 Edge", "Microsoft Edge, 1440\u00d7900"),
    ("Desktop \u00b7 Safari (Mac)", "Safari engine on Mac, 1280\u00d7720"),
    ("Desktop \u00b7 Firefox", "Firefox, 1440\u00d7900"),
    ("iPad \u00b7 Safari", "iPad (gen 7), Safari engine, 810\u00d71080, touch"),
    ("iPhone 15 \u00b7 Safari", "iPhone 15, Safari engine, 393\u00d7659, touch"),
    ("iPhone SE \u00b7 Safari (small)", "iPhone SE, small phone 320\u00d7568, touch"),
    ("Pixel 7 \u00b7 Chrome", "Pixel 7, Chrome, 412\u00d7839, touch"),
]


def coverage_table(summary):
    counts = {}
    for r in summary.get("results") or []:
        t = r.get("target") or r.get("device") or "unknown"
        c = counts.setdefault(t, {"pass": 0, "fail": 0, "at_risk": 0, "error": 0})
        c[r.get("status", "error")] = c.get(r.get("status", "error"), 0) + 1
    if not counts:
        return ""
    names = [t for t, _ in TARGET_ORDER if t in counts] + [t for t in counts if t not in dict(TARGET_ORDER)]
    desc = dict(TARGET_ORDER)
    rows = ""
    for t in names:
        c = counts[t]
        bad = c["fail"] + c["error"]
        mark = '<span style="color:#dc2626;font-weight:700;">%d fail</span>' % bad if bad else '<span style="color:#16a34a;font-weight:700;">OK</span>'
        rows += f"""<tr>
          <td style="padding:7px 10px;font-size:13px;border-bottom:1px solid #e2e8f0;"><b>{esc(t)}</b><div style="font-size:11px;color:#64748b;">{esc(desc.get(t, ""))}</div></td>
          <td style="padding:7px 10px;font-size:13px;border-bottom:1px solid #e2e8f0;text-align:right;">{c["pass"]}</td>
          <td style="padding:7px 10px;font-size:13px;border-bottom:1px solid #e2e8f0;text-align:right;">{c["at_risk"]}</td>
          <td style="padding:7px 10px;font-size:13px;border-bottom:1px solid #e2e8f0;text-align:right;">{mark}</td></tr>"""
    head = "".join(f'<th style="text-align:{a};font-size:11px;color:#64748b;padding:6px 10px;border-bottom:1px solid #e2e8f0;font-weight:500;">{h}</th>' for h, a in [("Device \u00b7 browser", "left"), ("Passed", "right"), ("At risk", "right"), ("Result", "right")])
    note = '<div style="font-size:11px;color:#64748b;margin-top:6px;">Emulated devices on a test server (real user agent, screen size, touch). Not physical phones; the on-screen keyboard is not simulated.</div>'
    return f'<table style="width:100%;border-collapse:collapse;{FONT}"><tr>{head}</tr>{rows}</table>{note}{failing_html(summary)}'


AXE_FRIENDLY = {
    "button-name": "Buttons without a readable name",
    "color-contrast": "Low text colour contrast",
    "link-in-text-block": "Links not distinguishable from surrounding text",
}


def failing_checks(summary):
    """Group failing/errored results by check so the report says WHAT failed, not just how many."""
    import re
    groups = {}
    for r in summary.get("results") or []:
        if r.get("status") not in ("fail", "error"):
            continue
        desc = str(r.get("description", ""))
        m = re.match(r"\[axe-core\]\s*([\w-]+)", desc)
        label = AXE_FRIENDLY.get(m.group(1), m.group(1)) if m else re.sub(r"\s*\(\d+ element\(s\) affected\)", "", desc)[:110]
        g = groups.setdefault((r.get("category", ""), label), {"forms": set(), "targets": set()})
        g["forms"].add(r.get("formName"))
        g["targets"].add(r.get("target") or r.get("device"))
    return groups


def failing_html(summary):
    groups = failing_checks(summary)
    if not groups:
        return ""
    rows = ""
    for (cat, label), g in sorted(groups.items(), key=lambda kv: -len(kv[1]["forms"]) * len(kv[1]["targets"])):
        forms = [f for f in FORMS if f in g["forms"]] + sorted(g["forms"] - set(FORMS), key=str)
        tg = sorted(g["targets"], key=str)
        tlabel = "all targets" if len(tg) >= len(TARGET_ORDER) else ", ".join(tg)
        rows += f"""<tr>
          <td style="padding:7px 10px;font-size:13px;border-bottom:1px solid #e2e8f0;"><b>{esc(label)}</b><div style="font-size:11px;color:#64748b;">{esc(cat)}</div></td>
          <td style="padding:7px 10px;font-size:12px;border-bottom:1px solid #e2e8f0;">{esc(", ".join(str(f) for f in forms))}</td>
          <td style="padding:7px 10px;font-size:12px;border-bottom:1px solid #e2e8f0;">{esc(tlabel)}</td></tr>"""
    head = "".join(f'<th style="text-align:left;font-size:11px;color:#64748b;padding:6px 10px;border-bottom:1px solid #e2e8f0;font-weight:500;">{h}</th>' for h in ("What failed", "Forms", "Seen on"))
    return f'<div style="font-size:12px;color:#64748b;margin:12px 0 6px;">What the "fail" counts above are:</div><table style="width:100%;border-collapse:collapse;{FONT}"><tr>{head}</tr>{rows}</table>'


def coverage_text(summary):
    counts = {}
    for r in summary.get("results") or []:
        t = r.get("target") or r.get("device") or "unknown"
        c = counts.setdefault(t, [0, 0])
        c[0 if r.get("status") == "pass" else 1] += 1
    return [f"  {t}: {c[0]} passed, {c[1]} not passing" for t, c in counts.items()]


def section(title, inner):
    return f'<div style="padding:4px 20px 14px 20px;{FONT}"><div style="font-size:13px;font-weight:700;color:#1e293b;margin:10px 0 8px;">{title}</div>{inner}</div>'


def build_html(summary):
    status_word, status_color = overall_status(summary)
    when = format_ist_timestamp(summary.get("runTimestamp", ""))
    parts = [f"""
    <div style="background-color:{status_color};color:#ffffff;padding:16px 20px;border-radius:8px 8px 0 0;{FONT}">
      <div style="font-size:18px;font-weight:700;">{status_word}</div>
      <div style="font-size:13px;opacity:0.9;margin-top:2px;">Lead Form Tester \u2014 {when}</div>
    </div>"""]

    if summary.get("runFailed"):
        parts.append(f"""<div style="padding:20px;"><div style="background-color:#fef2f2;border:1px solid #dc2626;border-radius:8px;padding:16px;{FONT}">
          <div style="font-weight:700;color:#dc2626;margin-bottom:6px;">Run failed to complete</div>
          <div style="font-size:13px;color:#334155;">{esc(summary.get('runFailureReason', 'unknown error'))}</div></div></div>""")
        return "".join(parts) + _footer()

    urgent, new_other = split_issues(summary)
    delta = summary.get("issueDelta") or {}
    known = delta.get("knownCount", 0)
    fixed = delta.get("fixed") or []

    stats = "".join([
        stat_box("forms healthy", f"{4 - len({u.get('formName') for u in urgent})} / 4", "#16a34a" if not urgent else "#dc2626"),
        stat_box("new issues", len(new_other) + len(urgent), "#d97706" if (new_other or urgent) else "#16a34a"),
        stat_box("known (unchanged)", known, "#64748b"),
        stat_box("fixed since last run", len(fixed), "#16a34a"),
    ])
    parts.append(f'<div style="padding:18px 20px 4px;"><table style="width:100%;border-collapse:separate;border-spacing:8px 0;"><tr>{stats}</tr></table>'
                 f'<div style="font-size:12px;color:#64748b;margin-top:10px;{FONT}">{esc(lead_line(summary))}</div></div>')

    if urgent:
        parts.append(section("Needs action now", "".join(build_issue_card(i) for i in urgent) +
                             (f'<div style="font-size:12px;color:#64748b;">Page screenshot from this run attached ({len(summary.get("urgentScreenshots") or [])}).</div>' if summary.get("urgentScreenshots") else "")))
    if new_other:
        parts.append(section("New this run", "".join(build_issue_card(i, "NEW") for i in sorted(new_other, key=lambda i: SEVERITY_ORDER.get(i.get("severity"), 3)))))
    if fixed:
        items = "".join(f'<li style="margin-bottom:3px;">\u2714 {esc(f.get("formName"))} \u2014 {esc(f.get("description")[:110])}</li>' for f in fixed[:8])
        parts.append(section("Fixed since last run", f'<ul style="margin:0;padding-left:18px;font-size:13px;color:#334155;">{items}</ul>'))
    if not urgent and not new_other:
        parts.append(section("Issues", f'<div style="font-size:13px;color:#16a34a;">No new issues. {known} known accessibility/layout issue(s) unchanged \u2014 see the weekly digest.</div>'))
    elif known:
        parts.append(f'<div style="padding:0 20px 8px;font-size:12px;color:#64748b;{FONT}">Plus {known} known issue(s) unchanged since earlier runs (not repeated here).</div>')

    parts.append(section("Submit health & speed", timing_table(summary, urgent)))
    cov = coverage_table(summary)
    if cov:
        parts.append(section("Devices &amp; browsers tested", cov))

    notion_url = summary.get("notionPageUrl")
    link = f'<a href="{notion_url}" style="font-size:13px;color:#2563eb;text-decoration:none;font-weight:600;">View full per-check results in Notion &rarr;</a>' if notion_url else '<span style="font-size:13px;color:#64748b;">See today\'s Notion page for full per-check results.</span>'
    parts.append(f'<div style="padding:0 20px 20px;{FONT}">{link}</div>')
    parts.append(_footer())
    return "".join(parts)


def _footer():
    return f"""
    <div style="padding:12px 20px;border-top:1px solid #e2e8f0;{FONT}font-size:11px;color:#94a3b8;">
      Automated message from the Lead Form Tester agent.
    </div>
    """


def build_plain_text(summary):
    status_word, _ = overall_status(summary)
    lines = [f"Lead Form Tester \u2014 {status_word}", f"Run: {format_ist_timestamp(summary.get('runTimestamp', ''))}", ""]
    if summary.get("runFailed"):
        lines.append(f"Run failed: {summary.get('runFailureReason', 'unknown error')}")
        return "\n".join(lines)
    urgent, new_other = split_issues(summary)
    delta = summary.get("issueDelta") or {}
    lines.append(lead_line(summary))
    lines.append(f"{len(urgent)} urgent, {len(new_other)} new, {delta.get('knownCount', 0)} known (unchanged), {len(delta.get('fixed') or [])} fixed")
    for label, group in (("NEEDS ACTION NOW", urgent), ("NEW", new_other)):
        for i in group:
            lines.append(f"- [{label}] {i.get('formName')} ({i.get('category')}): {i.get('description')} (affected: {', '.join(i.get('affectedDevices') or [])})")
    cov = coverage_text(summary)
    if cov:
        lines += ["", "Devices & browsers tested:"] + cov
        for (cat, label), g in failing_checks(summary).items():
            lines.append(f"  FAIL: {label} ({cat}) - {', '.join(sorted(map(str, g['forms'])))}")
    notion_url = summary.get("notionPageUrl")
    lines += ["", f"Full details: {notion_url}" if notion_url else "See today's Notion page for full per-check results."]
    return "\n".join(lines)


def send_email(subject, html_body, text_body, smtp_host, smtp_port, username, password, sender, recipient, attachments=None):
    from email.mime.image import MIMEImage
    alt = MIMEMultipart("alternative")
    alt.attach(MIMEText(text_body, "plain"))
    alt.attach(MIMEText(html_body, "html"))
    message = MIMEMultipart("mixed") if attachments else alt
    if attachments:
        message.attach(alt)
        for path in attachments:
            try:
                with open(path, "rb") as f:
                    img = MIMEImage(f.read(), name=os.path.basename(path))
                img.add_header("Content-Disposition", "attachment", filename=os.path.basename(path))
                message.attach(img)
            except OSError as err:
                print(f"[send_report_email] Could not attach {path}: {err}", file=sys.stderr)
    message["Subject"] = subject
    message["From"] = sender
    message["To"] = recipient

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
            attachments=(summary.get("urgentScreenshots") or []),
        )
    except (smtplib.SMTPException, OSError) as err:
        print(f"[send_report_email] Failed to send email: {err}", file=sys.stderr)
        return

    print(f"[send_report_email] Sent: {subject}")


if __name__ == "__main__":
    main()
