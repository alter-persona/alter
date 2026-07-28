export type QuestionType = "voice" | "likert";
export type TranscriptStatus = "pending" | "done" | "failed";

export interface QuestionDTO {
  id: string;
  orderIndex: number;
  section: string;
  type: QuestionType;
  promptText: string;
  oceanDomain: string | null;
  facet: string | null;
  reverseScored: boolean;
  isValidation: boolean;
}

export interface ResponseDTO {
  id: string;
  sessionId: string;
  questionId: string;
  type: QuestionType;
  audioPath: string | null;
  audioDurationSec: number | null;
  transcript: string | null;
  transcriptStatus: TranscriptStatus | null;
  transcriptSource: string | null;
  transcriptEditedByUser: boolean;
  likertValue: number | null;
  skipped: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SessionDTO {
  id: string;
  label: string;
  isTrial: boolean;
  status: "in_progress" | "complete";
  startedAt: string;
  completedAt: string | null;
}

export function isAnswered(r: ResponseDTO | undefined): boolean {
  return Boolean(r && !r.skipped && (r.audioPath !== null || r.likertValue !== null));
}
