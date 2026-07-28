import { prisma } from "@/lib/db";
import { embed, toVectorLiteral } from "@/lib/embedder";

export interface RetrievedProposition {
  id: string;
  type: string;
  text: string;
  strength: string | null;
  date: Date | null;
  topics: string[];
  distance: number;
  status?: string;
  period?: string | null;
}

/**
 * Retrieve 3-5 propositions/insights for a knowledge-intent message.
 * `includePrivate=false` is the public-variant path: it queries ONLY the
 * public table (invariant 2 — structural, not filtered).
 */
export async function retrievePropositions(
  personaId: string,
  query: string,
  opts: { k?: number; includePrivate?: boolean; includeHistorical?: boolean } = {}
): Promise<RetrievedProposition[]> {
  const k = Math.min(opts.k ?? 4, 5);
  const vec = toVectorLiteral(await embed(query));
  // Improvement-loop lifecycle: default retrieval serves ACTIVE chunks only.
  // Historical chunks additionally retrieve for explicitly past-framed
  // questions (routed by isPastFramed). Superseded/merged never retrieve.
  const statuses = opts.includeHistorical ? `('active','historical')` : `('active')`;
  const sql = (table: string) =>
    `SELECT id, type, text, strength, date, topics, status, period,
            embedding <=> $1::vector AS distance
     FROM "${table}" WHERE "personaId" = $2 AND status IN ${statuses}
     ORDER BY embedding <=> $1::vector ASC LIMIT $3`;

  const rows: RetrievedProposition[] = [];
  if (opts.includePrivate !== false) {
    rows.push(
      ...(await prisma.$queryRawUnsafe<RetrievedProposition[]>(sql("PropositionPrivate"), vec, personaId, k))
    );
  }
  rows.push(
    ...(await prisma.$queryRawUnsafe<RetrievedProposition[]>(sql("PropositionPublic"), vec, personaId, k))
  );
  return rows.sort((a, b) => a.distance - b.distance).slice(0, k);
}

/** Explicit-recall path: query the raw episodic store; results are for
 * attributed quotation only, never impersonation. */
export async function retrieveEpisodic(
  personaId: string,
  query: string,
  opts: { k?: number; includePrivate?: boolean } = {}
): Promise<{ origin: string; text: string; distance: number }[]> {
  const k = Math.min(opts.k ?? 3, 5);
  const vec = toVectorLiteral(await embed(query));
  const sql = (table: string) =>
    `SELECT origin, text, embedding <=> $1::vector AS distance
     FROM "${table}" WHERE "personaId" = $2 AND embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector ASC LIMIT $3`;
  const rows: { origin: string; text: string; distance: number }[] = [];
  if (opts.includePrivate !== false) {
    rows.push(
      ...(await prisma.$queryRawUnsafe<typeof rows>(sql("VectorChunkPrivate"), vec, personaId, k))
    );
  }
  rows.push(
    ...(await prisma.$queryRawUnsafe<typeof rows>(sql("VectorChunkPublic"), vec, personaId, k))
  );
  return rows.sort((a, b) => a.distance - b.distance).slice(0, k);
}
