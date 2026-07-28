import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureDefaultPersona } from "@/lib/personas";
import { ingestInbound, type InboundItem } from "@/loop/ingest";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Channel-agnostic ingest endpoint — both adapters call this. JSON for text,
 * multipart for audio/files. Tier-1 only: persists, transcribes, hot-notes,
 * acks; all heavier work is queued.
 */
export async function POST(req: NextRequest) {
  const persona = await ensureDefaultPersona();
  const ct = req.headers.get("content-type") ?? "";

  let item: InboundItem;
  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file field required" }, { status: 400 });
    }
    const kind = String(form.get("kind") ?? "file") as "audio" | "file";
    const dir = path.join(process.cwd(), "storage", "loop");
    await fs.mkdir(dir, { recursive: true });
    const safeName = file.name.replace(/[^\w.\-]/g, "_");
    const stored = path.join(dir, `${Date.now()}-${safeName}`);
    await fs.writeFile(stored, Buffer.from(await file.arrayBuffer()));
    item = {
      personaId: persona.id,
      channel: (String(form.get("channel") ?? "playground") as "playground" | "telegram"),
      conversationId: String(form.get("conversationId") ?? "default"),
      kind,
      audioPath: kind === "audio" ? stored : null,
      audioDurationSec: form.get("durationSec") ? Number(form.get("durationSec")) : null,
      filePath: kind === "file" ? path.relative(process.cwd(), stored) : null,
      filename: file.name,
      replyToEventId: form.get("replyToEventId") ? String(form.get("replyToEventId")) : null,
      intentHint: form.get("intentHint") ? (String(form.get("intentHint")) as InboundItem["intentHint"]) : undefined,
      sensitivity: form.get("sensitivity") === "public" ? "public" : "private",
    };
  } else {
    const body = (await req.json()) as Partial<InboundItem>;
    if (!body.text?.trim()) return NextResponse.json({ error: "text required" }, { status: 400 });
    item = {
      personaId: persona.id,
      channel: (body.channel ?? "playground") as "playground" | "telegram",
      conversationId: body.conversationId ?? "default",
      kind: "text",
      text: body.text,
      replyToEventId: body.replyToEventId ?? null,
      intentHint: body.intentHint,
      sensitivity: body.sensitivity ?? "private",
    };
  }

  const result = await ingestInbound(item);
  return NextResponse.json(result);
}
