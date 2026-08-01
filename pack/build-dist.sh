#!/usr/bin/env bash
# Build the distributable Alter pack: pack files + trimmed services,
# checksums, signature, and a personal-data scan that FAILS the build if any
# of the author's personal data appears anywhere in the pack.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-0.1.0}"
OUT="$REPO/dist/alter-v$VERSION"

rm -rf "$OUT"
mkdir -p "$OUT/services" "$OUT/bin" "$OUT/docs"

# ── Pack surface ────────────────────────────────────────────────
cp "$REPO/pack/SKILL.md" "$REPO/pack/manifest.yml" "$OUT/"
cp "$REPO/pack/README.md" "$REPO/pack/QUICKSTART.md" "$REPO/pack/EXPLAINER.md" "$REPO/pack/PRIVACY.md" "$OUT/docs/"
cp "$REPO/pack/bin/install.sh" "$REPO/pack/bin/health.sh" "$REPO/pack/bin/alter" "$OUT/bin/"
chmod +x "$OUT"/bin/*

# ── Services: the repo, trimmed of personal data and legacy v1 ──
rsync -a "$REPO/" "$OUT/services/" \
  --exclude node_modules --exclude .next --exclude .git \
  --exclude data --exclude corpus --exclude storage --exclude dist \
  --exclude packs --exclude logs --exclude models --exclude backups \
  --exclude eval \
  --exclude voice-dataset --exclude voice-train --exclude voice-ab \
  --exclude "*.tsbuildinfo" --exclude ".venv*" --exclude ".DS_Store" \
  --exclude voice --exclude voice-train-local --exclude scripts \
  --exclude docs --exclude tests --exclude pack \
  --exclude ".env*" --exclude "*.zip" --exclude CLAUDE.md \
  --exclude voice-personality-intake.md --exclude README.md \
  --exclude "src/corpus/persona" --exclude "src/skill"

# Strip legacy v1 script entries whose sources are excluded.
node -e '
const fs = require("fs");
const p = process.argv[1];
const d = JSON.parse(fs.readFileSync(p, "utf8"));
delete d.scripts["persona"]; delete d.scripts["skill"]; delete d.scripts["ingest:backfill"];
fs.writeFileSync(p, JSON.stringify(d, null, 2) + "\n");
' "$OUT/services/package.json"

# ── Personal-data scan (build fails on any hit) ────────────────
# Patterns live in an UNTRACKED local file (pack/scan-patterns.local.txt, one
# regex per line) — the owner's identifying strings must never ship, not even
# inside the scanner that guards against them.
echo "[pack] personal-data scan…"
PATTERNS=("Understudy" "understudy-v")
if [ -f "$REPO/pack/scan-patterns.local.txt" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && [ "${line#\#}" = "$line" ] && PATTERNS+=("$line")
  done < "$REPO/pack/scan-patterns.local.txt"
else
  echo "  ⚠ pack/scan-patterns.local.txt missing — create it with your name, emails,"
  echo "    voice ids, and machine paths (one regex per line) before releasing."
fi
FAIL=0
for pat in "${PATTERNS[@]}"; do
  if hits=$(grep -rInE "$pat" "$OUT" --exclude-dir=node_modules | head -5) && [ -n "$hits" ]; then
    echo "  ✖ pattern '$pat' found:"; echo "$hits" | sed 's/^/    /'
    FAIL=1
  fi
done
# No recorded media may ship — a voice clip is personal data no grep can read.
if media=$(find "$OUT" -type f \( -name "*.mp3" -o -name "*.wav" -o -name "*.ogg" -o -name "*.oga" -o -name "*.webm" -o -name "*.m4a" -o -name "*.flac" \) | head -5) && [ -n "$media" ]; then
  echo "  ✖ audio/media files in pack:"; echo "$media" | sed 's/^/    /'
  FAIL=1
fi
[ "$FAIL" -eq 0 ] || { echo "[pack] FAILED: personal data in pack"; exit 1; }
echo "  ✔ clean (text patterns + media files)"

# ── Checksums + signature ──────────────────────────────────────
echo "[pack] checksums…"
( cd "$OUT" && find . -type f ! -name SHASUMS256 ! -name SHASUMS256.sig -print0 \
  | sort -z | xargs -0 shasum -a 256 > SHASUMS256 )

SIGN_KEY="${UNDERSTUDY_SIGNING_KEY:-$HOME/.ssh/understudy_signing}"
if [ ! -f "$SIGN_KEY" ]; then
  echo "[pack] generating signing key at $SIGN_KEY"
  ssh-keygen -t ed25519 -N "" -C "understudy-release" -f "$SIGN_KEY" -q
fi
ssh-keygen -Y sign -f "$SIGN_KEY" -n understudy "$OUT/SHASUMS256" >/dev/null 2>&1
cp "$SIGN_KEY.pub" "$OUT/SIGNING_KEY.pub"
cat > "$OUT/VERIFY.md" <<'EOF'
# Verifying this pack

```bash
shasum -a 256 -c SHASUMS256          # every file matches
echo "understudy-release $(cat SIGNING_KEY.pub)" > /tmp/allowed_signers
ssh-keygen -Y verify -f /tmp/allowed_signers -I understudy-release \
  -n understudy -s SHASUMS256.sig < SHASUMS256
```
EOF

echo "[pack] built $OUT"
du -sh "$OUT"
