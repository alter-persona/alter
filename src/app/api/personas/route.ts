import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ensureDefaultPersona } from "@/lib/personas";

export const runtime = "nodejs";

export async function GET() {
  await ensureDefaultPersona();
  const personas = await prisma.persona.findMany({ orderBy: { createdAt: "asc" } });
  return NextResponse.json({ personas });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  const existing = await prisma.persona.findUnique({ where: { name } });
  if (existing) return NextResponse.json({ persona: existing });
  const persona = await prisma.persona.create({ data: { name } });
  return NextResponse.json({ persona }, { status: 201 });
}
