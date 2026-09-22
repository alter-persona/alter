import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "../../src/lib/loadEnv";

/**
 * The from-zero interview, the archived-turn exclusion, and the sealed
 * benchmark, all against a throwaway persona on the real database, with no
 * model calls (generation and judging are stubbed).
 */

import { prisma } from "../../src/lib/db";
import {
  greeting,
  nextQuestion,
  renderQuestion,
  progress,
  saveLikert,
  saveTextAnswer,
  skipQuestion,
  interviewStatus,
  maybeAutoBuild,
} from "../../src/loop/interview";
import { loadSession } from "../../src/loop/session";
import { evalSealed } from "../../src/understudy/evaluate";
import type { ModeFingerprint } from "../../src/persona2/fingerprint";

const PERSONA_NAME = "interview-test-persona";
const SESSION_LABEL = "in-chat interview";
let personaId: string;
let tmpEval: string;

function fakeFp(mode: "spoken" | "written"): ModeFingerprint {
  return {
    mode, totalWords: 500,
    markerRates: [{ term: "basically", per1k: 3, baselinePer1k: 0.5, ratio: 6 }],
    fillerRates: [], hedges: [], intensifiers: [],
    sentence: { meanWords: 12, stdWords: 5 }, clauseOpeners: [],
    punctuation: { commasPerSentence: 1, dashesPer1k: 1, exclamationsPer1k: 0, questionsPer1k: 2 },
    listVsProseRatio: 0.05, collocations: [],
  };
}

