import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { kickTranscriptionQueue } from "@/lib/transcriptionQueue";

export const runtime = "nodejs";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const existing = await prisma.response.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "response not found" }, { status: 404 });
  if (!existing.audioPath) {
    return NextResponse.json({ error: "response has no audio to transcribe" }, { status: 400 });
  }

  const response = await prisma.response.update({
    where: { id },
    data: { transcriptStatus: "pending" },
  });
  kickTranscriptionQueue();
  return NextResponse.json({ response });
}
