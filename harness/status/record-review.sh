#!/usr/bin/env bash
# The Critic calls this after every verdict so the status page can show it.
# Usage: record-review.sh <card id> <type> <pass|changes> "<title>" "<findings, one per line or empty>"
set -u
PROJECT="${HUSTLE_PROJECT:-$HOME/project}"
mkdir -p "$PROJECT/status"
python3 - "$@" <<'PY' >> "$PROJECT/status/reviews.jsonl"
import json, sys
from datetime import datetime, timezone
card, kind, verdict, title, findings = (sys.argv[1:] + ["", "", "", "", ""])[:5]
print(json.dumps({
    "at": datetime.now(timezone.utc).isoformat(timespec="minutes"),
    "card": card, "type": kind, "verdict": verdict, "title": title,
    "findings": [f for f in findings.splitlines() if f.strip()],
}))
PY
