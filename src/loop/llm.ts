import { loopConfig, type ModelRef } from "./config";

/**
 * LLM access for the improvement loop. Two tiers from config:
 *   classifierLlm()  — fast intent classification (local small model)
 *   improvementLlm() — distillation/reconciliation (frontier by default,
 *                      IMPROVEMENT_MODEL=local for the fully-offline path)
 * When frontier is selected but no ANTHROPIC_API_KEY exists, we degrade to
 * the local ref with a warning rather than failing the queue.
 * Tests inject a stub via setLoopLlmForTests().
 */

export type LoopLlm = (system: string, user: string) => Promise<string>;

let testStub: LoopLlm | null = null;
export function setLoopLlmForTests(fn: LoopLlm | null): void {
  testStub = fn;
}

function openaiCompatible(ref: ModelRef): LoopLlm {
  const base = (ref.url ?? "http://127.0.0.1:11434/v1").replace(/\/$/, "");
  // Ollama gets the native /api/chat with think:false (project convention) —
  // qwen-family models THINK by default on the OpenAI-compat path and can
  // burn minutes of reasoning tokens per call.
  const isOllama = /:11434\b/.test(base);
  return async (system, user) => {
    const target = isOllama ? `${base.replace(/\/v1$/, "")}/api/chat` : `${base}/chat/completions`;
    const messages = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    const body = isOllama
      ? { model: ref.model, stream: false, think: false, options: { temperature: 0.2 }, messages }
      : { model: ref.model, messages, temperature: 0.2 };
    const res = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(420_000),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
    if (isOllama) {
      const json = (await res.json()) as { message?: { content?: string } };
      const content = json.message?.content;
      if (typeof content !== "string") throw new Error("LLM response missing content");
      return content;
    }
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("LLM response missing content");
    return content;
  };
}

function anthropic(ref: ModelRef): LoopLlm {
  const key = process.env.ANTHROPIC_API_KEY!;
  return async (system, user) => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ref.model,
        max_tokens: 2000,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = json.content?.find((c) => c.type === "text")?.text;
    if (typeof text !== "string") throw new Error("anthropic response missing text");
    return text;
  };
}

function fromRef(ref: ModelRef): LoopLlm {
  return ref.provider === "anthropic" ? anthropic(ref) : openaiCompatible(ref);
}

export function classifierLlm(): LoopLlm {
  if (testStub) return testStub;
  return fromRef(loopConfig().classifierModel);
}

export function improvementLlm(): LoopLlm {
  if (testStub) return testStub;
  const cfg = loopConfig().improvementModel;
  if (cfg.mode === "frontier") {
    if (process.env.ANTHROPIC_API_KEY) return fromRef(cfg.frontier);
    console.warn("[loop] frontier improvement model selected but no ANTHROPIC_API_KEY — using local");
  }
  return fromRef(cfg.local);
}

/** Strip markdown fences and parse strict-JSON model output. */
export function parseJson<T>(raw: string): T {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  // Some local models prepend prose; recover the outermost object.
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const body = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  return JSON.parse(body) as T;
}
