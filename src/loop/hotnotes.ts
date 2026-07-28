import { prisma } from "@/lib/db";
import { loopConfig } from "./config";

/**
 * Hot notes: the bridge between a correction landing and its distilled update
 * going live. Written synchronously in tier 1 (verbatim-trimmed instruction —
 * fine, because notes are INSTRUCTIONS in the prompt, never embedded content),
 * refined by tier-2 distillation, retired when the deeper update is live.
 */

export async function writeHotNote(
  personaId: string,
  sourceEventId: string,
  note: string
): Promise<{ id: string; note: string }> {
  const cap = loopConfig().hotNoteCap;
  const created = await prisma.hotNote.create({
    data: { personaId, sourceEventId, note: note.trim().slice(0, 240) },
  });
  // Enforce the cap: retire the oldest active notes beyond it.
  const active = await prisma.hotNote.findMany({
    where: { personaId, active: true },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (active.length > cap) {
    const excess = active.slice(cap).map((n) => n.id);
    await prisma.hotNote.updateMany({
      where: { id: { in: excess } },
      data: { active: false, retiredAt: new Date() },
    });
  }
  return { id: created.id, note: created.note };
}

export async function retireHotNotesForEvent(personaId: string, sourceEventId: string): Promise<void> {
  await prisma.hotNote.updateMany({
    where: { personaId, sourceEventId, active: true, pendingCaseId: null },
    data: { active: false, retiredAt: new Date() },
  });
}

export async function retireHotNotesForCase(caseId: string): Promise<void> {
  await prisma.hotNote.updateMany({
    where: { pendingCaseId: caseId, active: true },
    data: { active: false, retiredAt: new Date() },
  });
}

/**
 * Render the injection block for the reply path. Placed at the END of the
 * user message (strongest attention position) immediately before the response
 * contract — these must change behavior on this very turn.
 */
export async function renderHotNotes(personaId: string): Promise<string> {
  const notes = await prisma.hotNote.findMany({
    where: { personaId, active: true },
    orderBy: { createdAt: "desc" },
    take: loopConfig().hotNoteCap,
  });
  if (notes.length === 0) return "";
  const lines = notes.map(
    (n) =>
      `- [hn-${n.id.slice(0, 4)}] ${n.note}${n.pendingCaseId ? " (a deeper reconciliation is still open — behave per this note meanwhile)" : ""}`
  );
  return `## Live corrections from the real person — instructions to APPLY, never content to recite or claim as memory
These are recent corrections/instructions from the real person. They override memory notes and defaults when they conflict. Do not mention them unless asked.

${lines.join("\n")}`;
}
