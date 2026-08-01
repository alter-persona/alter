import path from "node:path";
import fs from "node:fs";
import { prisma } from "@/lib/db";
import { moduleCoverage, renderMeter, MODULES } from "@/curriculum/curriculum";
import { enqueueResponseIngest } from "@/lib/ingestQueue";

/**
 * The in-chat interview — the from-zero experience. Before a persona is
 * active, the adapter routes messages here: Alter asks the curriculum one
 * question at a time, answers arrive as voice memos (preferred) or text,
 * Likert items take 1-5, "skip" skips, "status" shows the meter, and every
 * answer feeds the standard ingest pipeline (chunks, stylometry,
 * distillation — sealed questions excluded automatically).
 *
 * Auto-build at the threshold: once banked spoken minutes and distilled
 * propositions clear the gates (SKILL_MIN_VOICE_MINUTES / SKILL_MIN_PROPS),
 * synthesis kicks off in the background and the persona switches on.
 */

const SESSION_LABEL = "in-chat interview";

export interface InterviewQuestion {
  id: string;
  orderIndex: number;
  type: "voice" | "likert";
  promptText: string;
  module: string | null;
  artifactInvite: boolean;
  isValidation: boolean;
}

export async function interviewSession(personaId: string) {
  const existing = await prisma.session.findFirst({
    where: { personaId, label: SESSION_LABEL },
  });
  if (existing) return existing;
  return prisma.session.create({ data: { personaId, label: SESSION_LABEL } });
}

/** Next unanswered ACTIVE question for this persona, across all its sessions
 * (a bootstrap-seeded persona resumes where its recordings left off). */
export async function nextQuestion(personaId: string): Promise<InterviewQuestion | null> {
  const rows = await prisma.$queryRaw<InterviewQuestion[]>`
    SELECT q.id, q."orderIndex", q.type, q."promptText", q.module, q."artifactInvite", q."isValidation"
    FROM "Question" q
    WHERE q.active = true
      AND NOT EXISTS (
        SELECT 1 FROM "Response" r JOIN "Session" s ON s.id = r."sessionId"
        WHERE r."questionId" = q.id AND s."personaId" = ${personaId}
      )
    ORDER BY q."isValidation" ASC, q."orderIndex" ASC LIMIT 1`;
  // isValidation ASC guarantees the sealed benchmark questions come LAST even
  // on a migrated database where later modules got appended after them.
  return rows[0] ?? null;
}

export async function progress(personaId: string): Promise<{ answered: number; total: number; minutes: number }> {
  const [counts, mins] = await Promise.all([
    prisma.$queryRaw<{ answered: bigint; total: bigint }[]>`
      SELECT
        (SELECT COUNT(*) FROM "Question" q WHERE q.active = true AND EXISTS (
          SELECT 1 FROM "Response" r JOIN "Session" s ON s.id = r."sessionId"
          WHERE r."questionId" = q.id AND s."personaId" = ${personaId})) AS answered,
        (SELECT COUNT(*) FROM "Question" WHERE active = true) AS total`,
    prisma.$queryRaw<{ m: number | null }[]>`
      SELECT SUM(r."audioDurationSec")/60 AS m FROM "Response" r
      JOIN "Session" s ON s.id = r."sessionId"
      WHERE s."personaId" = ${personaId} AND r."audioPath" IS NOT NULL`,
  ]);
  return {
    answered: Number(counts[0]?.answered ?? 0),
    total: Number(counts[0]?.total ?? 0),
    minutes: Number(mins[0]?.m ?? 0),
  };
}

const MODULE_INTROS: Record<string, string> = {
  "identity-values": "First module: who you are — identity and values.",
  communication: "Next module: how you communicate. This is what makes your drafts sound like you — real examples beat descriptions every time.",
  "work-craft": "Next module: your work — what you actually do and how you judge it.",
  interests: "Next module: what you care about outside the job.",
  validation:
    "Last stretch: eight BENCHMARK questions, and these matter. Your answers here are sealed — they never enter my memory, on purpose. Once I'm live, I answer these same eight questions cold and we compare me against the real you: where I agree, where I differ, where the gaps are. It's the honest test that I'm actually you and not a generic bot. Answer them like the others; you'll get the benchmark report after.",
};

