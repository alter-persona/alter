import path from "node:path";

const ROOT = process.env.CORPUS_ROOT ?? process.cwd();

export const config = {
  root: ROOT,
  sourcesDir: path.join(ROOT, "sources"),
  interviewDir: path.join(ROOT, "sources", "interview"),
  chatExportDir: path.join(ROOT, "sources", "chat-export"),
  workDir: path.join(ROOT, "sources", "work"),
  corpusDir: path.join(ROOT, "corpus"),
  cacheDir: path.join(ROOT, "corpus", ".cache"),
  holdoutDir: path.join(ROOT, "holdout"),

  /** Human chat messages below this word count are dropped (no style signal). */
  minWords: Number(process.env.CORPUS_MIN_WORDS ?? 15),
  /** Chunking bounds in tokens; items at or under maxTokens stay whole. */
  chunkMaxTokens: Number(process.env.CORPUS_CHUNK_MAX_TOKENS ?? 400),
  chunkTargetTokens: Number(process.env.CORPUS_CHUNK_TARGET_TOKENS ?? 300),
  /** Jaccard similarity at or above this marks a near-duplicate. */
  dedupThreshold: Number(process.env.CORPUS_DEDUP_THRESHOLD ?? 0.88),
};

export type SourceKey = "interview" | "chat-export" | "work";
export const ALL_SOURCES: SourceKey[] = ["interview", "chat-export", "work"];
