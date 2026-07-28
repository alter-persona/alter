import { prisma } from "@/lib/db";
import { getLlmProvider } from "@/corpus/profile/llm/types";
import { lintProposition } from "./registerLint";
import { storeProposition } from "./distill";

/**
 * Reflection pass (Generative Agents pattern): cluster related propositions
 * and write higher-level insights as first-class records of type `insight`,
 * linked to their supporting propositions. Insights are what make answers to
 * novel questions sound considered rather than recited.
 */

interface PropRow {
  id: string;
  text: string;
  type: string;
  sensitivity: "private" | "public";
  sourceOrigins: string[];
  emb: number[];
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // embeddings are normalized
}

async function loadProps(personaId: string): Promise<PropRow[]> {
  const q = (table: string, sensitivity: string) =>
    prisma.$queryRawUnsafe<{ id: string; text: string; type: string; sourceOrigins: string[]; emb: string }[]>(
      `SELECT id, text, type, "sourceOrigins", embedding::text AS emb
       FROM "${table}" WHERE "personaId" = $1 AND type != 'insight' AND embedding IS NOT NULL`,
      personaId
    ).then((rows) =>
      rows.map((r) => ({
        ...r,
        sensitivity: sensitivity as "private" | "public",
        emb: JSON.parse(r.emb) as number[],
      }))
    );
  return [...(await q("PropositionPrivate", "private")), ...(await q("PropositionPublic", "public"))];
}

export async function reflect(
  personaId: string,
  opts: { simThreshold?: number; minCluster?: number; maxInsights?: number } = {}
): Promise<{ clusters: number; insightsStored: number; lintRejected: number }> {
  const provider = getLlmProvider();
  if (!provider) throw new Error("Reflection requires an LLM (CORPUS_LLM_PROVIDER unset).");

  const sim = opts.simThreshold ?? 0.62;
  const minCluster = opts.minCluster ?? 4;
  const personaRow = await prisma.persona.findUnique({ where: { id: personaId } });
  const subjectName = personaRow?.name ?? "the subject";
  const props = await loadProps(personaId);

  // Greedy clustering by embedding similarity.
  const used = new Set<number>();
  const clusters: PropRow[][] = [];
  for (let i = 0; i < props.length; i++) {
    if (used.has(i)) continue;
    const cluster = [props[i]];
    used.add(i);
    for (let j = i + 1; j < props.length; j++) {
      if (used.has(j)) continue;
      if (cosineSim(props[i].emb, props[j].emb) >= sim) {
        cluster.push(props[j]);
        used.add(j);
      }
    }
    const distinctSources = new Set(cluster.flatMap((p) => p.sourceOrigins));
    if (cluster.length >= minCluster && distinctSources.size >= 2) clusters.push(cluster);
  }

  let insightsStored = 0;
  let lintRejected = 0;
  for (const cluster of clusters.slice(0, opts.maxInsights ?? 25)) {
    const list = cluster.map((p) => `- ${p.text}`).join("\n");
    try {
      const raw = await provider.complete(
        `You are an archivist writing ONE higher-level insight from related observations about a person. Neutral third person, terse, no idiom, no first person. The insight must generalize across the observations ("Across many answers, ${subjectName} ..."), not restate one of them. Output STRICT JSON: {"insight": str, "topics": [str]}`,
        `Observations about ${subjectName}:\n${list}`
      );
      const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""));
      if (!parsed.insight) continue;
      const lint = lintProposition(parsed.insight);
      if (!lint.ok) {
        lintRejected++;
        continue;
      }
      const sensitivity = cluster.some((p) => p.sensitivity === "private") ? "private" : "public";
      await storeProposition(personaId, {
        text: parsed.insight.trim(),
        type: "insight",
        strength: null,
        topics: (parsed.topics ?? []).slice(0, 3).map((t: unknown) => String(t).toLowerCase()),
        date: new Date(),
        sensitivity,
        sourceOrigins: [...new Set(cluster.flatMap((p) => p.sourceOrigins))].slice(0, 20),
        supportIds: cluster.map((p) => p.id),
      });
      insightsStored++;
    } catch (e) {
      console.error(`[reflect] cluster failed: ${String(e).slice(0, 150)}`);
    }
  }
  return { clusters: clusters.length, insightsStored, lintRejected };
}
