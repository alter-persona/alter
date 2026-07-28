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
const OFFSET_FILE = path.join(process.cwd(), "storage", "loop", "telegram-offset.txt");
const HERMES_RUN = process.env.HERMES_RUN_PATH ?? path.join(os.homedir(), ".hermes", "bin", "hermes-run");
const NOTES_PATH =
  process.env.PERSONA_NOTES_PATH ?? path.join(os.homedir(), ".hermes", "profiles", process.env.HERMES_PROFILE ?? "default", "memory", "notes.md");

/** telegram message_id → persona UpdateEvent id (correction prior on replies). */
const sentMap = new Map<number, string>();

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

async function send(chatId: number, text: string): Promise<number> {
  const r = await tg<{ message_id: number }>("sendMessage", { chat_id: chatId, text: text.slice(0, 4000) });
  return r.message_id;
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
      await recordBotContent(`tg-${chatId}`, report); // discussable in-session
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
    await send(chatId, `Voice notes ${on ? "on" : "off"} for this chat.`);
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

  if (lower === "/about" || lower === "what are you" || lower === "what are you?") {
    await send(
      chatId,
      `I'm an Understudy — a digital persona built from ${persona.name}'s own words, answers, and writing, learning to answer and draft the way they would. Everything stays on this machine in a local database; the only things that leave are prompts to the configured model API (and, with voice on, the reply text to the voice provider). You can see everything I know, correct anything, and delete it all with one command.`
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

// ── Main message handling ────────────────────────────────────────────────
async function handleMessage(m: TgMessage): Promise<void> {
  const chatId = m.chat.id;
  if (ALLOWED_CHAT && String(chatId) !== ALLOWED_CHAT) return;
  const conversationId = `tg-${chatId}`;
  const persona = await ensureDefaultPersona();
  const text = m.text ?? m.caption ?? "";

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
