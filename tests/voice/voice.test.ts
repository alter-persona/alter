import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { parseSilences, speechSpans, planClips, MIN_CLIP_SEC, MAX_CLIP_SEC } from "../../src/voice/segment";
import { parseVoiceBinding, getTtsProvider, stripUnsupportedTags } from "../../src/lib/tts";
import { assignBlinding } from "../../src/voice/abpairs";

process.env.EMBED_FAKE = "1";
const prisma = new PrismaClient();
const cleanupPersonas: string[] = [];
const cleanupSessions: string[] = [];

// 1. Segmentation respects clip bounds and never cuts mid-word (VAD fixture).
test("segmentation cuts only at silences and respects 3-15s bounds", () => {
  // Fixture: speech 0-4s, silence 4-5s, speech 5-11s, silence 11-12s,
  // speech 12-30s (18s continuous — no internal silence), silence 30-31, speech 31-33.5s.
  const ffmpegStderr = [
    "[silencedetect] silence_start: 4.0",
    "[silencedetect] silence_end: 5.0 | silence_duration: 1.0",
    "[silencedetect] silence_start: 11.0",
    "[silencedetect] silence_end: 12.0 | silence_duration: 1.0",
    "[silencedetect] silence_start: 30.0",
    "[silencedetect] silence_end: 31.0 | silence_duration: 1.0",
  ].join("\n");
  const silences = parseSilences(ffmpegStderr);
  assert.equal(silences.length, 3);
  const spans = speechSpans(silences, 33.5);
  assert.equal(spans.length, 4);

  const plan = planClips(spans, 33.5);
  for (const c of plan.clips) {
    const len = c.end - c.start;
    assert.ok(len >= MIN_CLIP_SEC && len <= MAX_CLIP_SEC, `clip ${len.toFixed(1)}s within bounds`);
    // Never mid-word: every internal boundary must sit inside a silence (±pad).
    for (const edge of [c.start, c.end]) {
      const inSilence = silences.some((s) => edge >= s.start - 0.2 && edge <= s.end + 0.2);
      const atFileEdge = edge <= 0.2 || edge >= 33.3;
      assert.ok(inSilence || atFileEdge, `cut at ${edge.toFixed(2)}s is inside a silence or file edge`);
    }
  }
  // The 18s continuous span cannot be cut without going mid-word → dropped.
  assert.ok(
    plan.dropped.some((d) => d.reason.includes("exceeds") && d.span.start === 12.0),
    "unsplittable long span dropped, not cut mid-word"
  );
  // Spans 0-4 and 5-11 pack into one clip ≤15s (4+1+6=11s).
  assert.ok(plan.clips.some((c) => c.start < 0.2 && c.end > 10.8), "adjacent spans packed across silence");
});

// Helpers for DB-backed tests.
async function personaWithAnswer(opts: { validation: boolean; seconds: number }) {
  const persona = await prisma.persona.create({
    data: { name: `vtest-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` },
  });
  cleanupPersonas.push(persona.id);
  const session = await prisma.session.create({
    data: { label: "vtest", personaId: persona.id },
  });
  cleanupSessions.push(session.id);
  const question = await prisma.question.findFirst({ where: { isValidation: opts.validation } });
  // Real speech fixture via macOS `say`.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vtest-"));
  const aiff = path.join(dir, "a.aiff");
  const words = Array.from({ length: Math.round(opts.seconds * 2.4) }, (_, i) => `word ${i}`).join(" ");
  execFileSync("say", ["-o", aiff, words]);
  const webm = path.join(dir, "a.webm");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", aiff, "-c:a", "libopus", webm]);
  await prisma.response.create({
    data: {
      sessionId: session.id,
      questionId: question!.id,
      type: "voice",
      audioPath: path.relative(process.cwd(), webm),
      audioDurationSec: opts.seconds,
      transcript: words,
      transcriptEditedByUser: true,
      transcriptStatus: "done",
    },
  });
  return persona;
}

