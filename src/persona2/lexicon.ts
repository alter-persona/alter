/**
 * Shared lexicons for style work. Function words and discourse markers carry
 * authorship (Burrows's Delta); content words don't. Rates are measured per
 * 1,000 words against a general-English baseline so we keep what is
 * distinctive rather than what is common.
 */

export const FUNCTION_WORDS: string[] = (
  "the of and a to in that it is was i for on you he be with as by at have are this not but had his they from she which or we an there her were one all your what so if their who been would when will no more out do about up them then some me him time my could than into now only its also these may other new any"
).split(" ");

export const DISCOURSE_MARKERS: string[] = [
  "well", "so", "anyway", "actually", "basically", "honestly", "obviously",
  "essentially", "literally", "frankly", "look", "right", "okay", "now",
  "then", "though", "however", "therefore", "because", "but", "and",
  "you know", "i mean", "i think", "i guess", "i suppose", "to be honest",
  "kind of", "sort of", "at the end of the day", "the thing is",
];

export const FILLERS_SPOKEN: string[] = [
  "um", "uh", "erm", "you know", "like", "so", "i mean", "kind of", "sort of",
  "just", "really", "yeah",
];

export const HEDGES: string[] = [
  "maybe", "perhaps", "probably", "possibly", "i think", "i guess",
  "i suppose", "kind of", "sort of", "a bit", "a little", "roughly",
  "more or less", "not sure", "i don't know",
];

export const INTENSIFIERS: string[] = [
  "really", "very", "definitely", "absolutely", "completely", "totally",
  "genuinely", "massively", "hugely", "seriously", "honestly", "literally",
];

/** Approximate general-English rates per 1,000 words for baseline comparison.
 * Derived from standard frequency rankings (Zipf shape, ~0.07/rank). Words
 * absent from the table get RATE_FLOOR. */
const BASELINE_ORDER = FUNCTION_WORDS;
export const BASELINE_RATE_PER_1K: Map<string, number> = new Map();
BASELINE_ORDER.forEach((w, i) => {
  if (!BASELINE_RATE_PER_1K.has(w)) {
    BASELINE_RATE_PER_1K.set(w, (0.07 / (i + 1)) * 1000);
  }
});
export const RATE_FLOOR_PER_1K = 0.05;

export function baselineRate(word: string): number {
  return BASELINE_RATE_PER_1K.get(word) ?? RATE_FLOOR_PER_1K;
}

export function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, " ").split(/\s+/).filter(Boolean);
}

/** Count occurrences of a (possibly multi-word) term per 1,000 words. */
export function ratePer1k(tokens: string[], term: string): number {
  if (tokens.length === 0) return 0;
  const parts = term.split(" ");
  let count = 0;
  if (parts.length === 1) {
    for (const t of tokens) if (t === term) count++;
  } else {
    for (let i = 0; i <= tokens.length - parts.length; i++) {
      if (parts.every((p, j) => tokens[i + j] === p)) count++;
    }
  }
  return (count / tokens.length) * 1000;
}
