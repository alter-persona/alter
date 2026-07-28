import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ensureDefaultPersona } from "@/lib/personas";
import { appendStyleDelta } from "@/loop/corrections";
import { resolveWithAnswer } from "@/loop/reconcile";
import { drainLoopQueue } from "@/loop/queue";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Review panel data + actions: the approval queue, clarification cards
 * (batched by theme), the reconciliation log, hot notes, and the scoreboard.
 */
export async function GET() {
  const persona = await ensureDefaultPersona();
  const { moduleCoverage } = await import("@/curriculum/curriculum");
  const [approvals, openCases, resolvedCases, hotNotes, scoreboard, regressions, counters, meter] =
    await Promise.all([
      prisma.pendingApproval.findMany({
        where: { personaId: persona.id, status: "pending" },
        orderBy: { createdAt: "desc" },
      }),
      prisma.reconCase.findMany({
        where: { personaId: persona.id, status: "open" },
        orderBy: { createdAt: "asc" },
      }),
      prisma.reconCase.findMany({
        where: { personaId: persona.id, status: { in: ["auto_resolved", "resolved"] } },
        orderBy: { resolvedAt: "desc" },
        take: 30,
      }),
      prisma.hotNote.findMany({
        where: { personaId: persona.id, active: true },
        orderBy: { createdAt: "desc" },
      }),
      prisma.scoreboardEntry.findMany({
        where: { personaId: persona.id },
        orderBy: { runAt: "desc" },
        take: 20,
      }),
      prisma.regressionCase.findMany({
        where: { personaId: persona.id },
        orderBy: { createdAt: "desc" },
        take: 30,
      }),
      resynthCounters(persona.id),
      moduleCoverage(prisma),
    ]);

  // Batch clarification cards on the same theme into one card.
  const cards = new Map<string, typeof openCases>();
  for (const c of openCases) {
    const key = c.theme ?? "general";
    cards.set(key, [...(cards.get(key) ?? []), c]);
  }

  return NextResponse.json({
    approvals,
    clarificationCards: [...cards.entries()].map(([theme, cases]) => ({ theme, cases })),
    reconLog: resolvedCases,
    hotNotes,
    scoreboard,
    regressions,
    resynthesis: counters,
    meter,
  });
}

async function resynthCounters(personaId: string) {
  const { loopConfig } = await import("@/loop/config");
  const cfg = loopConfig();
  const last = await prisma.scoreboardEntry.findFirst({
    where: { personaId, kind: "resynthesis" },
    orderBy: { runAt: "desc" },
  });
  const since = last?.runAt ?? new Date(0);
  const [newProps, corrections, coreOpen] = await Promise.all([
    prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT (SELECT COUNT(*) FROM "PropositionPrivate" WHERE "personaId" = $1 AND "createdAt" > $2)
            + (SELECT COUNT(*) FROM "PropositionPublic" WHERE "personaId" = $1 AND "createdAt" > $2) AS n`,
      personaId,
      since
    ),
    prisma.updateEvent.count({
      where: { personaId, intent: { in: ["correction", "meta"] }, createdAt: { gt: since } },
    }),
    prisma.reconCase.count({ where: { personaId, status: "open", tier: "core" } }),
  ]);
  const chunks = Number(newProps[0]?.n ?? 0);
  return {
    newChunksSinceResynth: chunks,
    correctionsSinceResynth: corrections,
    chunkThreshold: cfg.resynthesisChunkThreshold,
    correctionThreshold: cfg.resynthesisCorrectionThreshold,
    due: chunks >= cfg.resynthesisChunkThreshold || corrections >= cfg.resynthesisCorrectionThreshold,
    blockedByOpenCoreCase: coreOpen > 0,
  };
}

export async function POST(req: NextRequest) {
  const persona = await ensureDefaultPersona();
  const body = (await req.json()) as {
    action: "approve" | "reject" | "answer_card" | "dismiss_case" | "drain";
    approvalId?: string;
    caseId?: string;
    answer?: string;
  };

  if (body.action === "approve" || body.action === "reject") {
    const a = await prisma.pendingApproval.findUnique({ where: { id: body.approvalId! } });
    if (!a) return NextResponse.json({ error: "not found" }, { status: 404 });
    await prisma.pendingApproval.update({
      where: { id: a.id },
      data: { status: body.action === "approve" ? "approved" : "rejected", decidedAt: new Date() },
    });
    if (body.action === "approve") {
      await appendStyleDelta(persona.id, a.text, a.kind as "style_rule" | "guardrail");
    }
    return NextResponse.json({ ok: true });
  }

  if (body.action === "answer_card") {
    if (!body.caseId || !body.answer?.trim()) {
      return NextResponse.json({ error: "caseId and answer required" }, { status: 400 });
    }
    const e = await prisma.updateEvent.create({
      data: {
        personaId: persona.id,
        channel: "playground",
        conversationId: "review-panel",
        kind: "text",
        rawText: body.answer,
        register: "written",
        intent: "correction",
        intentSource: "hint",
        status: "queued",
        retrievalLog: { clarifiesCaseId: body.caseId },
      },
    });
    await resolveWithAnswer(body.caseId, body.answer, e.id);
    await prisma.updateEvent.update({ where: { id: e.id }, data: { status: "distilled" } });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "dismiss_case") {
    await prisma.reconCase.update({
      where: { id: body.caseId! },
      data: { status: "dismissed", resolvedAt: new Date() },
    });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "drain") {
    await drainLoopQueue();
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
