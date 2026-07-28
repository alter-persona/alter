import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { ensureDefaultPersona } from "@/lib/personas";

export const runtime = "nodejs";

const AB_ROOT = path.join(process.cwd(), "voice-ab");

/** GET: the blinded pair list (without the blinding key). ?audio=<rel> streams a clip. */
export async function GET(req: NextRequest) {
  const persona = await ensureDefaultPersona();
  const url = new URL(req.url);
  const audio = url.searchParams.get("audio");
  if (audio) {
    const abs = path.resolve(AB_ROOT, persona.id, audio);
    if (!abs.startsWith(path.join(AB_ROOT, persona.id)) || !fs.existsSync(abs)) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return new NextResponse(new Uint8Array(fs.readFileSync(abs)), {
      headers: { "Content-Type": abs.endsWith(".mp3") ? "audio/mpeg" : "audio/wav" },
    });
  }
  const pairsFile = path.join(AB_ROOT, persona.id, "pairs.json");
  if (!fs.existsSync(pairsFile)) {
    return NextResponse.json(
      { error: "No A/B pairs yet — run `npm run voice -- abgen` after Stage 3." },
      { status: 404 }
    );
  }
  const { pairs } = JSON.parse(fs.readFileSync(pairsFile, "utf8"));
  // Blinding: the client never sees which side is local.
  return NextResponse.json({
    personaId: persona.id,
    pairs: pairs.map((p: { idx: number; register: string; a: string; b: string }) => ({
      idx: p.idx,
      register: p.register,
      a: p.a,
      b: p.b,
    })),
  });
}

/** POST: record one listener judgment; blinding resolved server-side. */
export async function POST(req: NextRequest) {
  const persona = await ensureDefaultPersona();
  const body = await req.json().catch(() => null);
  const { listener, sentenceIdx, pick } = body ?? {};
  if (!listener || typeof sentenceIdx !== "number" || !["A", "B", "cannot_tell"].includes(pick)) {
    return NextResponse.json({ error: "listener, sentenceIdx, pick(A|B|cannot_tell) required" }, { status: 400 });
  }
  const pairsFile = path.join(AB_ROOT, persona.id, "pairs.json");
  const { pairs } = JSON.parse(fs.readFileSync(pairsFile, "utf8"));
  const pair = pairs.find((p: { idx: number }) => p.idx === sentenceIdx);
  if (!pair) return NextResponse.json({ error: "unknown sentenceIdx" }, { status: 400 });

  const result = await prisma.voiceAbResult.create({
    data: {
      personaId: persona.id,
      listener: String(listener).slice(0, 60),
      sentenceIdx,
      positionOfLocal: pair.positionOfLocal,
      pick,
      pickedLocal: pick === "cannot_tell" ? null : pick === pair.positionOfLocal,
    },
  });
  return NextResponse.json({ ok: true, id: result.id });
}
