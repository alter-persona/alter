import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await prisma.session.findUnique({ where: { id } });
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });

  const [questions, responses] = await Promise.all([
    prisma.question.findMany({ orderBy: { orderIndex: "asc" } }),
    prisma.response.findMany({ where: { sessionId: id } }),
  ]);

  return NextResponse.json({ session, questions, responses });
}