async function cleanup(): Promise<void> {
  const p = await prisma.persona.findUnique({ where: { name: PERSONA_NAME } });
  if (!p) return;
  for (const table of ["UpdateEvent", "HotNote", "ReconCase", "RegressionCase", "CoverageGap", "PendingApproval", "LoopJob"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "personaId" = $1`, p.id);
  }
  await prisma.response.deleteMany({ where: { session: { personaId: p.id } } });
  await prisma.session.deleteMany({ where: { personaId: p.id } });
  await prisma.persona.delete({ where: { id: p.id } });
}

before(async () => {
  process.env.LOOP_QUEUE_MANUAL = "1";
  process.env.EMBED_FAKE = "1";
  await cleanup();
  personaId = (await prisma.persona.create({ data: { name: PERSONA_NAME } })).id;
  tmpEval = fs.mkdtempSync(path.join(os.tmpdir(), "alter-eval-"));
});

after(async () => {
  await cleanup();
  fs.rmSync(tmpEval, { recursive: true, force: true });
  await prisma.$disconnect();
});

test("interview: greeting, first question, answers and skips advance, sealed questions come last", async () => {
  const total = (await progress(personaId)).total;
  assert.ok(total >= 60, `curriculum seeded (${total} active questions)`);
  assert.match(greeting("Sam", total), new RegExp(`${total} questions across four modules`));

  const q1 = await nextQuestion(personaId);
  assert.ok(q1, "a first question exists");
  assert.equal(q1.isValidation, false, "the interview never opens with a sealed question");
  assert.match(renderQuestion(q1, 0, total, true), /^First module: who you are/);
  assert.match(renderQuestion(q1, 0, total, false), new RegExp(`Q1/${total}`));

  // Walk the whole curriculum with cheap answers: likert -> 3, voice -> skip.
  let seenValidation = false;
  let answered = 0;
  for (let guard = 0; guard < 200; guard++) {
    const q = await nextQuestion(personaId);
    if (!q) break;
    if (q.isValidation) seenValidation = true;
    else assert.equal(seenValidation, false, `non-sealed question ${q.orderIndex} surfaced after a sealed one`);
    if (q.type === "likert") await saveLikert(personaId, q, 3);
    else if (q.isValidation) await saveTextAnswer(personaId, q, `[interview-test] sealed answer ${q.orderIndex}`);
    else await skipQuestion(personaId, q);
    answered++;
  }
  assert.equal(answered, total, "every active question was consumed exactly once");
  assert.equal(await nextQuestion(personaId), null, "nothing left to ask");
  const p = await progress(personaId);
  assert.equal(p.answered, total);
  assert.equal(p.minutes, 0, "text and skips bank no spoken minutes");
  assert.equal(seenValidation, true, "the eight sealed questions were asked at the end");

  // Sealed text answers never enqueue ingestion: no propositions, no loop jobs.
  assert.equal(await prisma.propositionPrivate.count({ where: { personaId } }), 0);
  assert.equal(await prisma.loopJob.count({ where: { personaId } }), 0);

  const status = await interviewStatus(personaId);
  assert.match(status, new RegExp(`${total}/${total} answered`));
  assert.match(status, /builds automatically at \d+ spoken minutes \+ \d+ distilled memories/);
});

test("interview: auto-build waits below the gates and does nothing once a fingerprint exists", async () => {
  const announced: string[] = [];
  process.env.SKILL_MIN_VOICE_MINUTES = "30";
  process.env.SKILL_MIN_PROPS = "50";
  await maybeAutoBuild(personaId, "Sam", async (m) => { announced.push(m); });
  assert.equal(announced.length, 0, "gates not met: silent");

  await prisma.styleFingerprint.create({
    data: { personaId, spoken: fakeFp("spoken") as unknown as object, written: fakeFp("written") as unknown as object },
  });
  process.env.SKILL_MIN_VOICE_MINUTES = "0";
  process.env.SKILL_MIN_PROPS = "0";
  await maybeAutoBuild(personaId, "Sam", async (m) => { announced.push(m); });
  assert.equal(announced.length, 0, "already built: never rebuilds from the interview path");
});

test("session window excludes archived turns", async () => {
  const conversationId = "interview-test-archive";
  const mk = (kind: string, rawText: string, intentSource = "hint") =>
    prisma.updateEvent.create({ data: { personaId, channel: "playground", conversationId, kind, rawText, intent: "chat", intentSource, status: "none_needed" } });
  await mk("text", "user said this");
  await mk("text", "persona confabulated: I am a static snapshot", "persona_turn");
  await prisma.updateEvent.updateMany({ where: { conversationId, rawText: { startsWith: "persona confabulated" } }, data: { kind: "text_archived" } });
  await mk("text", "persona answered properly", "persona_turn");
  const s = await loadSession(conversationId);
  assert.deepEqual(s.turns.map((t) => t.content), ["user said this", "persona answered properly"]);
  assert.equal(s.turns[1].role, "assistant");
});

test("sealed benchmark: judges the persona's own sealed answers and never leaks them into the prompt", async () => {
  const sealed = await prisma.question.findMany({ where: { isValidation: true }, orderBy: { orderIndex: "asc" } });
  assert.equal(sealed.length, 8);
  const realAnswers = await prisma.response.findMany({ where: { session: { personaId, label: SESSION_LABEL }, question: { isValidation: true } }, select: { transcript: true } });
  assert.equal(realAnswers.length, 8, "the walk above stored eight sealed answers for this persona");

  const prompts: string[] = [];
  const r = await evalSealed(personaId, "Sam", {
    evalDir: tmpEval,
    generate: async (system, user) => { prompts.push(system + "\n" + user); return "I would call them straight away and listen first."; },
    judge: async (_system, user) => JSON.stringify({ agrees: user.includes("[interview-test] sealed answer"), rationale: "stub judge" }),
  });
  assert.equal(r.judged, 8);
  assert.equal(r.agreed, 8, "the judge saw this persona's own sealed transcripts");
  assert.equal(prompts.length, 8, "one generation per sealed question");
  for (const p of prompts) assert.ok(!p.includes("[interview-test] sealed answer"), "sealed answers stay out of the persona prompt");
  assert.ok(fs.existsSync(path.join(tmpEval, "sealed-report.md")));
  assert.ok(fs.existsSync(path.join(tmpEval, "blind-sheet.md")));
  assert.ok(fs.existsSync(path.join(tmpEval, "blind-sheet-key.md")));
  const report = fs.readFileSync(path.join(tmpEval, "sealed-report.md"), "utf8");
  assert.match(report, /Decision agreement: 8\/8/);
});
