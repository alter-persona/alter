import type { LlmProvider } from "./types";

export function openaiCompatibleProvider(modelOverride?: string): LlmProvider {
  const url = process.env.CORPUS_LLM_URL;
  const model = modelOverride ?? process.env.CORPUS_LLM_MODEL;
  if (!url || !model) {
    throw new Error("openai_compatible provider needs CORPUS_LLM_URL and CORPUS_LLM_MODEL");
  }
  const key = process.env.CORPUS_LLM_API_KEY;

  // Ollama endpoints get the NATIVE /api/chat with think:false (project
  // convention): via the OpenAI-compat path, qwen-family models default to
  // think mode and burn minutes of reasoning tokens per call — enough to hit
  // Ollama's 5-minute 500 and fail every batch.
  const isOllama = /:11434\b/.test(url);
  const base = url.replace(/\/$/, "");

  return {
    name: "openai_compatible",
    model,
    async complete(system: string, user: string): Promise<string> {
      const target = isOllama ? `${base.replace(/\/v1$/, "")}/api/chat` : `${base}/chat/completions`;
      const body = isOllama
        ? {
            model,
            stream: false,
            think: false,
            options: { temperature: 0.3 },
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
          }
        : {
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            temperature: 0.3,
          };
      const res = await fetch(target, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number(process.env.CORPUS_LLM_TIMEOUT_MS ?? 420_000)),
      });
      if (!res.ok) {
        throw new Error(`LLM endpoint ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      if (isOllama) {
        const json = (await res.json()) as { message?: { content?: string } };
        const content = json.message?.content;
        if (typeof content !== "string") throw new Error("LLM response missing message content");
        return content;
      }
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("LLM response missing message content");
      return content;
    },
  };
}
