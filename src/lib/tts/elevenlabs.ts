import type { TtsProvider } from "./index";

export function elevenLabsTts(): TtsProvider {
  return {
    name: "elevenlabs",
    async synthesize(text: string, voiceRef: string) {
      const key = process.env.ELEVENLABS_API_KEY;
      if (!key) throw new Error("ELEVENLABS_API_KEY not set");
      const model = process.env.ELEVENLABS_TTS_MODEL ?? "eleven_flash_v2_5";
      const t0 = Date.now();
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceRef}?output_format=mp3_44100_64`,
        {
          method: "POST",
          headers: { "xi-api-key": key, "Content-Type": "application/json" },
          body: JSON.stringify({ text, model_id: model }),
        }
      );
      if (!res.ok) throw new Error(`elevenlabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const audio = Buffer.from(await res.arrayBuffer());
      void t0;
      return { audio, mime: "audio/mpeg" };
    },
  };
}
