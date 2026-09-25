#!/usr/bin/env bash
# No-agent cron: prints nothing when healthy, so Hermes delivers nothing.
# Speaks only when the dispatcher is down or the board has not closed a card in 6 hours.
# Install: hermes -p hustle-reporter cron create "every 30m" --no-agent --script /Users/hustle/project/harness/watchdog.sh --deliver telegram --name "hustle-watchdog"
set -u
PROJECT="${HUSTLE_PROJECT:-/Users/hustle/project}"
DB="${HERMES_KANBAN_DB:-$HOME/.hermes/kanban.db}"
STALL_HOURS="${STALL_HOURS:-6}"

if ! hermes gateway status 2>/dev/null | grep -qi running; then
  echo "hustle: gateway is not running, so nothing is being dispatched."
  exit 1
fi

if ! command -v sqlite3 >/dev/null; then
  exit 0
fi

# Newest done transition, from the board's event log.
last_done=$(sqlite3 "$DB" "select max(created_at) from events where to_status='done';" 2>/dev/null || true)
if [ -z "$last_done" ]; then
  exit 0
fi
last_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${last_done%%.*}" +%s 2>/dev/null || date -d "$last_done" +%s)
now=$(date +%s)
hours=$(( (now - last_epoch) / 3600 ))
if [ "$hours" -ge "$STALL_HOURS" ]; then
  running=$(sqlite3 "$DB" "select count(*) from tasks where status='running';")
  blocked=$(sqlite3 "$DB" "select count(*) from tasks where status='blocked';")
  echo "hustle: no card has closed in ${hours}h. running=${running} blocked=${blocked}. Driver ticks continue; check LEDGER.md if this repeats."
  exit 1
fi
exit 0
