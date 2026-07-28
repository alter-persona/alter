import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Upsert a non-audio answer (Likert value or a skip marker) keyed on
 * (sessionId, questionId). Called the moment an answer is given so nothing
 * is ever held only in browser state.
 */
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.sessionId || !body?.questionId) {
    return NextResponse.json({ error: "sessionId and questionId are required" }, { status: 400 });
  }

  const question = await prisma.question.findUnique({ where: { id: body.questionId } });
  if (!question) return NextResponse.json({ error: "question not found" }, { status: 404 });

  let likertValue: number | null | undefined = undefined;
  if ("likertValue" in body) {
    if (body.likertValue !== null) {
      const v = Number(body.likertValue);
      if (!Number.isInteger(v) || v < 1 || v > 5) {
        return NextResponse.json({ error: "likertValue must be an integer 1-5" }, { status: 400 });
      }
      likertValue = v;
    } else {
      likertValue = null;
    }
  }
  const skipped: boolean | undefined =
    "skipped" in body ? Boolean(body.skipped) : likertValue != null ? false : undefined;

  const response = await prisma.response.upsert({
    where: { sessionId_questionId: { sessionId: body.sessionId, questionId: body.questionId } },
    create: {
      sessionId: body.sessionId,
      questionId: body.questionId,
      type: question.type,
      likertValue: likertValue ?? null,
      skipped: skipped ?? false,
    },
    update: {
      ...(likertValue !== undefined ? { likertValue } : {}),
      ...(skipped !== undefined ? { skipped } : {}),
    },
  });

  return NextResponse.json({ response });
}
