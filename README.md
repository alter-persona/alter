# Alter

Build a digital persona of yourself — your alter ego — that chats and drafts the way you would, and gets better every time you use it.

Runs entirely on your machine. Your recordings, answers, documents, and the persona itself stay in local Postgres and on your disk. The only network calls go to the model API you choose, and a fully local mode needs none.

## How it works

The conversation is the interface. You talk to Alter in your own client, such as Telegram — chatting, correcting, uploading, status: all of it in-chat.

1. **Interview in chat.** Alter asks its questions one at a time — identity, how you communicate, your work, your interests. Answer by voice memo or text; voice transcribes locally. Say "status" anytime for the per-module meter and what's pending. Already have recordings? `bootstrap` builds the persona from them with no interview at all.
2. **Base persona at the threshold.** Bank 30 spoken minutes and the core answers, and Alter builds the base persona and switches it on. Keep answering whenever you like — every answer deepens it, nothing restarts it.
3. **Enrich.** Drop in writing samples, documents, and exported AI chats from OpenAI or Claude. Alter keeps only your words, strips everyone else's, redacts secrets before storing, and reports back what each upload actually taught it.
4. **Use.** A thinking partner that answers like you, with live tools — web search, page fetch, your platform's skills — and a drafter for messages and emails in your voice.
5. **Improve, forever.** Correct a reply and it changes on the very next turn, then keeps the fix. When new facts clash with old ones it asks instead of overwriting: "you just said introvert, but earlier you described drawing energy from people — situational, changed, or wrong?" The richer answer wins. Conversation memory fades in hours; say "remember this:" and it's permanent. Eight sealed questions never enter its memory, so it can always be tested against the real you.

## Voice

Text by default. Turn voice on and Alter speaks in your cloned voice, built from the memos you already recorded — or ask it to read anything aloud, on demand.

- **ElevenLabs.** Highest quality, your own key and your own clone. Your key, your account, never ours.
- **Local.** No key, no cloud — a step below clone parity today, and honest about it.

Voice synthesizes after the text reply has already sent, so it never slows the conversation, and any failure degrades silently to text.

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

```bash
npm install
npx prisma migrate dev
npm run db:seed
```

The seed builds the four-module curriculum from `src/curriculum/curriculum.ts`
— Identity & values, Communication situations, Work & craft, Interests &
passions — with the 20-item **Mini-IPIP** (Donnellan et al., 2006; public
domain, ipip.ori.org) interleaved and the eight sealed validation questions
last. (`voice-personality-intake.md` is generated documentation, not an
input.) Swapping in the 120-item IPIP-NEO later is a seed-only change:
replace `LIKERT_ITEMS` in `prisma/seed.ts` and re-run.

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

## Voice persona (legacy local loop — not in this repo)

An earlier spoken-conversation loop (`voice/talk.sh`: mic → whisper.cpp →
persona skill → local zero-shot voice clone) predates the current voice
pipeline and its assets are deliberately untracked (personal audio never
ships). It's superseded by in-chat voice notes and the `/talk` page; kept
here only as a pointer for anyone rebuilding a fully local voice loop.
