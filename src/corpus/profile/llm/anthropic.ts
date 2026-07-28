import type { LlmProvider } from "./types";

export function anthropicProvider(modelOverride?: string): LlmProvider {
  const model = modelOverride ?? process.env.CORPUS_LLM_MODEL;
  const key = process.env.CORPUS_LLM_API_KEY;
  if (!model || !key) {
    throw new Error("anthropic provider needs CORPUS_LLM_MODEL and CORPUS_LLM_API_KEY");
  }
  const url = process.env.CORPUS_LLM_URL ?? "https://api.anthropic.com";

  return {
    name: "anthropic",
    model,
    async complete(system: string, user: string): Promise<string> {
      const res = await fetch(`${url.replace(/\/$/, "")}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          system,
          messages: [{ role: "user", content: user }],
        }),
      });
      if (!res.ok) {
        throw new Error(`Anthropic endpoint ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const json = (await res.json()) as { content?: { type: string; text?: string }[] };
      const text = json.content?.filter((b) => b.type === "text").map((b) => b.text).join("");
      if (!text) throw new Error("Anthropic response missing text content");
      return text;
    },
  };
}
