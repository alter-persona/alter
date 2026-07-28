import type { HumanMessage } from "../types";

export interface MechanicalStats {
  conversationsAnalyzed: number;
  messagesAnalyzed: number;
  dateRange: { from: string | null; to: string | null };
  medianWords: number;
  meanWords: number;
  listVsProseRatio: number; // fraction of lines that are list items
  topPhrases: { phrase: string; count: number }[];
}

const STOPWORDS = new Set(
  "the a an and or but if of to in on for with at by from as is are was were be been being it this that these those i you he she we they my your our their me him her us them do does did have has had will would can could should just so than then there here what which who when how not no yes it's i'm don't can't".split(
    " "
  )
);

function words(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, " ").split(/\s+/).filter(Boolean);
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** All mechanical profile fields, computed deterministically in code. */
export function computeMechanical(messages: HumanMessage[]): MechanicalStats {
  const convIds = new Set(messages.map((m) => m.conversationId));
  const dates = messages.map((m) => m.date).filter((d): d is string => Boolean(d)).sort();
  const wordCounts = messages.map((m) => words(m.text).length);

  let listLines = 0;
  let totalLines = 0;
  for (const m of messages) {
    for (const line of m.text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      totalLines++;
      if (/^([-*•]|\d+[.)])\s/.test(t)) listLines++;
    }
  }

  // Top recurring 3-grams by frequency, skipping stopword-only phrases.
  const phraseCounts = new Map<string, number>();
  for (const m of messages) {
    const w = words(m.text);
    const seenInMsg = new Set<string>(); // count once per message
    for (let i = 0; i <= w.length - 3; i++) {
      const gram = w.slice(i, i + 3);
      if (gram.every((x) => STOPWORDS.has(x))) continue;
      const phrase = gram.join(" ");
      if (seenInMsg.has(phrase)) continue;
      seenInMsg.add(phrase);
      phraseCounts.set(phrase, (phraseCounts.get(phrase) ?? 0) + 1);
    }
  }
  const topPhrases = [...phraseCounts.entries()]
    .filter(([, c]) => c >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([phrase, count]) => ({ phrase, count }));

  const meanWords = wordCounts.length
    ? Math.round(wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length)
    : 0;

  return {
    conversationsAnalyzed: convIds.size,
    messagesAnalyzed: messages.length,
    dateRange: {
      from: dates[0]?.slice(0, 10) ?? null,
      to: dates[dates.length - 1]?.slice(0, 10) ?? null,
    },
    medianWords: median(wordCounts),
    meanWords,
    listVsProseRatio: totalLines ? Number((listLines / totalLines).toFixed(3)) : 0,
    topPhrases,
  };
}
