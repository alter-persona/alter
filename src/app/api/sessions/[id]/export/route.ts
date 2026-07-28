import { NextRequest, NextResponse } from "next/server";
import archiver from "archiver";
import { PassThrough, Readable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Export a session as a zip: manifest.json + audio/ files.
 * The manifest carries everything the next stage (analysis + voice clone)
 * needs, including the combined voice-audio duration.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await prisma.session.findUnique({ where: { id } });
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });

  const [questions, responses, sessionFiles] = await Promise.all([
    prisma.question.findMany({ orderBy: { orderIndex: "asc" } }),
    prisma.response.findMany({ where: { sessionId: id } }),
    prisma.sessionFile.findMany({ where: { sessionId: id }, orderBy: { createdAt: "asc" } }),
  ]);
  const byQuestion = new Map(responses.map((r) => [r.questionId, r]));

  const entries = questions.map((q) => {
    const r = byQuestion.get(q.id);
    const audioFilename = r?.audioPath ? path.basename(r.audioPath) : null;
    return {
      questionId: q.id,
      orderIndex: q.orderIndex,
      section: q.section,
      type: q.type,
      promptText: q.promptText,
      oceanDomain: q.oceanDomain,
      reverseScored: q.reverseScored,
      isValidation: q.isValidation,
      answered: Boolean(r && !r.skipped && (r.audioPath || r.likertValue != null)),
      skipped: r?.skipped ?? false,
      audioFilename,
      audioDurationSec: r?.audioDurationSec ?? null,
      transcript: r?.transcript ?? null,
      transcriptSource: r?.transcriptSource ?? null,
      transcriptEditedByUser: r?.transcriptEditedByUser ?? false,
      transcriptStatus: r?.transcriptStatus ?? null,
      likertValue: r?.likertValue ?? null,
      answeredAt: r?.updatedAt ?? null,
    };
  });

  const totalVoiceAudioDurationSec = responses.reduce(
    (sum, r) => sum + (r.audioPath ? r.audioDurationSec ?? 0 : 0),
    0
  );

  const manifest = {
    exportedAt: new Date().toISOString(),
    session: {
      id: session.id,
      label: session.label,
      isTrial: session.isTrial,
      status: session.status,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
    },
    totals: {
      questions: questions.length,
      answered: entries.filter((e) => e.answered).length,
      skipped: entries.filter((e) => e.skipped).length,
      voiceAnswers: entries.filter((e) => e.type === "voice" && e.audioFilename).length,
      totalVoiceAudioDurationSec: Math.round(totalVoiceAudioDurationSec * 10) / 10,
      totalVoiceAudioDurationMin:
        Math.round((totalVoiceAudioDurationSec / 60) * 10) / 10,
    },
    responses: entries,
    files: sessionFiles.map((f) => ({
      id: f.id,
      filename: f.filename,
      exportName: f.storedPath ? path.basename(f.storedPath) : null,
      label: f.label,
      domain: f.domain,
      sensitivity: f.sensitivity,
      note: f.note,
      sizeBytes: f.sizeBytes,
      mimeType: f.mimeType,
      addedAt: f.createdAt,
    })),
  };

  const archive = archiver("zip", { zlib: { level: 6 } });
  const pass = new PassThrough();
  archive.pipe(pass);

  archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
  for (const r of responses) {
    if (!r.audioPath) continue;
    const abs = path.resolve(process.cwd(), r.audioPath);
    if (fs.existsSync(abs)) {
      archive.append(fs.createReadStream(abs), { name: `audio/${path.basename(r.audioPath)}` });
    }
  }
  for (const f of sessionFiles) {
    if (!f.storedPath) continue;
    const abs = path.resolve(process.cwd(), f.storedPath);
    if (fs.existsSync(abs)) {
      archive.append(fs.createReadStream(abs), { name: `files/${path.basename(f.storedPath)}` });
    }
  }
  void archive.finalize();

  const filename = `intake-${session.label.replace(/[^a-zA-Z0-9_-]+/g, "-")}-${id.slice(0, 8)}.zip`;
  return new Response(Readable.toWeb(pass) as ReadableStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
