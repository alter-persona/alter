#!/usr/bin/env python3
"""Render the harness status page.

Reads the kanban board (via `hermes kanban list --json`), the Critic's review log
(status/reviews.jsonl), the ledger, the decisions log and the research scorecards,
and writes status/index.html. No agent, no model: a cron job runs this every five
minutes and the page refreshes itself every sixty seconds.

Usage: render.py [project_dir]   (default: $HUSTLE_PROJECT or ~/project)
"""
from __future__ import annotations

import html
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

PROJECT = Path(sys.argv[1] if len(sys.argv) > 1 else os.environ.get("HUSTLE_PROJECT", Path.home() / "project"))
STATUS = PROJECT / "status"
COLUMNS = ["triage", "todo", "ready", "running", "blocked", "review", "done", "archived"]
NOW = datetime.now(timezone.utc)


def parse_ts(value):
    if not value:
        return None
    try:
        s = str(value).replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def board():
    try:
        out = subprocess.run(["hermes", "kanban", "list", "--json"], capture_output=True, text=True, timeout=60)
        data = json.loads(out.stdout or "[]")
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return []
    if isinstance(data, dict):
        data = data.get("tasks") or data.get("items") or []
    return [t for t in data if isinstance(t, dict)]


def reviews():
    path = STATUS / "reviews.jsonl"
    if not path.exists():
        return []
    rows = []
    for line in path.read_text().splitlines():
        try:
            rows.append(json.loads(line))
        except ValueError:
            continue
    return rows


def tail(path: Path, n: int):
    if not path.exists():
        return []
    lines = [l for l in path.read_text().splitlines() if l.strip()]
    return lines[-n:]


def table_rows(path: Path):
    """Count filled rows in a markdown table file (rows starting with | that are not header or rule)."""
    if not path.exists():
        return 0
    n = 0
    for line in path.read_text().splitlines():
        s = line.strip()
        if s.startswith("|") and not s.startswith("| ---") and not s.startswith("|---"):
            n += 1
    return max(0, n - 1)


def esc(s):
    return html.escape(str(s if s is not None else ""))


def metrics(tasks, revs):
    day_ago = NOW - timedelta(hours=24)
    done_24h = 0
    last_done = None
    for t in tasks:
        if str(t.get("status")) == "done":
            ts = parse_ts(t.get("updated_at") or t.get("completed_at"))
            if ts and ts >= day_ago:
                done_24h += 1
            if ts and (last_done is None or ts > last_done):
                last_done = ts
    recent = [r for r in revs if (parse_ts(r.get("at")) or NOW) >= day_ago]
    bounced = sum(1 for r in recent if r.get("verdict") == "changes")
    bounce_rate = f"{round(100 * bounced / len(recent))}%" if recent else "n/a"
    hours = f"{(NOW - last_done).total_seconds() / 3600:.1f}" if last_done else "n/a"
    connectors = sum(1 for t in tasks if str(t.get("status")) == "done" and "connector" in str(t.get("body", "")).lower()[:200])
    return [
        ("Cards done, 24h", done_24h, "6 to 20"),
        ("Critic bounce rate, 24h", bounce_rate, "20 to 60%"),
        ("Hours since last done", hours, "under 6"),
        ("Reviews, 24h", len(recent), ""),
        ("Verticals catalogued", table_rows(PROJECT / "research" / "integrations.md"), "8 by day 6"),
        ("Channel experiments scored", table_rows(PROJECT / "research" / "channels.md"), "5 by day 5"),
        ("Connectors passing", connectors, "3 before launch"),
    ]


