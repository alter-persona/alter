#!/usr/bin/env bash
# Understudy installer — brings a clean machine to a passing health check.
set -euo pipefail
cd "$(dirname "$0")/../services"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1; }

say "Understudy installer"

# ── 1. Dependencies ─────────────────────────────────────────────
MISSING=()
need node    || MISSING+=("node (v20+): brew install node")
need ffmpeg  || MISSING+=("ffmpeg: brew install ffmpeg")
need whisper-cli || MISSING+=("whisper.cpp: brew install whisper-cpp")
if [ ${#MISSING[@]} -gt 0 ]; then
  say "Missing dependencies:"
  printf '  - %s\n' "${MISSING[@]}"
  exit 1
fi
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node 20+ required (found $(node -v))"; exit 1; }

# ── 2. Whisper model ────────────────────────────────────────────
WHISPER_DIR="${WHISPER_MODEL_DIR:-$HOME/.cache/understudy}"
WHISPER_MODEL="$WHISPER_DIR/ggml-large-v3-turbo.bin"
if [ ! -f "$WHISPER_MODEL" ]; then
  say "Downloading whisper model (large-v3-turbo, ~1.6 GB, one time)…"
  mkdir -p "$WHISPER_DIR"
  curl -L --progress-bar -o "$WHISPER_MODEL" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"
fi

# ── 3. PostgreSQL + pgvector ────────────────────────────────────
DB_PORT="${UNDERSTUDY_DB_PORT:-5434}"
DB_URL="postgresql://understudy:understudy@127.0.0.1:${DB_PORT}/understudy"
if ! (echo > /dev/tcp/127.0.0.1/"$DB_PORT") 2>/dev/null; then
  if need docker; then
    say "Starting PostgreSQL 16 + pgvector in Docker (port ${DB_PORT})…"
    docker run -d --name understudy-postgres --restart unless-stopped \
      -e POSTGRES_USER=understudy -e POSTGRES_PASSWORD=understudy -e POSTGRES_DB=understudy \
      -p "127.0.0.1:${DB_PORT}:5432" -v understudy_pg:/var/lib/postgresql/data \
      pgvector/pgvector:pg16 >/dev/null
    for i in $(seq 1 30); do
      docker exec understudy-postgres pg_isready -U understudy >/dev/null 2>&1 && break
      sleep 1
    done
  else
    say "No PostgreSQL on port ${DB_PORT} and no Docker."
    echo "Install Docker (easiest), or provide a Postgres 16 + pgvector instance and"
    echo "re-run with DATABASE_URL set."
    exit 1
  fi
fi

# ── 4. Configuration ────────────────────────────────────────────
if [ ! -f .env ]; then
  say "Configuration"
  read -r -p "Your name (what the persona is called): " UNAME
  echo
  echo "Build model — the model that synthesizes your persona."
  echo "  [Enter]  local only (Ollama at localhost:11434; fully offline; works, slightly rougher)"
  echo "  [key]    paste an Anthropic API key for the recommended frontier model"
  read -r -p "> " BUILDKEY
  {
    echo "DATABASE_URL=\"${DATABASE_URL:-$DB_URL}\""
    echo "UNDERSTUDY_NAME=\"$UNAME\""
    echo "WHISPER_MODEL_PATH=\"$WHISPER_MODEL\""
    if [ -n "$BUILDKEY" ]; then
      echo "ANTHROPIC_API_KEY=\"$BUILDKEY\""
      echo "CORPUS_LLM_PROVIDER=anthropic"
      echo "CORPUS_LLM_MODEL=claude-sonnet-5"
    else
      echo "CORPUS_LLM_PROVIDER=openai_compatible"
      echo "CORPUS_LLM_URL=http://127.0.0.1:11434/v1"
      echo "CORPUS_LLM_MODEL=\${UNDERSTUDY_LOCAL_MODEL:-llama3.1:8b}"
      echo "# Local build model configured. Understudy will synthesize with it, and the"
      echo "# quality floor warning applies: a frontier model is recommended. Adding a"
      echo "# key later + 'understudy rebuild' re-synthesizes everything — nothing lost."
    fi
  } > .env
  chmod 600 .env
fi

# ── 5. Install + migrate + seed ─────────────────────────────────
say "Installing packages…"
npm install --no-fund --no-audit
say "Running migrations + seeding the curriculum…"
npx prisma migrate deploy
npx prisma db seed || true   # seed refuses on a populated DB — that's correct
say "Prefetching the local embedder (bge-small, ~130 MB, one time)…"
node -e 'import("./src/lib/embedder.js").catch(()=>null)' 2>/dev/null || \
  npx tsx -e 'import { embed } from "./src/lib/embedder"; embed("warmup").then(()=>process.exit(0))'

# ── 6. Health check ─────────────────────────────────────────────
say "Health check"
npx tsx src/understudy/cli.ts health
say "Done. Next: ./bin/understudy status — then start answering questions."
