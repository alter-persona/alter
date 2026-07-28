import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { storeProposition } from "@/persona2/distill";
import { lintProposition } from "@/persona2/registerLint";
import { CORRECTION_TYPE_SYSTEM, type CorrectionType } from "./classify";
import { improvementLlm, parseJson } from "./llm";
import { nearNeighbors, reconcile } from "./reconcile";
import { retireHotNotesForEvent, writeHotNote } from "./hotnotes";

/**
 * Tier-2 correction distillation. Each correction type lands in a different
 * place — see the routing below. Every correction also writes a regression
 * case, and the FEEDBACK FIREWALL holds throughout: the person's feedback
 * sentence itself is never embedded; only distilled outputs (exemplar pairs,
 * neutral-register chunks, style rules) leave the event record.
 */

interface EventRow {
  id: string;
  personaId: string;
  rawText: string | null;
  register: string | null;
  replyToEventId: string | null;
  sensitivity: string;
  intent: string;
}

interface TypedCorrection {
  type: CorrectionType;
  distilledNote: string;
  correctedVersion: string | null;
  correctedFact: string | null;
  generalRule: string | null;
  inferred: boolean;
  topics: string[];
}

const STYLE_DELTA_PATH = (personaId: string) =>
  path.join(process.cwd(), "corpus", "persona2", personaId, "style-delta.md");

export async function distillCorrection(event: EventRow): Promise<void> {
  const feedback = event.rawText?.trim();
  if (!feedback) return;

  // The persona turn being corrected (for the original output + retrieval log).
  const personaTurn = event.replyToEventId
    ? await prisma.updateEvent.findUnique({ where: { id: event.replyToEventId } })
    : null;
  const personaOriginal = personaTurn?.rawText ?? null;
  // The user message that triggered the corrected persona turn.
  const trigger = personaTurn?.replyToEventId
    ? await prisma.updateEvent.findUnique({ where: { id: personaTurn.replyToEventId } })
    : null;

  const personaRow = await prisma.persona.findUnique({ where: { id: event.personaId } });
  const raw = await improvementLlm()(
    CORRECTION_TYPE_SYSTEM,
    [
      `Subject name: ${personaRow?.name ?? "the subject"}.`,
      personaOriginal ? `Persona's original response:\n"""${personaOriginal.slice(0, 1500)}"""` : "",
      `The person's ${event.intent === "meta" ? "instruction" : "correction"}${event.register === "spoken" ? " (spoken)" : ""}:\n"""${feedback.slice(0, 2500)}"""`,
    ]
      .filter(Boolean)
      .join("\n\n")
  );
  const t = parseJson<TypedCorrection>(raw);
  if (event.intent === "meta") t.type = "behavior";
  await prisma.updateEvent.update({ where: { id: event.id }, data: { correctionType: t.type } });

  // Refine the tier-1 verbatim hot note into the distilled one-liner.
  if (t.distilledNote) {
    const existing = await prisma.hotNote.findFirst({
      where: { sourceEventId: event.id, active: true },
    });
    if (existing) {
      await prisma.hotNote.update({ where: { id: existing.id }, data: { note: t.distilledNote.slice(0, 240) } });
    } else {
      await writeHotNote(event.personaId, event.id, t.distilledNote);
    }
  }

  const sensitivity = event.sensitivity === "public" ? "public" : "private";
  let reconOpen = false;

  if (t.type === "style") {
    // Paired exemplar: my corrected version against the persona's original.
    if (t.correctedVersion && personaOriginal) {
      await prisma.exemplarPair.create({
        data: {
          personaId: event.personaId,
          mode: event.register === "spoken" ? "spoken" : "written",
          personaOriginal: personaOriginal.slice(0, 2000),
          correctedText: t.correctedVersion.slice(0, 2000),
          rule: t.generalRule,
          sourceEventId: event.id,
        },
      });
    }
    if (t.generalRule) await handleRule(event, t, "style_rule");
  } else if (t.type === "factual" || t.type === "position") {
    // New typed chunk through the standard pipeline (register lint enforced),
    // then reconciliation against the chunk that fed the wrong answer.
    if (t.correctedFact) {
      const { isSealedContent } = await import("./sealed");
      const lint = lintProposition(t.correctedFact, []);
      if (lint.ok && !(await isSealedContent(t.correctedFact))) {
        const newId = await storeProposition(event.personaId, {
          text: t.correctedFact.trim(),
          type: t.type === "position" ? "belief" : "fact",
          strength: "strong", // direct correction from the person
          topics: (t.topics ?? []).slice(0, 3).map((x) => x.toLowerCase()),
          date: new Date(),
          sensitivity,
          sourceOrigins: [`correction:${event.id.slice(0, 8)}`],
        });
        // Culprit first: the retrieval log of the corrected turn.
        const log = (personaTurn?.retrievalLog ?? null) as { props?: string[] } | null;
        const culprits = new Set(log?.props ?? []);
        const neighbors = await nearNeighbors(event.personaId, t.correctedFact, newId, sensitivity);
        const ordered = [
          ...neighbors.filter((n) => culprits.has(n.id)),
          ...neighbors.filter((n) => !culprits.has(n.id)),
        ];
        if (ordered[0]) {
          const res = await reconcile({
            personaId: event.personaId,
            newPropId: newId,
            oldPropId: ordered[0].id,
            sourceEventId: event.id,
            fromDirectCorrection: true,
          });
          reconOpen = res.status === "open";
        }
      }
    }
  } else {
    // behavior — guardrail / style rule candidate.
    if (t.generalRule ?? t.distilledNote) await handleRule(event, t, "guardrail");
  }

  // Every correction writes a regression case — the growing eval suite.
  await prisma.regressionCase.create({
    data: {
      personaId: event.personaId,
      kind: t.type,
      triggerInput: (trigger?.rawText ?? personaOriginal ?? feedback).slice(0, 2000),
      rejectedOutput: (personaOriginal ?? "").slice(0, 2000),
      correctedOutput: (t.correctedVersion ?? t.correctedFact ?? t.distilledNote ?? feedback).slice(0, 2000),
      sourceEventId: event.id,
    },
  });

  // Retire the hot note once the update is live — unless it carries an open
  // reconciliation case (then it stays, flagged pending, until I answer).
  if (!reconOpen) await retireHotNotesForEvent(event.personaId, event.id);
}

/** Direct statements apply immediately; inferred generalizations queue for
 * one-tap approval in the playground before taking effect. */
async function handleRule(
  event: EventRow,
  t: TypedCorrection,
  kind: "style_rule" | "guardrail"
): Promise<void> {
  const rule = (t.generalRule ?? t.distilledNote).trim();
  if (!rule) return;
  if (t.inferred) {
    await prisma.pendingApproval.create({
      data: { personaId: event.personaId, kind, text: rule, sourceEventId: event.id },
    });
    return;
  }
  await appendStyleDelta(event.personaId, rule, kind);
}

export async function appendStyleDelta(
  personaId: string,
  rule: string,
  kind: "style_rule" | "guardrail"
): Promise<void> {
  const p = STYLE_DELTA_PATH(personaId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const line = `- ${rule} <!-- ${kind} ${new Date().toISOString().slice(0, 10)} -->\n`;
  const existing = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "# Style guide delta (from corrections)\n\n";
  if (!existing.includes(`- ${rule}`)) fs.writeFileSync(p, existing + line);
}

/** Read active style-delta rules for prompt assembly. */
export function readStyleDelta(personaId: string): string[] {
  const p = STYLE_DELTA_PATH(personaId);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.replace(/\s*<!--.*?-->\s*$/, "").slice(2).trim())
    .filter(Boolean);
}
