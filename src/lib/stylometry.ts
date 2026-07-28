import { prisma } from "./db";

/**
 * Per-persona stylometry: word/phrase frequency tables, sentence-length
 * distribution, list-vs-prose ratio, and distinctive n-grams scored against a
 * general-English baseline (so we surface what is characteristic, not what is
 * common). Updated incrementally by every ingest job's style half; only the
 * person's own text feeds it.
 */

// Zipf-style baseline: P(rank r) ≈ 0.07 / r over the ~300 most common English
// words. Words outside the table get a floor probability, which makes rare
// vocabulary score as distinctive.
const COMMON_ORDER = (
  "the be to of and a in that have i it for not on with he as you do at this but his by from they we say her she or an will my one all would there their what so up out if about who get which go me when make can like time no just him know take people into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most us is are was were been has had did said get got make made go went gone see saw seen know knew known think thought take took taken come came give gave given find found tell told become became show showed left right really still never too very much many lot bit thing things something anything nothing everything someone anyone everyone person life world day time year week home house school family friend friends work job money part place case point government company number group problem fact hand eye woman man child children area story month night water room mother father question business issue side kind head far own both while during before after between under again once here where why yes no maybe okay ok well actually basically definitely probably little big small large great high low long short old young early late important different same real sure true"
).split(/\s+/);
const BASELINE: Map<string, number> = new Map();
{
  let rank = 1;
  for (const w of COMMON_ORDER) {
    if (!BASELINE.has(w)) {
      BASELINE.set(w, 0.07 / rank);
      rank++;
    }
  }
}
const BASELINE_FLOOR = 3e-6;

function baselineProb(word: string): number {
  return BASELINE.get(word) ?? BASELINE_FLOOR;
}

export interface TextAnalysis {
  words: number;
  sentences: number;
  lines: number;
  listLines: number;
  wordFreq: Record<string, number>;
  phraseFreq: Record<string, number>;
  sentenceLenHist: Record<string, number>;
}

const SENTENCE_BUCKETS = [5, 10, 15, 20, 30, 40, 60, 100];

function bucketFor(len: number): string {
  for (const b of SENTENCE_BUCKETS) if (len <= b) return `<=${b}`;
  return ">100";
}

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, " ").split(/\s+/).filter(Boolean);
}

export function analyzeText(text: string): TextAnalysis {
  const a: TextAnalysis = {
    words: 0,
    sentences: 0,
    lines: 0,
    listLines: 0,
    wordFreq: {},
    phraseFreq: {},
    sentenceLenHist: {},
  };

  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    a.lines++;
    if (/^([-*•]|\d+[.)])\s/.test(t)) a.listLines++;
  }

  const sentences = text.match(/[^.!?\n]+[.!?]+/g) ?? [text];
  for (const s of sentences) {
    const len = tokenize(s).length;
    if (len === 0) continue;
    a.sentences++;
    a.sentenceLenHist[bucketFor(len)] = (a.sentenceLenHist[bucketFor(len)] ?? 0) + 1;
  }

  const words = tokenize(text);
  a.words = words.length;
  for (const w of words) a.wordFreq[w] = (a.wordFreq[w] ?? 0) + 1;
  for (let n = 2; n <= 3; n++) {
    for (let i = 0; i <= words.length - n; i++) {
      const gram = words.slice(i, i + n).join(" ");
      a.phraseFreq[gram] = (a.phraseFreq[gram] ?? 0) + 1;
    }
  }
  return a;
}

function mergeCounts(
  into: Record<string, number>,
  from: Record<string, number>,
  cap: number
): Record<string, number> {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
  const entries = Object.entries(into);
  if (entries.length <= cap) return into;
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, cap));
}

export interface DistinctiveEntry {
  ngram: string;
  count: number;
  score: number;
}

/** Log-likelihood ratio of persona frequency vs the general-English baseline. */
export function computeDistinctive(
  wordFreq: Record<string, number>,
  phraseFreq: Record<string, number>,
  totalWords: number
): DistinctiveEntry[] {
  if (totalWords === 0) return [];
  const out: DistinctiveEntry[] = [];

  for (const [w, c] of Object.entries(wordFreq)) {
    if (c < 5 || w.length < 3) continue;
    const score = Math.log2(c / totalWords / baselineProb(w));
    if (score > 1) out.push({ ngram: w, count: c, score: Number(score.toFixed(2)) });
  }
  for (const [p, c] of Object.entries(phraseFreq)) {
    if (c < 4) continue;
    const parts = p.split(" ");
    // Phrase baseline: product of word baselines, damped so common-word
    // phrases don't all surface.
    const base = parts.reduce((acc, w) => acc * baselineProb(w), 1) ** (1 / parts.length);
    const score = Math.log2(c / totalWords / base) - 2;
    if (score > 1) out.push({ ngram: p, count: c, score: Number(score.toFixed(2)) });
  }

  return out.sort((a, b) => b.score * Math.log(1 + b.count) - a.score * Math.log(1 + a.count)).slice(0, 60);
}

/** Merge one text's analysis into the persona's persistent stylometry record. */
export async function updateStylometry(personaId: string, text: string): Promise<void> {
  const a = analyzeText(text);
  if (a.words === 0) return;

  const existing = await prisma.stylometryRecord.findUnique({ where: { personaId } });
  const wordFreq = mergeCounts(
    (existing?.wordFreq as Record<string, number>) ?? {},
    a.wordFreq,
    8000
  );
  const phraseFreq = mergeCounts(
    (existing?.phraseFreq as Record<string, number>) ?? {},
    a.phraseFreq,
    8000
  );
  const sentenceLenHist = mergeCounts(
    (existing?.sentenceLenHist as Record<string, number>) ?? {},
    a.sentenceLenHist,
    50
  );
  const totalWords = (existing?.totalWords ?? 0) + a.words;
  const distinctive = computeDistinctive(wordFreq, phraseFreq, totalWords);

  await prisma.stylometryRecord.upsert({
    where: { personaId },
    create: {
      personaId,
      totalWords,
      totalSentences: a.sentences,
      totalLines: a.lines,
      listLines: a.listLines,
      wordFreq,
      phraseFreq,
      sentenceLenHist,
      distinctive: distinctive as unknown as object,
    },
    update: {
      totalWords,
      totalSentences: (existing?.totalSentences ?? 0) + a.sentences,
      totalLines: (existing?.totalLines ?? 0) + a.lines,
      listLines: (existing?.listLines ?? 0) + a.listLines,
      wordFreq,
      phraseFreq,
      sentenceLenHist,
      distinctive: distinctive as unknown as object,
    },
  });
}
