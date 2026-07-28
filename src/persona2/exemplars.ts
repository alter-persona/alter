import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { getLlmProvider } from "@/corpus/profile/llm/types";
import { tokenize } from "./lexicon";

/**
 * Exemplar bank: 8-12 short passages of the person's REAL text (40-120
 * words), curated for maximum style signal and deliberately biased toward
 * topics UNLIKELY to be asked about — exemplars must never double as answer
 * material. Stored in the skill pack, never in the vector store.
 */

export interface ExemplarCandidate {
  text: string;
  mode: "spoken" | "written";
  origin: string;
  // Filled by the curation pass:
  styleSignal?: number; // 0-10
  topic?: string;
  likelyAsked?: number; // 0-10 — high means it could double as answer material
}

export interface Exemplar {
  text: string;
  mode: "spoken" | "written";
  topic: string;
}

export const MAX_LIKELY_ASKED = 4;

/** Deterministic selection over scored candidates. Pure — unit-testable.
 * Rejects on-topic passages (likelyAsked > MAX_LIKELY_ASKED), ranks by style
 * signal, caps two per topic, balances modes, returns 8-12. */
export function selectExemplars(candidates: ExemplarCandidate[]): Exemplar[] {
  const eligible = candidates
    .filter(
      (c) =>
        c.styleSignal !== undefined &&
        c.likelyAsked !== undefined &&
        c.likelyAsked <= MAX_LIKELY_ASKED
    )
    .sort((a, b) => (b.styleSignal ?? 0) - (a.styleSignal ?? 0));

  const picked: Exemplar[] = [];
  const perTopic = new Map<string, number>();
  const perMode = { spoken: 0, written: 0 };

  for (const c of eligible) {
    if (picked.length >= 12) break;
    const topic = (c.topic ?? "misc").toLowerCase();
    if ((perTopic.get(topic) ?? 0) >= 2) continue;
    // Keep modes balanced: neither mode may exceed the other by more than 4.
    if (perMode[c.mode] - perMode[c.mode === "spoken" ? "written" : "spoken"] >= 4) continue;
    picked.push({ text: c.text, mode: c.mode, topic });
    perTopic.set(topic, (perTopic.get(topic) ?? 0) + 1);
    perMode[c.mode]++;
  }
  return picked;
}

function splitPassages(text: string, mode: "spoken" | "written", origin: string): ExemplarCandidate[] {
  const out: ExemplarCandidate[] = [];
  const sentences = (text.match(/[^.!?\n]+[.!?]*/g) ?? []).map((s) => s.trim()).filter(Boolean);
  let buf: string[] = [];
  for (const s of sentences) {
    buf.push(s);
    const words = tokenize(buf.join(" ")).length;
    if (words >= 40) {
      if (words <= 120) out.push({ text: buf.join(" "), mode, origin });
      buf = [];
    }
  }
  return out;
}

export async function gatherCandidates(personaId: string): Promise<ExemplarCandidate[]> {
  const select = { sourceType: true, text: true, origin: true } as const;
  const [priv, pub] = await Promise.all([
    prisma.vectorChunkPrivate.findMany({ where: { personaId }, select }),
    prisma.vectorChunkPublic.findMany({ where: { personaId }, select }),
  ]);
  const out: ExemplarCandidate[] = [];
  for (const r of [...priv, ...pub]) {
    if (r.sourceType === "interview") out.push(...splitPassages(r.text, "spoken", r.origin));
    else if (r.sourceType === "chat_export") {
      const words = tokenize(r.text).length;
      if (words >= 40 && words <= 120) out.push({ text: r.text, mode: "written", origin: r.origin });
    } else if (r.sourceType === "work_file") out.push(...splitPassages(r.text, "written", r.origin));
  }
  return out;
}

export async function curateExemplars(personaId: string): Promise<Exemplar[]> {
  const provider = getLlmProvider();
  if (!provider) throw new Error("Exemplar curation requires an LLM (CORPUS_LLM_PROVIDER unset).");

  let candidates = await gatherCandidates(personaId);
  // Cap the scoring workload: sample evenly if very large.
  if (candidates.length > 240) {
    const step = candidates.length / 240;
    candidates = Array.from({ length: 240 }, (_, i) => candidates[Math.floor(i * step)]);
  }

  const scored: ExemplarCandidate[] = [];
  for (let i = 0; i < candidates.length; i += 12) {
    const batch = candidates.slice(i, i + 12);
    const user = batch.map((c, j) => `[${j}] (${c.mode}) ${c.text}`).join("\n\n");
    try {
      const raw = await provider.complete(
        `You score short passages of one person's real speech/writing for use as STYLE exemplars in a persona prompt. For each, return: styleSignal 0-10 (how strongly it carries their characteristic voice — rhythm, markers, hedges — regardless of subject), topic (1-3 word label), likelyAsked 0-10 (how likely a stranger chatting with this person's digital persona would ask about this passage's subject; personal biography, opinions on big questions, and their work score HIGH; incidental logistics, one-off anecdotes about mundane things score LOW). Output STRICT JSON: {"scores": [{"i": int, "styleSignal": int, "topic": str, "likelyAsked": int}]}`,
        user
      );
      const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""));
      for (const s of parsed.scores ?? []) {
        const c = batch[s.i];
        if (!c) continue;
        scored.push({ ...c, styleSignal: s.styleSignal, topic: s.topic, likelyAsked: s.likelyAsked });
      }
    } catch (e) {
      console.error(`[exemplars] scoring batch failed: ${String(e).slice(0, 150)}`);
    }
  }

  const bank = selectExemplars(scored);
  const dir = path.join(process.cwd(), "corpus", "persona2", personaId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "exemplars.json"), JSON.stringify(bank, null, 2));
  return bank;
}
