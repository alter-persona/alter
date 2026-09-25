#!/usr/bin/env bash
# No-agent cron wrapper: render the status page. Prints nothing, so Hermes delivers nothing.
set -u
PROJECT="${HUSTLE_PROJECT:-$HOME/project}"
python3 "$PROJECT/harness/status/render.py" "$PROJECT" >> "$PROJECT/status/render.log" 2>&1
exit 0
