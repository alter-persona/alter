# Alter

**A skill that studies you until it can stand in for you.**

Alter interviews you through ordinary conversation and voice memos,
accepts your writing samples, documents, and AI chat exports (Anthropic and
OpenAI), and synthesizes a digital persona: your voice on the page, your
values, your decision habits, your interests, and a working knowledge of your
life and job. You then use it two ways — as a thinking partner that answers
like you would, and as a delegate for writing tasks it performs the way you
would perform them. Forward it an email and say "reply to this"; the draft
that comes back should be recognizably yours, and your corrections make the
next one need fewer.

It is never finished. Every correction, every clarified contradiction, and
every new upload makes it better — with you in the loop for anything that
touches who you are.

## The ownership guarantee

Every byte of your data stays on your machine: recordings, transcripts,
documents, the persona itself — all in a local PostgreSQL database and local
files you can inspect and delete (`alter delete-everything`). The only
network calls are:

1. **The model API you configure** — prompts for synthesis and reconciliation
   go to whichever provider you chose (a fully local Ollama setup means
   nothing leaves at all).
2. **Voice output, only if you enable it** — with ElevenLabs configured, the
   text of each spoken reply is sent to ElevenLabs for synthesis. Leave voice
   off (the default) or use a local voice and this call never happens.

No telemetry, no accounts, no cloud storage. See PRIVACY.md for the full
picture.

## The honest time commitment

- **Install**: ~10 minutes (one script, mostly downloads).
- **Interview**: 40-60 questions at your own pace; most people spend 60-90
  minutes total across a few sittings, in voice memos. You can stop and
  resume anytime, and the persona becomes useful before the interview is
  complete (30 spoken minutes is the activation floor).
- **Already have recordings?** `alter bootstrap` activates a persona
  from an existing intake export with no live interview.
- **Living with it**: corrections take seconds; the system does the rest in
  the background.

## What's in the box

- `SKILL.md` — the agent behavior contract
- `services/` — the companion local services (interview capture, whisper.cpp
  transcription, embedding, synthesis, the improvement loop)
- `bin/install.sh` — installer; `bin/health.sh` — proves everything alive
- `bin/alter` — CLI: `bootstrap | status | rebuild | export | health |
  about | delete-everything`
- `QUICKSTART.md` — install to your first three answers in five minutes
- `EXPLAINER.md` — for non-technical readers deciding whether to use this
- `PRIVACY.md` — storage, redaction, sensitivity, deletion
- `SHASUMS256` + `SHASUMS256.sig` — file checksums and signature

## Requirements

macOS or Linux, Node 20+, PostgreSQL 16 with pgvector (the installer can use
Docker for this), whisper.cpp (`whisper-cli`), ffmpeg, and a model endpoint —
local Ollama works fully offline; an Anthropic/OpenAI-compatible API key
improves synthesis quality and can be added later (`alter rebuild`
re-synthesizes everything under the better model; nothing is lost by
starting local).
