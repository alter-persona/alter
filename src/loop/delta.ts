import { prisma } from "@/lib/db";

/**
 * Post-ingest delta report: what an upload actually bought. Take a snapshot
 * before enqueueing material, another after distillation completes, and
 * render the difference conversationally — chunk counts by type, new topics
 * discovered, and any reconciliations it raised.
 */

export interface CorpusSnapshot {
  at: string;
  chunksByType: Record<string, number>;
  propsByType: Record<string, number>;
  topics: string[];
  reconCases: number;
  openRecons: number;
}

export async function snapshotCorpus(personaId: string): Promise<CorpusSnapshot> {
  const chunkRows = await prisma.$queryRawUnsafe<{ sourceType: string; n: bigint }[]>(
    `SELECT "sourceType", COUNT(*) AS n FROM (
       SELECT "sourceType" FROM "VectorChunkPrivate" WHERE "personaId" = $1
       UNION ALL SELECT "sourceType" FROM "VectorChunkPublic" WHERE "personaId" = $1
     ) t GROUP BY "sourceType"`,
    personaId
  );
  const propRows = await prisma.$queryRawUnsafe<{ type: string; n: bigint }[]>(
    `SELECT type, COUNT(*) AS n FROM (
       SELECT type FROM "PropositionPrivate" WHERE "personaId" = $1
       UNION ALL SELECT type FROM "PropositionPublic" WHERE "personaId" = $1
     ) t GROUP BY type`,
    personaId
  );
  const topicRows = await prisma.$queryRawUnsafe<{ topic: string }[]>(
    `SELECT DISTINCT UNNEST(topics) AS topic FROM (
       SELECT topics FROM "PropositionPrivate" WHERE "personaId" = $1
       UNION ALL SELECT topics FROM "PropositionPublic" WHERE "personaId" = $1
     ) t`,
    personaId
  );
  const [reconCases, openRecons] = await Promise.all([
    prisma.reconCase.count({ where: { personaId } }),
    prisma.reconCase.count({ where: { personaId, status: "open" } }),
  ]);
  return {
    at: new Date().toISOString(),
    chunksByType: Object.fromEntries(chunkRows.map((r) => [r.sourceType, Number(r.n)])),
    propsByType: Object.fromEntries(propRows.map((r) => [r.type, Number(r.n)])),
    topics: topicRows.map((r) => r.topic),
    reconCases,
    openRecons,
  };
}

export interface CorpusDelta {
  newChunksByType: Record<string, number>;
  newPropsByType: Record<string, number>;
  newTopics: string[];
  reconRaised: number;
  reconOpen: number;
}

export function diffCorpus(before: CorpusSnapshot, after: CorpusSnapshot): CorpusDelta {
  const diffMap = (a: Record<string, number>, b: Record<string, number>) =>
    Object.fromEntries(
      Object.entries(b)
        .map(([k, v]) => [k, v - (a[k] ?? 0)])
        .filter(([, v]) => (v as number) > 0)
    ) as Record<string, number>;
  const beforeTopics = new Set(before.topics);
  return {
    newChunksByType: diffMap(before.chunksByType, after.chunksByType),
    newPropsByType: diffMap(before.propsByType, after.propsByType),
    newTopics: after.topics.filter((t) => !beforeTopics.has(t)).slice(0, 20),
    reconRaised: Math.max(0, after.reconCases - before.reconCases),
    reconOpen: Math.max(0, after.openRecons - before.openRecons),
  };
}

/** Conversational rendering — sent back through whatever channel uploaded. */
export function renderDelta(label: string, d: CorpusDelta): string {
  const lines: string[] = [`Finished folding in ${label}.`];
  const chunks = Object.entries(d.newChunksByType);
  if (chunks.length) {
    lines.push(`New material: ${chunks.map(([k, v]) => `${v} ${k.replace(/_/g, " ")} chunk${v === 1 ? "" : "s"}`).join(", ")}.`);
  }
  const props = Object.entries(d.newPropsByType);
  if (props.length) {
    lines.push(`Distilled into memory: ${props.map(([k, v]) => `${v} ${k.replace(/_/g, " ")}${v === 1 ? "" : "s"}`).join(", ")}.`);
  }
  if (d.newTopics.length) {
    lines.push(`New topics I now know something about: ${d.newTopics.slice(0, 10).join(", ")}${d.newTopics.length > 10 ? "…" : ""}.`);
  }
  if (d.reconRaised > 0) {
    lines.push(
      d.reconOpen > 0
        ? `It disagreed with ${d.reconRaised} thing${d.reconRaised === 1 ? "" : "s"} I had on record — ${d.reconOpen} need${d.reconOpen === 1 ? "s" : ""} your word; I'll ask as we talk.`
        : `It disagreed with ${d.reconRaised} thing${d.reconRaised === 1 ? "" : "s"} I had on record; I reconciled them automatically (see the log).`
    );
  }
  if (chunks.length === 0 && props.length === 0) {
    lines.push("Nothing new made it past filtering — likely too short or duplicate material.");
  }
  return lines.join("\n");
}
