import fscb from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * Live tools for the persona runtime — the Hermes agent's hands, attached to
 * the persona voice. Executed via native Ollama tool calling inside the
 * generation loop. Kept deliberately tight:
 *   web_search  — local SearXNG (falls back to nothing gracefully)
 *   fetch_url   — HTTP GET, HTML stripped, 8KB cap
 *   run_skill   — Hermes skills from the configured profile (passthrough)
 *   read_notes  — the personal notes file
 * Everything degrades to a clear error string; a tool failure never breaks
 * the reply, the model just answers with what it has.
 */

const SEARX = () => process.env.SEARXNG_URL ?? "http://127.0.0.1:8888";
const HERMES_RUN = () => process.env.HERMES_RUN_PATH ?? path.join(os.homedir(), ".hermes", "bin", "hermes-run");
const HERMES_PROFILE = () => process.env.HERMES_PROFILE ?? "default";
const NOTES_PATH = () =>
  process.env.PERSONA_NOTES_PATH ??
  path.join(os.homedir(), ".hermes", "profiles", HERMES_PROFILE(), "memory", "notes.md");

export interface OllamaTool {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

export function personaTools(): OllamaTool[] {
  return [
    {
      type: "function",
      function: {
        name: "web_search",
        description:
          "Search the live web (local metasearch). Use for anything current: weather, news, prices, facts you don't have in memory.",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "search query" } },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "fetch_url",
        description: "Fetch a web page and return its readable text (truncated).",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "http(s) URL" } },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "run_skill",
        description: `Run one of the installed Hermes skills and return its output. Available: ${listSkills().join(", ") || "none"}.`,
        parameters: {
          type: "object",
          properties: { skill: { type: "string", description: "skill name from the available list" } },
          required: ["skill"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_notes",
        description: "Read the owner's recent personal notes (the /note file).",
        parameters: {
          type: "object",
          properties: { count: { type: "number", description: "how many recent notes (default 10)" } },
        },
      },
    },
    ...(process.env.ALTER_TOOL_INSTALL === "allow"
      ? [
          {
            type: "function" as const,
            function: {
              name: "install_skill",
              description:
                "Install a new skill/tool into this persona's platform profile from a GitHub repository (owner/repo or full URL). After install it becomes available to run_skill. Use web_search first if you only know the tool's name.",
              parameters: {
                type: "object",
                properties: { repo: { type: "string", description: "GitHub owner/repo or https URL of the skill" } },
                required: ["repo"],
              },
            },
          },
        ]
      : []),
    {
      type: "function",
      function: {
        name: "send_voice_note",
        description:
          "Speak text aloud in the owner's cloned voice, delivered as a Telegram voice note. Use when asked to 'read this out', 'say it in my voice', or speak any content aloud. Pass the FULL text to be spoken.",
        parameters: {
          type: "object",
          properties: { text: { type: "string", description: "the text to speak (plain prose, no markdown)" } },
          required: ["text"],
        },
      },
    },
  ];
}

export interface ToolContext {
  channel?: string;
  conversationId?: string;
}

/** Synthesize text in the persona's bound voice and send as a Telegram voice
 * note (OGG/Opus). Explicit requests override the per-chat auto-voice toggle. */
