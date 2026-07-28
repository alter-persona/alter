import { prisma } from "@/lib/db";
import { heuristicIntent, type Intent } from "./classify";
import { writeHotNote } from "./hotnotes";
import { kickLoopQueue } from "./queue";

/**
 * Tier 1: capture and hot notes, within seconds. Channel-agnostic — both
 * adapters (playground, telegram) call ingestInbound. NO LLM runs here; the
 * reply path stays fast. All tier-2 work (classification refinement,
 * distillation, reconciliation) goes through the LoopJob queue.
 */

export interface InboundItem {
  personaId: string;
  channel: "playground" | "telegram";
  conversationId: string;
  kind: "text" | "audio" | "file";
  text?: string | null;
  /** Adapter already saved the audio; we transcribe here so classification sees words. */
  audioPath?: string | null;
  audioDurationSec?: number | null;
  filePath?: string | null;
  filename?: string | null;
  /** The persona turn this responds to → strong correction prior. */
  replyToEventId?: string | null;
  /** Affordance prior: correct-this box → correction, drop zone → material. */
  intentHint?: Intent;
  sensitivity?: "private" | "public";
}

export interface IngestResult {
  eventId: string;
  intent: Intent;
  intentConfident: boolean;
  transcript?: string;
  hotNote?: { id: string; note: string } | null;
  ack: string;
  /** true → the adapter should route this to the persona runtime as a normal turn */
  chat: boolean;
}

async function transcribeAudio(audioPath: string): Promise<string> {
  const { getTranscriber } = await import("@/lib/transcriber");
  return (await getTranscriber().transcribe(audioPath)).text.trim();
}

export async function ingestInbound(item: InboundItem): Promise<IngestResult> {
  // 1. Transcribe audio first (spec: transcribe before classification), tag spoken.
  let text = item.text ?? null;
  let register: string | null = item.kind === "audio" ? "spoken" : item.kind === "text" ? "written" : null;
  if (item.kind === "audio" && item.audioPath) {
    text = await transcribeAudio(item.audioPath);
    register = "spoken";
  }

  // 2. Heuristic intent — mechanical, no LLM in the reply path.
  const replyToPersonaTurn = Boolean(item.replyToEventId);
  const h = heuristicIntent({
    kind: item.kind,
    text,
    audioDurationSec: item.audioDurationSec,
    replyToPersonaTurn,
    intentHint: item.intentHint,
  });

  // 3. Persist the raw event immediately.
  const event = await prisma.updateEvent.create({
    data: {
      personaId: item.personaId,
      channel: item.channel,
      conversationId: item.conversationId,
      kind: item.kind,
      rawText: text,
      audioPath: item.audioPath ?? null,
      filePath: item.filePath ?? null,
      filename: item.filename ?? null,
      register,
      intent: h.intent,
      intentSource: h.source,
      replyToEventId: item.replyToEventId ?? null,
      sensitivity: item.sensitivity ?? "private",
      status: h.intent === "chat" && h.confident ? "captured" : "queued",
    },
  });

  // 4. Hot note for confident corrections/meta — verbatim-trimmed instruction.
  //    (Feedback firewall: this text lands ONLY in HotNote/UpdateEvent, never
  //    in any vector table. Tier-2 distillation refines the note later.)
  let hotNote: { id: string; note: string } | null = null;
  if ((h.intent === "correction" || h.intent === "meta") && text) {
    hotNote = await writeHotNote(item.personaId, event.id, text);
  }

  // 5. Queue tier-2 work: distillation for non-chat, classification refinement
  //    for low-confidence chat (an LLM may upgrade it to correction/material).
  const needsWork = h.intent !== "chat" || !h.confident;
  if (needsWork) {
    await prisma.loopJob.create({
      data: {
        personaId: item.personaId,
        kind: h.intent === "chat" ? "classify" : h.intent,
        eventId: event.id,
      },
    });
    kickLoopQueue();
  }

  // 6. Acknowledge.
  let ack: string;
  switch (h.intent) {
    case "material":
      ack =
        item.kind === "file"
          ? `Got ${item.filename ?? "the file"} — extracting and indexing now; it should be retrievable in a few minutes.`
          : `Got it — a ${Math.round((item.audioDurationSec ?? 0) / 60) || "few"}-minute account. Transcribed; distilling into memory now, retrievable in a few minutes.`;
      break;
    case "correction":
      ack = "Noted — applying that from the next reply onward; the deeper memory update runs in the background.";
      break;
    case "meta":
      ack = "Understood — that rule applies from the next reply onward.";
      break;
    default:
      ack = "";
  }

  return {
    eventId: event.id,
    intent: h.intent,
    intentConfident: h.confident,
    transcript: item.kind === "audio" ? (text ?? undefined) : undefined,
    hotNote,
    ack,
    chat: h.intent === "chat",
  };
}

/** Record what a persona turn retrieved, so corrections can find the culprit chunk. */
export async function recordPersonaTurn(opts: {
  personaId: string;
  channel: "playground" | "telegram";
  conversationId: string;
  replyText: string;
  retrievalLog: { props: string[]; episodic: string[] };
  inReplyToEventId?: string | null;
}): Promise<string> {
  const e = await prisma.updateEvent.create({
    data: {
      personaId: opts.personaId,
      channel: opts.channel,
      conversationId: opts.conversationId,
      kind: "text",
      rawText: opts.replyText,
      register: "written",
      intent: "chat",
      intentSource: "persona_turn",
      replyToEventId: opts.inReplyToEventId ?? null,
      retrievalLog: opts.retrievalLog,
      status: "none_needed",
    },
  });
  return e.id;
}
