import { NextRequest, NextResponse } from "next/server";
import { ensureDefaultPersona } from "@/lib/personas";
import { ingestInbound } from "@/loop/ingest";
import { runChatTurn, routeClarificationAnswer } from "@/loop/runtime";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * One playground chat turn: ingest the message through the loop (tier 1),
 * then — when it routes as chat — generate the persona reply with hot notes,
 * clarifications, and gap invitations applied. Corrections/material get the
 * loop's acknowledgement instead of a persona reply.
 */
export async function POST(req: NextRequest) {
  const t0 = Date.now();
  const persona = await ensureDefaultPersona();
  const body = (await req.json()) as {
    message: string;
    conversationId?: string;
    history?: { role: "user" | "assistant"; content: string }[];
    replyToEventId?: string | null;
    intentHint?: "chat" | "correction" | "material" | "meta";
  };
  if (!body.message?.trim()) return NextResponse.json({ error: "message required" }, { status: 400 });
  const conversationId = body.conversationId ?? "playground-default";

  const ingest = await ingestInbound({
    personaId: persona.id,
    channel: "playground",
    conversationId,
    kind: "text",
    text: body.message,
    replyToEventId: body.replyToEventId ?? null,
    intentHint: body.intentHint,
  });

  // A message following an asked clarification is its answer — route it back,
  // then still reply conversationally.
  const clarifiedCase = await routeClarificationAnswer(conversationId, ingest.eventId);

  if (!ingest.chat && !clarifiedCase) {
    return NextResponse.json({
      reply: ingest.ack,
      kind: "ack",
      intent: ingest.intent,
      eventId: ingest.eventId,
      totalMs: Date.now() - t0,
    });
  }

  const turn = await runChatTurn({
    personaId: persona.id,
    personaName: persona.name,
    channel: "playground",
    conversationId,
    message: body.message,
    userEventId: ingest.eventId,
    history: body.history ?? [],
    mode: "written",
  });

  return NextResponse.json({
    reply: turn.reply,
    kind: "chat",
    intent: ingest.intent,
    eventId: ingest.eventId,
    personaEventId: turn.personaEventId,
    askedClarification: turn.askedClarification ?? null,
    invitedTopic: turn.invitedTopic ?? null,
    answeredClarification: Boolean(clarifiedCase),
    totalMs: Date.now() - t0,
  });
}
