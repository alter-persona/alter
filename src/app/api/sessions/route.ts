import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  const [sessions, totalQuestions] = await Promise.all([
    prisma.session.findMany({
      orderBy: { startedAt: "desc" },
      include: { responses: { select: { skipped: true, audioPath: true, likertValue: true } } },
    }),
    prisma.question.count(),
  ]);

  return NextResponse.json({
    totalQuestions,
    sessions: sessions.map((s) => ({
      id: s.id,
      label: s.label,
      isTrial: s.isTrial,
      status: s.status,
      startedAt: s.startedAt,
      completedAt: s.completedAt,
      answered: s.responses.filter(
        (r) => !r.skipped && (r.audioPath !== null || r.likertValue !== null)
      ).length,
      skipped: s.responses.filter((r) => r.skipped).length,
    })),
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : null;
  if (!label) {
    return NextResponse.json({ error: "label is required" }, { status: 400 });
  }
  const session = await prisma.session.create({
    data: { label, isTrial: Boolean(body.isTrial) },
  });
  return NextResponse.json({ session }, { status: 201 });
}
