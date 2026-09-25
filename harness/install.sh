#!/usr/bin/env bash
# Sets up the push harness on the Mac Studio. Run as the `hustle` macOS user, from a clone of this repo.
# Prerequisites: Hermes installed for this user (`hermes doctor` passes), the local model server reachable,
# and this user's ~/.hermes/.env holding TELEGRAM_BOT_TOKEN and the service tokens
# named in harness/config/builder.config.yaml.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROJECT="${HUSTLE_PROJECT:-$HOME/project}"

# The shipped files name /Users/hustle/project; localize() rewrites that to this install's folder,
# so the harness also runs under another user or path.
localize() { sed "s#/Users/hustle/project#$PROJECT#g" "$1" > "$2"; }

echo "1/6 project folder"
mkdir -p "$PROJECT"/{research,site,services,marketing,emails,reports,evidence}
cp -n "$HERE/CHARTER.md" "$PROJECT/CHARTER.md"
cp -n "$HERE/RUBRIC.md" "$PROJECT/RUBRIC.md"
touch "$PROJECT/LEDGER.md" "$PROJECT/DECISIONS.md"
mkdir -p "$PROJECT/harness/status" "$PROJECT/status"
localize "$HERE/watchdog.sh" "$PROJECT/harness/watchdog.sh"
localize "$HERE/driver-tick.sh" "$PROJECT/harness/driver-tick.sh"
cp "$HERE/status/render.py" "$HERE/status/render.sh" "$HERE/status/record-review.sh" "$PROJECT/harness/status/"
chmod +x "$PROJECT/harness/watchdog.sh" "$PROJECT/harness/driver-tick.sh" "$PROJECT/harness/status/"*.sh
if [ ! -d "$PROJECT/.git" ]; then
  (cd "$PROJECT" && git init -q && git config user.name "hustle" && git config user.email "hustle@localhost" \
    && git add -A && git commit -qm "harness: initial charter and rubric")
fi

echo "2/6 profiles"
for p in driver builder critic reporter; do
  hermes profile create "hustle-$p" >/dev/null 2>&1 || true
  cp "$HERE/profiles/$p/SOUL.md" "$HOME/.hermes/profiles/hustle-$p/SOUL.md"
done

echo "3/6 config (each key applied with hermes config set; edit the yaml files first if your paths differ)"
python3 -c 'import yaml' 2>/dev/null || { echo "PyYAML is needed for this step: pip3 install pyyaml"; exit 1; }
apply() { # profile file
  python3 - "$1" "$2" <<'PY'
import sys, subprocess, yaml
profile, path = sys.argv[1], sys.argv[2]
def walk(node, prefix=""):
    for k, v in node.items():
        key = f"{prefix}{k}"
        if isinstance(v, dict): walk(v, key + "."); continue
        val = yaml.safe_dump(v, default_flow_style=True).strip() if isinstance(v, list) else str(v)
        subprocess.run(["hermes", "-p", profile, "config", "set", key, val], check=False)
walk(yaml.safe_load(open(path)))
PY
}
TMPCFG="$(mktemp -d)"
for p in driver builder critic reporter; do
  localize "$HERE/config/$p.config.yaml" "$TMPCFG/$p.yaml"
  apply "hustle-$p" "$TMPCFG/$p.yaml"
done
rm -rf "$TMPCFG"

echo "4/6 write fence"
grep -q HERMES_WRITE_SAFE_ROOT "$HOME/.hermes/.env" 2>/dev/null || echo "HERMES_WRITE_SAFE_ROOT=$PROJECT:$HOME/.hermes" >> "$HOME/.hermes/.env"

echo "5/6 skills and board"
for s in hustle-driver hustle-critic hustle-digest; do
  for p in driver critic reporter; do
    mkdir -p "$HOME/.hermes/profiles/hustle-$p/skills/$s"
    localize "$HERE/skills/$s/SKILL.md" "$HOME/.hermes/profiles/hustle-$p/skills/$s/SKILL.md"
  done
done
hermes kanban init >/dev/null 2>&1 || true

echo "6/6 cron jobs, all owned by the reporter profile because its gateway hosts the scheduler"
# The Driver tick is a script job that runs a one-shot chat in the hustle-driver profile (see driver-tick.sh).
hermes -p hustle-reporter cron create "every 30m" --no-agent --script "$PROJECT/harness/driver-tick.sh" \
  --deliver local --name "hustle-driver-tick" || true
hermes -p hustle-reporter cron create "daily at 7:45am" "Compose and send the daily hustle digest using the hustle-digest skill." \
  --name "hustle-digest" --skill hustle-digest --deliver telegram || true
hermes -p hustle-reporter cron create "every 30m" --no-agent --script "$PROJECT/harness/watchdog.sh" \
  --deliver telegram --name "hustle-watchdog" || true
hermes -p hustle-reporter cron create "every 5m" --no-agent --script "$PROJECT/harness/status/render.sh" \
  --deliver local --name "hustle-status-render" || true

echo "7/7 status page on http://127.0.0.1:8091"
python3 "$PROJECT/harness/status/render.py" "$PROJECT" || true
PLIST="$HOME/Library/LaunchAgents/ai.hustle.status.plist"
mkdir -p "$HOME/Library/LaunchAgents"
sed "s#PROJECT_DIR#$PROJECT#g" "$HERE/status/ai.hustle.status.plist" > "$PLIST"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST" 2>/dev/null || echo "launchctl load failed; start by hand: python3 -m http.server 8091 --bind 127.0.0.1 --directory $PROJECT/status"

cat <<EOF

Done. Next:
  1. Check $PROJECT/CHARTER.md: the products page URL, the spend cap and the launch gate.
  2. hermes -p hustle-reporter gateway start      # Telegram plus the board dispatcher
  3. $PROJECT/harness/driver-tick.sh               # first tick now instead of in 30 minutes
  4. open http://127.0.0.1:8091                    # the status page; hermes kanban watch for a live stream
To show the page at http://localhost:8090/status instead, point the 8090 server at $PROJECT/status
(a symlink works if it serves a static directory).
EOF
