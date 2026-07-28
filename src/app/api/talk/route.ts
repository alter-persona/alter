import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prisma } from "@/lib/db";
import { ensureDefaultPersona } from "@/lib/personas";
import { getTranscriber } from "@/lib/transcriber";
import { routeIntent } from "@/persona2/gate";
import { retrievePropositions, retrieveEpisodic } from "@/persona2/retrieve";
import {
  renderPersonaCore,
  renderResponseContract,
  buildPrompt,
  buildRecallPrompt,
} from "@/persona2/prompt";
import { valuesAndHeuristics } from "@/persona2/skillgen";
import type { ModeFingerprint } from "@/persona2/fingerprint";
import type { Exemplar } from "@/persona2/exemplars";

export const runtime = "nodejs";
export const maxDuration = 120;

const OLLAMA = () => process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const TALK_MODEL = () => process.env.TALK_MODEL ?? "local-small:latest";
// flash = lowest latency + half-price credits; quality still professional-clone.
const EL_TTS_MODEL = () => process.env.ELEVENLABS_TTS_MODEL ?? "eleven_flash_v2_5";

interface Turn {
  role: "user" | "assistant";
  content: string;
}

/**
 * One voice-conversation turn, tuned for latency:
 * browser audio → whisper STT → v2 position-disciplined prompt (spoken mode)
 * → fast local model → ElevenLabs professional clone → base64 mp3 back.
 */
export async function POST(req: NextRequest) {
  const t0 = Date.now();
  const form = await req.formData();
  const file = form.get("audio");
  const history: Turn[] = JSON.parse(String(form.get("history") ?? "[]")).slice(-8);
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "audio is required" }, { status: 400 });
  }

  // --- STT ---
  const tmp = path.join(os.tmpdir(), `talk-${Date.now()}.webm`);
  await fs.writeFile(tmp, Buffer.from(await file.arrayBuffer()));
  let transcript: string;
  try {
    transcript = (await getTranscriber().transcribe(tmp)).text.trim();
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
  const tStt = Date.now();
  if (!transcript) {
    return NextResponse.json({ error: "could not hear anything in that recording" }, { status: 422 });
  }

  // --- Prompt assembly (v2, spoken mode) ---
  const persona = await ensureDefaultPersona();
  const fpRow = await prisma.styleFingerprint.findUnique({ where: { personaId: persona.id } });
  if (!fpRow) return NextResponse.json({ error: "no style fingerprint yet — run persona2 fingerprint" }, { status: 500 });
  const fp = fpRow.spoken as unknown as ModeFingerprint;
  const { values, heuristics } = await valuesAndHeuristics(persona.id);
  const exemplarsPath = path.join(process.cwd(), "corpus", "persona2", persona.id, "exemplars.json");
  const exemplars: Exemplar[] = await fs
    .readFile(exemplarsPath, "utf8")
    .then(JSON.parse)
    .catch(() => []);

  const core = renderPersonaCore({ name: persona.name, values, heuristics, fingerprint: fp, mode: "spoken" });
  const intent = routeIntent(transcript);
  let system: string;
  let user: string;
  if (intent === "explicit_recall") {
    const eps = await retrieveEpisodic(persona.id, transcript, { k: 3 });
    ({ system, user } = buildRecallPrompt({ core, episodic: eps, question: transcript }));
  } else {
    const notes = intent === "knowledge" ? await retrievePropositions(persona.id, transcript, { k: 3 }) : [];
    ({ system, user } = buildPrompt({
      core,
      notes,
      contract: renderResponseContract({ name: persona.name, voiceNote: true }),
      exemplars,
      mode: "spoken",
      question: transcript,
    }));
  }

  // --- Generation (fast local model; history for continuity) ---
  const res = await fetch(`${OLLAMA()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: TALK_MODEL(),
      stream: false,
      think: false,
      options: { num_predict: 220 },
      messages: [
        { role: "system", content: system },
        ...history,
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) return NextResponse.json({ error: `LLM ${res.status}` }, { status: 502 });
  let reply = (((await res.json()) as { message?: { content?: string } }).message?.content ?? "").trim();
  // If the token cap truncated mid-sentence, trim back to the last complete
  // sentence so the spoken reply never dies mid-word.
  if (reply && !/[.!?…"')\]]$/.test(reply)) {
    const cut = Math.max(reply.lastIndexOf("."), reply.lastIndexOf("!"), reply.lastIndexOf("?"));
    if (cut > reply.length * 0.4) reply = reply.slice(0, cut + 1);
  }
  const tLlm = Date.now();

  // --- TTS via the provider interface, selected by the persona's registry
  // binding; ElevenLabs is the fallback provider until the local voice wins
  // its A/B. Degrades to text-only on failure.
  let audioB64: string | null = null;
  let audioMime = "audio/mpeg";
  if (reply) {
    const { parseVoiceBinding, getTtsProvider, stripUnsupportedTags } = await import("@/lib/tts");
    // /talk is the explicit voice page: a "none"/missing binding falls back to
    // the env ElevenLabs voice here (chat channels respect "none" strictly).
    let binding = parseVoiceBinding(persona.voiceId);
    if ((!binding || binding.provider === "none") && process.env.ELEVENLABS_VOICE_ID) {
      binding = { provider: "elevenlabs" as const, voiceRef: process.env.ELEVENLABS_VOICE_ID };
    }
    if (binding && binding.provider !== "none") {
      const speakText = stripUnsupportedTags(reply.replace(/[*_`#]/g, ""), binding.provider).slice(0, 1200);
      try {
        const out = await getTtsProvider(binding).synthesize(speakText, binding.voiceRef);
        audioB64 = out.audio.toString("base64");
        audioMime = out.mime;
      } catch (e) {
        console.error(`[talk] tts ${binding.provider} failed: ${String(e).slice(0, 150)}`);
        // Fall back to elevenlabs when a non-EL binding fails.
        if (binding.provider !== "elevenlabs" && process.env.ELEVENLABS_VOICE_ID) {
          try {
            const out = await getTtsProvider({ provider: "elevenlabs", voiceRef: process.env.ELEVENLABS_VOICE_ID }).synthesize(
              stripUnsupportedTags(reply.replace(/[*_`#]/g, ""), "elevenlabs").slice(0, 1200),
              process.env.ELEVENLABS_VOICE_ID
            );
            audioB64 = out.audio.toString("base64");
            audioMime = out.mime;
          } catch {
            /* text-only */
          }
        }
      }
    }
  }

  return NextResponse.json({
    transcript,
    reply,
    intent,
    audioB64,
    audioMime,
    timings: {
      sttMs: tStt - t0,
      llmMs: tLlm - tStt,
      ttsMs: Date.now() - tLlm,
      totalMs: Date.now() - t0,
    },
  });
}
