import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

/** Per-persona collection counters for the uploader UI. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const [privCount, pubCount, privOrigins, pubOrigins, voice, pending] = await Promise.all([
    prisma.vectorChunkPrivate.count({ where: { personaId: id } }),
    prisma.vectorChunkPublic.count({ where: { personaId: id } }),
    prisma.vectorChunkPrivate.findMany({
      where: { personaId: id },
      distinct: ["origin"],
      select: { origin: true },
    }),
    prisma.vectorChunkPublic.findMany({
      where: { personaId: id },
      distinct: ["origin"],
      select: { origin: true },
    }),
    prisma.response.aggregate({
      where: { session: { personaId: id }, audioPath: { not: null } },
      _sum: { audioDurationSec: true },
    }),
    prisma.ingestJob.count({ where: { personaId: id, status: { in: ["queued", "running"] } } }),
  ]);

  const voiceMinutes = (voice._sum.audioDurationSec ?? 0) / 60;
  return NextResponse.json({
    items: new Set([...privOrigins, ...pubOrigins].map((o) => o.origin)).size,
    chunks: privCount + pubCount,
    voiceMinutes: Math.round(voiceMinutes * 10) / 10,
    voiceFloorMinutes: 30,
    pendingJobs: pending,
  });
}
