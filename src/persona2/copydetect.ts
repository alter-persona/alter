import { tokenize } from "./lexicon";

/**
 * Copy-rate measurement: the direct measure of parroting. For a generated
 * reply, find the longest verbatim word run shared with a source set, and
 * flag any reply containing a run of >= 8 words.
 */

export const COPY_FLAG_NGRAM = 8;

export function ngramSet(texts: string[], n: number): Set<string> {
  const set = new Set<string>();
  for (const text of texts) {
    const toks = tokenize(text);
    for (let i = 0; i <= toks.length - n; i++) {
      set.add(toks.slice(i, i + n).join(" "));
    }
  }
  return set;
}

/** Longest run of consecutive words in `reply` that appears verbatim in the
 * source set (built at n=COPY_FLAG_NGRAM; longer runs are detected by
 * counting consecutive overlapping matched n-grams). */
export function longestSharedRun(reply: string, sourceNgrams: Set<string>): number {
  const toks = tokenize(reply);
  const n = COPY_FLAG_NGRAM;
  if (toks.length < n) return 0;
  let longest = 0;
  let streak = 0; // consecutive matching n-gram windows
  for (let i = 0; i <= toks.length - n; i++) {
    if (sourceNgrams.has(toks.slice(i, i + n).join(" "))) {
      streak++;
      longest = Math.max(longest, n + streak - 1);
    } else {
      streak = 0;
    }
  }
  return longest;
}

export interface CopyCheck {
  longestRun: number;
  flagged: boolean;
}

export function checkCopy(reply: string, sourceNgrams: Set<string>): CopyCheck {
  const longestRun = longestSharedRun(reply, sourceNgrams);
  return { longestRun, flagged: longestRun >= COPY_FLAG_NGRAM };
}
