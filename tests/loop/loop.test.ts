import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import "../../src/lib/loadEnv";

/**
 * Improvement-loop acceptance tests. Runs with REAL embeddings (bge-small,
 * already cached locally) so paraphrase retrieval is genuinely exercised, and
 * with stubbed LLMs everywhere:
 *   - loop LLM calls (classify / correction-typing / reconciliation) via
 *     setLoopLlmForTests, dispatched on the system prompt
 *   - the corpus distill provider via an in-test OpenAI-compatible HTTP mock
 * Everything runs against an isolated test persona, cleaned up afterwards.
 */

import { prisma } from "../../src/lib/db";
import { setLoopLlmForTests } from "../../src/loop/llm";
import { ingestInbound } from "../../src/loop/ingest";
import { drainLoopQueue } from "../../src/loop/queue";
import { runChatTurn, routeClarificationAnswer } from "../../src/loop/runtime";
import { retrievePropositions } from "../../src/persona2/retrieve";
import { isPastFramed } from "../../src/persona2/gate";
import { storeProposition } from "../../src/persona2/distill";
import { replayRegressions } from "../../src/loop/drift";
import { renderHotNotes } from "../../src/loop/hotnotes";
import { resetSealedCacheForTests } from "../../src/loop/sealed";
import type { ModeFingerprint } from "../../src/persona2/fingerprint";

const PERSONA_NAME = "loop-test-persona";
let personaId: string;
let mockServer: http.Server;
let mockPort: number;
let llmCalls = 0;

// ── Stub LLM dispatch, keyed on the system prompt ──────────────────────────
type Handler = (system: string, user: string) => string | null;
let overrides: Handler[] = [];

async function stubLlm(system: string, user: string): Promise<string> {
  llmCalls++;
  for (const h of overrides) {
    const r = h(system, user);
    if (r !== null) return r;
  }
  if (system.startsWith("You classify one inbound message")) {
    return JSON.stringify({ intent: "chat", confidence: 0.3 });
  }
  if (system.startsWith("A real person corrected")) {
    return JSON.stringify({
      type: "factual",
      distilledNote: "Apply the correction.",
      correctedVersion: null,
      correctedFact: null,
      generalRule: null,
      inferred: false,
      topics: [],
    });
  }
  if (system.startsWith("You are reconciling")) {
    return JSON.stringify({
      conflict: true,
      outcome: "evolve",
      confidence: 0.9,
      merged: null,
      changeNote: null,
      question: null,
      reasoning: "stub",
    });
  }
  throw new Error(`stub LLM: unknown system prompt: ${system.slice(0, 60)}`);
}

// ── Mock OpenAI-compatible server for the corpus distill provider ──────────
// Returns propositions about Sam's job for any distill batch.
function startMockServer(): Promise<void> {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body) as { messages: { role: string; content: string }[] };
        const user = parsed.messages.find((m) => m.role === "user")?.content ?? "";
        const ids = [...user.matchAll(/\[sourceId: ([^\]]+)\]/g)].map((m) => m[1]);
        const content = JSON.stringify({
          items: ids.map((sourceId) => ({
            sourceId,
            propositions: [
              { text: "Sam leads the platform engineering group at Acme.", type: "fact", strength: "strong", topics: ["career"] },
              { text: "Sam's group is responsible for internal data infrastructure.", type: "fact", strength: "moderate", topics: ["career"] },
            ],
          })),
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    mockServer.listen(0, "127.0.0.1", () => {
      mockPort = (mockServer.address() as { port: number }).port;
      resolve();
    });
  });
}

function fakeFp(mode: "spoken" | "written"): ModeFingerprint {
  return {
    mode,
    totalWords: 1000,
    markerRates: [{ term: "basically", per1k: 3, baselinePer1k: 0.5, ratio: 6 }],
    fillerRates: [],
    hedges: [],
    intensifiers: [],
    sentence: { meanWords: 14, stdWords: 6 },
    clauseOpeners: [],
    punctuation: { commasPerSentence: 1, dashesPer1k: 1, exclamationsPer1k: 0, questionsPer1k: 2 },
    listVsProseRatio: 0.05,
    collocations: [],
  };
}

