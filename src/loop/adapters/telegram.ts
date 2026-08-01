import fs from "node:fs/promises";
import fscb from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import "@/lib/loadEnv";
import { prisma } from "@/lib/db";
import { ensureDefaultPersona } from "@/lib/personas";
import { ingestInbound } from "../ingest";
import { runChatTurn, routeClarificationAnswer } from "../runtime";
import { statusReport, renderStatus, renderPending, decideApproval } from "../status";

const execFileP = promisify(execFile);

/**
 * Telegram channel adapter — the SINGLE poller on the persona bot
 * (TELEGRAM_PERSONA_BOT_TOKEN). Calls the same ingest API and runtime as the
 * playground, so loop logic lives in one place.
 *
 * Channel semantics:
 *   - reply to a persona message → strong correction prior
 *   - document → material (chat exports included; delta report follows)
 *   - voice memo → transcribe then classify (long = material, short = chat)
 *   - in-band: status / pending / approve N / reject N — natural language or
 *     slash forms both work; no UI required for anything.
 *   - migrated from the retired owner-agent listener: /note, /notes,
 *     /schedules, /skills, /run <skill> (passthrough to hermes-run).
 *   - /voice on|off per-chat toggle. Voice notes are ElevenLabs → ffmpeg
 *     OGG/Opus → sendVoice, ALWAYS async after the text reply; any failure
 *     degrades silently to text (logged, never user-visible).
 *
 * Run: npm run loop:telegram   (LaunchAgent: ai.understudy.telegram)
 */

const TOKEN = process.env.TELEGRAM_PERSONA_BOT_TOKEN;
const API = () => `https://api.telegram.org/bot${TOKEN}`;
const ALLOWED_CHAT = process.env.TELEGRAM_PERSONA_CHAT_ID; // optional lock
// Multiple adapter instances (one per bot, one persona each) must not share
// offsets or conversation ids: everything is namespaced by the bot id.
const BOT_ID = (TOKEN ?? "nobot").split(":")[0];
const OFFSET_FILE = path.join(process.cwd(), "storage", "loop", `telegram-offset-${BOT_ID}.txt`);
const convId = (chatId: number) => `tg-${BOT_ID}-${chatId}`;
const HERMES_RUN = process.env.HERMES_RUN_PATH ?? path.join(os.homedir(), ".hermes", "bin", "hermes-run");
const NOTES_PATH =
  process.env.PERSONA_NOTES_PATH ?? path.join(os.homedir(), ".hermes", "profiles", process.env.HERMES_PROFILE ?? "default", "memory", "notes.md");

/** telegram message_id → persona UpdateEvent id (correction prior on replies). */
const sentMap = new Map<number, string>();

const lowerSafe = (s: string) => s.trim().toLowerCase();

interface TgMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  caption?: string;
  voice?: { file_id: string; duration: number };
  audio?: { file_id: string; duration: number };
  document?: { file_id: string; file_name?: string };
  reply_to_message?: { message_id: number; from?: { is_bot?: boolean } };
}

async function tg<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!json.ok) throw new Error(`telegram ${method}: ${json.description}`);
  return json.result;
}

/** Telegram caps messages at 4096 chars — long replies are SPLIT on
 * paragraph/line boundaries and sent in order, never silently truncated.
 * Returns the LAST message id (replies-to for corrections track the tail). */
async function send(chatId: number, text: string): Promise<number> {
  const LIMIT = 3900;
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > LIMIT) {
    let cut = rest.lastIndexOf("\n\n", LIMIT);
    if (cut < LIMIT * 0.5) cut = rest.lastIndexOf("\n", LIMIT);
    if (cut < LIMIT * 0.5) cut = rest.lastIndexOf(" ", LIMIT);
    if (cut < LIMIT * 0.5) cut = LIMIT;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  let lastId = 0;
  for (const c of chunks) {
    const r = await tg<{ message_id: number }>("sendMessage", { chat_id: chatId, text: c });
    lastId = r.message_id;
  }
  return lastId;
}

