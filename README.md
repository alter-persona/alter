# Voice Personality Intake

# Alter

Build a digital persona of yourself, your alter ego, that chats and drafts the way you would, and gets better every time you use it.

Runs entirely on your machine. Your recordings, answers, documents, and the persona itself stay in local Postgres and on your disk. The only network calls go to a model API you choose, and a fully local mode needs none.

## How it works

There is no website and no forms. You talk to Alter in your own client, such as Telegram, and the conversation is the whole interface.

1. **Interview in chat.** Alter asks you the personality questions directly in the client. You answer by text or voice memo, and it transcribes voice locally. Ask for a status anytime and it replies with a summary: questions answered, minutes banked, and how far off the next milestone is.
2. **Base persona at the threshold.** Once you have answered enough of the core questions, Alter builds the base persona automatically and switches it on. You keep answering the remaining questions whenever you like, and each answer deepens the persona rather than restarting it.
3. **Enrich.** Add writing samples, documents, and exported AI chats from OpenAI or Claude. Alter keeps only your words, strips other people's text, and redacts secrets before storing.
4. **Use.** Chat to it as a thinking partner, or hand it tasks like drafting an email in your voice.
5. **Improve, forever.** Correct a reply and it changes on the next turn, then keeps the fix. Drop in new material and it absorbs it. When new facts clash with old ones it asks instead of overwriting: "you just said introvert, but earlier you described drawing energy from people, situational, changed, or wrong?" It keeps the richer answer, flags gaps in what it knows, and tracks its own fidelity so drift stays visible.

## Voice

Replies are text by default. Turn on voice and Alter speaks back in your client:

- **Custom local voice.** Runs on your machine, no key, no cloud. A generic voice, or a clone of your own from the voice memos you already recorded during the interview.
- **ElevenLabs.** Highest quality, using your own ElevenLabs key and a clone of your voice. Your key, your account, never ours.

Voice replies synthesize after the text reply is already sent, so they never slow the conversation, and Alter falls back to text on any client that cannot play audio.

## Status

Live today: the in-chat interview and base persona build. Enrichment, the full improvement loop, and voice output are specified and landing next.

Everything runs on your machine. No third-party network calls at runtime:
audio, transcripts, and answers live in local Postgres and `./data/audio/`.

## Setup

### 1. Postgres

```bash
docker-compose up -d
```

Starts Postgres 16 on `127.0.0.1:5433` (5433, not 5432, to avoid colliding
with any existing local Postgres).

### 2. Environment

```bash
cp .env.example .env
```

`DATABASE_URL` in the example already matches the docker-compose defaults.

### 3. Database + questions

Place **`voice-personality-intake.md`** in the project root — the seed parses
the numbered open-ended questions in sections A–H and the validation items
V1–V8 from it. Then:

```bash
npm install
npx prisma migrate dev
npm run db:seed
```

The seed also loads the 20-item **Mini-IPIP** (Donnellan et al., 2006; public
domain, from the International Personality Item Pool) as the Likert set for
the trial, with the published domain/reverse-scoring key. OCEAN items are
interleaved in small batches between the voice sections; the validation set is
sealed at the very end. Swapping in the full 120-item IPIP-NEO later is a
seed-only change: replace the `LIKERT_ITEMS` array in `prisma/seed.ts`
(text, domain, facet, reverse per item) and re-run the seed — no app code
changes.

### 4. whisper.cpp (default transcriber)

whisper.cpp is the fastest local option on Apple Silicon because it runs on
Metal (and the Neural Engine via Core ML).

```bash
# Build with Metal (on by default on macOS) — Core ML optional but faster:
git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp
cmake -B build -DWHISPER_COREML=1
cmake --build build -j --config Release

# Download a model — large-v3-turbo recommended (or large-v3 for max accuracy):
./models/download-ggml-model.sh large-v3-turbo
```

Then set in `.env`:

```
WHISPER_CLI_PATH=/path/to/whisper.cpp/build/bin/whisper-cli
WHISPER_MODEL_PATH=/path/to/whisper.cpp/models/ggml-large-v3-turbo.bin
```

**ffmpeg is required** to convert browser webm/opus recordings to the 16 kHz
WAV whisper.cpp expects:

```bash
brew install ffmpeg
```

