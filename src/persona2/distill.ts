import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { embed, toVectorLiteral } from "@/lib/embedder";
import { getLlmProvider } from "@/corpus/profile/llm/types";
import { lintProposition } from "./registerLint";
import type { DistinctiveEntry } from "@/lib/stylometry";

/**
 * Build-time distillation: raw corpus items → atomic propositions in a
 * neutral third-person archivist register. Propositions are embedded; raw
 * text is NOT (it stays in the VectorChunk tables as the episodic store and
 * the untouched v1 index for A/B). Every proposition passes the register
 * lint before it may be stored — the anti-parrot firewall.
 */

const BULK_MODEL = () => process.env.PERSONA2_DISTILL_MODEL ?? undefined; // provider default otherwise

export const DISTILL_SYSTEM = `You are an archivist distilling a person's raw words into atomic propositions for a knowledge index.

Rules — absolute:
- Each proposition is ONE self-contained statement in NEUTRAL THIRD PERSON about the subject, referred to by name.
- Register: terse, flat, archival. No idiom, no first person, no fillers, none of the subject's phrasing or characteristic expressions. Rewrite completely; never copy phrases from the source.
- type is one of: fact, belief, preference, decision_heuristic, experience, story_summary.
- strength reflects hedging in the source: strong (stated flatly), moderate (some hedging), weak (heavy hedging/uncertainty).
- topics: 1-3 short lowercase topic tags.
- Skip content that is purely conversational mechanics (greetings, thanks, requests to an assistant with no information about the subject).

Output STRICT JSON: {"items": [{"sourceId": str, "propositions": [{"text": str, "type": str, "strength": str, "topics": [str]}]}]} — no markdown fences.`;

interface RawItem {
  sourceId: string; // origin
  text: string;
  date: Date | null;
  sensitivity: "private" | "public";
}

export interface DistillStats {
  itemsProcessed: number;
  propositionsStored: number;
  lintRejected: number;
  llmErrors: number;
}

function propId(personaId: string, text: string): string {
  return createHash("sha256")
    .update(`${personaId}|${text.toLowerCase().replace(/\s+/g, " ").trim()}`)
    .digest("hex")
    .slice(0, 16);
}

async function loadDistinctiveCollocations(personaId: string): Promise<string[]> {
  const s = await prisma.stylometryRecord.findUnique({ where: { personaId } });
  const entries = ((s?.distinctive as unknown as DistinctiveEntry[]) ?? []);
  return entries
    .filter((e) => e.ngram.split(" ").length >= 2)
    .slice(0, 30)
    .map((e) => e.ngram);
}

/** Load raw items (grouped chunks by origin) from the episodic store. */
export async function loadRawItems(
  personaId: string,
  onlyOrigins?: string[]
): Promise<RawItem[]> {
  const whereBase = { personaId, ...(onlyOrigins ? { origin: { in: onlyOrigins } } : {}) };
  const select = { origin: true, text: true, date: true, id: true } as const;
  const [priv, pub] = await Promise.all([
    prisma.vectorChunkPrivate.findMany({ where: whereBase, select, orderBy: { id: "asc" } }),
    prisma.vectorChunkPublic.findMany({ where: whereBase, select, orderBy: { id: "asc" } }),
  ]);

  const groups = new Map<string, RawItem>();
  const add = (rows: typeof priv, sensitivity: "private" | "public") => {
    for (const r of rows) {
      const existing = groups.get(r.origin);
      if (existing) {
        if (existing.text.length < 6000) existing.text += "\n" + r.text;
      } else {
        groups.set(r.origin, {
          sourceId: r.origin,
          text: r.text,
          date: r.date,
          sensitivity,
        });
      }
    }
  };
  add(priv, "private");
  add(pub as typeof priv, "public");
  return [...groups.values()];
}

async function alreadyDistilled(personaId: string): Promise<Set<string>> {
  const [a, b] = await Promise.all([
    prisma.propositionPrivate.findMany({ where: { personaId }, select: { sourceOrigins: true } }),
    prisma.propositionPublic.findMany({ where: { personaId }, select: { sourceOrigins: true } }),
  ]);
  const done = new Set<string>();
  for (const r of [...a, ...b]) for (const o of r.sourceOrigins) done.add(o);
  return done;
}

