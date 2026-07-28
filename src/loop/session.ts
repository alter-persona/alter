import { prisma } from "@/lib/db";
import { loopConfig } from "./config";

/**
 * Short-term conversational memory (the SESSION layer) — distinct from
 * permanent memory (propositions/style, which only grow via the improvement
 * loop). A session is a rolling window over the conversation's event log:
 *
 *   - turns older than sessionRetentionHours fall out of the prompt (the
 *     "purge" — events are retained on disk for the loop and audit, they
 *     just stop shaping replies)
 *   - at most sessionMaxTurns turns are included
 *   - a session_reset marker (the /session reset command, or "new topic")
 *     is a hard boundary — nothing before it enters the prompt
 *
 * Permanent updates are explicit: corrections, uploads, and messages opening
 * with "remember this:" go through the loop into durable memory.
 */

export async function insertSessionReset(personaId: string, channel: string, conversationId: string): Promise<void> {
  await prisma.updateEvent.create({
    data: {
      personaId,
      channel,
      conversationId,
      kind: "session_reset",
      intent: "chat",
      intentSource: "marker",
      status: "none_needed",
    },
  });
}

export interface SessionInfo {
  turns: { role: "user" | "assistant"; content: string }[];
  turnCount: number;
  oldestAt: Date | null;
  retentionHours: number;
  maxTurns: number;
}

export async function loadSession(conversationId: string): Promise<SessionInfo> {
  const cfg = loopConfig();
  const cutoff = new Date(Date.now() - cfg.sessionRetentionHours * 3600 * 1000);

  // Hard boundary: the most recent session_reset marker, if any.
  const marker = await prisma.updateEvent.findFirst({
    where: { conversationId, kind: "session_reset" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const since = marker && marker.createdAt > cutoff ? marker.createdAt : cutoff;

  const rows = await prisma.updateEvent.findMany({
    where: {
      conversationId,
      rawText: { not: null },
      kind: { in: ["text", "audio"] },
      createdAt: { gt: since },
    },
    orderBy: { createdAt: "desc" },
    take: cfg.sessionMaxTurns,
  });
  const ordered = rows.reverse();
  return {
    turns: ordered.map((r) => ({
      role: (r.intentSource === "persona_turn" ? "assistant" : "user") as "user" | "assistant",
      content: (r.rawText ?? "").slice(0, 2000),
    })),
    turnCount: ordered.length,
    oldestAt: ordered[0]?.createdAt ?? null,
    retentionHours: cfg.sessionRetentionHours,
    maxTurns: cfg.sessionMaxTurns,
  };
}

export function renderSessionStatus(s: SessionInfo): string {
  const age = s.oldestAt ? `${Math.round((Date.now() - s.oldestAt.getTime()) / 3600000 * 10) / 10}h ago` : "—";
  return [
    `Session (short-term memory): ${s.turnCount}/${s.maxTurns} turns in window, oldest ${age}.`,
    `Turns older than ${s.retentionHours}h fall out automatically (config/improvement.json → sessionRetentionHours).`,
    `"/session reset" starts a clean thread now. Anything you want KEPT permanently: start with "remember this:" — or just correct me, corrections always stick.`,
  ].join("\n");
}
