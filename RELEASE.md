# Releasing Alter

Every step has the command to run and what its output must show. Stop at the first step whose output differs. The signing key never leaves the release machine, and nothing is pushed until step 3 is clean.

## 1. Tests

```bash
npm run test:corpus && npm run test:ingest && npm run test:persona2 && npm run test:voice && npm run test:loop
```

Expected: every suite ends with `fail 0`. Current counts are 17, 5, 10, 5, and 19 tests. `test:loop` and `test:ingest` need the local Postgres from `docker-compose up -d`; `test:persona2` and `test:voice` run with `EMBED_FAKE=1` and need nothing.

```bash
npx tsc --noEmit -p tsconfig.json
```

Expected: no output.

## 2. Pre-push audit

Run all of these against the commits that will be pushed. `origin/main` is the last published state.

```bash
git log --format='%an <%ae>' origin/main..HEAD | sort -u
```

Expected: exactly one line, `alter-persona <alter-persona@users.noreply.github.com>`. Any other identity means a commit was made without the repo-local config; fix it with `git rebase --exec 'git commit --amend --no-edit --reset-author' origin/main` after `git config user.name alter-persona` and `git config user.email alter-persona@users.noreply.github.com`.

```bash
git diff --name-only origin/main..HEAD | grep -iE '\.(wav|webm|mp3|m4a|ogg|oga|flac|zip)$' ; echo "media: $?"
git diff --name-only origin/main..HEAD | grep -E '^packs/' | grep -vE '^packs/sample/' ; echo "packs: $?"
```

Expected: both print `1` (no matches).

```bash
while IFS= read -r pat; do [ -n "$pat" ] && [ "${pat#\#}" = "$pat" ] && git grep -nIE "$pat" HEAD -- . ':!src/corpus/redact.ts' ':!tests/corpus/processing.test.ts' && echo "HIT: $pat"; done < pack/scan-patterns.local.txt; echo "scan done"
```

Expected: only `scan done`. The pattern file is untracked and holds the owner's name, email addresses, voice ids, machine paths, and project names that must never ship. It must include the names of the owner's private projects and workspaces, not only personal identifiers. The commit messages are checked the same way:

```bash
git log --format='%B' origin/main..HEAD | grep -iE -f pack/scan-patterns.local.txt ; echo "messages: $?"
```

Expected: `messages: 1`.

## 3. Version

Set the same version in four places and confirm they agree:

```bash
grep -n '"version"' package.json
grep -n 'version:' skills/alter/SKILL.md
grep -n '^version' pack/manifest.yml
head -5 CHANGELOG.md
```

Expected: `package.json` and the SKILL.md frontmatter carry the release version; `pack/manifest.yml` keeps its integer manifest version; the CHANGELOG has a dated heading for the release at the top.

## 4. Pack build

```bash
bash pack/build-dist.sh <version>
```

Expected: `✔ clean (text patterns + media files)` and `[pack] built .../dist/alter` followed by a size. A `⚠ pack/scan-patterns.local.txt missing` line means the scan ran without the owner's patterns; do not continue. The build fails outright on any hit.

```bash
ls dist/alter && ls dist/alter/services/packs/sample
```

Expected: `SKILL.md manifest.yml bin docs services SHASUMS256 SHASUMS256.sig SIGNING_KEY.pub VERIFY.md`, and the sample persona files.

## 5. Verify the pack as a stranger would

```bash
cd dist/alter && shasum -a 256 -c SHASUMS256 | grep -v ': OK' ; echo "checksums: $?"
echo "understudy-release $(cat SIGNING_KEY.pub)" > /tmp/allowed_signers && ssh-keygen -Y verify -f /tmp/allowed_signers -I understudy-release -n understudy -s SHASUMS256.sig < SHASUMS256
cd ../..
```

Expected: `checksums: 1` (no non-OK lines) and `Good "understudy" signature for understudy-release with ED25519 key ...`.

```bash
bash pack/time-to-first-reply.sh "$PWD" --url http://127.0.0.1:11434/v1
```

Expected: a reply from Maren Holt and a final line like `clone 2s · install 40s · first reply 15s · total 57s`. The total must be under 300 seconds; record it in the release notes.

## 6. Publish

```bash
gh skill publish --dry-run
```

Expected: `ok` and `Dry run complete`.

```bash
cd dist && zip -qr alter-v<version>.zip alter && cd ..
git push origin main
git tag v<version> && git push origin v<version>
gh release create v<version> dist/alter-v<version>.zip dist/alter/SHASUMS256 dist/alter/SHASUMS256.sig dist/alter/SIGNING_KEY.pub --title "Alter v<version>" --notes-file <notes.md>
gh skill publish --tag v<version>
```

Expected: the release page lists four assets. The tag ruleset `protect-release-tags` forbids moving or deleting the tag afterwards, so a mistake means a new patch version, not a re-tag.

## 7. Registries

```bash
gh api repos/alter-persona/alter/releases/latest --jq .tag_name
curl -s https://alter-persona.github.io/.well-known/skills/index.json | head -c 300
curl -s https://clawhub.ai/api/v1/skills/alter | grep -o '"latest":"[^"]*"'
```

Expected: the new tag; the well-known index still lists `alter`; after `clawhub skill publish skills/alter` from the owner's account, the ClawHub `latest` matches the new version. Update the well-known index in the `alter-persona.github.io` repo if the SKILL.md changed.

## 8. After the release

- Record the time-to-first-reply number and the test counts in the release notes.
- Confirm `git status` is clean and `git log origin/main..HEAD` is empty.
- The signing key stays at `~/.ssh/understudy_signing` on the release machine and is never copied into CI.