(If ffmpeg isn't on PATH, set `FFMPEG_PATH` in `.env`.)

### 5. Run

```bash
npm run dev
```

Open http://localhost:3000, start a labelled session, and grant microphone
access when prompted. Use Chrome for `audio/webm;codecs=opus` recording
(Safari falls back to `audio/mp4`, which is also supported end to end).

## Transcription providers

Selected by the `TRANSCRIBER` env var:

- `whisper_cpp` (default) — invokes the `whisper-cli` binary on each saved
  recording. `transcriptSource` records the model used
  (e.g. `whisper.cpp:large-v3-turbo`).
- `openai_compatible` — POSTs the audio to `WHISPER_HTTP_URL`
  (an OpenAI-style `/v1/audio/transcriptions` endpoint). Use this to point the
  same interface at a local faster-whisper server or a future local
  audio-capable model without changing app code. Keep the URL on localhost to
  preserve the no-third-party-calls guarantee.

Note: Ollama and typical local multimodal models handle text and images, not
speech — so transcription runs through Whisper by default. The
OpenAI-compatible provider is the hook for wiring in an audio-capable model if
you have one.

Transcription is asynchronous: saving a recording marks it `pending` and a
background worker (single concurrency, resumed automatically on server
restart) fills in the transcript. Recording is never blocked. Failed jobs show
a Retry button. Editing a transcript in the UI flags it
`transcriptEditedByUser` — your corrected text is the ground truth and is
never overwritten by the transcriber.

## Durability & resume

- Every answer is upserted on `(sessionId, questionId)` the moment it is
  saved — re-answering updates in place, a refresh or crash loses nothing.
- Re-recording writes the new file to a temp name and atomically renames it
  over the old one, so the previous take is never destroyed until the
  replacement is safely on disk. Re-recording re-queues transcription.
- Reopening a session resumes at the first unanswered question; skipped
  questions stay visible (amber) in the index grid so you can see what
  remains.

## Export

From the session overview (or the home page): downloads a zip containing
`manifest.json` plus every audio file. The manifest lists each question with
its section, type, prompt, `oceanDomain`, `reverseScored`, `isValidation`,
audio filename, duration, transcript, `transcriptSource`,
`transcriptEditedByUser`, `transcriptStatus`, and `likertValue`, along with
session metadata and the **combined voice-audio duration** — so you can
confirm you've cleared the 30-minute floor for professional voice cloning
(1–2 hours is the ideal range).

## Layout

```
prisma/schema.prisma        Session / Question / Response
prisma/seed.ts              Parses voice-personality-intake.md + Mini-IPIP
src/lib/transcriber/        Pluggable transcription providers
src/lib/transcriptionQueue.ts  Background worker (resumes on boot)
src/app/                    Home, interview, API routes
data/audio/{session}/{question}.webm   Recordings (path stored in DB)
```

## Corpus pipeline (stage 2)

Sits between intake and persona synthesis. Ingests `sources/` (three
subfolders, re-scannable any time), normalizes into one corpus, and writes the
synthesis contract to `corpus/` + `holdout/`.

```bash
npm run corpus -- build                 # full build
npm run corpus -- build --source work   # rebuild one source (others from cache)
npm run corpus -- build --dry-run       # print report, write nothing
npm run corpus -- build --no-llm        # profile judgment fields = null (offline)
npm run test:corpus                     # parser/processing unit tests
```

- `sources/interview/*.zip` — intake export(s). Edited transcripts are ground
  truth; the 8 sealed validation questions go ONLY to `holdout/validation.jsonl`.
- `sources/chat-export/*.zip` — assistant data exports (Claude supported;
  provider interface ready for ChatGPT). Human messages only.
- `sources/work/` — drop folder (md/txt/pdf/docx/html/eml). Every file needs an
  entry in `sources/work/manifest.yaml` (label, domain, sensitivity) or the run
  fails naming the orphans.

Outputs: `corpus/private.jsonl` + `corpus/public.jsonl` (physically separate by
sensitivity), `corpus/profile.json` (mechanical fields deterministic; judgment
fields via CORPUS_LLM_* env or null), `corpus/report.md`.

Redaction (keys, SSNs, cards/accounts, emails, phones, street addresses) runs
before anything is stored; near-dups and <15-word chat fragments are dropped;
long items chunk to 200–400 tokens; ids are stable content hashes so re-runs
only change what changed. `corpus/`, `holdout/`, `sources/` are gitignored.

## Voice persona (stage 3, local loop)

```bash
./voice/talk.sh          # spoken conversation: Enter to start/stop recording
./voice/talk.sh --type   # type instead of speaking
```

Mic → whisper.cpp → persona Hermes skill (ollama/local-large) → F5-TTS
voice clone (`.venv-tts`, zero-shot from `voice/ref.wav`) → speakers. All
local. Refresh the persona after corpus changes:
`npm run corpus -- build && npm run persona -- --install`.
