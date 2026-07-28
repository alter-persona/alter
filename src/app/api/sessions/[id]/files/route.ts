import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

const FILES_ROOT = path.join(process.cwd(), "data", "files");
const ALLOWED_EXT = [".md", ".txt", ".pdf", ".docx", ".html", ".htm", ".eml", ".zip"];
const MAX_BYTES = 100 * 1024 * 1024; // chat-export zips are large

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const files = await prisma.sessionFile.findMany({
    where: { sessionId: id },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ files });
}

/**
 * Attach a file to a session, with the configuration the corpus pipeline
 * requires: label, domain, sensitivity, optional note. Files ride along in
 * the session export zip and are ingested by the corpus build.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await prisma.session.findUnique({ where: { id } });
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });

  const form = await req.formData();
  const file = form.get("file");
  const label = String(form.get("label") ?? "").trim();
  const domain = String(form.get("domain") ?? "").trim();
  const sensitivity = String(form.get("sensitivity") ?? "private");
  const note = String(form.get("note") ?? "").trim();

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }
  if (!label) {
    return NextResponse.json(
      { error: "label is required (e.g. writing-sample, spec, review, bio)" },
      { status: 400 }
    );
  }
  if (sensitivity !== "private" && sensitivity !== "public") {
    return NextResponse.json({ error: "sensitivity must be private or public" }, { status: 400 });
  }
  const ext = path.extname(file.name).toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) {
    return NextResponse.json(
      { error: `unsupported file type "${ext}" — accepted: ${ALLOWED_EXT.join(", ")}` },
      { status: 400 }
    );
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length === 0) return NextResponse.json({ error: "empty file" }, { status: 400 });
  if (bytes.length > MAX_BYTES) {
    return NextResponse.json({ error: "file exceeds 100 MB limit" }, { status: 400 });
  }
  if (ext === ".zip") {
    const { isChatExportZip } = await import("@/lib/ingestQueue");
    if (!isChatExportZip(bytes)) {
      return NextResponse.json(
        { error: "zip is not a recognized AI chat export (Claude format supported)" },
        { status: 400 }
      );
    }
  }

  const safeName = path.basename(file.name).replace(/[^\w.\-() ]+/g, "_");
  const record = await prisma.sessionFile.create({
    data: {
      sessionId: id,
      filename: safeName,
      storedPath: "", // set below once the id exists
      mimeType: file.type || null,
      sizeBytes: bytes.length,
      label,
      domain: domain || null,
      sensitivity: sensitivity as "private" | "public",
      note: note || null,
    },
  });

  const dir = path.join(FILES_ROOT, id);
  await fs.mkdir(dir, { recursive: true });
  const storedName = `${record.id.slice(0, 8)}__${safeName}`;
  const abs = path.join(dir, storedName);
  const tmp = path.join(dir, `.${storedName}.tmp`);
  await fs.writeFile(tmp, bytes);
  await fs.rename(tmp, abs);

  const updated = await prisma.sessionFile.update({
    where: { id: record.id },
    data: { storedPath: path.join("data", "files", id, storedName) },
  });

  // Uploading IS ingestion: queue the background job (retrieval + style halves).
  const { enqueueFileIngest } = await import("@/lib/ingestQueue");
  const { personaForSession } = await import("@/lib/personas");
  const persona = await personaForSession(id);
  await enqueueFileIngest(persona.id, updated.id);

  return NextResponse.json({ file: updated }, { status: 201 });
}
