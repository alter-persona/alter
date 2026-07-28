import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "@/lib/db";
import { kickTranscriptionQueue } from "@/lib/transcriptionQueue";

export const runtime = "nodejs";

const AUDIO_ROOT = path.join(process.cwd(), "data", "audio");
const execFileP = promisify(execFile);

/**
 * Save a voice answer. Multipart form: sessionId, questionId, durationSec, file.
 *
 * The file is written to a temp name first and renamed over the final path only
 * once fully on disk, so a re-record never destroys the previous take until its
 * replacement is safely saved. Saving resets the transcript state and re-queues
 * background transcription.
 */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const sessionId = String(form.get("sessionId") ?? "");
  const questionId = String(form.get("questionId") ?? "");
  const durationSec = Number(form.get("durationSec") ?? 0);
  const file = form.get("file");

  if (!sessionId || !questionId || !(file instanceof File)) {
    return NextResponse.json(
      { error: "sessionId, questionId and file are required" },
      { status: 400 }
    );
  }

  const [session, question] = await Promise.all([
    prisma.session.findUnique({ where: { id: sessionId } }),
    prisma.question.findUnique({ where: { id: questionId } }),
  ]);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
  if (!question) return NextResponse.json({ error: "question not found" }, { status: 404 });
  if (question.type !== "voice") {
    return NextResponse.json({ error: "question is not a voice question" }, { status: 400 });
  }

  const ext = file.type.includes("mp4") ? "m4a" : "webm";
  const dir = path.join(AUDIO_ROOT, sessionId);
  await fs.mkdir(dir, { recursive: true });

  const finalName = `${questionId}.${ext}`;
  const finalAbs = path.join(dir, finalName);
  const tmpAbs = path.join(dir, `.${finalName}.tmp-${Date.now()}`);

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length === 0) {
    return NextResponse.json({ error: "empty audio upload" }, { status: 400 });
  }
  await fs.writeFile(tmpAbs, bytes);

  // MediaRecorder output lacks a duration header, which breaks the playback
  // timeline. Losslessly remux via ffmpeg (-c copy) to write proper metadata,
  // then atomically replace any previous take. Falls back to the raw file if
  // ffmpeg is unavailable — audio is never lost either way.
  const remuxAbs = `${tmpAbs}.remux.${ext}`;
  try {
    await execFileP(
      process.env.FFMPEG_PATH ?? "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-y", "-i", tmpAbs, "-c", "copy", remuxAbs],
      { maxBuffer: 16 * 1024 * 1024 }
    );
    await fs.rename(remuxAbs, finalAbs);
    await fs.unlink(tmpAbs).catch(() => {});
  } catch {
    await fs.rename(tmpAbs, finalAbs);
  }

  const relPath = path.join("data", "audio", sessionId, finalName);

  // If a previous take used a different container/extension, clean it up now
  // that the replacement is saved.
  const existing = await prisma.response.findUnique({
    where: { sessionId_questionId: { sessionId, questionId } },
  });
  if (existing?.audioPath && existing.audioPath !== relPath) {
    await fs.unlink(path.resolve(process.cwd(), existing.audioPath)).catch(() => {});
  }

  const response = await prisma.response.upsert({
    where: { sessionId_questionId: { sessionId, questionId } },
    create: {
      sessionId,
      questionId,
      type: "voice",
      audioPath: relPath,
      audioDurationSec: Number.isFinite(durationSec) ? durationSec : null,
      transcriptStatus: "pending",
    },
    update: {
      audioPath: relPath,
      audioDurationSec: Number.isFinite(durationSec) ? durationSec : null,
      transcript: null,
      transcriptStatus: "pending",
      transcriptSource: null,
      transcriptEditedByUser: false,
      skipped: false,
    },
  });

  kickTranscriptionQueue();

  return NextResponse.json({ response }, { status: 201 });
}
