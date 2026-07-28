import { prisma } from "@/lib/db";
import { moduleCoverage, renderMeter } from "@/curriculum/curriculum";

/**
 * In-band status — one implementation for the CLI, the API, and the chat
 * channels: phase, per-module meter, memory size, pending queues.
 */

export interface StatusReport {
  personaName: string;
  packVersion: number;
  phase: "install" | "interviewing" | "synthesizing" | "active + improving";
  meter: string;
  propositions: number;
  pending: { clarifications: number; approvals: number; hotNotes: number; queuedJobs: number };
}

export async function statusReport(personaId: string, personaName: string, packVersion: number): Promise<StatusReport> {
  const [cov, open, hot, approvals, queued, props, fp] = await Promise.all([
    moduleCoverage(prisma),
    prisma.reconCase.count({ where: { personaId, status: "open" } }),
    prisma.hotNote.count({ where: { personaId, active: true } }),
    prisma.pendingApproval.count({ where: { personaId, status: "pending" } }),
    prisma.loopJob.count({ where: { status: "queued" } }),
    prisma.propositionPrivate
      .count({ where: { personaId } })
      .then(async (a) => a + (await prisma.propositionPublic.count({ where: { personaId } }))),
    prisma.styleFingerprint.findUnique({ where: { personaId } }),
  ]);
  const phase: StatusReport["phase"] =
    props === 0 ? "interviewing" : !fp || packVersion === 0 ? "synthesizing" : "active + improving";
  return {
    personaName,
    packVersion,
    phase,
    meter: renderMeter(cov),
    propositions: props,
    pending: { clarifications: open, approvals, hotNotes: hot, queuedJobs: queued },
  };
}

export function renderStatus(s: StatusReport): string {
  const p = s.pending;
  return [
    `${s.personaName} — ${s.phase} (pack v${s.packVersion})`,
    `Meter: ${s.meter}`,
    `Memory: ${s.propositions} propositions`,
    `Pending: ${p.clarifications} clarification${p.clarifications === 1 ? "" : "s"}, ${p.approvals} approval${p.approvals === 1 ? "" : "s"}, ${p.hotNotes} live correction${p.hotNotes === 1 ? "" : "s"}, ${p.queuedJobs} background job${p.queuedJobs === 1 ? "" : "s"}`,
  ].join("\n");
}

/** Pending items rendered for chat: approvals numbered for "approve N". */
export async function renderPending(personaId: string): Promise<string> {
  const [approvals, cards] = await Promise.all([
    prisma.pendingApproval.findMany({
      where: { personaId, status: "pending" },
      orderBy: { createdAt: "asc" },
    }),
    prisma.reconCase.findMany({
      where: { personaId, status: "open" },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const parts: string[] = [];
  if (approvals.length) {
    parts.push(
      "Rules I inferred, waiting for your yes/no (reply `approve N` or `reject N`):\n" +
        approvals.map((a, i) => `${i + 1}. [${a.kind.replace("_", " ")}] ${a.text}`).join("\n")
    );
  }
  if (cards.length) {
    parts.push(
      "Open clarifications (answer any in your own words):\n" +
        cards
          .map((c) => `• ${c.question ?? `"${c.oldText.slice(0, 80)}" vs "${c.newText.slice(0, 80)}"`}`)
          .join("\n")
    );
  }
  return parts.length ? parts.join("\n\n") : "Nothing pending — no approvals, no open clarifications.";
}

export async function decideApproval(
  personaId: string,
  index: number,
  approve: boolean
): Promise<string> {
  const approvals = await prisma.pendingApproval.findMany({
    where: { personaId, status: "pending" },
    orderBy: { createdAt: "asc" },
  });
  const a = approvals[index - 1];
  if (!a) return `No pending approval #${index}. Say "pending" to see the list.`;
  await prisma.pendingApproval.update({
    where: { id: a.id },
    data: { status: approve ? "approved" : "rejected", decidedAt: new Date() },
  });
  if (approve) {
    const { appendStyleDelta } = await import("./corrections");
    await appendStyleDelta(personaId, a.text, a.kind as "style_rule" | "guardrail");
  }
  return approve ? `Applied: ${a.text}` : `Dropped: ${a.text}`;
}
