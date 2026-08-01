# Alter Quickstart

Install to your first three answered questions in about five minutes.

## 1. Install (≈3 minutes, mostly downloads)

```bash
cd alter
./bin/install.sh
```

The installer checks Node, ffmpeg, and whisper.cpp (telling you the exact
`brew install` line for anything missing), starts PostgreSQL with pgvector
(Docker if you have it, otherwise it points you at a local install), creates
the database, runs migrations, seeds the interview curriculum, and asks two
questions:

- **Your name** — what the persona will be called.
- **Your build model** — press Enter for local-only (Ollama; fully offline,
  slower and slightly rougher synthesis), or paste an API key for the
  recommended frontier model. You can change this anytime and re-run
  `alter rebuild`.

It finishes by running the health check. All green means go.

## 2. Verify

```bash
./bin/alter health   # every line should be ✔
./bin/alter status   # phase: interviewing, meter at 0%
```

## 3. Answer your first three questions

Talk to the skill through your agent client (or open the localhost page it
prints). It will ask one question at a time — answer in a voice memo or text:

1. *"Introduce yourself the way you would to someone interesting you just
   met…"* — 60-90 seconds is plenty.
2. It transcribes in the background and moves on. Say "skip" to skip,
   "later" to pause, "status" for the meter.
3. Keep going as long as you like. The persona activates at 30 spoken
   minutes; every module you finish makes it noticeably better.

## Already have recordings?

If you have an intake export zip from a previous Alter (or this one):

```bash
./bin/alter bootstrap your-export.zip --name "Your Name"
```

That imports the answers and audio, credits the banked minutes, runs the
gates and first synthesis, and activates the persona — no live interview.
Add `--chat-zip claude-or-openai-export.zip` to fold in an AI chat export at
the same time.

## What next

- `./bin/alter status` any time — phase, module meter, pending items.
- Drop files (emails you're proud of, documents) into the chat — real
  artifacts teach style better than any description.
- When it gets something wrong, just say so. Corrections apply from the very
  next reply.
