import { prisma } from "@/lib/db";
import { embed, toVectorLiteral } from "@/lib/embedder";
import { storeProposition } from "@/persona2/distill";
import { loopConfig } from "./config";
import { improvementLlm, parseJson } from "./llm";
import { retireHotNotesForCase } from "./hotnotes";

/**
 * Reconciliation: how new information meets old. The model proposes an
 * outcome; CODE clamps it by tier. Nothing is ever deleted — resolutions
 * flip proposition status and link parents.
 *
 * Tiers:
 *   mutable  — job title, location, tools, current projects → auto evolve/replace on recency
 *   position — beliefs/preferences → auto only coexist/augment above confidence; reversals ask
 *   core     — values, traits, self-concept, decision heuristics → ALWAYS ask
 */

export type Tier = "mutable" | "position" | "core";
export type Outcome = "augment" | "evolve" | "replace" | "coexist" | "ask";

interface PropRow {
  id: string;
  type: string;
  text: string;
  strength: string | null;
  date: Date | null;
  topics: string[];
  status: string;
  sourceOrigins: string[];
}

const CORE_TOPIC_RES =
  /\b(personality|identity|self|values?|character|temperament|introver|extrover|trait)\b/i;
const MUTABLE_TOPIC_RES =
  /\b(job|title|role|employer|company|location|city|address|tool|stack|project|team|salary|phone|email)\b/i;

export function tierFor(p: { type: string; topics: string[]; text: string }): Tier {
  const hay = `${p.topics.join(" ")} ${p.text}`;
  if (p.type === "decision_heuristic" || p.type === "insight") return "core";
  if (CORE_TOPIC_RES.test(hay)) return "core";
  if (p.type === "fact" && MUTABLE_TOPIC_RES.test(hay)) return "mutable";
  if (p.type === "belief" || p.type === "preference") return "position";
  // Experiences/stories/other facts: treat as mutable-fact reconciliation.
  return "mutable";
}

export const RECON_SYSTEM = `You are reconciling two statements in a person's knowledge archive that may disagree. Both are neutral third-person archival statements with provenance.

Output STRICT JSON:
{"conflict": true|false,
 "outcome": "augment"|"evolve"|"replace"|"coexist"|"ask",
 "confidence": 0.0-1.0,
 "merged": {"text": str, "type": str, "strength": str, "topics": [str]} | null,
 "changeNote": str | null,
 "question": str | null,
 "reasoning": str}

Outcome definitions — prefer them in this order:
- augment: both are true in different contexts. Draft ONE merged statement that carries the scope of both (e.g. "<Name> is energized by small trusted groups and drained by crowds"). A scoped truth is richer than either input. Required: merged.
- coexist: closer reading shows no real conflict; both stay untouched.
- evolve: the person changed over time — the OLD was true for its period, the NEW is true now. Required: changeNote, one archival sentence recording that the shift happened and roughly when.
- replace: the OLD is simply an extraction or transcription error, not a change.
- ask: the resolution genuinely needs the person (a real contradiction whose scope only they know). Required: question — ONE short conversational question presenting both sides and the shapes of resolution (situational? changed? we had it wrong?).

Merged/changeNote text must be neutral third-person archivist register using the subject's name: terse, flat, no first person, no idiom.`;

export interface ReconDecision {
  conflict: boolean;
  outcome: Outcome;
  confidence: number;
  merged: { text: string; type: string; strength: string; topics: string[] } | null;
  changeNote: string | null;
  question: string | null;
  reasoning: string;
}

async function findProp(personaId: string, id: string): Promise<(PropRow & { table: string }) | null> {
  for (const table of ["PropositionPrivate", "PropositionPublic"]) {
    const rows = await prisma.$queryRawUnsafe<PropRow[]>(
      `SELECT id, type, text, strength, date, topics, status, "sourceOrigins" FROM "${table}" WHERE id = $1 AND "personaId" = $2`,
      id,
      personaId
    );
    if (rows[0]) return { ...rows[0], table };
  }
  return null;
}