def render():
    tasks = board()
    revs = reviews()
    by_col = {c: [] for c in COLUMNS}
    for t in tasks:
        by_col.setdefault(str(t.get("status", "triage")), []).append(t)

    parts = [
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>",
        "<meta http-equiv='refresh' content='60'><meta name='viewport' content='width=device-width,initial-scale=1'>",
        "<title>Hustle harness status</title>",
        "<style>",
        ":root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#e3e3e3;--ok:#2e7d32;--warn:#c62828;--card:#f7f7f7}",
        "@media(prefers-color-scheme:dark){:root{--bg:#121212;--fg:#eaeaea;--muted:#9a9a9a;--line:#2a2a2a;--ok:#81c784;--warn:#ef9a9a;--card:#1c1c1c}}",
        "body{margin:0;padding:16px;font:15px/1.45 -apple-system,system-ui,sans-serif;background:var(--bg);color:var(--fg)}",
        "h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 8px}small{color:var(--muted)}",
        ".metrics{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}",
        ".m{border:1px solid var(--line);border-radius:8px;padding:10px;background:var(--card)}.m b{font-size:22px;display:block}",
        ".board{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}",
        ".col{border:1px solid var(--line);border-radius:8px;padding:8px;background:var(--card)}.col h3{margin:0 0 6px;font-size:13px;text-transform:uppercase;color:var(--muted)}",
        ".card{border-top:1px solid var(--line);padding:6px 0;font-size:14px}",
        ".ok{color:var(--ok)}.warn{color:var(--warn)}",
        "pre{white-space:pre-wrap;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;font-size:13px;overflow-x:auto}",
        "table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:6px;text-align:left;vertical-align:top;font-size:14px}",
        "</style></head><body>",
        f"<h1>Hustle harness</h1><small>Rendered {NOW.strftime('%Y-%m-%d %H:%M UTC')}. Refreshes every minute. Data: board, Critic log, ledger, decisions.</small>",
        "<h2>Metrics</h2><div class='metrics'>",
    ]
    for label, value, target in metrics(tasks, revs):
        parts.append(f"<div class='m'><small>{esc(label)}</small><b>{esc(value)}</b><small>{esc(target)}</small></div>")
    parts.append("</div>")

    parts.append("<h2>Board</h2><div class='board'>")
    for col in COLUMNS:
        items = by_col.get(col, [])
        if col == "archived" and not items:
            continue
        parts.append(f"<div class='col'><h3>{esc(col)} ({len(items)})</h3>")
        for t in items[:25]:
            parts.append(
                f"<div class='card'><small>{esc(t.get('id'))} · {esc(t.get('assignee', ''))}</small><br>{esc(t.get('title'))}</div>"
            )
        parts.append("</div>")
    parts.append("</div>")

    parts.append("<h2>Critic verdicts (latest 30)</h2><table><tr><th>When</th><th>Card</th><th>Type</th><th>Verdict</th><th>Findings</th></tr>")
    for r in list(reversed(revs))[:30]:
        v = r.get("verdict")
        cls = "ok" if v == "pass" else "warn"
        findings = r.get("findings") or ""
        if isinstance(findings, list):
            findings = "<br>".join(esc(f) for f in findings)
        else:
            findings = esc(findings).replace("\n", "<br>")
        parts.append(
            f"<tr><td>{esc(str(r.get('at', ''))[:16])}</td><td>{esc(r.get('card'))}<br><small>{esc(r.get('title', ''))}</small></td>"
            f"<td>{esc(r.get('type'))}</td><td class='{cls}'>{esc(v)}</td><td>{findings}</td></tr>"
        )
    parts.append("</table>")

    parts.append("<h2>Ledger (last 20)</h2><pre>" + esc("\n".join(tail(PROJECT / "LEDGER.md", 20))) + "</pre>")
    parts.append("<h2>Decisions (last 20)</h2><pre>" + esc("\n".join(tail(PROJECT / "DECISIONS.md", 20))) + "</pre>")
    parts.append("</body></html>")

    STATUS.mkdir(parents=True, exist_ok=True)
    (STATUS / "index.html").write_text("\n".join(parts))
    (STATUS / "board.json").write_text(json.dumps({"rendered_at": NOW.isoformat(), "tasks": tasks, "reviews": revs[-200:]}, indent=1))


if __name__ == "__main__":
    render()
