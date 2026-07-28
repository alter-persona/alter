import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

/** Update a session file's configuration (label, domain, sensitivity, note). */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const existing = await prisma.sessionFile.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "file not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const data: Record<string, unknown> = {};
  if (typeof body.label === "string" && body.label.trim()) data.label = body.label.trim();
  if ("domain" in body) data.domain = typeof body.domain === "string" && body.domain.trim() ? body.domain.trim() : null;
  if ("note" in body) data.note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
  if ("sensitivity" in body) {
    if (body.sensitivity !== "private" && body.sensitivity !== "public") {
      return NextResponse.json({ error: "sensitivity must be private or public" }, { status: 400 });
    }
    data.sensitivity = body.sensitivity;
  }

  const file = await prisma.sessionFile.update({ where: { id }, data });
  return NextResponse.json({ file });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const existing = await prisma.sessionFile.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "file not found" }, { status: 404 });

  await prisma.sessionFile.delete({ where: { id } });
  if (existing.storedPath) {
    await fs.unlink(path.resolve(process.cwd(), existing.storedPath)).catch(() => {});
  }
  return NextResponse.json({ ok: true });
}
