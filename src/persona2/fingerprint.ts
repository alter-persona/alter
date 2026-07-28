import { prisma } from "@/lib/db";
import {
  DISCOURSE_MARKERS,
  FILLERS_SPOKEN,
  FUNCTION_WORDS,
  HEDGES,
  INTENSIFIERS,
  baselineRate,
  ratePer1k,
  tokenize,
} from "./lexicon";
import type { DistinctiveEntry } from "@/lib/stylometry";

/**
 * Style fingerprint, computed from the person's OWN text only, in two
 * variants: spoken (interview transcripts) and written (chat messages, work
 * writing). Function words and discourse markers measured as rates per 1,000
 * words against a general-English baseline — we keep what is distinctive.
 * The fingerprint lives in the skill; style never enters the vector store.
 */

export interface MarkerRate {
  term: string;
  per1k: number;
  baselinePer1k: number;
  ratio: number;
}

export interface ModeFingerprint {
  mode: "spoken" | "written";
  totalWords: number;
  markerRates: MarkerRate[]; // distinctive function words + discourse markers
  fillerRates: MarkerRate[]; // spoken mode; measured, to be matched not maximized
  hedges: MarkerRate[];
  intensifiers: MarkerRate[];
  sentence: { meanWords: number; stdWords: number };
  clauseOpeners: { opener: string; per1k: number }[];
  punctuation: {
    commasPerSentence: number;
    dashesPer1k: number;
    exclamationsPer1k: number;
    questionsPer1k: number;
  };
  listVsProseRatio: number;
  collocations: string[];
}

function sentenceStats(text: string): { meanWords: number; stdWords: number; sentences: string[] } {
  const sentences = (text.match(/[^.!?\n]+[.!?]*/g) ?? []).map((s) => s.trim()).filter(Boolean);
  const lens = sentences.map((s) => tokenize(s).length).filter((n) => n > 0);
  const mean = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  const variance = lens.length
    ? lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length
    : 0;
  return { meanWords: Number(mean.toFixed(1)), stdWords: Number(Math.sqrt(variance).toFixed(1)), sentences };
}

function rates(tokens: string[], terms: string[]): MarkerRate[] {
  return terms
    .map((term) => {
      const per1k = ratePer1k(tokens, term);
      const base = term.includes(" ") ? 0.15 : baselineRate(term);
      return { term, per1k: Number(per1k.toFixed(2)), baselinePer1k: Number(base.toFixed(2)), ratio: Number((per1k / base).toFixed(2)) };
    })
    .filter((r) => r.per1k > 0);
}

export function computeModeFingerprint(
  mode: "spoken" | "written",
  text: string,
  listVsProseRatio: number,
  collocations: string[]
): ModeFingerprint {
  const tokens = tokenize(text);
  const { meanWords, stdWords, sentences } = sentenceStats(text);

  // Distinctive function words + markers: keep those whose usage departs from
  // baseline (ratio >= 1.5 or <= 0.5), ranked by |log ratio| * usage.
  const all = rates(tokens, [...new Set([...FUNCTION_WORDS, ...DISCOURSE_MARKERS])]);
  const markerRates = all
    .filter((r) => r.ratio >= 1.5 || r.ratio <= 0.5)
    .sort((a, b) => Math.abs(Math.log(b.ratio + 1e-9)) * b.per1k - Math.abs(Math.log(a.ratio + 1e-9)) * a.per1k)
    .slice(0, 25);

  const openersCount = new Map<string, number>();
  for (const s of sentences) {
    const t = tokenize(s);
    if (t.length < 3) continue;
    const opener = t.slice(0, 2).join(" ");
    openersCount.set(opener, (openersCount.get(opener) ?? 0) + 1);
  }
  const clauseOpeners = [...openersCount.entries()]
    .filter(([, c]) => c >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([opener, c]) => ({ opener, per1k: Number(((c / (tokens.length || 1)) * 1000).toFixed(2)) }));

  const nSent = sentences.length || 1;
  const punctuation = {
    commasPerSentence: Number(((text.match(/,/g)?.length ?? 0) / nSent).toFixed(2)),
    dashesPer1k: Number((((text.match(/[—–-]{1,2}\s/g)?.length ?? 0) / (tokens.length || 1)) * 1000).toFixed(2)),
    exclamationsPer1k: Number((((text.match(/!/g)?.length ?? 0) / (tokens.length || 1)) * 1000).toFixed(2)),
    questionsPer1k: Number((((text.match(/\?/g)?.length ?? 0) / (tokens.length || 1)) * 1000).toFixed(2)),
  };

  return {
    mode,
    totalWords: tokens.length,
    markerRates,
    fillerRates: mode === "spoken" ? rates(tokens, FILLERS_SPOKEN) : [],
    hedges: rates(tokens, HEDGES).slice(0, 10),
    intensifiers: rates(tokens, INTENSIFIERS).slice(0, 10),
    sentence: { meanWords, stdWords },
    clauseOpeners,
    punctuation,
    listVsProseRatio,
    collocations: collocations.slice(0, 15),
  };
}

/** Pull the person's own text by mode from the episodic store. */
export async function ownTextByMode(personaId: string): Promise<{ spoken: string; written: string }> {
  const select = { sourceType: true, text: true } as const;
  const [priv, pub] = await Promise.all([
    prisma.vectorChunkPrivate.findMany({ where: { personaId }, select }),
    prisma.vectorChunkPublic.findMany({ where: { personaId }, select }),
  ]);
  const rows = [...priv, ...pub];
  const spoken = rows.filter((r) => r.sourceType === "interview").map((r) => r.text).join("\n\n");
  // project_doc is excluded: partially assistant-authored, not the person's voice.
  const written = rows
    .filter((r) => r.sourceType === "chat_export" || r.sourceType === "work_file")
    .map((r) => r.text)
    .join("\n\n");
  return { spoken, written };
}

export async function buildFingerprint(personaId: string): Promise<{ spoken: ModeFingerprint; written: ModeFingerprint }> {
  const { spoken, written } = await ownTextByMode(personaId);
  const style = await prisma.stylometryRecord.findUnique({ where: { personaId } });
  const listRatio = style && style.totalLines > 0 ? style.listLines / style.totalLines : 0;
  const collocations = ((style?.distinctive as unknown as DistinctiveEntry[]) ?? [])
    .filter((e) => e.ngram.split(" ").length >= 2)
    .map((e) => e.ngram);

  const result = {
    spoken: computeModeFingerprint("spoken", spoken, 0, collocations),
    written: computeModeFingerprint("written", written, listRatio, collocations),
  };
  await prisma.styleFingerprint.upsert({
    where: { personaId },
    create: { personaId, spoken: result.spoken as unknown as object, written: result.written as unknown as object },
    update: { spoken: result.spoken as unknown as object, written: result.written as unknown as object },
  });
  return result;
}
