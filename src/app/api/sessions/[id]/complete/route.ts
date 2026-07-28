import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await prisma.session.findUnique({ where: { id } });
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });

  const updated = await prisma.session.update({
    where: { id },
    data: { status: "complete", completedAt: session.completedAt ?? new Date() },
  });
  return NextResponse.json({ session: updated });
}
