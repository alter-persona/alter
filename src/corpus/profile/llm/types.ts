export interface LlmProvider {
  name: string;
  model: string;
  complete(system: string, user: string): Promise<string>;
}

import { openaiCompatibleProvider } from "./openaiCompatible";
import { anthropicProvider } from "./anthropic";

/**
 * Provider selection via env:
 *   CORPUS_LLM_PROVIDER = openai_compatible | anthropic
 *   CORPUS_LLM_MODEL    = model id
 *   CORPUS_LLM_API_KEY  = key (if the endpoint needs one)
 *   CORPUS_LLM_URL      = base URL (openai_compatible only, e.g. http://127.0.0.1:11434/v1)
 * Returns null when nothing is configured — the pipeline then behaves as --no-llm.
 */
export function getLlmProvider(modelOverride?: string): LlmProvider | null {
  const kind = process.env.CORPUS_LLM_PROVIDER?.trim();
  if (!kind) return null;
  if (kind === "openai_compatible") return openaiCompatibleProvider(modelOverride);
  if (kind === "anthropic") return anthropicProvider(modelOverride);
  throw new Error(`Unknown CORPUS_LLM_PROVIDER "${kind}"`);
}