async function cleanup(): Promise<void> {
  const p = await prisma.persona.findUnique({ where: { name: PERSONA_NAME } });
  if (!p) return;
  for (const table of [
    "UpdateEvent", "HotNote", "ReconCase", "ExemplarPair", "RegressionCase",
    "CoverageGap", "PendingApproval", "LoopJob", "ScoreboardEntry",
  ]) {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "personaId" = $1`, p.id);
  }
  // Sealed test question/responses (created in the sealed test).
  await prisma.response.deleteMany({ where: { question: { promptText: { startsWith: "[loop-test]" } } } });
  await prisma.session.deleteMany({ where: { label: "loop-test-session" } });
  await prisma.question.deleteMany({ where: { promptText: { startsWith: "[loop-test]" } } });
  await prisma.persona.delete({ where: { id: p.id } }); // cascades chunks/props/fingerprint
}

before(async () => {
  delete process.env.EMBED_FAKE; // real embeddings for paraphrase retrieval
  process.env.LOOP_QUEUE_MANUAL = "1"; // tests drain explicitly — no background races
  await startMockServer();
  process.env.CORPUS_LLM_PROVIDER = "openai_compatible";
  process.env.CORPUS_LLM_URL = `http://127.0.0.1:${mockPort}/v1`;
  process.env.CORPUS_LLM_MODEL = "mock";
  delete process.env.PERSONA2_DISTILL_MODEL;
  setLoopLlmForTests(stubLlm);
  await cleanup();
  const p = await prisma.persona.create({ data: { name: PERSONA_NAME } });
  personaId = p.id;
  await prisma.styleFingerprint.create({
    data: { personaId, spoken: fakeFp("spoken") as unknown as object, written: fakeFp("written") as unknown as object },
  });
});

after(async () => {
  setLoopLlmForTests(null);
  await cleanup();
  mockServer.close();
  await prisma.$disconnect();
});

const echoGenerate = async (_s: string, u: string) => `reply. [[PROMPT:${u}]]`;

// 1 ─ A factual correction changes the very next turn through hot notes,
//     before any embedding has run.
test("correction shapes the next turn via hot notes before distillation", async () => {
  const r = await ingestInbound({
    personaId,
    channel: "playground",
    conversationId: "c1",
    kind: "text",
    text: "No, actually my job title is Head of Platform now, not engineer.",
    intentHint: "correction",
  });
  assert.equal(r.intent, "correction");
  assert.ok(r.hotNote, "hot note written synchronously");

  // The job is still queued — nothing embedded yet.
  const queued = await prisma.loopJob.count({ where: { eventId: r.eventId, status: "queued" } });
  assert.equal(queued, 1);

  const turn = await runChatTurn({
    personaId,
    personaName: "Sam",
    channel: "playground",
    conversationId: "c1",
    message: "what do you do for work?",
    userEventId: r.eventId,
    history: [],
    generate: echoGenerate,
  });
  assert.match(turn.reply, /Head of Platform/i, "hot note injected into the assembled prompt");
});

// 2+4 ─ After distillation: corrected mutable fact retrieves, superseded chunk
//       does not, hot note retired; the mutable case auto-resolved without asking.
test("mutable fact correction distills, auto-resolves on recency, retires hot note", async () => {
  const oldId = await storeProposition(personaId, {
    text: "Sam works as a staff engineer at OldCo.",
    type: "fact",
    strength: "strong",
    topics: ["job", "career"],
    date: new Date("2025-01-01"),
    sensitivity: "private",
    sourceOrigins: ["seed:old-job"],
  });

  const r = await ingestInbound({
    personaId,
    channel: "playground",
    conversationId: "c2",
    kind: "text",
    text: "Actually, I'm Head of Platform at NewCo these days.",
    intentHint: "correction",
    replyToEventId: null,
  });

  overrides = [
    (system) =>
      system.startsWith("A real person corrected")
        ? JSON.stringify({
            type: "factual",
            distilledNote: "Sam is Head of Platform at NewCo, not a staff engineer at OldCo.",
            correctedVersion: null,
            correctedFact: "Sam holds the position of Head of Platform at NewCo.",
            generalRule: null,
            inferred: false,
            topics: ["job", "career"],
          })
        : null,
  ];
  await drainLoopQueue();
  overrides = [];

  // Reconciliation auto-resolved (mutable tier, recency) and was logged.
  const kase = await prisma.reconCase.findFirst({ where: { personaId, oldPropId: oldId } });
  assert.ok(kase, "recon case created");
  assert.equal(kase!.status, "auto_resolved");
  assert.equal(kase!.resolution, "evolve");

  // Old chunk out of default retrieval; corrected fact in.
  const notes = await retrievePropositions(personaId, "what's your role at work these days?", { k: 4 });
  assert.ok(notes.some((n) => /Head of Platform at NewCo/.test(n.text)), "corrected fact retrieves");
  assert.ok(!notes.some((n) => n.id === oldId), "superseded/historical chunk no longer retrieves");

  // Hot note retired once live.
  const active = await prisma.hotNote.count({ where: { personaId, sourceEventId: r.eventId, active: true } });
  assert.equal(active, 0, "hot note retired after distillation");
});