export async function sendVoiceNoteTo(chatId: string, text: string): Promise<string> {
  const TOKEN = process.env.TELEGRAM_PERSONA_BOT_TOKEN;
  if (!TOKEN) return "error: no Telegram bot token configured";
  const { prisma } = await import("@/lib/db");
  const { ensureDefaultPersona } = await import("@/lib/personas");
  const { parseVoiceBinding, getTtsProvider, stripUnsupportedTags } = await import("@/lib/tts");
  const fsp = await import("node:fs/promises");
  let tmpIn: string | null = null;
  let tmpOut: string | null = null;
  try {
    const persona = await ensureDefaultPersona();
    const binding = parseVoiceBinding(persona.voiceId);
    if (!binding || binding.provider === "none") {
      return "error: no voice is bound for this persona";
    }
    const speak = stripUnsupportedTags(text.replace(/[*_`#>]/g, ""), binding.provider).slice(0, 2400);
    const out = await getTtsProvider(binding).synthesize(speak, binding.voiceRef);
    tmpIn = path.join(os.tmpdir(), `sv-${Date.now()}.mp3`);
    tmpOut = tmpIn.replace(/\.mp3$/, ".ogg");
    await fsp.writeFile(tmpIn, out.audio);
    await execFileP("ffmpeg", ["-y", "-i", tmpIn, "-c:a", "libopus", "-b:a", "48k", "-ar", "48000", "-ac", "1", tmpOut]);
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("voice", new Blob([new Uint8Array(await fsp.readFile(tmpOut))], { type: "audio/ogg" }), "reply.ogg");
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendVoice`, { method: "POST", body: form });
    if (!res.ok) return `error: sendVoice ${res.status}`;
    await prisma.$queryRaw`SELECT 1`; // keep client warm; no-op
    return `voice note sent (${Math.round(speak.length / 14)}s approx). Do not repeat the spoken text in your reply — just confirm briefly.`;
  } catch (e) {
    return `error: ${String(e).slice(0, 200)}`;
  } finally {
    if (tmpIn) await fsp.unlink(tmpIn).catch(() => {});
    if (tmpOut) await fsp.unlink(tmpOut).catch(() => {});
  }
}

export function listSkills(): string[] {
  const dir = path.join(os.homedir(), ".hermes", "profiles", HERMES_PROFILE(), "skills");
  try {
    return fscb.readdirSync(dir).filter((d) => !d.startsWith(".") && !d.includes("-persona"));
  } catch {
    return [];
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext = {}
): Promise<string> {
  try {
    switch (name) {
      case "send_voice_note": {
        const text = String(args.text ?? "").trim();
        if (!text) return "error: no text to speak";
        if (ctx.channel === "telegram" && ctx.conversationId?.startsWith("tg-")) {
          // conversation ids are `tg-<botId>-<chatId>` (legacy: `tg-<chatId>`)
          const chat = ctx.conversationId.split("-").pop()!;
          return sendVoiceNoteTo(chat, text);
        }
        return "error: voice notes are only deliverable on Telegram — on localhost use the /talk page for live voice";
      }
      case "install_skill": {
        if (process.env.ALTER_TOOL_INSTALL !== "allow") {
          return "error: tool installation is disabled for this persona. The owner can enable it by setting ALTER_TOOL_INSTALL=allow (see the README's Tools section).";
        }
        const ref = String(args.repo ?? "").trim();
        const m = ref.match(/^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
        if (!m) return "error: give me a GitHub owner/repo (or full GitHub URL)";
        const name = m[1].split("/")[1].toLowerCase().replace(/[^\w-]/g, "-");
        const dest = path.join(os.homedir(), ".hermes", "profiles", HERMES_PROFILE(), "skills", name);
        if (fscb.existsSync(dest)) return `already installed: ${name} (run_skill can use it now)`;
        try {
          await execFileP("git", ["clone", "--depth", "1", `https://github.com/${m[1]}.git`, dest], { timeout: 120_000 });
          const files = fscb.readdirSync(dest).map((f) => f.toLowerCase());
          if (!files.includes("skill.md") && !files.includes("manifest.yml")) {
            fscb.rmSync(dest, { recursive: true, force: true });
            return `error: ${m[1]} doesn't look like a skill (no SKILL.md/manifest.yml at its root) — removed`;
          }
          return `installed "${name}" from ${m[1]} — available to run_skill now. Skills: ${listSkills().join(", ")}`;
        } catch (e) {
          fscb.rmSync(dest, { recursive: true, force: true });
          return `error: install failed — ${String(e).slice(0, 150)}`;
        }
      }
      case "web_search": {
        const q = String(args.query ?? "").slice(0, 300);
        if (!q) return "error: empty query";
        const res = await fetch(`${SEARX()}/search?q=${encodeURIComponent(q)}&format=json`, {
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return `error: search backend ${res.status}`;
        const json = (await res.json()) as { results?: { title: string; url: string; content?: string }[] };
        const top = (json.results ?? []).slice(0, 6);
        if (top.length === 0) return "no results";
        return top.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${(r.content ?? "").slice(0, 200)}`).join("\n");
      }
      case "fetch_url": {
        const url = String(args.url ?? "");
        if (!/^https?:\/\//.test(url)) return "error: http(s) URLs only";
        const res = await fetch(url, {
          signal: AbortSignal.timeout(15_000),
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh) AlterPersona/1.0" },
        });
        if (!res.ok) return `error: ${res.status}`;
        return stripHtml(await res.text()).slice(0, 8000);
      }
      case "run_skill": {
        const skill = String(args.skill ?? "").replace(/[^\w-]/g, "");
        if (!listSkills().includes(skill)) return `error: unknown skill "${skill}" (available: ${listSkills().join(", ")})`;
        const { stdout } = await execFileP(
          "/opt/homebrew/bin/python3",
          [HERMES_RUN(), "--profile", HERMES_PROFILE(), "--skill", skill, "--input", "{}"],
          { timeout: 600_000, maxBuffer: 4 * 1024 * 1024 }
        );
        return stdout.trim().slice(0, 6000) || "(skill produced no output)";
      }
      case "read_notes": {
        const n = Number(args.count) || 10;
        if (!fscb.existsSync(NOTES_PATH())) return "no notes file";
        const lines = fscb
          .readFileSync(NOTES_PATH(), "utf8")
          .split("\n")
          .filter((l) => l.startsWith("- "))
          .slice(-n);
        return lines.join("\n") || "no notes yet";
      }
      default:
        return `error: unknown tool "${name}"`;
    }
  } catch (e) {
    return `error: ${String(e).slice(0, 200)}`;
  }
}

/** Capabilities block for the response contract — the anti-confabulation
 * clause: the persona must know what it can do and what it is. */
export function renderCapabilities(): string {
  return `## Your live capabilities — use them, never deny them
You are a LIVING persona running on the owner's agent platform. You are not a
static snapshot: your memory grows with every correction, clarification, and
upload, and you have real tools available THIS turn:
- web_search: live web search (weather, news, anything current)
- fetch_url: read a specific web page
- run_skill: run the installed platform skills (${listSkills().join(", ") || "none"})
- read_notes: the owner's personal notes
- send_voice_note: SPEAK text aloud in the owner's cloned voice (Telegram
  voice note). When asked to "read this out" or "say it in my voice", call it
  with the full text — then confirm in one short line, don't repeat the text.
${process.env.ALTER_TOOL_INSTALL === "allow" ? "- install_skill: install a new tool/skill from a GitHub repo into your platform profile (web_search for it first if you only have a name)." : "- (tool installation is disabled for this persona; the owner can enable it with ALTER_TOOL_INSTALL=allow)"}
When a question needs current information or an action, CALL a tool instead
of declining. Never claim you "cannot browse", "cannot speak or generate
audio", are "text-based only", "fixed", or "cannot be updated" — those
statements are all false. If a tool fails, say plainly that it failed and
answer from what you have.`;
}
