import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TtsProvider } from "./index";

const execFileP = promisify(execFile);

/**
 * Local Qwen3-TTS via mlx-audio (see VERSIONS). voiceRef is the per-persona
 * artifact path: either a merged MLX model directory (plan B, expected) or a
 * LoRA adapter path if mlx-audio grows TTS adapter loading (plan A).
 *
 * Measures real-time factor per reply and warns above 0.8 — the adoption
 * gate for keeping this on the runtime path.
 *
 * STATUS: implemented to the pinned mlx-audio CLI contract; exercised for
 * real only once a trained artifact exists (Stage 2/3).
 */
export function qwen3TtsMlx(): TtsProvider {
  return {
    name: "qwen3tts-mlx",
    async synthesize(text: string, voiceRef: string) {
      const python = process.env.MLX_AUDIO_PYTHON ?? path.join(process.cwd(), ".venv-tts", "bin", "python");
      const outPrefix = path.join(os.tmpdir(), `q3tts-${Date.now()}`);
      const model = voiceRef; // merged model dir (or base model + adapter, plan A)
      const t0 = Date.now();
      await execFileP(
        python,
        [
          "-m", "mlx_audio.tts.generate",
          "--model", model,
          "--text", text,
          "--output", outPrefix,
        ],
        { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }
      );
      // mlx-audio writes <prefix>.wav (or _000.wav depending on version) — take the first match.
      const dir = path.dirname(outPrefix);
      const base = path.basename(outPrefix);
      const files = (await fs.readdir(dir)).filter((f) => f.startsWith(base) && f.endsWith(".wav"));
      if (files.length === 0) throw new Error("qwen3tts-mlx produced no audio file");
      const wavPath = path.join(dir, files[0]);
      const audio = await fs.readFile(wavPath);
      await fs.unlink(wavPath).catch(() => {});

      const wallSec = (Date.now() - t0) / 1000;
      // WAV duration from header assumption is fragile; estimate from size (24kHz 16-bit mono).
      const audioSec = Math.max(0.1, (audio.length - 44) / (24000 * 2));
      const rtf = wallSec / audioSec;
      if (rtf > 0.8) {
        console.warn(`[qwen3tts-mlx] RTF ${rtf.toFixed(2)} exceeds 0.8 — too slow for the runtime loop`);
      }
      return { audio, mime: "audio/wav", rtf };
    },
  };
}