export function renderQuestion(
  q: InterviewQuestion,
  answeredBefore: number,
  total: number,
  newModule: boolean,
  personaActive = false
): string {
  const parts: string[] = [];
  if (newModule && q.module && MODULE_INTROS[q.module]) parts.push(MODULE_INTROS[q.module]);
  const label = MODULES.find((m) => m.key === q.module)?.label ?? q.module ?? "";
  const head = `Q${answeredBefore + 1}/${total} — ${label}`;
  if (q.type === "likert") {
    parts.push(`${head}\n"${q.promptText}"\n\nHow well does that describe you, 1 (not at all) to 5 (very much)?`);
  } else if (q.artifactInvite) {
    parts.push(`${head}\n${q.promptText}\n\n(Send the file(s) right here — or "skip".)`);
  } else {
    const controls = personaActive
      ? `"pause" to chat with your persona · "skip" · "status"`
      : `"skip" to skip, "status" for progress, "later" to pause`;
    parts.push(`${head}\n${q.promptText}\n\n(A voice memo is best — a minute or two, just talk. Text works too. ${controls}.)`);
  }
  return parts.join("\n\n");
}

export function greeting(personaName: string, total: number): string {
  return (
    `Hello — I'm Alter, and I'm going to become ${personaName}.\n\n` +
    `Here's the deal: I interview you through ordinary conversation — ${total} questions across four modules (identity, communication, work, interests). ` +
    `You answer by voice memo, ideally, because I learn your voice from how you actually talk. Everything stays on this machine.\n\n` +
    `Once you've banked enough spoken minutes and answers, I build the base persona automatically and switch it on — then I answer as you, and every correction makes me sharper. ` +
    `You can stop anytime and pick up later; nothing is ever lost.\n\n` +
    `Say "status" for progress, "skip" to skip a question, "what are you" for the full disclosure.\n\nReady? First question:`
  );
}

// ── Saving answers ──────────────────────────────────────────────────────

async function upsertResponse(
  sessionId: string,
  q: InterviewQuestion,
  data: {
    transcript?: string | null;
    audioPath?: string | null;
    audioDurationSec?: number | null;
    likertValue?: number | null;
    skipped?: boolean;
    transcriptSource?: string;
  }
): Promise<string> {
  const r = await prisma.response.upsert({
    where: { sessionId_questionId: { sessionId, questionId: q.id } },
    create: {
      sessionId,
      questionId: q.id,
      type: q.type,
      transcript: data.transcript ?? null,
      transcriptStatus: data.transcript ? "done" : null,
      transcriptSource: data.transcript ? (data.transcriptSource ?? "chat") : null,
      audioPath: data.audioPath ?? null,
      audioDurationSec: data.audioDurationSec ?? null,
      likertValue: data.likertValue ?? null,
      skipped: data.skipped ?? false,
    },
    update: {
      transcript: data.transcript ?? null,
      audioPath: data.audioPath ?? null,
      audioDurationSec: data.audioDurationSec ?? null,
      likertValue: data.likertValue ?? null,
      skipped: data.skipped ?? false,
    },
  });
  return r.id;
}

export async function saveTextAnswer(personaId: string, q: InterviewQuestion, text: string): Promise<void> {
  const session = await interviewSession(personaId);
  const rid = await upsertResponse(session.id, q, { transcript: text, transcriptSource: "chat-text" });
  if (q.type === "voice" && !q.isValidation) await enqueueResponseIngest(personaId, rid);
}

/** Voice memo answer: audio already downloaded by the adapter; transcribe,
 * store with the audio path + duration (banked minutes), ingest. */
