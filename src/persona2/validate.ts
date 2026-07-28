import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { checkCopy, ngramSet, COPY_FLAG_NGRAM } from "./copydetect";
import { burrowsDelta, profileStats, selfDistance } from "./delta";
import { routeIntent } from "./gate";
import { retrievePropositions, retrieveEpisodic } from "./retrieve";
import { renderPersonaCore, renderResponseContract, buildPrompt, buildRecallPrompt } from "./prompt";
import { ownTextByMode } from "./fingerprint";
import { ratePer1k, tokenize } from "./lexicon";
import type { ModeFingerprint } from "./fingerprint";
import type { Exemplar } from "./exemplars";

/**
 * Validation harness: makes parroting a number. Copy rate (8-gram), Burrows's
 * Delta vs a self-distance-calibrated band, marker calibration for spoken
 * mode, and a v1-vs-v2 A/B over a fixed 20-question battery.
 */

const HARNESS_MODEL = () => process.env.PERSONA2_HARNESS_MODEL ?? "local-small:latest";
const OLLAMA = () => process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";

export interface BatteryItem {
  q: string;
  intent: "knowledge" | "explicit_recall" | "smalltalk";
  mode: "spoken" | "written";
}

export const BATTERY: BatteryItem[] = [
  { q: "What do you think makes a life well lived?", intent: "knowledge", mode: "written" },
  { q: "How would you handle a colleague taking credit for your work?", intent: "knowledge", mode: "written" },
  { q: "What matters more to you, craft or speed?", intent: "knowledge", mode: "spoken" },
  { q: "Tell me about where you grew up.", intent: "knowledge", mode: "spoken" },
  { q: "What's your take on AI replacing jobs in the next decade?", intent: "knowledge", mode: "written" },
  { q: "Would you rather lead a big team or build alone?", intent: "knowledge", mode: "written" },
  { q: "What's a belief you hold that most people around you don't?", intent: "knowledge", mode: "spoken" },
  { q: "How do you decide when to quit something?", intent: "knowledge", mode: "written" },
  { q: "What would you do with a completely free month?", intent: "knowledge", mode: "written" },
  { q: "Should kids learn to code? Why or why not?", intent: "knowledge", mode: "written" },
  { q: "What kind of manager gets the best out of you?", intent: "knowledge", mode: "written" },
  { q: "Is remote work good for people like you?", intent: "knowledge", mode: "spoken" },
  { q: "What's something you changed your mind about recently?", intent: "knowledge", mode: "written" },
  { q: "How do you deal with stress when everything hits at once?", intent: "knowledge", mode: "spoken" },
  { q: "What's your honest opinion of social media?", intent: "knowledge", mode: "written" },
  { q: "If you moved countries tomorrow, where and why?", intent: "knowledge", mode: "written" },
  { q: "What exactly did you say about your first computer?", intent: "explicit_recall", mode: "written" },
  { q: "What did you say in your interview about losing respect for people?", intent: "explicit_recall", mode: "written" },
  { q: "hey, how's it going?", intent: "smalltalk", mode: "spoken" },
  { q: "thanks, that makes sense", intent: "smalltalk", mode: "written" },
];

