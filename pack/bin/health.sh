#!/usr/bin/env bash
# Proves the companion services alive: db, migrations, pgvector, whisper,
# ffmpeg, embedder, model endpoint, and a queue drain.
set -euo pipefail
cd "$(dirname "$0")/../services"
exec npx tsx src/understudy/cli.ts health
