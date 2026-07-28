import fs from "node:fs/promises";
import path from "node:path";
import type { Transcriber, TranscriptionResult } from "./index";

/**
 * OpenAI-compatible provider: POSTs the audio file to /v1/audio/transcriptions
 * on a URL you control (WHISPER_HTTP_URL). Intended for local servers such as
 * faster-whisper / speaches or any future local audio-capable model exposing
 * the same contract. Keep the URL pointed at localhost to preserve the
 * no-third-party-calls guarantee.
 */
export function openaiCompatibleTranscriber(): Transcriber {
  return {
    name: "openai_compatible",
    async transcribe(audioPath: string): Promise<TranscriptionResult> {
      const url = process.env.WHISPER_HTTP_URL;
      if (!url) throw new Error("WHISPER_HTTP_URL is not set");
      const model = process.env.WHISPER_HTTP_MODEL ?? "whisper-1";

      const buf = await fs.readFile(audioPath);
      const filename = path.basename(audioPath);
      const contentType = filename.endsWith(".m4a") ? "audio/mp4" : "audio/webm";

      const form = new FormData();
      form.append("file", new File([new Uint8Array(buf)], filename, { type: contentType }));
      form.append("model", model);
      form.append("response_format", "json");

      const res = await fetch(url, { method: "POST", body: form });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Transcription endpoint returned ${res.status}: ${body.slice(0, 500)}`);
      }
      const json = (await res.json()) as { text?: string };
      if (typeof json.text !== "string") {
        throw new Error("Transcription endpoint response missing 'text' field");
      }
      return { text: json.text.trim(), engine: `openai_compatible:${model}` };
    },
  };
}
