#!/usr/bin/env bash
# Measures the stranger's path: fresh clone, install, one reply from the
# sample persona. Prints elapsed seconds per stage and the reply. Needs git,
# Node 20+, and an OpenAI-compatible endpoint (default: local :11434/v1).
#
#   bash pack/time-to-first-reply.sh [repo-url] [--url .../v1] [--model name] [--api-key key]
set -euo pipefail
REPO="${1:-https://github.com/alter-persona/alter.git}"; shift || true
WORK="$(mktemp -d)"
T0=$(date +%s)
git clone -q --depth 1 "$REPO" "$WORK/alter"
T1=$(date +%s)
cd "$WORK/alter"
npm install --no-fund --no-audit --silent
T2=$(date +%s)
npm run --silent demo -- --message "Someone offers you a smart doorbell for free. What do you do with it?" "$@"
T3=$(date +%s)
echo "clone $((T1-T0))s · install $((T2-T1))s · first reply $((T3-T2))s · total $((T3-T0))s"
rm -rf "$WORK"
