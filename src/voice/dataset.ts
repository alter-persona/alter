import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prisma } from "@/lib/db";
import { parseSilences, planClips, refineSpans, speechSpans } from "./segment";

const execFileP = promisify(execFile);

/**
 * Stage 1: build the per-persona TTS training dataset from the intake data.
 * 24 kHz mono WAV clips (codec requirement, see VERSIONS), cut only at
 * silences, loudness-normalized, with per-clip whisper text. Sealed
 * validation questions are excluded (invariant 4). Refuses under 20 kept
 * minutes, and refuses entirely without the owner's voice-consent
 * attestation.
 */

const MIN_KEPT_MINUTES = 20;
const WHISPER_MODEL = () => path.join(process.cwd(), "models", "ggml-large-v3-turbo.bin");

export class DatasetError extends Error {}

export interface DatasetSummary {
  personaId: string;
  clips: number;
  keptMinutes: number;
  droppedMinutes: number;
  drops: { reason: string; count: number }[];
  perSection: Record<string, { clips: number; minutes: number }>;
  skippedUnreviewed: number;
  editedTranscriptAnswers: number;
  outDir: string;
}

async function ff(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileP(process.env.FFMPEG_PATH ?? "ffmpeg", ["-hide_banner", ...args], {
    maxBuffer: 32 * 1024 * 1024,
  });
}

async function probeDuration(file: string): Promise<number> {
  const { stdout } = await execFileP("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
  ]);
  return parseFloat(stdout.trim());
}

