import { prisma } from "@/lib/db";
import { loopConfig } from "./config";

/**
 * Gap detection and solicitation. Two triggers:
 *   1. Weak retrieval on a personal topic → CoverageGap counter; enough weak
 *      hits earn one short invitation appended to a reply.
 *   2. Open reconciliation cases (the stronger signal) — handled by the
 *      runtime asking its one in-chat clarification.
 * Rate limits: one invitation per conversation; never repeat a topic the
 * person ignored twice.
 */

const PERSONAL_TOPIC_RES =
  /\b(family|childhood|school|health|friend|parent|brother|sister|hobby|hobbies|music|sport|travel|holiday|pet|relationship|wedding|birthday|home|house|neighborhood|faith|religion|politics|money|retirement)\b/i;

function topicOf(query: string): string {
  const words = query
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !["what", "would", "about", "your", "think", "tell", "have", "does", "with"].includes(w));
  return words.slice(0, 3).join(" ") || "general";
}

export function isPersonalTopic(query: string): boolean {
  return PERSONAL_TOPIC_RES.test(query);
}

/** Log a weak retrieval; returns the gap row when it crossed the invite bar. */
export async function logWeakRetrieval(
  personaId: string,
  query: string,
  bestDistance: number | null
): Promise<{ topic: string; readyToInvite: boolean } | null> {
  const cfg = loopConfig();
  const weak = bestDistance === null || bestDistance > cfg.gapSimilarityThreshold;
  if (!weak || !isPersonalTopic(query)) return null;
  const topic = topicOf(query);
  const gap = await prisma.coverageGap.upsert({
    where: { personaId_topic: { personaId, topic } },
    create: { personaId, topic },
    update: { weakCount: { increment: 1 } },
  });
  const readyToInvite =
    gap.weakCount >= cfg.gapWeakCountForInvite && gap.ignoredCount < 2 && !recentlyInvited(gap.lastInvitedAt);
  return { topic, readyToInvite };
}

function recentlyInvited(at: Date | null): boolean {
  return Boolean(at && Date.now() - at.getTime() < 24 * 3600 * 1000);
}

export function invitationText(topic: string): string {
  return `\n\n(By the way — I have very little on ${topic}. If you drop a file or record a few minutes about it, I'll fold it in.)`;
}

export async function markInvited(personaId: string, topic: string): Promise<void> {
  await prisma.coverageGap.update({
    where: { personaId_topic: { personaId, topic } },
    data: { lastInvitedAt: new Date(), ignoredCount: { increment: 1 } },
  });
}

/** An answered invitation (material arrived on the topic) resets the ignore counter. */
export async function markAnswered(personaId: string, topicLike: string): Promise<void> {
  await prisma.coverageGap.updateMany({
    where: { personaId, topic: { contains: topicLike.split(" ")[0] ?? topicLike } },
    data: { ignoredCount: 0 },
  });
}