async function download(fileId: string, suffix: string): Promise<string> {
  const info = await tg<{ file_path: string }>("getFile", { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${info.file_path}`);
  const dir = path.join(process.cwd(), "storage", "loop");
  await fs.mkdir(dir, { recursive: true });
  const dest = path.join(dir, `tg-${Date.now()}${suffix}`);
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

// ── Short-term session memory (rolling window + TTL + reset markers) ──────
import { loadSession, insertSessionReset, renderSessionStatus } from "../session";
import { recordPersonaTurn } from "../ingest";

/** Content the bot produced outside runChatTurn (skill outputs, delta
 * reports) is recorded into the session so follow-up questions can
 * reference it — "clarify point 3 of the briefing" needs the briefing. */
async function recordBotContent(conversationId: string, text: string): Promise<void> {
  try {
    const persona = await ensureDefaultPersona();
    await recordPersonaTurn({
      personaId: persona.id,
      channel: "telegram",
      conversationId,
      replyText: text.slice(0, 6000),
      retrievalLog: { props: [], episodic: [] },
    });
  } catch (e) {
    console.error(`[tg] session record failed: ${String(e).slice(0, 120)}`);
  }
}

// ── Voice notes: EL → ffmpeg OGG/Opus → sendVoice, silent degrade ─────────
async function voicePref(conversationId: string): Promise<boolean> {
  const p = await prisma.channelPref.findUnique({
    where: { channel_conversationId: { channel: "telegram", conversationId } },
  });
  return p?.voiceReplies ?? false; // off by default — voice is an add-on
}

async function maybeSendVoiceNote(chatId: number, conversationId: string, text: string): Promise<void> {
  let tmpIn: string | null = null;
  let tmpOut: string | null = null;
  try {
    if (!(await voicePref(conversationId))) return;
    const persona = await ensureDefaultPersona();
    const { parseVoiceBinding, getTtsProvider, stripUnsupportedTags } = await import("@/lib/tts");
    const binding = parseVoiceBinding(persona.voiceId);
    if (!binding || binding.provider === "none") return;
    const speak = stripUnsupportedTags(text.replace(/[*_`#]/g, ""), binding.provider).slice(0, 1200);
    const out = await getTtsProvider(binding).synthesize(speak, binding.voiceRef);

    // Telegram voice notes require OGG with the Opus codec.
    tmpIn = path.join(os.tmpdir(), `un-voice-${Date.now()}.mp3`);
    tmpOut = tmpIn.replace(/\.mp3$/, ".ogg");
    await fs.writeFile(tmpIn, out.audio);
    await execFileP("ffmpeg", ["-y", "-i", tmpIn, "-c:a", "libopus", "-b:a", "48k", "-ar", "48000", "-ac", "1", tmpOut]);

    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("voice", new Blob([new Uint8Array(await fs.readFile(tmpOut))], { type: "audio/ogg" }), "reply.ogg");
    const res = await fetch(`${API()}/sendVoice`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`sendVoice ${res.status}`);
  } catch (e) {
    // Silent degrade: the text reply already went out; log and move on.
    console.error(`[tg] voice note degraded to text: ${String(e).slice(0, 200)}`);
  } finally {
    if (tmpIn) await fs.unlink(tmpIn).catch(() => {});
    if (tmpOut) await fs.unlink(tmpOut).catch(() => {});
  }
}

// ── Delta watcher: after material, report what the upload bought ──────────
function watchDelta(chatId: number, eventId: string): void {
  const started = Date.now();
  const tick = async () => {
    const e = await prisma.updateEvent.findUnique({ where: { id: eventId } });
    const report = (e?.retrievalLog as { deltaReport?: string } | null)?.deltaReport;
    if (e?.status === "distilled" && report) {
      await send(chatId, report);
      await recordBotContent(convId(chatId), report); // discussable in-session
      return;
    }
    if (e?.status === "failed") {
      await send(chatId, `That upload didn't make it in: ${e.error ?? "unknown error"}`);
      return;
    }
    if (Date.now() - started < 90 * 60 * 1000) setTimeout(() => void tick().catch(() => {}), 10_000);
  };
  setTimeout(() => void tick().catch(() => {}), 10_000);
}

// ── Migrated owner-agent commands ───────────────────────────────────────────
async function handleCommand(chatId: number, conversationId: string, text: string): Promise<boolean> {
  const persona = await ensureDefaultPersona();
  const t = text.trim();
  const lower = t.toLowerCase();

  if (t === "/voice on" || t === "/voice off") {
    const on = t.endsWith("on");
    await prisma.channelPref.upsert({
      where: { channel_conversationId: { channel: "telegram", conversationId } },
      create: { channel: "telegram", conversationId, voiceReplies: on },
      update: { voiceReplies: on },
    });
    if (on) {
      const { parseVoiceBinding } = await import("@/lib/tts");
      const binding = parseVoiceBinding(persona.voiceId);
      await send(
        chatId,
        binding && binding.provider !== "none"
          ? "Voice notes on for this chat."
          : "Voice notes toggled on — but no voice is bound for this persona yet (a clone needs 30+ recorded minutes and your consent), so replies stay text until one is."
      );
    } else {
      await send(chatId, "Voice notes off for this chat.");
    }
    return true;
  }

  if (lower === "/status" || lower === "status") {
    const s = await statusReport(persona.id, persona.name, persona.packVersion);
    await send(chatId, renderStatus(s));
    return true;
  }

  if (lower === "/pending" || lower === "pending" || lower === "what's pending" || lower === "whats pending") {
    await send(chatId, await renderPending(persona.id));
    return true;
  }

  const approveMatch = lower.match(/^\/?(approve|reject)\s+(\d+)$/);
  if (approveMatch) {
    await send(chatId, await decideApproval(persona.id, Number(approveMatch[2]), approveMatch[1] === "approve"));
    return true;
  }

  if (lower === "benchmark" || lower === "/benchmark") {
    const fp = await prisma.styleFingerprint.findUnique({ where: { personaId: persona.id } });
    if (!fp) await send(chatId, "The benchmark runs once your base persona is live (it needs a persona to test).");
    else runBenchmark(chatId, persona);
    return true;
  }

  if (lower === "/about" || lower === "what are you" || lower === "what are you?") {
    await send(
      chatId,
      `I'm an Alter — a digital persona built from ${persona.name}'s own words, answers, and writing, learning to answer and draft the way they would. Everything stays on this machine in a local database; the only things that leave are prompts to the configured model API (and, with voice on, the reply text to the voice provider). You can see everything I know, correct anything, and delete it all with one command.`
    );
    return true;
  }

  if (t.startsWith("/note ")) {
    const note = t.slice(6).trim();
    const line = `- ${new Date().toISOString().slice(0, 16).replace("T", " ")} ${note}\n`;
    await fs.mkdir(path.dirname(NOTES_PATH), { recursive: true });
    await fs.appendFile(NOTES_PATH, line);
    await send(chatId, "Noted.");
    return true;
  }
  if (t.startsWith("/notes")) {
    const n = Number(t.split(/\s+/)[1]) || 10;
    const body = fscb.existsSync(NOTES_PATH) ? fscb.readFileSync(NOTES_PATH, "utf8") : "";
    const lines = body.split("\n").filter((l) => l.startsWith("- ")).slice(-n);
    await send(chatId, lines.length ? lines.join("\n") : "No notes yet.");
    return true;
  }

  if (t === "/schedules") {
    const dir = path.join(os.homedir(), "Library", "LaunchAgents");
    const jobs = fscb
      .readdirSync(dir)
      .filter((f) => f.startsWith("ai.hermes.scheduled.") || f.startsWith("ai.understudy."));
    await send(chatId, jobs.length ? `Scheduled jobs:\n${jobs.map((j) => `• ${j.replace(/\.plist$/, "")}`).join("\n")}` : "No scheduled jobs.");
    return true;
  }

  if (t === "/skills") {
    const dir = path.join(os.homedir(), ".hermes", "profiles", process.env.HERMES_PROFILE ?? "default", "skills");
    const skills = fscb.existsSync(dir) ? fscb.readdirSync(dir).filter((d) => !d.startsWith(".")) : [];
    await send(chatId, skills.length ? `Skills (run with /run <name>):\n${skills.map((s) => `• ${s}`).join("\n")}` : "No skills found.");
    return true;
  }
  if (t.startsWith("/run ")) {
    const skill = t.slice(5).trim().split(/\s+/)[0];
    await send(chatId, `Running ${skill}…`);
    try {
      const { stdout } = await execFileP(
        "/opt/homebrew/bin/python3",
        [HERMES_RUN, "--profile", process.env.HERMES_PROFILE ?? "default", "--skill", skill, "--input", "{}"],
        { timeout: 600_000, maxBuffer: 4 * 1024 * 1024 }
      );
      const out = stdout.trim().slice(0, 3900) || `${skill} finished (no output).`;
      await send(chatId, out);
      // Into the session, so "clarify point 3" works on what was just shown.
      await recordBotContent(conversationId, `[${skill} output]\n${out}`);
    } catch (e) {
      await send(chatId, `${skill} failed: ${String(e).slice(0, 300)}`);
    }
    return true;
  }

  if (t === "/session" || lower === "session") {
    await send(chatId, renderSessionStatus(await loadSession(conversationId)));
    return true;
  }
  if (t === "/session reset" || lower === "new topic" || lower === "new conversation") {
    await insertSessionReset(persona.id, "telegram", conversationId);
    await send(chatId, "Fresh thread — short-term memory cleared from here. (Permanent memory untouched.)");
    return true;
  }

  if (t === "/help") {
    await send(
      chatId,
      "Just talk — I answer as the persona, and I remember the current conversation (short-term memory, rolls off after a few hours). Reply to any of my messages to correct me; drop files or chat exports as material; send voice memos freely.\n" +
        'Start a message with "remember this:" to store something permanently.\n' +
        "status · pending · approve N / reject N · /session · /session reset · /voice on|off · /about\n" +
        "/note <text> · /notes [N] · /schedules · /skills · /run <skill>"
    );
    return true;
  }

  return false;
}

// ── The in-chat interview (pre-active phase, + "continue interview") ─────
import {
  nextQuestion, renderQuestion, greeting, progress as interviewProgress,
  saveTextAnswer, saveVoiceAnswer, saveLikert, skipQuestion,
  interviewStatus, maybeAutoBuild, interviewSession,
} from "../interview";
import type { InterviewQuestion } from "../interview";

/** Active-phase "continue interview": the question we just asked, awaiting an answer. */
const pendingInterview = new Map<string, InterviewQuestion>();

async function personaActive(personaId: string): Promise<boolean> {
  const fp = await prisma.styleFingerprint.findUnique({ where: { personaId } });
  return Boolean(fp);
}

async function askNext(chatId: number, personaId: string, prevModule: string | null, active = false): Promise<void> {
  const q = await nextQuestion(personaId);
  if (!q) {
    pendingInterview.delete(convId(chatId));
    await send(chatId, "That's every question answered — the whole curriculum. Anything new I learn from here comes from talking with you and what you upload.");
    return;
  }
  const p = await interviewProgress(personaId);
  pendingInterview.set(convId(chatId), q);
  await send(chatId, renderQuestion(q, p.answered, p.total, q.module !== prevModule, active));
}

/** The sealed benchmark: the persona answers the eight held-out questions
 * cold; an LLM judges substantive agreement against the real answers; the
 * summary + gaps come back conversationally (full sheets under eval/). */
const benchmarking = new Set<string>();
function runBenchmark(chatId: number, persona: { id: string; name: string }): void {
  if (benchmarking.has(persona.id)) return;
  benchmarking.add(persona.id);
  void (async () => {
    try {
      await send(chatId, "Running the benchmark: I'm answering your eight sealed questions cold, then judging myself against your real answers. This takes a while on the local model — I'll report when done.");
      const { evalSealed } = await import("@/understudy/evaluate");
      const r = await evalSealed(persona.id, persona.name);
      const lines = [
        `Benchmark done: I matched your substantive position on ${r.agreed} of ${r.judged} sealed questions.`,
        r.gaps.length
          ? `Where I differ from the real you:\n${r.gaps.map((g) => `• ${g}`).join("\n")}\n\nThese gaps are what corrections and more material fix — talk to me about any of them and I'll learn.`
          : `No substantive gaps found — keep testing me with corrections anyway.`,
        `Full blind sheet (label which answer is really you before peeking at the key): eval/blind-sheet.md`,
      ];
      await send(chatId, lines.join("\n\n"));
    } catch (e) {
      await send(chatId, `Benchmark failed: ${String(e).slice(0, 150)}`);
    } finally {
      benchmarking.delete(persona.id);
    }
  })();
}

/** Returns true when the message was consumed by the interview flow. */
async function handleInterview(
  chatId: number,
  persona: { id: string; name: string },
  m: TgMessage,
  active: boolean
): Promise<boolean> {
  const text = (m.text ?? m.caption ?? "").trim();
  const lower = text.toLowerCase();
  const announce = (msg: string) => send(chatId, msg).then(() => {});

  // Entry points.
  if (lower === "/start" || lower === "begin" || lower === "start interview") {
    const p = await interviewProgress(persona.id);
    await interviewSession(persona.id);
    if (p.answered === 0) await send(chatId, greeting(persona.name, p.total));
    await askNext(chatId, persona.id, null, active);
    return true;
  }
  if (active && (lower === "continue interview" || lower === "next question")) {
    await askNext(chatId, persona.id, null, active);
    return true;
  }

  const current = active ? pendingInterview.get(convId(chatId)) : await nextQuestion(persona.id);
  if (!current) return false; // nothing pending — plain chat

  // In active phase, only consume answers while a question is pending, and
  // bail back to chat if the user is clearly asking something instead.
  if (active && (!pendingInterview.has(convId(chatId)) || (text.includes("?") && !m.voice))) {
    pendingInterview.delete(convId(chatId));
    return false;
  }

  // In-band controls during the interview.
  if (lower === "status" || lower === "/status") {
    await send(chatId, await interviewStatus(persona.id));
    return true;
  }
  if (lower === "skip") {
    await skipQuestion(persona.id, current);
    await askNext(chatId, persona.id, current.module, active);
    return true;
  }
  if (["later", "pause", "stop", "chat", "stop questions", "done for now"].includes(lower)) {
    pendingInterview.delete(convId(chatId));
    await send(
      chatId,
      active
        ? 'Question mode off — you\'re talking to your persona now. Say "continue interview" whenever you want more questions.'
        : 'Paused — nothing is lost. Say "continue interview" (or "begin") whenever you\'re ready. Chatting with the persona unlocks once the base build fires.'
    );
    return true;
  }

  // Answers.
  if (m.voice || m.audio) {
    const v = (m.voice ?? m.audio)!;
    const audioPath = await download(v.file_id, ".oga");
    const transcript = await saveVoiceAnswer(persona.id, current, path.relative(process.cwd(), audioPath), v.duration);
    const p = await interviewProgress(persona.id);
    await send(chatId, `Got it — ${v.duration}s banked (${p.minutes.toFixed(1)} min total). I heard: "${transcript.slice(0, 140)}${transcript.length > 140 ? "…" : ""}"`);
    await maybeAutoBuild(persona.id, persona.name, announce);
    await askNext(chatId, persona.id, current.module, active);
    if (current.isValidation && active && !(await nextQuestion(persona.id))) runBenchmark(chatId, persona);
    return true;
  }
  if (m.document) {
    // A file during an artifact invitation answers it; the file itself rides
    // the normal material path either way.
    if (current.artifactInvite) {
      await saveTextAnswer(persona.id, current, `[artifact uploaded: ${m.document.file_name ?? "file"}]`);
      void askNext(chatId, persona.id, current.module, active);
    }
    return false; // let the material pipeline ingest the document
  }
  if (text) {
    if (current.type === "likert") {
      const v = Number(text.match(/^[1-5]$/)?.[0]);
      if (!v) {
        await send(chatId, "Just a number 1-5 for this one (1 = not at all, 5 = very much).");
        return true;
      }
      await saveLikert(persona.id, current, v);
    } else {
      await saveTextAnswer(persona.id, current, text);
    }
    await maybeAutoBuild(persona.id, persona.name, announce);
    await askNext(chatId, persona.id, current.module, active);
    if (current.isValidation && active && !(await nextQuestion(persona.id))) runBenchmark(chatId, persona);
    return true;
  }
  return false;
}

// ── Main message handling ────────────────────────────────────────────────
async function handleMessage(m: TgMessage): Promise<void> {
  const chatId = m.chat.id;
  if (ALLOWED_CHAT && String(chatId) !== ALLOWED_CHAT) return;
  const conversationId = convId(chatId);
  const persona = await ensureDefaultPersona();
  const text = m.text ?? m.caption ?? "";

  // Pre-active personas live in the interview; active ones can opt back in
  // with "continue interview". Commands still work in both phases.
  const active = await personaActive(persona.id);
  if (text && (lowerSafe(text) === "/about" || lowerSafe(text) === "what are you" || lowerSafe(text) === "what are you?")) {
    // disclosure handled by handleCommand below in both phases
  } else if (await handleInterview(chatId, persona, m, active)) {
    return;
  }
  if (!active) {
    // No persona yet and the message wasn't an interview move: guide, don't impersonate.
    if (text && (await handleCommand(chatId, conversationId, text))) return;
    await send(
      chatId,
      "No persona exists yet — I'm still in interview mode. Say \"begin\" to start (or continue) the interview, \"status\" for progress, or run `bootstrap` from the CLI if you already have recordings."
    );
    return;
  }

  if (text && (await handleCommand(chatId, conversationId, text))) return;

  const replyToBot = m.reply_to_message?.from?.is_bot;
  const replyToEventId = replyToBot ? (sentMap.get(m.reply_to_message!.message_id) ?? null) : null;

  let ingest;
  if (m.voice || m.audio) {
    const v = (m.voice ?? m.audio)!;
    const audioPath = await download(v.file_id, ".oga");
    ingest = await ingestInbound({
      personaId: persona.id,
      channel: "telegram",
      conversationId,
      kind: "audio",
      audioPath,
      audioDurationSec: v.duration,
      replyToEventId,
    });
  } else if (m.document) {
    const filePath = await download(m.document.file_id, path.extname(m.document.file_name ?? "") || ".bin");
    ingest = await ingestInbound({
      personaId: persona.id,
      channel: "telegram",
      conversationId,
      kind: "file",
      filePath: path.relative(process.cwd(), filePath),
      filename: m.document.file_name ?? path.basename(filePath),
      intentHint: "material",
    });
  } else if (text.trim()) {
    ingest = await ingestInbound({
      personaId: persona.id,
      channel: "telegram",
      conversationId,
      kind: "text",
      text,
      replyToEventId,
      // A reply to a persona message classifies with a strong prior toward correction.
      intentHint: replyToEventId && !text.includes("?") ? "correction" : undefined,
    });
  } else {
    return;
  }

  const clarifiedCase = await routeClarificationAnswer(conversationId, ingest.eventId);

  if (!ingest.chat && !clarifiedCase) {
    await send(chatId, ingest.ack);
    if (ingest.intent === "material") watchDelta(chatId, ingest.eventId);
    return;
  }

  const message = ingest.transcript ?? text;
  const history = (await loadSession(conversationId)).turns;
  const turn = await runChatTurn({
    personaId: persona.id,
    personaName: persona.name,
    channel: "telegram",
    conversationId,
    message,
    userEventId: ingest.eventId,
    history,
    mode: m.voice ? "spoken" : "written",
  });

  const msgId = await send(chatId, turn.reply);
  sentMap.set(msgId, turn.personaEventId);
  if (sentMap.size > 500) sentMap.delete(sentMap.keys().next().value!);

  // Voice is an optional add-on: synthesized async AFTER the text reply.
  void maybeSendVoiceNote(chatId, conversationId, turn.reply);
}

async function main(): Promise<void> {
  if (!TOKEN) {
    console.error("TELEGRAM_PERSONA_BOT_TOKEN not set.");
    process.exit(1);
  }
  let offset = 0;
  try {
    offset = Number(await fs.readFile(OFFSET_FILE, "utf8")) || 0;
  } catch {
    /* first run */
  }
  console.log("[tg] understudy adapter polling…");
  for (;;) {
    try {
      const updates = await tg<{ update_id: number; message?: TgMessage }[]>("getUpdates", {
        offset,
        timeout: 25,
      });
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message) {
          await handleMessage(u.message).catch((e) =>
            console.error(`[tg] handle failed: ${String(e).slice(0, 300)}`)
          );
        }
      }
      if (updates.length) {
        await fs.mkdir(path.dirname(OFFSET_FILE), { recursive: true });
        await fs.writeFile(OFFSET_FILE, String(offset));
      }
    } catch (e) {
      console.error(`[tg] poll error: ${String(e).slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

if (process.argv[1]?.includes("telegram")) void main();