// 5 ─ Historical chunks excluded by default, returned for past-framed questions.
test("historical chunks retrieve only for past-framed questions", async () => {
  const q = "what did you used to think about your old job?";
  assert.equal(isPastFramed(q), true);
  assert.equal(isPastFramed("what's your job now?"), false);

  const old = await prisma.propositionPrivate.findFirst({
    where: { personaId, text: { contains: "OldCo" }, status: "historical" },
  });
  assert.ok(old, "evolve marked the old chunk historical with its period preserved");
  assert.ok(old!.period, "period recorded");

  const defaultNotes = await retrievePropositions(personaId, "staff engineer OldCo role", { k: 5 });
  assert.ok(!defaultNotes.some((n) => n.id === old!.id), "not in default retrieval");
  const pastNotes = await retrievePropositions(personaId, "staff engineer OldCo role", { k: 5, includeHistorical: true });
  assert.ok(pastNotes.some((n) => n.id === old!.id), "returned when past-framed");
});

// 3 ─ Trait-level contradiction: no silent overwrite → in-chat clarification →
//     answer produces a merged chunk linked to both parents.
test("trait contradiction asks, and the answer produces a merged augment chunk", async () => {
  const extro = await storeProposition(personaId, {
    text: "Sam describes himself as an extrovert who recharges around people.",
    type: "belief",
    strength: "moderate",
    topics: ["personality"],
    date: new Date("2025-06-01"),
    sensitivity: "private",
    sourceOrigins: ["seed:extrovert"],
  });

  const r = await ingestInbound({
    personaId,
    channel: "playground",
    conversationId: "c3",
    kind: "text",
    text: "No — I am an introvert.",
    intentHint: "correction",
  });

  overrides = [
    (system) =>
      system.startsWith("A real person corrected")
        ? JSON.stringify({
            type: "position",
            distilledNote: "Sam identifies as an introvert.",
            correctedVersion: null,
            correctedFact: "Sam identifies as an introvert.",
            generalRule: null,
            inferred: false,
            topics: ["personality"],
          })
        : null,
    (system) =>
      system.startsWith("You are reconciling")
        ? JSON.stringify({
            conflict: true,
            outcome: "replace", // model may propose anything — code must clamp core to ask
            confidence: 0.95,
            merged: null,
            changeNote: null,
            question: "Earlier you described recharging around people, and just now you called yourself an introvert — is it situational, did it change, or did I have it wrong?",
            reasoning: "stub",
          })
        : null,
  ];
  await drainLoopQueue();
  overrides = [];

  const kase = await prisma.reconCase.findFirst({
    where: { personaId, oldPropId: extro },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(kase);
  assert.equal(kase!.tier, "core");
  assert.equal(kase!.status, "open", "core tier NEVER auto-resolves, even on direct correction");
  assert.ok(kase!.question);

  // Extrovert chunk untouched while open — no silent overwrite.
  const stillActive = await prisma.propositionPrivate.findUnique({ where: { id: extro } });
  assert.equal(stillActive!.status, "active");

  // The persona asks the one in-chat clarification.
  const turn = await runChatTurn({
    personaId,
    personaName: "Sam",
    channel: "playground",
    conversationId: "c3",
    message: "how do you feel about big parties?",
    userEventId: r.eventId,
    history: [],
    generate: async () => "Honestly, depends on the party.",
  });
  assert.ok(turn.askedClarification?.includes("situational"), "clarification appended to the reply");

  // A second turn in the SAME conversation must not ask again (one per conversation)…
  // …but first: the next user message routes as the clarification answer.
  const answer = await ingestInbound({
    personaId,
    channel: "playground",
    conversationId: "c3",
    kind: "text",
    text: "It's situational — small trusted groups energize me, big crowds drain me.",
  });
  const routed = await routeClarificationAnswer("c3", answer.eventId);
  assert.equal(routed, kase!.id, "answer routed back to the open case");

  overrides = [
    (system) =>
      system.startsWith("You are reconciling")
        ? JSON.stringify({
            conflict: true,
            outcome: "augment",
            confidence: 0.9,
            merged: {
              text: "Sam is energized by small trusted groups and drained by large crowds.",
              type: "belief",
              strength: "strong",
              topics: ["personality"],
            },
            changeNote: null,
            question: null,
            reasoning: "scoped by the person's answer",
          })
        : null,
  ];
  await drainLoopQueue();
  overrides = [];

  const resolved = await prisma.reconCase.findUnique({ where: { id: kase!.id } });
  assert.equal(resolved!.status, "resolved");
  assert.equal(resolved!.resolution, "augment");

  const merged = await prisma.propositionPrivate.findFirst({
    where: { personaId, text: { contains: "small trusted groups" } },
  });
  assert.ok(merged, "merged chunk stored");
  assert.deepEqual([...merged!.parentIds].sort(), [extro, resolved!.newPropId].sort(), "linked to both parents");
  const parentA = await prisma.propositionPrivate.findUnique({ where: { id: extro } });
  assert.equal(parentA!.status, "merged", "parents retired from default retrieval");
});

// 6 ─ A voice memo about my job produces typed chunks with embeddings, and a
//     paraphrase sharing no keywords with the memo answers from them.
test("material memo distills into propositions answerable by paraphrase", async () => {
  // Simulated transcript of a spoken memo (whisper itself is covered by the
  // voice test suite; the loop consumes its output text).
  const memo =
    "So, a bit of background on the day job. I run the platform group over at Acme — " +
    "we own the internal data infrastructure, the pipelines, the warehouse, all of it. " +
    "Been doing that for about two years, took it over when the old lead left. " +
    "It is a small team but they cover a huge surface area, and honestly most of my week " +
    "is unblocking people and arguing for headcount rather than writing code myself.";
  const e = await prisma.updateEvent.create({
    data: {
      personaId,
      channel: "telegram",
      conversationId: "c4",
      kind: "audio",
      rawText: memo,
      register: "spoken",
      intent: "material",
      intentSource: "heuristic",
      status: "queued",
    },
  });
  await prisma.loopJob.create({ data: { personaId, kind: "material", eventId: e.id } });
  await drainLoopQueue();

  const origin = `loop:${e.id.slice(0, 8)}`;
  const chunks = await prisma.vectorChunkPrivate.count({ where: { personaId, origin } });
  assert.ok(chunks > 0, "episodic chunks stored");
  const props = await prisma.propositionPrivate.findMany({
    where: { personaId, sourceOrigins: { has: origin } },
  });
  assert.ok(props.length >= 2, "typed propositions distilled");

  // Paraphrase with no content-word overlap with the memo text.
  const notes = await retrievePropositions(personaId, "what do you do for a living?", { k: 3 });
  assert.ok(
    notes.some((n) => props.some((p) => p.id === n.id)),
    `memo propositions answer the paraphrase (got: ${notes.map((n) => n.text.slice(0, 40)).join(" | ")})`
  );
  const event = await prisma.updateEvent.findUnique({ where: { id: e.id } });
  assert.equal(event!.status, "distilled");
});

// 7 ─ Style correction → paired exemplar + regression case; the replay catches
//     a deliberately reintroduced bad output.
test("style correction produces exemplar pair and a regression that catches reintroduction", async () => {
  // A persona turn to correct, with the triggering user turn linked.
  const trigger = await prisma.updateEvent.create({
    data: {
      personaId, channel: "playground", conversationId: "c5", kind: "text",
      rawText: "how would you kick off a project update?", intent: "chat", intentSource: "default", status: "none_needed",
    },
  });
  const badReply =
    "Leveraging synergies across our verticals, I am thrilled to announce the following key takeaways for stakeholders moving forward together.";
  const personaTurn = await prisma.updateEvent.create({
    data: {
      personaId, channel: "playground", conversationId: "c5", kind: "text",
      rawText: badReply, intent: "chat", intentSource: "persona_turn",
      replyToEventId: trigger.id, status: "none_needed", retrievalLog: { props: [], episodic: [] },
    },
  });

  const r = await ingestInbound({
    personaId,
    channel: "playground",
    conversationId: "c5",
    kind: "text",
    text: "Nope, not like that. I'd just say: quick update — here's where we are and what's blocked.",
    intentHint: "correction",
    replyToEventId: personaTurn.id,
  });

  overrides = [
    (system) =>
      system.startsWith("A real person corrected")
        ? JSON.stringify({
            type: "style",
            distilledNote: "Open updates plainly; no corporate buzzwords.",
            correctedVersion: "Quick update — here's where we are and what's blocked.",
            correctedFact: null,
            generalRule: null,
            inferred: false,
            topics: ["style"],
          })
        : null,
  ];
  await drainLoopQueue();
  overrides = [];

  const pair = await prisma.exemplarPair.findFirst({ where: { personaId, sourceEventId: r.eventId } });
  assert.ok(pair, "paired exemplar stored");
  assert.equal(pair!.personaOriginal, badReply);

  const reg = await prisma.regressionCase.findFirst({ where: { personaId, sourceEventId: r.eventId } });
  assert.ok(reg, "regression case stored");

  // Replay: a generator that reintroduces the rejected output must FAIL…
  const bad = await replayRegressions(personaId, async () => badReply);
  const thisCaseBad = bad.find((x) => x.caseId === reg!.id);
  assert.equal(thisCaseBad!.pass, false, "reintroduced bad output caught");
  // …and a clean generator passes it.
  const good = await replayRegressions(personaId, async (q) =>
    q.includes("project update") ? "Quick one: here's where things stand and what's blocked."
    : "Head of Platform at NewCo — I run platform engineering."
  );
  const thisCaseGood = good.find((x) => x.caseId === reg!.id);
  assert.equal(thisCaseGood!.pass, true);
});

// 8 ─ Feedback firewall: feedback sentences never appear in any index.
test("feedback language never enters any vector store", async () => {
  const fixture = "nope, not like that — I would never say synergize the deliverables, that phrasing is awful";
  await ingestInbound({
    personaId,
    channel: "playground",
    conversationId: "c6",
    kind: "text",
    text: fixture,
    intentHint: "correction",
  });
  await drainLoopQueue();

  for (const table of ["VectorChunkPrivate", "VectorChunkPublic"]) {
    const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*) AS n FROM "${table}" WHERE text ILIKE $1`,
      `%synergize the deliverables%`
    );
    assert.equal(Number(rows[0].n), 0, `${table} clean of feedback text`);
  }
  for (const table of ["PropositionPrivate", "PropositionPublic"]) {
    const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*) AS n FROM "${table}" WHERE text ILIKE $1 OR text ILIKE $2`,
      `%nope, not like that%`,
      `%synergize the deliverables%`
    );
    assert.equal(Number(rows[0].n), 0, `${table} clean of feedback text`);
  }
});