// 2 + 3. Holdout exclusion by question id, consent gate, under-20-minute refusal.
test("dataset builder: consent gate, holdout exclusion, and 20-minute refusal", async () => {
  const { buildDataset, DatasetError } = await import("../../src/voice/dataset");

  // Consent gate: refuse without attestation.
  const p1 = await personaWithAnswer({ validation: false, seconds: 12 });
  await assert.rejects(
    () => buildDataset(p1.id, { log: () => {} }),
    (e: unknown) => e instanceof DatasetError && /attest/i.test(e.message),
    "refuses without voice-consent attestation"
  );

  // Under-20-minutes refusal (12s of real audio, attested).
  await assert.rejects(
    () => buildDataset(p1.id, { attestOwnVoice: true, log: () => {} }),
    (e: unknown) => e instanceof DatasetError && /Refusing to emit/.test(e.message),
    "refuses under the 20-minute floor"
  );
  const p1row = await prisma.persona.findUnique({ where: { id: p1.id } });
  assert.ok(p1row?.voiceConsentAt, "attestation recorded with timestamp");

  // Holdout exclusion: a persona whose ONLY answer is a sealed validation
  // question yields zero usable audio ("0.0 minutes"), proving the sealed
  // set never enters the dataset even when its audio exists on disk.
  const p2 = await personaWithAnswer({ validation: true, seconds: 12 });
  await assert.rejects(
    () => buildDataset(p2.id, { attestOwnVoice: true, log: () => {} }),
    (e: unknown) =>
      e instanceof DatasetError && /only 0\.0 minutes/.test(e.message),
    "validation answers are structurally excluded"
  );
});

// 4. Provider selection by registry binding.
test("TTS provider selection follows the registry voice binding", () => {
  assert.deepEqual(parseVoiceBinding("elevenlabs:VOICEIDFIXTURE000000"), {
    provider: "elevenlabs",
    voiceRef: "VOICEIDFIXTURE000000",
  });
  assert.deepEqual(parseVoiceBinding("qwen3tts-mlx:/path/to/adapter"), {
    provider: "qwen3tts-mlx",
    voiceRef: "/path/to/adapter",
  });
  assert.equal(parseVoiceBinding("bogus"), null);
  // Voice output is an add-on, never the default: no binding = provider none.
  assert.deepEqual(parseVoiceBinding(null), { provider: "none", voiceRef: "" });
  assert.equal(getTtsProvider({ provider: "elevenlabs", voiceRef: "x" }).name, "elevenlabs");
  assert.equal(getTtsProvider({ provider: "qwen3tts-mlx", voiceRef: "x" }).name, "qwen3tts-mlx");
});

// 5. Tag stripping for unsupported delivery tags.
test("delivery tags are stripped for providers that would speak them aloud", () => {
  const text = "Well [pause] that's the thing [breathes] — it depends [warmly].";
  const local = stripUnsupportedTags(text, "qwen3tts-mlx");
  assert.ok(!local.includes("["), `local strips all tags: "${local}"`);
  assert.ok(local.includes("that's the thing"), "content intact");
  const el = stripUnsupportedTags(text, "elevenlabs");
  assert.ok(el.includes("[pause]") && el.includes("[breathes]"), "EL keeps supported v3 tags");
  assert.ok(!el.includes("[warmly]"), "EL drops unsupported tags too");
});

// 6. Blinded pair assignment.
test("A/B blinding is deterministic per seed and roughly balanced", () => {
  const a = assignBlinding(16, "persona-x");
  const b = assignBlinding(16, "persona-x");
  assert.deepEqual(a, b, "deterministic for the same seed");
  const c = assignBlinding(16, "persona-y");
  assert.notDeepEqual(a, c, "differs across seeds");
  const localAsA = a.filter((p) => p === "A").length;
  assert.ok(localAsA >= 4 && localAsA <= 12, `positions mixed (${localAsA}/16 as A)`);
});

after(async () => {
  for (const id of cleanupSessions) {
    await prisma.response.deleteMany({ where: { sessionId: id } });
    await prisma.session.delete({ where: { id } }).catch(() => {});
  }
  for (const id of cleanupPersonas) await prisma.persona.delete({ where: { id } }).catch(() => {});
  await prisma.$disconnect();
});