export async function saveVoiceAnswer(
  personaId: string,
  q: InterviewQuestion,
  audioPath: string,
  durationSec: number
): Promise<string> {
  const session = await interviewSession(personaId);
  const { getTranscriber } = await import("@/lib/transcriber");
  const transcript = (await getTranscriber().transcribe(path.resolve(process.cwd(), audioPath))).text.trim();
  // Keep the audio under the intake convention so exports and voice-clone
  // dataset builds see it.
  const destDir = path.join(process.cwd(), "data", "audio", session.id);
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, `${q.id}${path.extname(audioPath) || ".oga"}`);
  fs.copyFileSync(path.resolve(process.cwd(), audioPath), dest);
  const rid = await upsertResponse(session.id, q, {
    transcript,
    transcriptSource: "chat-voice",
    audioPath: path.relative(process.cwd(), dest),
    audioDurationSec: durationSec,
  });
  if (!q.isValidation) await enqueueResponseIngest(personaId, rid);
  return transcript;
}

export async function saveLikert(personaId: string, q: InterviewQuestion, value: number): Promise<void> {
  const session = await interviewSession(personaId);
  await upsertResponse(session.id, q, { likertValue: value });
}

export async function skipQuestion(personaId: string, q: InterviewQuestion): Promise<void> {
  const session = await interviewSession(personaId);
  await upsertResponse(session.id, q, { skipped: true });
}

export async function interviewStatus(personaId: string): Promise<string> {
  const [p, cov] = await Promise.all([progress(personaId), moduleCoverage(prisma)]);
  const gates = { minutes: Number(process.env.SKILL_MIN_VOICE_MINUTES ?? 30), props: Number(process.env.SKILL_MIN_PROPS ?? 50) };
  const props = await propCount(personaId);
  return [
    `Interviewing — ${p.answered}/${p.total} answered, ${p.minutes.toFixed(1)} spoken minutes banked.`,
    renderMeter(cov),
    `Base persona builds automatically at ${gates.minutes} spoken minutes + ${gates.props} distilled memories (currently ${props}).`,
  ].join("\n");
}

// ── Auto-build at the threshold ─────────────────────────────────────────

async function propCount(personaId: string): Promise<number> {
  const [a, b] = await Promise.all([
    prisma.propositionPrivate.count({ where: { personaId } }),
    prisma.propositionPublic.count({ where: { personaId } }),
  ]);
  return a + b;
}

const building = new Set<string>();

export async function maybeAutoBuild(
  personaId: string,
  personaName: string,
  announce: (msg: string) => Promise<void>
): Promise<void> {
  if (building.has(personaId)) return;
  const fp = await prisma.styleFingerprint.findUnique({ where: { personaId } });
  if (fp) return; // already built
  const minMinutes = Number(process.env.SKILL_MIN_VOICE_MINUTES ?? 30);
  const minProps = Number(process.env.SKILL_MIN_PROPS ?? 50);
  const [p, props] = await Promise.all([progress(personaId), propCount(personaId)]);
  if (p.minutes < minMinutes || props < minProps) return;

  building.add(personaId);
  await announce(
    `That's the threshold — ${p.minutes.toFixed(1)} spoken minutes and ${props} distilled memories. Building your base persona now (style fingerprint, exemplars, the pack). This runs in the background; keep answering or take a break. I'll tell you the moment it's live.`
  );
  void (async () => {
    try {
      const { synthesizePersona } = await import("./build");
      const result = await synthesizePersona(personaId, personaName);
      await announce(
        `Your base persona is LIVE (pack v${result.version}). From here on I answer as ${personaName} — talk to me normally, correct anything that sounds off, and keep feeding me questions or material whenever you like. Say "continue interview" anytime for the next question; every answer still deepens me.`
      );
    } catch (e) {
      building.delete(personaId);
      await announce(`Base-persona build hit a wall: ${String(e).slice(0, 200)} — I'll retry after your next answer.`);
    }
  })();
}