// 9 ─ Chat reply latency unchanged with the loop enabled and the queue loaded.
test("tier-1 chat path adds no LLM work even with a loaded queue", async () => {
  // Load the queue with pending jobs (not drained).
  const filler = await prisma.updateEvent.create({
    data: {
      personaId, channel: "playground", conversationId: "c7", kind: "text",
      rawText: "filler", intent: "material", intentSource: "hint", status: "queued",
    },
  });
  await prisma.loopJob.createMany({
    data: Array.from({ length: 20 }, () => ({ personaId, kind: "material", eventId: filler.id })),
  });

  const callsBefore = llmCalls;
  const t0 = Date.now();
  const r = await ingestInbound({
    personaId,
    channel: "playground",
    conversationId: "c7",
    kind: "text",
    text: "what's a good way to spend a free weekend?",
  });
  const elapsed = Date.now() - t0;
  assert.equal(r.chat, true);
  assert.equal(llmCalls, callsBefore, "zero LLM calls in the tier-1 path");
  assert.ok(elapsed < 500, `tier-1 ingest fast with loaded queue (${elapsed}ms)`);
  // Clean the filler jobs so later drains don't chew on them.
  await prisma.loopJob.deleteMany({ where: { eventId: filler.id } });
  await prisma.loopJob.deleteMany({ where: { eventId: r.eventId } });
});

