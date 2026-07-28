export type SourceType = "interview" | "chat_export" | "project_doc" | "work_file";
export type Sensitivity = "private" | "public";

/** A normalized item before chunking. */
export interface CorpusItem {
  text: string;
  sourceType: SourceType;
  /** Category tag: interview section, "chat-message", "project-doc", or work manifest label. */
  label: string;
  domain: string | null;
  /** ISO date of authorship, or null when unknown. */
  date: string | null;
  sensitivity: Sensitivity;
  /** File or conversation reference — human-readable provenance. */
  origin: string;
}

/** One output line in corpus/private.jsonl or corpus/public.jsonl. */
export interface CorpusChunk {
  id: string;
  text: string;
  source_type: SourceType;
  label: string;
  domain: string | null;
  date: string | null;
  sensitivity: Sensitivity;
  origin: string;
}

export interface HoldoutEntry {
  questionId: string;
  orderIndex: number;
  section: string;
  question: string;
  answer: string | null;
  audioDurationSec: number | null;
}

/** A raw extracted human chat message, used by the profile builder. */
export interface HumanMessage {
  text: string;
  date: string | null;
  conversation: string;
  conversationId: string;
  project: string | null;
}

export interface SourceStats {
  itemsIn: number;
  itemsKept: number;
  chunks: number;
  privateChunks: number;
  publicChunks: number;
  redactions: Record<string, number>;
  shortDropped: number;
  dedupDropped: number;
  skippedFiles: { file: string; reason: string }[];
  dateMin: string | null;
  dateMax: string | null;
  notes: string[];
}

export interface RunReport {
  generatedAt: string;
  dryRun: boolean;
  sourcesRun: string[];
  perSource: Record<string, SourceStats>;
  interviewAudioMinutes: number | null;
  holdoutCount: number;
  totals: { items: number; chunks: number; private: number; public: number };
  profileGeneratedBy: string | null;
}

export class CorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorpusError";
  }
}
