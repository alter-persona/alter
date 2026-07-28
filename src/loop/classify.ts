import { loopConfig } from "./config";
import { classifierLlm, parseJson } from "./llm";

/**
 * Intent classification, two stages:
 *   heuristicIntent() — mechanical, runs in the tier-1 reply path (no LLM).
 *     Confident signals only: adapter hints, files, reply-to-persona priors,
 *     unmistakable correction/meta phrasing, memo length.
 *   llmClassify()     — async refinement for everything the heuristic left
 *     as low-confidence chat. Ambiguous stays chat (spec default).
 */

export type Intent = "chat" | "correction" | "material" | "meta";

export interface HeuristicInput {
  kind: "text" | "audio" | "file";
  text: string | null;
  audioDurationSec?: number | null;
  replyToPersonaTurn: boolean;
  intentHint?: Intent;
}

export interface HeuristicResult {
  intent: Intent;
  source: "hint" | "heuristic" | "default";
  confident: boolean;
}

const CORRECTION_RES: RegExp[] = [
  /^\s*(no|nope|nah)[,.\s]/i,
  /\bnot like that\b/i,
  /\bi (would|wouldn'?t) (not )?(say|phrase|put) it\b/i,
  /\bthat'?s (not|wrong)\b/i,
  /\bactually,? (my|i|it'?s|that)\b/i,
  /\byou got (that|it|my \w+) wrong\b/i,
  /\bcorrection\b/i,
  /\bmy answer would (actually )?be\b/i,
  /\bi'?m (actually|really) (an?|not)\b/i,
];

/** Explicit-permanence trigger: "remember this:" routes to durable memory
 * (material distillation) with full confidence — the temporary/permanent
 * split the session layer depends on. */
const REMEMBER_RES: RegExp[] = [
  /^\s*(please\s+)?remember( this| that)?\s*[:,-]/i,
  /^\s*(permanently|for good|long[- ]term)\s*[:,-]/i,
  /^\s*(save|store) (this|that) (to|in) (your )?memory\b/i,
];

const META_RES: RegExp[] = [
  /^\s*(stop|start|always|never|please stop|please always|don'?t ever|from now on)\b/i,
  /\bstop (using|doing|saying|adding)\b/i,
  /\balways (ask|use|start|end|check)\b/i,
  /\bnever (use|say|assume|add)\b/i,
  /\bfrom now on\b/i,
];

export function heuristicIntent(input: HeuristicInput): HeuristicResult {
  if (input.intentHint) return { intent: input.intentHint, source: "hint", confident: true };
  if (input.kind === "file") return { intent: "material", source: "heuristic", confident: true };

  const text = (input.text ?? "").trim();
  const cfg = loopConfig();

  // Long voice memo is usually material; a short one is usually chat.
  if (input.kind === "audio" && (input.audioDurationSec ?? 0) >= cfg.longMemoMaterialSeconds) {
    return { intent: "material", source: "heuristic", confident: true };
  }

  if (REMEMBER_RES.some((re) => re.test(text))) {
    return { intent: "material", source: "heuristic", confident: true };
  }
  if (META_RES.some((re) => re.test(text))) return { intent: "meta", source: "heuristic", confident: true };

  const looksCorrective = CORRECTION_RES.some((re) => re.test(text));
  if (looksCorrective && input.replyToPersonaTurn) {
    return { intent: "correction", source: "heuristic", confident: true };
  }
  if (looksCorrective) {
    // Corrective phrasing without a reply-anchor: still a correction, but the
    // async classifier gets to overrule it.
    return { intent: "correction", source: "heuristic", confident: false };
  }
  if (input.replyToPersonaTurn && /\b(wrong|no[,.]|actually)\b/i.test(text)) {
    return { intent: "correction", source: "heuristic", confident: false };
  }
  return { intent: "chat", source: "default", confident: false };
}

const CLASSIFY_SYSTEM = `You classify one inbound message from a real person to their digital persona. Output STRICT JSON: {"intent": "chat"|"correction"|"material"|"meta", "confidence": 0.0-1.0}.

Definitions:
- chat: ordinary conversation with the persona.
- correction: feedback on the persona's previous response ("I would not phrase it that way", "actually my answer is X", "that's not what I think").
- material: new source content ABOUT the person — a long account of their job, history, opinions, a pasted writing sample. Length and information density about the person's life mark material.
- meta: an instruction about the persona's behavior ("stop using bullet points", "always ask before assuming").

When genuinely ambiguous, choose chat with low confidence.`;

export interface LlmClassifyResult {
  intent: Intent;
  confidence: number;
}

export async function llmClassify(
  text: string,
  context: { previousPersonaReply?: string | null }
): Promise<LlmClassifyResult> {
  const user = [
    context.previousPersonaReply
      ? `The persona's previous reply was:\n"""${context.previousPersonaReply.slice(0, 600)}"""\n`
      : "",
    `The person's message:\n"""${text.slice(0, 3000)}"""`,
  ].join("\n");
  try {
    const raw = await classifierLlm()(CLASSIFY_SYSTEM, user);
    const parsed = parseJson<LlmClassifyResult>(raw);
    if (!["chat", "correction", "material", "meta"].includes(parsed.intent)) {
      return { intent: "chat", confidence: 0 };
    }
    return { intent: parsed.intent, confidence: Number(parsed.confidence) || 0 };
  } catch {
    return { intent: "chat", confidence: 0 }; // ambiguous/failed → chat (spec default)
  }
}

/** Correction sub-typing happens at distillation time (tier 2). */
export type CorrectionType = "style" | "factual" | "position" | "behavior";

export const CORRECTION_TYPE_SYSTEM = `A real person corrected their digital persona. Classify the correction and extract its parts. Output STRICT JSON:
{"type": "style"|"factual"|"position"|"behavior",
 "distilledNote": str,          // one imperative line, <=140 chars, telling the persona what to do differently
 "correctedVersion": str|null,  // for style: how the person WOULD have phrased it, extracted or reconstructed from their words; else null
 "correctedFact": str|null,     // for factual/position: ONE neutral third-person statement of the corrected fact/opinion about the subject; else null
 "generalRule": str|null,       // a general rule ONLY if the person stated one or it follows directly; null if it would be an inference beyond their words
 "inferred": bool,              // true when generalRule goes beyond what they literally said
 "topics": [str]}

Definitions:
- style: the content was right but the voice/phrasing was wrong.
- factual: the persona got the person's life or work wrong.
- position: the persona misrepresented the person's opinion — preserve their stated nuance in correctedFact.
- behavior: an instruction about how the persona should behave.
correctedFact must be neutral archival third person using the subject's name — never the person's own phrasing.`;