// 10 ─ Sealed questions stay excluded from every ingestion path.
test("sealed validation content is excluded from material ingestion", async () => {
  const sealedAnswer =
    "[loop-test] my first computer was a hand-me-down amstrad and I spent the whole summer teaching myself basic on it before school started again";
  const q = await prisma.question.create({
    data: {
      orderIndex: 99001,
      section: "loop-test",
      type: "voice",
      promptText: "[loop-test] sealed question",
      isValidation: true,
    },
  });
  const s = await prisma.session.create({ data: { label: "loop-test-session", personaId } });
  await prisma.response.create({
    data: { sessionId: s.id, questionId: q.id, type: "voice", transcript: sealedAnswer, transcriptStatus: "done" },
  });
  resetSealedCacheForTests();

  const e = await prisma.updateEvent.create({
    data: {
      personaId, channel: "playground", conversationId: "c8", kind: "text",
      rawText: `Here's some material for you. ${sealedAnswer} — and some trailing words.`,
      register: "written", intent: "material", intentSource: "hint", status: "queued",
    },
  });
  await prisma.loopJob.create({ data: { personaId, kind: "material", eventId: e.id } });
  await drainLoopQueue();

  const job = await prisma.loopJob.findFirst({ where: { eventId: e.id } });
  assert.equal(job!.status, "failed");
  assert.match(job!.error ?? "", /sealed/i);
  const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*) AS n FROM "VectorChunkPrivate" WHERE "personaId" = $1 AND text ILIKE $2`,
    personaId,
    `%hand-me-down amstrad%`
  );
  assert.equal(Number(rows[0].n), 0, "sealed content absent from the index");
});

// Session layer: rolling short-term memory with TTL, reset boundary, and the
// explicit-permanence trigger.
test("session memory: retention window, reset marker, remember-this trigger", async () => {
  const { loadSession, insertSessionReset } = await import("../../src/loop/session");
  const { heuristicIntent } = await import("../../src/loop/classify");
  const conv = "sess-test";
  const mk = (text: string, personaTurn: boolean, ageHours: number) =>
    prisma.updateEvent.create({
      data: {
        personaId, channel: "playground", conversationId: conv, kind: "text",
        rawText: text, intent: "chat",
        intentSource: personaTurn ? "persona_turn" : "default",
        status: "none_needed",
        createdAt: new Date(Date.now() - ageHours * 3600 * 1000),
      },
    });

  await mk("ancient question", false, 30); // beyond the 12h retention
  await mk("ancient answer", true, 30);
  await mk("point three of the briefing is about GPUs", true, 1);
  await mk("tell me more about point three", false, 0.5);

  let s = await loadSession(conv);
  assert.equal(s.turnCount, 2, "turns beyond retention fall out of the window");
  assert.equal(s.turns[0].role, "assistant");
  assert.match(s.turns[0].content, /point three/, "in-window bot content is referenceable");

  // Hard boundary: reset marker clears the session without deleting anything.
  await insertSessionReset(personaId, "playground", conv);
  await mk("fresh start question", false, 0);
  s = await loadSession(conv);
  assert.equal(s.turnCount, 1, "reset marker is a hard session boundary");
  assert.match(s.turns[0].content, /fresh start/);
  const retained = await prisma.updateEvent.count({ where: { conversationId: conv, kind: "text" } });
  assert.equal(retained, 5, "purge is prompt-only — events retained on disk");

  // Explicit permanence: "remember this:" routes to durable memory.
  const r = heuristicIntent({
    kind: "text",
    text: "remember this: my brother's wedding is in Lisbon next May",
    replyToPersonaTurn: false,
  });
  assert.equal(r.intent, "material");
  assert.equal(r.confident, true);
});

// Bonus wiring check: hot-note render + cap behavior.
test("hot notes render and respect the cap", async () => {
  const { writeHotNote } = await import("../../src/loop/hotnotes");
  const seedEvent = await prisma.updateEvent.create({
    data: {
      personaId, channel: "playground", conversationId: "c9", kind: "text",
      rawText: "always ask before assuming", intent: "meta", intentSource: "hint", status: "captured",
    },
  });
  await writeHotNote(personaId, seedEvent.id, "Always ask before assuming.");
  const block = await renderHotNotes(personaId);
  assert.ok(block.includes("instructions to APPLY"), "header states these are corrections to apply, not content");
  const active = await prisma.hotNote.count({ where: { personaId, active: true } });
  assert.ok(active <= 10, `cap respected (${active})`);
});