async function ollamaChat(system: string, user: string): Promise<string> {
  const res = await fetch(`${OLLAMA()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: HARNESS_MODEL(),
      stream: false,
      think: false,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const json = (await res.json()) as { message?: { content?: string } };
  return (json.message?.content ?? "").trim();
}

/** v1 arm: the old skill construction — persona pack (raw voice text) + rules. */
function v1Prompt(packText: string, name: string): string {
  return `# persona — speak as ${name}\n\nYou are a persona emulation of ${name}, built from their own interview answers, chat history, and writing. Reply AS ${name}, first person, in their voice.\n\nGround everything in the material below.\n\n# Source material\n\n${packText}`;
}

export interface ReplyMetrics {
  question: string;
  intent: string;
  reply: string;
  copyVsCorpus: number;
  copyVsNotes: number;
  flagged: boolean;
}

export interface ArmReport {
  arm: "v1" | "v2";
  replies: ReplyMetrics[];
  copyFlagRatePct: number;
  meanLongestRun: number;
  delta: number;
  deltaSelf: number;
  deltaWithinBand: boolean;
  markerCalibration: { term: string; target: number; generated: number; withinTolerance: boolean }[];
}

export async function runBattery(personaId: string, personaName: string): Promise<{ v1: ArmReport; v2: ArmReport; reportPath: string }> {
  // Corpus n-gram set for copy detection (raw own text, all of it).
  const { spoken, written } = await ownTextByMode(personaId);
  const corpusNgrams = ngramSet([spoken, written], COPY_FLAG_NGRAM);

  // Delta calibration from own docs.
  const ownDocs = [
    ...spoken.split(/\n{2,}/).filter((d) => tokenize(d).length > 60),
    ...written.split(/\n{2,}/).filter((d) => tokenize(d).length > 60),
  ];
  const { delta: deltaSelf, stats } = selfDistance(ownDocs);
  const ownAll = ownDocs.join("\n");

  const fpRow = await prisma.styleFingerprint.findUnique({ where: { personaId } });
  const spokenFp = fpRow?.spoken as unknown as ModeFingerprint | undefined;
  const writtenFp = fpRow?.written as unknown as ModeFingerprint | undefined;
  const exemplarsPath = path.join(process.cwd(), "corpus", "persona2", personaId, "exemplars.json");
  const exemplars: Exemplar[] = fs.existsSync(exemplarsPath)
    ? JSON.parse(fs.readFileSync(exemplarsPath, "utf8"))
    : [];
  const packText = fs.readFileSync(path.join(process.cwd(), "corpus", "persona-pack.md"), "utf8");

  const values: string[] = [];
  const heuristics: string[] = [];
  for (const t of ["belief", "preference", "insight"]) {
    const rows = await prisma.propositionPrivate.findMany({
      where: { personaId, type: t, strength: t === "insight" ? undefined : "strong" },
      take: 4,
      select: { text: true },
    });
    values.push(...rows.map((r) => r.text));
  }
  heuristics.push(
    ...(
      await prisma.propositionPrivate.findMany({
        where: { personaId, type: "decision_heuristic" },
        take: 8,
        select: { text: true },
      })
    ).map((r) => r.text)
  );

  const arms: { v1: ReplyMetrics[]; v2: ReplyMetrics[] } = { v1: [], v2: [] };
  const spokenReplies: { arm: "v1" | "v2"; text: string }[] = [];

  for (const item of BATTERY) {
    // --- v1 arm ---
    const r1 = await ollamaChat(v1Prompt(packText, personaName), item.q).catch((e) => `[generation failed: ${e}]`);
    const c1 = checkCopy(r1, corpusNgrams);
    arms.v1.push({
      question: item.q,
      intent: item.intent,
      reply: r1,
      copyVsCorpus: c1.longestRun,
      copyVsNotes: 0,
      flagged: c1.flagged,
    });
    if (item.mode === "spoken") spokenReplies.push({ arm: "v1", text: r1 });

    // --- v2 arm: gate → retrieve → position-disciplined prompt ---
    const intent = routeIntent(item.q);
    const fp = (item.mode === "spoken" ? spokenFp : writtenFp)!;
    const core = renderPersonaCore({ name: personaName, values: values.slice(0, 8), heuristics, fingerprint: fp, mode: item.mode });
    let system = core;
    let user: string;
    let notesTexts: string[] = [];
    if (intent === "explicit_recall") {
      const eps = await retrieveEpisodic(personaId, item.q, { k: 3 });
      notesTexts = eps.map((e) => e.text);
      const p = buildRecallPrompt({ core, episodic: eps, question: item.q });
      system = p.system;
      user = p.user;
    } else {
      const notes = intent === "knowledge" ? await retrievePropositions(personaId, item.q, { k: 4 }) : [];
      notesTexts = notes.map((n) => n.text);
      const p = buildPrompt({
        core,
        notes,
        contract: renderResponseContract({ name: personaName, voiceNote: item.mode === "spoken" }),
        exemplars,
        mode: item.mode,
        question: item.q,
      });
      system = p.system;
      user = p.user;
    }
    const r2 = await ollamaChat(system, user).catch((e) => `[generation failed: ${e}]`);
    const noteNgrams = ngramSet(notesTexts, COPY_FLAG_NGRAM);
    const c2c = checkCopy(r2, corpusNgrams);
    const c2n = checkCopy(r2, noteNgrams);
    // Recall intent legitimately quotes — do not flag corpus copies there.
    const flagged = intent === "explicit_recall" ? false : c2c.flagged || c2n.flagged;
    arms.v2.push({
      question: item.q,
      intent,
      reply: r2,
      copyVsCorpus: c2c.longestRun,
      copyVsNotes: c2n.longestRun,
      flagged,
    });
    if (item.mode === "spoken") spokenReplies.push({ arm: "v2", text: r2 });
  }

  const mkReport = (arm: "v1" | "v2"): ArmReport => {
    const replies = arms[arm];
    const genAll = replies.map((r) => r.reply).join("\n");
    const delta = burrowsDelta(genAll, ownAll, stats);
    const spokenGen = spokenReplies.filter((s) => s.arm === arm).map((s) => s.text).join("\n");
    const genTokens = tokenize(spokenGen);
    const markerCalibration = (spokenFp?.fillerRates ?? [])
      .filter((f) => f.per1k >= 1)
      .slice(0, 6)
      .map((f) => {
        const generated = Number(ratePer1k(genTokens, f.term).toFixed(2));
        return {
          term: f.term,
          target: f.per1k,
          generated,
          withinTolerance: generated >= f.per1k * 0.7 && generated <= f.per1k * 1.3,
        };
      });
    const flaggedCount = replies.filter((r) => r.flagged).length;
    return {
      arm,
      replies,
      copyFlagRatePct: Number(((flaggedCount / replies.length) * 100).toFixed(1)),
      meanLongestRun: Number(
        (replies.reduce((a, r) => a + Math.max(r.copyVsCorpus, r.copyVsNotes), 0) / replies.length).toFixed(1)
      ),
      delta: Number(delta.toFixed(3)),
      deltaSelf: Number(deltaSelf.toFixed(3)),
      deltaWithinBand: delta <= deltaSelf * 1.5,
      markerCalibration,
    };
  };

  const v1 = mkReport("v1");
  const v2 = mkReport("v2");

  const dir = path.join(process.cwd(), "corpus", "persona2", personaId);
  fs.mkdirSync(dir, { recursive: true });
  const reportPath = path.join(dir, "ab-report.md");
  fs.writeFileSync(path.join(dir, "ab-report.json"), JSON.stringify({ v1, v2 }, null, 2));
  fs.writeFileSync(reportPath, renderAbReport(v1, v2));
  return { v1, v2, reportPath };
}

function renderAbReport(v1: ArmReport, v2: ArmReport): string {
  const row = (label: string, a: string | number, b: string | number) => `| ${label} | ${a} | ${b} |`;
  const mc = (r: ArmReport) =>
    r.markerCalibration.length
      ? r.markerCalibration.map((m) => `${m.term}: ${m.generated}/1k vs target ${m.target}/1k ${m.withinTolerance ? "OK" : "OFF"}`).join("; ")
      : "—";
  return `# Persona encoding A/B — v1 (raw-chunk voice pack) vs v2 (propositions + fingerprint)

Generated ${new Date().toISOString()} · model ${HARNESS_MODEL()} · ${BATTERY.length}-question battery

| metric | v1 | v2 |
|---|---|---|
${row("copy flag rate (replies with ≥8-word verbatim run)", v1.copyFlagRatePct + "%", v2.copyFlagRatePct + "%")}
${row("mean longest verbatim run (words)", v1.meanLongestRun, v2.meanLongestRun)}
${row("Burrows's Delta vs own text", v1.delta, v2.delta)}
${row("self-distance (calibration)", v1.deltaSelf, v2.deltaSelf)}
${row("Delta within 1.5x self-distance", v1.deltaWithinBand ? "YES" : "NO", v2.deltaWithinBand ? "YES" : "NO")}

Target: copy flag rate under 5%. Marker calibration (spoken): v1 — ${mc(v1)}; v2 — ${mc(v2)}.

## Blind discrimination
Not automatable honestly. Manual protocol: mix 10 generated replies with 10 real
passages, have a reader who knows the person label each real/fake; a score near 50%
means indistinguishable. Record results here per run.

## Per-reply detail (v2 flags)
${v2.replies.filter((r) => r.flagged).map((r) => `- FLAGGED (run ${Math.max(r.copyVsCorpus, r.copyVsNotes)}w): "${r.question}"`).join("\n") || "- none flagged"}
`;
}