async function transcribeClip(wav24k: string): Promise<string> {
  const tmp16 = wav24k.replace(/\.wav$/, ".16k.wav");
  const prefix = wav24k.replace(/\.wav$/, "");
  try {
    await ff(["-loglevel", "error", "-y", "-i", wav24k, "-ar", "16000", tmp16]);
    await execFileP("whisper-cli", ["-m", WHISPER_MODEL(), "-f", tmp16, "-otxt", "-of", prefix, "-np"], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return fs.readFileSync(`${prefix}.txt`, "utf8").replace(/\s+/g, " ").trim();
  } finally {
    for (const f of [tmp16, `${prefix}.txt`]) fs.rmSync(f, { force: true });
  }
}

export async function buildDataset(
  personaRef: string,
  opts: { attestOwnVoice?: boolean; allowUnreviewed?: boolean; log?: (s: string) => void } = {}
): Promise<DatasetSummary> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const persona =
    (await prisma.persona.findUnique({ where: { id: personaRef } }).catch(() => null)) ??
    (await prisma.persona.findUnique({ where: { name: personaRef } }));
  if (!persona) throw new DatasetError(`Persona "${personaRef}" not found`);

  // Factory consent rule: never make it easy to clone someone who didn't sit
  // the interview. Attestation is stored with a timestamp on the persona.
  if (!persona.voiceConsentAt) {
    if (!opts.attestOwnVoice) {
      throw new DatasetError(
        "Refusing to build: no voice-consent attestation on this persona. Re-run with " +
          "--attest-own-voice to attest that the training audio is the account owner's own voice."
      );
    }
    await prisma.persona.update({ where: { id: persona.id }, data: { voiceConsentAt: new Date() } });
    log(`[consent] attestation recorded ${new Date().toISOString()}`);
  }

  // Ground-truth rule: edited transcripts only, unless explicitly overridden.
  const answers = await prisma.response.findMany({
    where: {
      session: { personaId: persona.id },
      audioPath: { not: null },
      transcript: { not: null },
      question: { isValidation: false }, // invariant 4 — sealed set never enters
    },
    include: { question: true },
    orderBy: { createdAt: "asc" },
  });
  const reviewed = answers.filter((a) => a.transcriptEditedByUser);
  const usable = opts.allowUnreviewed ? answers : reviewed;
  const skippedUnreviewed = answers.length - usable.length;
  if (skippedUnreviewed > 0) {
    log(
      `[dataset] ${skippedUnreviewed} answer(s) skipped: transcripts never human-reviewed` +
        (opts.allowUnreviewed ? " (OVERRIDDEN — using machine transcripts)" : " (use --allow-unreviewed to include)")
    );
  }

  const outDir = path.join(process.cwd(), "voice-dataset", persona.id);
  const wavDir = path.join(outDir, "wavs");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(wavDir, { recursive: true });

  const manifest: { audio: string; text: string }[] = [];
  const dropCounts = new Map<string, number>();
  const perSection: Record<string, { clips: number; minutes: number }> = {};
  const dropsLog: string[] = [];
  let keptSec = 0;
  let droppedSec = 0;
  let clipIdx = 0;
  const drop = (reason: string, sec: number, ctx: string) => {
    dropCounts.set(reason, (dropCounts.get(reason) ?? 0) + 1);
    droppedSec += sec;
    dropsLog.push(`${ctx}: ${reason} (${sec.toFixed(1)}s)`);
  };

  for (const a of usable) {
    const ctx = `q${a.question.orderIndex + 1}`;
    const src = path.resolve(process.cwd(), a.audioPath!);
    if (!fs.existsSync(src)) {
      drop("source audio missing on disk", a.audioDurationSec ?? 0, ctx);
      continue;
    }
    const tmpBase = path.join(os.tmpdir(), `vds-${Date.now()}-${clipIdx}`);
    const norm = `${tmpBase}.wav`;
    try {
      // 24 kHz mono + loudness normalization in one pass.
      await ff(["-loglevel", "error", "-y", "-i", src, "-af", "loudnorm=I=-19:TP=-1.5:LRA=11", "-ar", "24000", "-ac", "1", norm]);
      const dur = await probeDuration(norm);
      // Silence detection at three sensitivities: strict pauses first, then
      // breath-level pauses for continuous talkers (this speaker's long runs
      // dropped 55 spans at the strict threshold alone).
      const detect = async (params: string) =>
        parseSilences((await ff(["-i", norm, "-af", `silencedetect=${params}`, "-f", "null", "-"])).stderr);
      const l1 = await detect("noise=-35dB:d=0.35");
      const l2 = await detect("noise=-30dB:d=0.22");
      const l3 = await detect("noise=-25dB:d=0.15");
      const spans = refineSpans(speechSpans(l1, dur), [l2, l3]);
      const plan = planClips(spans, dur);
      for (const d of plan.dropped) drop(d.reason.replace(/[\d.]+s/g, "Ns"), d.span.end - d.span.start, ctx);

      for (const clip of plan.clips) {
        const name = `clip_${String(++clipIdx).padStart(4, "0")}.wav`;
        const dest = path.join(wavDir, name);
        await ff(["-loglevel", "error", "-y", "-i", norm, "-ss", clip.start.toFixed(3), "-to", clip.end.toFixed(3), "-c", "copy", dest]);
        const sec = clip.end - clip.start;

        // Clipping check.
        const { stderr: vol } = await ff(["-i", dest, "-af", "volumedetect", "-f", "null", "-"]);
        const maxVol = parseFloat(vol.match(/max_volume:\s*(-?[\d.]+)/)?.[1] ?? "-99");
        if (maxVol > -0.3) {
          fs.rmSync(dest, { force: true });
          drop("clipped audio (peak at 0 dBFS)", sec, ctx);
          clipIdx--;
          continue;
        }
        const text = await transcribeClip(dest);
        if (!text || text.split(/\s+/).length < 2 || /^\[.*\]$/.test(text)) {
          fs.rmSync(dest, { force: true });
          drop("no intelligible speech in clip", sec, ctx);
          clipIdx--;
          continue;
        }
        manifest.push({ audio: `wavs/${name}`, text });
        keptSec += sec;
        const section = a.question.section;
        perSection[section] ??= { clips: 0, minutes: 0 };
        perSection[section].clips++;
        perSection[section].minutes += sec / 60;
      }
    } finally {
      fs.rmSync(norm, { force: true });
    }
    log(`[dataset] ${ctx}: ${manifest.length} clips so far, ${(keptSec / 60).toFixed(1)} min kept`);
  }

  const keptMinutes = keptSec / 60;
  if (keptMinutes < MIN_KEPT_MINUTES) {
    fs.rmSync(outDir, { recursive: true, force: true });
    throw new DatasetError(
      `Refusing to emit: only ${keptMinutes.toFixed(1)} minutes of clean audio kept ` +
        `(minimum ${MIN_KEPT_MINUTES}). ${skippedUnreviewed > 0 ? `${skippedUnreviewed} answers were skipped as unreviewed — review transcripts in the app or pass --allow-unreviewed. ` : ""}` +
        `Drops: ${[...dropCounts.entries()].map(([r, c]) => `${r}×${c}`).join(", ") || "none"}`
    );
  }

  // Reserve the last 10% of clips as held-back real audio for Stage 3
  // speaker-similarity evaluation — never trained on.
  const holdbackCount = Math.max(3, Math.floor(manifest.length * 0.1));
  const holdback = manifest.splice(manifest.length - holdbackCount, holdbackCount);
  const hbDir = path.join(outDir, "holdback");
  fs.mkdirSync(hbDir, { recursive: true });
  for (const h of holdback) {
    fs.renameSync(path.join(outDir, h.audio), path.join(hbDir, path.basename(h.audio)));
  }

  fs.writeFileSync(
    path.join(outDir, "train_raw.jsonl"),
    manifest.map((m) => JSON.stringify(m)).join("\n") + "\n"
  );
  fs.writeFileSync(path.join(outDir, "dataset-drops.log"), dropsLog.join("\n") + "\n");
  const summary: DatasetSummary = {
    personaId: persona.id,
    clips: manifest.length,
    keptMinutes: Number(keptMinutes.toFixed(1)),
    droppedMinutes: Number((droppedSec / 60).toFixed(1)),
    drops: [...dropCounts.entries()].map(([reason, count]) => ({ reason, count })),
    perSection: Object.fromEntries(
      Object.entries(perSection).map(([k, v]) => [k, { clips: v.clips, minutes: Number(v.minutes.toFixed(1)) }])
    ),
    skippedUnreviewed,
    editedTranscriptAnswers: reviewed.length,
    outDir,
  };
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}
