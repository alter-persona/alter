import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Transcriber, TranscriptionResult } from "./index";

const execFileP = promisify(execFile);

/**
 * whisper.cpp provider. Converts the browser recording (webm/opus or mp4) to
 * 16 kHz mono WAV via ffmpeg, then runs the whisper-cli binary on it.
 * Everything runs locally.
 */
export function whisperCppTranscriber(): Transcriber {
  return {
    name: "whisper.cpp",
    async transcribe(audioPath: string): Promise<TranscriptionResult> {
      const cli = process.env.WHISPER_CLI_PATH;
      const model = process.env.WHISPER_MODEL_PATH;
      const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
      if (!cli) throw new Error("WHISPER_CLI_PATH is not set");
      if (!model) throw new Error("WHISPER_MODEL_PATH is not set");
      await fs.access(audioPath);

      const tmpBase = path.join(
        os.tmpdir(),
        `intake-tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      );
      const wavPath = `${tmpBase}.wav`;
      const outPrefix = `${tmpBase}-out`;

      try {
        await execFileP(
          ffmpeg,
          ["-hide_banner", "-loglevel", "error", "-y", "-i", audioPath, "-ar", "16000", "-ac", "1", wavPath],
          { maxBuffer: 16 * 1024 * 1024 }
        );

        await execFileP(
          cli,
          ["-m", model, "-f", wavPath, "-otxt", "-of", outPrefix, "-np"],
          { maxBuffer: 64 * 1024 * 1024 }
        );

        const text = (await fs.readFile(`${outPrefix}.txt`, "utf8")).trim();
        const modelName = path.basename(model).replace(/^ggml-/, "").replace(/\.bin$/, "");
        return { text, engine: `whisper.cpp:${modelName}` };
      } finally {
        await Promise.allSettled([
          fs.unlink(wavPath),
          fs.unlink(`${outPrefix}.txt`),
        ]);
      }
    },
  };
}
