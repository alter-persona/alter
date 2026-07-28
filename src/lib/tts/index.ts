import { elevenLabsTts } from "./elevenlabs";
import { qwen3TtsMlx } from "./qwen3ttsMlx";

/**
 * TTS provider interface, mirroring the transcriber pattern. The persona
 * registry's voice binding selects the provider:
 *   "elevenlabs:<voice_id>"        hosted clone (current fallback)
 *   "qwen3tts-mlx:<adapter_path>"  local LoRA fine-tune served via mlx-audio
 *   "f5:<ref>"                     legacy zero-shot local clone
 */

export interface TtsProvider {
  name: string;
  /** Synthesize text to audio; returns the audio bytes and their mime type. */
  synthesize(text: string, voiceRef: string): Promise<{ audio: Buffer; mime: string; rtf?: number }>;
}

export interface VoiceBinding {
  provider: "none" | "elevenlabs" | "qwen3tts-mlx" | "f5";
  voiceRef: string;
}

export function parseVoiceBinding(voiceId: string | null | undefined): VoiceBinding | null {
  // Voice output is an optional add-on, never the default: no binding = none.
  if (!voiceId) return { provider: "none", voiceRef: "" };
  if (voiceId === "none") return { provider: "none", voiceRef: "" };
  const idx = voiceId.indexOf(":");
  if (idx <= 0) return null;
  const provider = voiceId.slice(0, idx);
  const voiceRef = voiceId.slice(idx + 1);
  if (provider === "elevenlabs" || provider === "qwen3tts-mlx" || provider === "f5") {
    return { provider, voiceRef };
  }
  return null;
}

const noneTts: TtsProvider = {
  name: "none",
  async synthesize(): Promise<never> {
    throw new Error("voice output disabled (provider: none)");
  },
};

export function getTtsProvider(binding: VoiceBinding): TtsProvider {
  switch (binding.provider) {
    case "none":
      return noneTts;
    case "elevenlabs":
      return elevenLabsTts();
    case "qwen3tts-mlx":
      return qwen3TtsMlx();
    case "f5":
      // Legacy zero-shot path is only used by voice/talk.sh; API callers fall
      // back to elevenlabs until a local binding exists.
      return elevenLabsTts();
  }
}

/**
 * Delivery-tag policy per provider. ElevenLabs v3 understands bracketed
 * audio tags ([pause], [breathes], [slows down]); the local Qwen3-TTS model
 * does not — strip them cleanly rather than speaking them aloud.
 */
const EL_SUPPORTED_TAGS = new Set(["pause", "breathes", "slows down", "sighs", "laughs"]);

export function stripUnsupportedTags(text: string, provider: VoiceBinding["provider"]): string {
  return text
    .replace(/\[([^\]]{1,30})\]/g, (whole, tag: string) => {
      const t = tag.trim().toLowerCase();
      if (provider === "elevenlabs" && EL_SUPPORTED_TAGS.has(t)) return whole;
      return " ";
    })
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