export async function storeProposition(
  personaId: string,
  p: {
    text: string;
    type: string;
    strength: string | null;
    topics: string[];
    date: Date | null;
    sensitivity: "private" | "public";
    sourceOrigins: string[];
    supportIds?: string[];
  }
): Promise<string> {
  const id = propId(personaId, p.text);
  const vec = toVectorLiteral(await embed(p.text));
  const table = p.sensitivity === "public" ? "PropositionPublic" : "PropositionPrivate";
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${table}"
       (id, "personaId", type, text, strength, date, topics, "sourceOrigins", "supportIds", embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector)
     ON CONFLICT (id) DO UPDATE SET topics = EXCLUDED.topics, "sourceOrigins" = EXCLUDED."sourceOrigins"`,
    id,
    personaId,
    p.type,
    p.text,
    p.strength,
    p.date,
    p.topics,
    p.sourceOrigins,
    p.supportIds ?? [],
    vec
  );
  return id;
}

const VALID_TYPES = new Set([
  "fact", "belief", "preference", "decision_heuristic", "experience", "story_summary",
]);

/**
 * Distill items in batches. Skips origins already distilled (idempotent
 * migration). Register lint gates every proposition; failures are dropped
 * and counted, with one corrective retry per batch.
 */
export async function distill(
  personaId: string,
  opts: { limit?: number; onlyOrigins?: string[]; onProgress?: (s: DistillStats) => void } = {}
): Promise<DistillStats> {
  const provider = getLlmProvider(BULK_MODEL());
  if (!provider) {
    throw new Error(
      "Distillation requires an LLM (set CORPUS_LLM_PROVIDER / CORPUS_LLM_URL / CORPUS_LLM_MODEL). " +
        "There is no mechanical fallback — propositions are a rewrite, not a transform."
    );
  }
  // Factory rule: the subject's name comes from the persona row, never a literal.
  const personaRow = await prisma.persona.findUnique({ where: { id: personaId } });
  const subjectName = personaRow?.name ?? "the subject";
  const collocations = await loadDistinctiveCollocations(personaId);
  const done = opts.onlyOrigins ? new Set<string>() : await alreadyDistilled(personaId);
  let items = (await loadRawItems(personaId, opts.onlyOrigins)).filter(
    (i) => !done.has(i.sourceId)
  );
  if (opts.limit) items = items.slice(0, opts.limit);

  const stats: DistillStats = {
    itemsProcessed: 0,
    propositionsStored: 0,
    lintRejected: 0,
    llmErrors: 0,
  };

  // Batch items so short chat messages share a call.
  const batches: RawItem[][] = [];
  let cur: RawItem[] = [];
  let curLen = 0;
  for (const item of items) {
    const len = Math.min(item.text.length, 4000);
    if (cur.length > 0 && (curLen + len > 6000 || cur.length >= 10)) {
      batches.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(item);
    curLen += len;
  }
  if (cur.length) batches.push(cur);

  for (const batch of batches) {
    const user = batch
      .map(
        (i) =>
          `[sourceId: ${i.sourceId}]${i.date ? ` [date: ${i.date.toISOString().slice(0, 10)}]` : ""}\n${i.text.slice(0, 4000)}`
      )
      .join("\n\n=====\n\n");
    let parsed: { items?: { sourceId: string; propositions?: { text: string; type: string; strength?: string; topics?: string[] }[] }[] };
    try {
      const raw = await provider.complete(DISTILL_SYSTEM, `Subject name: ${subjectName}.\n\n${user}`);
      parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""));
    } catch (e) {
      stats.llmErrors++;
      console.error(`[distill] batch failed: ${String(e).slice(0, 200)}`);
      continue;
    }

    const byId = new Map(batch.map((i) => [i.sourceId, i]));
    for (const out of parsed.items ?? []) {
      const src = byId.get(out.sourceId);
      if (!src) continue;
      stats.itemsProcessed++;
      for (const p of out.propositions ?? []) {
        if (!p.text || !VALID_TYPES.has(p.type)) continue;
        const lint = lintProposition(p.text, collocations);
        if (!lint.ok) {
          stats.lintRejected++;
          continue;
        }
        await storeProposition(personaId, {
          text: p.text.trim(),
          type: p.type,
          strength: p.strength && ["strong", "moderate", "weak"].includes(p.strength) ? p.strength : null,
          topics: (p.topics ?? []).slice(0, 3).map((t) => String(t).toLowerCase()),
          date: src.date,
          sensitivity: src.sensitivity,
          sourceOrigins: [src.sourceId],
        });
        stats.propositionsStored++;
      }
    }
    opts.onProgress?.(stats);
  }
  return stats;
}
