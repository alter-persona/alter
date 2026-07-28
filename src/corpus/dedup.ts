import { normalizeForHash } from "./hash";
import type { CorpusItem } from "./types";

/**
 * Near-duplicate removal. Exact duplicates (after whitespace/case
 * normalization) are dropped first; then word-set Jaccard similarity catches
 * near-identical items — at a high threshold (default 0.88) two texts must
 * share almost all their vocabulary, which flags one-word edits and re-pastes
 * while unrelated texts score near zero. Comparison is scoped within each
 * source type and banded by length so the pairwise pass stays fast.
 */

function shingles(text: string): Set<string> {
  return new Set(
    normalizeForHash(text).replace(/[^\p{L}\p{N} ]/gu, "").split(" ").filter(Boolean)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const s of small) if (large.has(s)) inter++;
  return inter / (a.size + b.size - inter);
}

export function dedupe(
  items: CorpusItem[],
  threshold: number
): { kept: CorpusItem[]; dropped: number } {
  const kept: CorpusItem[] = [];
  const seenExact = new Set<string>();
  const sigs: { sig: Set<string>; len: number; sourceType: string }[] = [];
  let dropped = 0;

  for (const item of items) {
    const norm = normalizeForHash(item.text);
    const exactKey = `${item.sourceType}|${norm}`;
    if (seenExact.has(exactKey)) {
      dropped++;
      continue;
    }

    const sig = shingles(item.text);
    const len = norm.length;
    let isDup = false;
    for (const prev of sigs) {
      if (prev.sourceType !== item.sourceType) continue;
      const ratio = len / prev.len;
      if (ratio < 0.6 || ratio > 1.67) continue; // length band prefilter
      if (jaccard(sig, prev.sig) >= threshold) {
        isDup = true;
        break;
      }
    }
    if (isDup) {
      dropped++;
      continue;
    }

    seenExact.add(exactKey);
    sigs.push({ sig, len, sourceType: item.sourceType });
    kept.push(item);
  }

  return { kept, dropped };
}
