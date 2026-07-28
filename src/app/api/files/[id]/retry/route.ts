import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { enqueueFileIngest } from "@/lib/ingestQueue";
import { personaForSession } from "@/lib/personas";

export const runtime = "nodejs";

/** Re-queue ingestion for a failed file. */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const file = await prisma.sessionFile.findUnique({ where: { id } });
  if (!file) return NextResponse.json({ error: "file not found" }, { status: 404 });
  const persona = await personaForSession(file.sessionId);
  await enqueueFileIngest(persona.id, id);
  return NextResponse.json({ ok: true });
}
