import { prisma } from "@/lib/db";

/**
 * Sealed-question firewall for the improvement loop. The eight validation
 * answers are holdout — they must never enter ANY ingestion path, including
 * material drops and corrections. Checked by content (normalized substring
 * both ways), not just by id, so a pasted transcript of a sealed answer is
 * caught too.
 */

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

let cache: { at: number; answers: string[] } | null = null;

export async function sealedAnswers(): Promise<string[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.answers;
  const rows = await prisma.response.findMany({
    where: { question: { isValidation: true }, transcript: { not: null } },
    select: { transcript: true },
  });
  const answers = rows
    .map((r) => norm(r.transcript ?? ""))
    .filter((t) => t.length >= 40);
  cache = { at: Date.now(), answers };
  return answers;
}

export function resetSealedCacheForTests(): void {
  cache = null;
}

/** True when the text IS or CONTAINS a sealed validation answer. */
export async function isSealedContent(text: string): Promise<boolean> {
  const t = norm(text);
  if (t.length < 40) return false;
  const answers = await sealedAnswers();
  return answers.some((a) => t.includes(a) || a.includes(t));
}
