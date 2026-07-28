# Push audit — first push to alter-persona/alter (2026-07-28)

Repository state before this task: **zero commits** (git init, never
committed), so "history" was empty and this audit gates what enters the
first commit. The repo stays private; nothing here changes visibility.

## Tree audit — what ships (162 files)

| Group | Files | Notes |
|---|---|---|
| src/app, src/corpus, src/loop, src/persona2, src/lib, src/voice, src/curriculum, src/understudy | 119 | Factory source. Legacy v1 (`src/corpus/persona/`, `src/skill/`) excluded. |
| prisma/ (schema + 10 migrations) | 12 | No data, schema only. |
| pack/ (SKILL.md, docs set, bin, build-dist, manifest) | 10 | Scan patterns externalized to an untracked local file. |
| tests/ (corpus 3, ingest, loop, persona2, voice) | 7 | Fixtures genericized (see below). |
| Root: package.json/lock, tsconfig, next.config, instrumentation, docker-compose, README, .env.example, .gitignore, voice-personality-intake.md, LICENSE, NOTICE, .githooks/ | 14 | docker-compose carries only the dev-default `intake` password matching .env.example. |

## Flag scan results (tree, staged content)

- **Media/zip filenames**: 0. Global ignore for wav/webm/mp3/m4a/ogg/oga/flac/zip.
- **sources/ corpus/ holdout/ packs/ data/ storage/ eval/ voice\*/**: 0 staged; all ignored (packs/sample/ negation reserved for the future synthetic sample).
- **.env / credentials**: only `.env.example` (verified placeholders). Secret-pattern content scan: 2 hits, both **intentional fixtures** — `src/corpus/redact.ts` (the redaction rules themselves) and `tests/corpus/processing.test.ts` (a fake `sk-ant-…` the test proves gets redacted). Allowlisted by path in the pre-commit hook.
- **Personal data** (owner name, emails, voice id, machine paths, transcript fragments): **0 hits after remediation.** Fixed during the audit: test fixtures renamed to a neutral name (3 files), root README's persona-skill reference genericized, the real ElevenLabs voice id in the voice test replaced with a fixture id, hermes profile defaults de-personalized (`HERMES_PROFILE`/`HERMES_PERSONA_SKILLS` env, owner values kept in untracked .env), and the pack scanner's own patterns moved to untracked `pack/scan-patterns.local.txt` — the scanner no longer ships the strings it guards against. A stale voice-test assertion (pre-dating none-by-default voice) was updated; all suites green after (5/17/11/5/5).
- **.gitignore hardening**: rewritten with **anchored** paths — the unanchored `corpus/`/`voice/` patterns were silently swallowing `src/corpus` and `tests/voice`. Also learned: tracked files override ignore rules (`check-ignore --no-index` to test patterns); previously-staged files were purged from the index.

## History audit

Local history did not exist before this task; the single local commit was
authored as `alter-persona <alter-persona@users.noreply.github.com>` and
contains exactly the audited tree.

**⚠ FLAGGED (open):** the remote holds creation-form commit `069283ef`
("Initial commit", LICENSE only) authored **`JasonQuantum <j@jasonc.net>`** —
the owner's real email, which is on this audit's flag list. It is already on
GitHub in the owner's private repo, so pushing adds no new exposure *today*,
but on the public flip at release it becomes permanently visible in history.
Merged locally (LICENSE identical to ours; no conflict). **Push is HELD
pending the owner's choice:**

- **Option A (recommended):** replace the remote history — reset to our
  single clean noreply-authored initial commit and force-push it over the
  creation commit. The repo has never been public and has one machine-made
  commit; replacing it is safe, and the result contains no personal email
  anywhere. (Force-push only after explicit approval, per the task rules.)
- **Option B:** keep the merge as-is and accept the email in the creation
  commit. Note the org/repo is owned by the JasonQuantum account regardless,
  so the *identity* link exists either way — Option B only additionally
  exposes the raw email address.

## Pre-commit guard (installed and proven)

`.githooks/pre-commit` (versioned; activated via `git config core.hooksPath
.githooks`) rejects: audio/media extensions, any `packs/` content outside
`packs/sample/`, and secret-shaped strings (redaction fixtures allowlisted by
path). Fixture test staged an mp3 + `packs/evil/leak.txt` + a fake
`sk_live_…` — all three rejected, commit blocked. Fixtures removed.

## License and identity

- `LICENSE`: canonical Apache-2.0 (201 lines). `NOTICE`: Alter, copyright
  2026 alter-persona. `pack/SKILL.md` frontmatter: `author: alter-persona`,
  `license: Apache-2.0` — consistent. (The SKILL.md *body* still reads
  Understudy: the Alter rename is the release prompt's stage, gated on the
  feature-inventory approval, deliberately out of this task's scope.)

## Remote

`origin` → `https://github.com/alter-persona/alter.git` (no prior remote
existed; SSH unconfigured on this machine → https with gh credentials, gh
authed). Branch renamed `master` → `main`.

## Verification (captured after the approved Option A push)

Owner approved **Option A**: remote history replaced with the single clean
noreply-authored initial commit via `git push --force-with-lease`
(`069283e...72376a1 (forced update)`). The owner-email creation commit no
longer exists in any history, local or remote. (The interim local merge
commit, which carried a machine-default author, was discarded with it.)

```
$ git log --format='%h %ae %s'
72376a1 alter-persona@users.noreply.github.com Initial commit: Alter persona factory

$ gh repo view alter-persona/alter --json name,visibility,defaultBranchRef,isPrivate
{ "defaultBranchRef": { "name": "main" }, "isPrivate": true,
  "name": "alter", "visibility": "PRIVATE" }

$ gh api repos/alter-persona/alter/commits --jq 'length'
1
```

Final state: origin `https://github.com/alter-persona/alter.git`, branch
`main` (upstream tracked), **1 commit pushed**, visibility **PRIVATE —
unchanged**, no tags. Working tree clean apart from this audit document,
committed immediately after capture.

