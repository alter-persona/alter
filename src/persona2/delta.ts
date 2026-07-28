import { FUNCTION_WORDS, tokenize } from "./lexicon";

/**
 * Burrows's Delta on function-word profiles: the standard authorship
 * distance. Lower = closer in voice. The target band is calibrated from the
 * self-distance between two disjoint samples of the person's own writing;
 * generated text should land within 1.5x that self-distance.
 */

export function functionWordProfile(text: string): Map<string, number> {
  const toks = tokenize(text);
  const total = toks.length || 1;
  const counts = new Map<string, number>();
  for (const w of FUNCTION_WORDS) counts.set(w, 0);
  for (const t of toks) {
    if (counts.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const profile = new Map<string, number>();
  for (const [w, c] of counts) profile.set(w, (c / total) * 1000);
  return profile;
}

/** z-score standardization stats computed over a set of reference documents. */
export function profileStats(docs: string[]): { mean: Map<string, number>; std: Map<string, number> } {
  const profiles = docs.map(functionWordProfile);
  const mean = new Map<string, number>();
  const std = new Map<string, number>();
  for (const w of FUNCTION_WORDS) {
    const vals = profiles.map((p) => p.get(w) ?? 0);
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    const v = vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length;
    mean.set(w, m);
    std.set(w, Math.sqrt(v) || 1e-6);
  }
  return { mean, std };
}

export function burrowsDelta(
  textA: string,
  textB: string,
  stats: { mean: Map<string, number>; std: Map<string, number> }
): number {
  const pa = functionWordProfile(textA);
  const pb = functionWordProfile(textB);
  let sum = 0;
  for (const w of FUNCTION_WORDS) {
    const za = ((pa.get(w) ?? 0) - (stats.mean.get(w) ?? 0)) / (stats.std.get(w) ?? 1);
    const zb = ((pb.get(w) ?? 0) - (stats.mean.get(w) ?? 0)) / (stats.std.get(w) ?? 1);
    sum += Math.abs(za - zb);
  }
  return sum / FUNCTION_WORDS.length;
}

/** Self-distance: split own text into two disjoint halves (by alternating
 * documents) and measure Delta between them — the natural variation of the
 * person against themselves. */
export function selfDistance(ownDocs: string[]): { delta: number; stats: ReturnType<typeof profileStats> } {
  const a: string[] = [];
  const b: string[] = [];
  ownDocs.forEach((d, i) => (i % 2 === 0 ? a : b).push(d));
  const stats = profileStats(ownDocs);
  return { delta: burrowsDelta(a.join("\n"), b.join("\n"), stats), stats };
}
