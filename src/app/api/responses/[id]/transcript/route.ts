import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

/**
 * User correction of a transcript. Edited text is the ground truth for the
 * later synthesis stage, so it is flagged and never overwritten by the
 * background transcriber.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (typeof body?.transcript !== "string") {
    return NextResponse.json({ error: "transcript (string) is required" }, { status: 400 });
  }

  const existing = await prisma.response.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "response not found" }, { status: 404 });

  const response = await prisma.response.update({
    where: { id },
    data: {
      transcript: body.transcript,
      transcriptEditedByUser: true,
      transcriptStatus: "done",
    },
  });

  // Corrected text is ground truth — re-ingest it into the persona index.
  try {
    const { enqueueResponseIngest } = await import("@/lib/ingestQueue");
    const { personaForSession } = await import("@/lib/personas");
    const persona = await personaForSession(response.sessionId);
    await enqueueResponseIngest(persona.id, response.id);
  } catch (e) {
    console.error("[transcript] ingest enqueue failed:", e);
  }

  return NextResponse.json({ response });
}