async function setStatus(
  table: string,
  id: string,
  status: string,
  period?: string | null
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "${table}" SET status = $1, period = COALESCE($2, period) WHERE id = $3`,
    status,
    period ?? null,
    id
  );
}

async function setParents(table: string, id: string, parentIds: string[]): Promise<void> {
  await prisma.$executeRawUnsafe(`UPDATE "${table}" SET "parentIds" = $1 WHERE id = $2`, parentIds, id);
}

/** Find active near-neighbors of a new proposition that might disagree. */
export async function nearNeighbors(
  personaId: string,
  text: string,
  excludeId: string,
  sensitivity: "private" | "public"
): Promise<PropRow[]> {
  const maxDist = loopConfig().neighborCheckDistance;
  const vec = toVectorLiteral(await embed(text));
  const table = sensitivity === "public" ? "PropositionPublic" : "PropositionPrivate";
  return prisma.$queryRawUnsafe<PropRow[]>(
    `SELECT id, type, text, strength, date, topics, status, "sourceOrigins",
            embedding <=> $1::vector AS distance
     FROM "${table}"
     WHERE "personaId" = $2 AND status = 'active' AND id <> $3
       AND embedding <=> $1::vector < $4
     ORDER BY embedding <=> $1::vector ASC LIMIT 3`,
    vec,
    personaId,
    excludeId,
    maxDist
  );
}

function fmt(p: { text: string; type: string; strength: string | null; date: Date | null; sourceOrigins?: string[] }, label: string): string {
  return `${label}:
  statement: ${p.text}
  type: ${p.type}${p.strength ? `, strength: ${p.strength}` : ""}
  date: ${p.date ? p.date.toISOString().slice(0, 10) : "unknown"}
  provenance: ${(p.sourceOrigins ?? []).join(", ") || "unknown"}`;
}

/**
 * Reconcile one new proposition against one existing proposition.
 * Creates a ReconCase; auto-resolves within tier policy or leaves it open
 * with a clarification question. Returns the case.
 */
export async function reconcile(opts: {
  personaId: string;
  newPropId: string;
  oldPropId: string;
  sourceEventId?: string | null;
  /** Correction prior: the new statement came directly from the person. */
  fromDirectCorrection?: boolean;
}): Promise<{ caseId: string; status: string; resolution: string | null; question: string | null }> {
  const cfg = loopConfig();
  const [newP, oldP] = await Promise.all([
    findProp(opts.personaId, opts.newPropId),
    findProp(opts.personaId, opts.oldPropId),
  ]);
  if (!newP || !oldP) throw new Error("reconcile: proposition not found");

  // Tier is the STRICTER of the two sides.
  const rank: Record<Tier, number> = { mutable: 0, position: 1, core: 2 };
  const tier = [tierFor(newP), tierFor(oldP)].sort((a, b) => rank[b] - rank[a])[0];

  const raw = await improvementLlm()(
    RECON_SYSTEM,
    `${fmt(oldP, "OLD")}\n\n${fmt(newP, "NEW")}${
      opts.fromDirectCorrection ? "\n\nNote: NEW arrived as the person's own direct correction of the persona." : ""
    }`
  );
  const d = parseJson<ReconDecision>(raw);

  // ── Tier clamps (code, not model) ──────────────────────────────────────
  let outcome: Outcome = d.outcome;
  if (!d.conflict) outcome = "coexist";
  if (tier === "core") {
    // Never auto-resolve — even a direct correction: the truth is usually
    // scoped rather than binary, and only the person knows the scope.
    if (outcome !== "coexist" || d.confidence < cfg.reconAutoConfidence) outcome = "ask";
  } else if (tier === "position") {
    const allowed = outcome === "coexist" || (outcome === "augment" && d.confidence >= cfg.reconAutoConfidence);
    if (!allowed) outcome = "ask"; // genuine reversal always asks
  } else {
    // mutable: recency wins; clamp exotic outcomes to evolve.
    if (outcome === "ask" || outcome === "augment") {
      outcome = newerThan(newP, oldP) ? "evolve" : "coexist";
    }
  }

  const kase = await prisma.reconCase.create({
    data: {
      personaId: opts.personaId,
      newPropId: newP.id,
      oldPropId: oldP.id,
      newText: newP.text,
      oldText: oldP.text,
      tier,
      sourceEventId: opts.sourceEventId ?? null,
      theme: newP.topics[0] ?? oldP.topics[0] ?? null,
      confidence: d.confidence,
      log: JSON.parse(JSON.stringify([{ at: new Date().toISOString(), model: d, clampedTo: outcome }])),
    },
  });

  if (outcome === "ask") {
    const question =
      d.question ??
      `Earlier I had "${oldP.text}" on record, and now "${newP.text}". Is it situational, did it change, or did I have it wrong?`;
    await prisma.reconCase.update({ where: { id: kase.id }, data: { status: "open", question } });
    // The hot note (if any) carries the pending case.
    if (opts.sourceEventId) {
      await prisma.hotNote.updateMany({
        where: { sourceEventId: opts.sourceEventId, active: true },
        data: { pendingCaseId: kase.id },
      });
    }
    return { caseId: kase.id, status: "open", resolution: null, question };
  }

  await applyResolution(opts.personaId, kase.id, outcome, d, newP, oldP, "auto_resolved");
  return { caseId: kase.id, status: "auto_resolved", resolution: outcome, question: null };
}

function newerThan(a: { date: Date | null }, b: { date: Date | null }): boolean {
  const ta = a.date?.getTime() ?? Date.now(); // new props default to now
  const tb = b.date?.getTime() ?? 0;
  return ta >= tb;
}

/** Apply a resolution (auto or human-confirmed). Never deletes anything. */
export async function applyResolution(
  personaId: string,
  caseId: string,
  outcome: Exclude<Outcome, "ask">,
  d: Partial<ReconDecision>,
  newP: PropRow & { table: string },
  oldP: PropRow & { table: string },
  status: "auto_resolved" | "resolved"
): Promise<void> {
  const sensitivity = oldP.table === "PropositionPublic" ? "public" : "private";

  if (outcome === "augment") {
    const merged = d.merged ?? {
      text: `${oldP.text} ${newP.text}`,
      type: oldP.type,
      strength: oldP.strength ?? "moderate",
      topics: [...new Set([...oldP.topics, ...newP.topics])],
    };
    const mergedId = await storeProposition(personaId, {
      text: merged.text.trim(),
      type: merged.type ?? oldP.type,
      strength: merged.strength ?? null,
      topics: (merged.topics ?? []).slice(0, 3),
      date: new Date(),
      sensitivity,
      sourceOrigins: [...new Set([...oldP.sourceOrigins, ...newP.sourceOrigins])],
    });
    // Link the merged chunk to both parents, retire the parents from default retrieval.
    await setParents(oldP.table, mergedId, [oldP.id, newP.id]);
    await setStatus(oldP.table, oldP.id, "merged");
    await setStatus(newP.table, newP.id, "merged");
  } else if (outcome === "evolve") {
    const period = oldP.date ? `until ${oldP.date.toISOString().slice(0, 7)}` : "earlier period";
    await setStatus(oldP.table, oldP.id, "historical", period);
    // How a person changed is itself persona content — record the shift.
    const changeText =
      d.changeNote ??
      `This changed over time: previously "${oldP.text}"; as of ${new Date().toISOString().slice(0, 7)}, "${newP.text}".`;
    await storeProposition(personaId, {
      text: changeText.trim(),
      type: "experience",
      strength: "moderate",
      topics: newP.topics.slice(0, 3),
      date: new Date(),
      sensitivity,
      sourceOrigins: [...new Set([...oldP.sourceOrigins, ...newP.sourceOrigins])],
    });
  } else if (outcome === "replace") {
    await setStatus(oldP.table, oldP.id, "superseded");
  }
  // coexist: both stay active untouched.

  await prisma.reconCase.update({
    where: { id: caseId },
    data: { status, resolution: outcome, resolvedAt: new Date() },
  });
  await retireHotNotesForCase(caseId);
}

/**
 * Route the person's clarification answer back through reconciliation.
 * Their answer usually scopes the truth → augment via a fresh model call
 * that now has the answer in hand.
 */
export async function resolveWithAnswer(caseId: string, answerText: string, answerEventId: string): Promise<void> {
  const kase = await prisma.reconCase.findUnique({ where: { id: caseId } });
  if (!kase || kase.status !== "open") throw new Error("case not open");
  const [newP, oldP] = await Promise.all([
    findProp(kase.personaId, kase.newPropId),
    findProp(kase.personaId, kase.oldPropId),
  ]);
  if (!newP || !oldP) throw new Error("propositions missing");

  const raw = await improvementLlm()(
    RECON_SYSTEM,
    `${fmt(oldP, "OLD")}\n\n${fmt(newP, "NEW")}\n\nThe person was asked: "${kase.question}"\nTheir answer: """${answerText.slice(0, 1500)}"""\n\nResolve now using their answer. Do NOT output "ask" again. If their answer scopes both statements, output augment with a merged statement carrying their stated scope (preserve their nuance). Never quote their answer's phrasing — archival register only.`
  );
  const d = parseJson<ReconDecision>(raw);
  const outcome: Exclude<Outcome, "ask"> =
    d.outcome === "ask" || !d.outcome ? "augment" : (d.outcome as Exclude<Outcome, "ask">);

  await prisma.reconCase.update({
    where: { id: caseId },
    data: {
      answerEventId,
      log: [
        ...(Array.isArray(kase.log) ? (kase.log as object[]) : []),
        { at: new Date().toISOString(), answer: answerText.slice(0, 500), model: d },
      ],
    },
  });
  await applyResolution(kase.personaId, caseId, outcome, d, newP, oldP, "resolved");
}
