# Alter Privacy

## Local-first storage

Everything lives on your machine:

- **PostgreSQL database** (local): interview answers and transcripts, the
  persona's memory (typed propositions + text chunks with embeddings), style
  fingerprints, the improvement-loop event log, reconciliation history.
- **Local files**: your audio recordings (`data/audio/`), uploaded documents
  (`data/files/`), the generated persona pack (`corpus/`).

No cloud storage, no telemetry, no accounts. Backups are yours to make and
yours to not make.

## What leaves the machine, exactly

1. **Model API prompts** — synthesis, reconciliation, and generation prompts
   go to the model endpoint you configured. Configure local Ollama and
   nothing leaves at all. Configure a cloud model and those prompts (which
   contain excerpts of your material) go to that provider under their data
   terms — the same trade you make using any AI assistant.
2. **Voice synthesis (optional, off by default)** — if you enable ElevenLabs
   voice output, the text of each spoken reply is sent to ElevenLabs.
3. Nothing else. The services bind to localhost; the Telegram adapter, if you
   enable it, talks only to Telegram's API for your own bot.

## Redaction at ingest

Before anything is indexed, an automatic redaction pass strips high-risk
tokens — email addresses, phone numbers, credit-card-shaped numbers, API
keys and secrets — from the text that enters the memory stores. Raw audio
files are kept as you recorded them (they never leave the machine).

## Sensitivity: private and public are physically separate

Every piece of material is tagged **private** (default) or **public** at
ingest, and the two live in physically separate database tables. Anything
built for sharing (a public persona variant) is constructed exclusively from
the public tables — there is no code path from the private store into a
public pack. When in doubt, everything defaults to private.

## The sealed questions

Eight interview questions are held out for honest evaluation. Their answers
are stored but excluded from every ingestion path — enforced by question id
AND by content matching, so even a pasted copy of a sealed answer is refused.
This is what lets Alter measure itself without grading on the training
set.

## Your feedback is not persona content

When you correct the persona ("no, not like that"), the correction steers
behavior but the feedback sentence itself is never embedded as something you
believe. Verified by test.

## How to delete everything

```bash
./bin/alter delete-everything --yes   # wipes all database content
rm -rf data/ corpus/                       # removes audio, files, packs
```

After that, the only copies of anything are whatever backups you made
yourself. There is nothing to request deletion of anywhere else, because
nothing was ever stored anywhere else.
