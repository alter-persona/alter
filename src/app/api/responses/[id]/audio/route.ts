import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

/** Serve a saved recording back to the browser for playback on revisit. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const response = await prisma.response.findUnique({ where: { id } });
  if (!response?.audioPath) {
    return NextResponse.json({ error: "no audio for this response" }, { status: 404 });
  }
  const abs = path.resolve(process.cwd(), response.audioPath);
  // audioPath is always written by our own API under data/audio, but guard anyway.
  if (!abs.startsWith(path.join(process.cwd(), "data", "audio"))) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }
  try {
    const buf = await fs.readFile(abs);
    const type = abs.endsWith(".m4a") ? "audio/mp4" : "audio/webm";
    return new NextResponse(new Uint8Array(buf), {
      headers: { "Content-Type": type, "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "audio file missing on disk" }, { status: 404 });
  }
}
