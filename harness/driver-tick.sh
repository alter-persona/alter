#!/usr/bin/env bash
# One Driver tick, run by a no-agent cron job every 30 minutes.
# Wrapping the tick in a one-shot chat means it runs in the hustle-driver profile (its SOUL, toolset and
# model) no matter which profile's gateway hosts the cron scheduler. Output goes to the cron log only.
set -u
PROJECT="${HUSTLE_PROJECT:-/Users/hustle/project}"
cd "$PROJECT" || exit 1
hermes -p hustle-driver chat --oneshot -Q -s hustle-driver --yolo \
  -q "Run one driver tick for the hustle board. Working folder: $PROJECT." >> "$PROJECT/harness/driver-tick.log" 2>&1
# Print nothing on success so the cron delivers nothing.
exit 0
