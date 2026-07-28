export interface TranscriptionResult {
  text: string;
  /** Engine identifier recorded in Response.transcriptSource */
  engine: string;
}

export interface Transcriber {
  name: string;
  transcribe(audioPath: string): Promise<TranscriptionResult>;
}

import { whisperCppTranscriber } from "./whisperCpp";
import { openaiCompatibleTranscriber } from "./openaiCompatible";

export function getTranscriber(): Transcriber {
  const kind = (process.env.TRANSCRIBER ?? "whisper_cpp").trim();
  switch (kind) {
    case "openai_compatible":
      return openaiCompatibleTranscriber();
    case "whisper_cpp":
      return whisperCppTranscriber();
    default:
      throw new Error(
        `Unknown TRANSCRIBER "${kind}" — expected "whisper_cpp" or "openai_compatible"`
      );
  }
}
