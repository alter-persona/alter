import { prisma } from "@/lib/db";
import { ngramSet, longestSharedRun, COPY_FLAG_NGRAM } from "@/persona2/copydetect";
import { burrowsDelta, selfDistance } from "@/persona2/delta";
import { ownTextByMode } from "@/persona2/fingerprint";
import { tokenize } from "@/persona2/lexicon";
import { loopConfig } from "./config";

/**
 * Drift control. Every N processed events (or on demand):
 *   - replay the full regression suite (mechanical checks — a reintroduced
 *     rejected output is caught by 8-gram overlap; corrected facts must
 *     surface by keyword coverage)
 *   - re-run the sealed-question harness (Burrows's Delta vs the calibrated
 *     self-distance band, copy rate)
 * Results land on the scoreboard so improvement or drift is a trend line;
 * a previously-passing regression case that starts failing is flagged.
 */

export type Generate = (question: string) => Promise<string>;

const OLLAMA = () => process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const TALK_MODEL = () => process.env.TALK_MODEL ?? "local-small:latest";

async function defaultGenerate(personaId: string, personaName: string): Promise<Generate> {
  const { runChatTurn } = await import("./runtime");
  return async (question: string) => {
    const turn = await runChatTurn({
      personaId,
      personaName,
      channel: "playground",
      conversationId: `spotcheck-${Date.now().toString(36)}`,
      message: question,
      userEventId: (
        await prisma.updateEvent.create({
          data: {
            personaId,
            channel: "playground",
            conversationId: "spotcheck",
            kind: "text",
            rawText: question,
            intent: "chat",
            intentSource: "hint",
            status: "none_needed",
          },
        })
      ).id,
      history: [],
      mode: "written",
      generate: async (system, user) => {
        const res = await fetch(`${OLLAMA()}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: TALK_MODEL(),
            stream: false,
            think: false,
            options: { num_predict: 300 },
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
          }),
        });
        if (!res.ok) throw new Error(`LLM ${res.status}`);
        return (((await res.json()) as { message?: { content?: string } }).message?.content ?? "").trim();
      },
    });
    return turn.reply;
  };
}

function keywords(text: string, subjectName?: string): string[] {
  const stop = new Set([
    "the", "and", "that", "this", "with", "from", "have", "has", "was", "were", "his", "her",
    "their", "about", "would", "will", "not", "for", "are", "but", "now", "when",
    ...(subjectName ? subjectName.toLowerCase().split(/\s+/) : []),
  ]);
  return [...new Set(tokenize(text.toLowerCase()).filter((w) => w.length > 3 && !stop.has(w)))];
}

export interface RegressionResult {
  caseId: string;
  kind: string;
  pass: boolean;
  reason: string;
  newlyFailing: boolean;
}

export async function replayRegressions(
  personaId: string,
  generate: Generate
): Promise<RegressionResult[]> {
  const personaRow = await prisma.persona.findUnique({ where: { id: personaId } });
  const subjectName = personaRow?.name;
  const cases = await prisma.regressionCase.findMany({ where: { personaId }, orderBy: { createdAt: "asc" } });
  const out: RegressionResult[] = [];
  for (const c of cases) {
    let reply: string;
    try {
      reply = await generate(c.triggerInput);
    } catch (e) {
      out.push({ caseId: c.id, kind: c.kind, pass: false, reason: `generate failed: ${String(e).slice(0, 80)}`, newlyFailing: c.lastResult === "pass" });
      continue;
    }
    // 1. The rejected output must not be reintroduced (8-gram overlap).
    const rejectedNgrams = ngramSet([c.rejectedOutput], COPY_FLAG_NGRAM);
    const run = rejectedNgrams.size > 0 ? longestSharedRun(reply, rejectedNgrams) : 0;
    let pass = run < COPY_FLAG_NGRAM;
    let reason = pass ? "no rejected-output overlap" : `reintroduced ${run}-word run of rejected output`;
    // 2. Factual/position corrections: the corrected substance must surface.
    if (pass && (c.kind === "factual" || c.kind === "position")) {
      const kws = keywords(c.correctedOutput, subjectName);
      if (kws.length >= 2) {
        const replyLower = reply.toLowerCase();
        const hit = kws.filter((k) => replyLower.includes(k)).length / kws.length;
        pass = hit >= 0.3;
        reason = pass ? `corrected substance present (${Math.round(hit * 100)}% keywords)` : `corrected substance missing (${Math.round(hit * 100)}% keywords)`;
      }
    }
    out.push({ caseId: c.id, kind: c.kind, pass, reason, newlyFailing: !pass && c.lastResult === "pass" });
    await prisma.regressionCase.update({
      where: { id: c.id },
      data: { lastResult: pass ? "pass" : "fail", lastRunAt: new Date() },
    });
  }
  return out;
}

export interface SpotCheckReport {
  regressions: { total: number; passed: number; newlyFailing: string[] };
  sealed: { count: number; delta: number | null; deltaSelf: number | null; withinBand: boolean | null; copyFlagRatePct: number | null };
}

export async function runSpotCheck(
  personaId: string,
  personaName: string,
  generate?: Generate
): Promise<SpotCheckReport> {
  const gen = generate ?? (await defaultGenerate(personaId, personaName));

  const reg = await replayRegressions(personaId, gen);
  const newlyFailing = reg.filter((r) => r.newlyFailing).map((r) => r.caseId);

  // Sealed-question harness: the blind discrimination sheet's questions.
  const sealedQs = await prisma.question.findMany({
    where: { isValidation: true },
    orderBy: { orderIndex: "asc" },
    select: { promptText: true },
  });
  let sealed: SpotCheckReport["sealed"] = { count: sealedQs.length, delta: null, deltaSelf: null, withinBand: null, copyFlagRatePct: null };
  if (sealedQs.length > 0) {
    const replies: string[] = [];
    for (const q of sealedQs) {
      try {
        replies.push(await gen(q.promptText));
      } catch {
        /* skip */
      }
    }
    if (replies.length >= 3) {
      const { spoken, written } = await ownTextByMode(personaId);
      const ownDocs = [...spoken.split(/\n{2,}/), ...written.split(/\n{2,}/)].filter((d) => tokenize(d).length > 60);
      const { delta: deltaSelf, stats } = selfDistance(ownDocs);
      const delta = burrowsDelta(replies.join("\n\n"), ownDocs.join("\n"), stats);
      const corpusNgrams = ngramSet([spoken, written], COPY_FLAG_NGRAM);
      const flagged = replies.filter((r) => longestSharedRun(r, corpusNgrams) >= COPY_FLAG_NGRAM).length;
      sealed = {
        count: replies.length,
        delta: Number(delta.toFixed(3)),
        deltaSelf: Number(deltaSelf.toFixed(3)),
        withinBand: delta <= deltaSelf * 1.35,
        copyFlagRatePct: Number(((flagged / replies.length) * 100).toFixed(1)),
      };
    }
  }

  const report: SpotCheckReport = {
    regressions: { total: reg.length, passed: reg.filter((r) => r.pass).length, newlyFailing },
    sealed,
  };
  await prisma.scoreboardEntry.create({
    data: { personaId, kind: "spot_check", metrics: report as unknown as object },
  });
  if (newlyFailing.length > 0) {
    console.warn(`[loop] ALERT: ${newlyFailing.length} regression case(s) that previously passed now fail: ${newlyFailing.join(", ")}`);
  }
  return report;
}

/** Cadence check, called after each distilled event. Fires the spot check
 * only when the counter crosses the configured threshold. */
export async function maybeSpotCheck(personaId: string): Promise<void> {
  const cfg = loopConfig();
  const last = await prisma.scoreboardEntry.findFirst({
    where: { personaId, kind: "spot_check" },
    orderBy: { runAt: "desc" },
  });
  const since = last?.runAt ?? new Date(0);
  const processed = await prisma.updateEvent.count({
    where: { personaId, status: "distilled", createdAt: { gt: since } },
  });
  if (processed < cfg.spotCheckEveryEvents) return;
  const persona = await prisma.persona.findUnique({ where: { id: personaId } });
  if (!persona) return;
  await runSpotCheck(personaId, persona.name);
}
