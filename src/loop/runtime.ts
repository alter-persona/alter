import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { routeIntent, isPastFramed } from "@/persona2/gate";
import { retrievePropositions, retrieveEpisodic } from "@/persona2/retrieve";
import {
  renderPersonaCore,
  renderResponseContract,
  buildPrompt,
  buildRecallPrompt,
} from "@/persona2/prompt";
import { valuesAndHeuristics } from "@/persona2/skillgen";
import type { ModeFingerprint } from "@/persona2/fingerprint";
import type { Exemplar } from "@/persona2/exemplars";
import { loopConfig } from "./config";
import { renderHotNotes } from "./hotnotes";
import { readStyleDelta } from "./corrections";
import { recordPersonaTurn } from "./ingest";
import { logWeakRetrieval, invitationText, markInvited } from "./gaps";
import { kickLoopQueue } from "./queue";

/**
 * The persona chat turn, channel-agnostic, with the improvement loop wired in:
 *   - hot notes injected each turn (corrections apply on the very next turn)
 *   - style-delta rules appended to the response contract
 *   - retrieval logged per turn (so corrections can find the culprit chunk)
 *   - past-framed questions additionally retrieve historical chunks
 *   - at most ONE in-chat clarification per conversation; at most one gap
 *     invitation per conversation (clarification wins when both are due)
 *   - a message following an asked clarification routes back as its answer
 * All improvement work stays async; this path adds only DB reads.
 */

const OLLAMA = () => process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const TALK_MODEL = () => process.env.TALK_MODEL ?? "local-small:latest";

interface OllamaMsg {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
}

async function defaultToolLoopGenerate(ctx: { channel: string; conversationId: string }) {
  const { personaTools, executeTool } = await import("./tools");
  const tools = personaTools();
  return async (
    sys: string,
    usr: string,
    history: { role: "user" | "assistant"; content: string }[]
  ): Promise<string> => {
    const messages: OllamaMsg[] = [
      { role: "system", content: sys },
      ...history.slice(-8).map((h) => ({ role: h.role, content: h.content }) as OllamaMsg),
      { role: "user", content: usr },
    ];
    for (let round = 0; round < 6; round++) {
      const res = await fetch(`${OLLAMA()}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: TALK_MODEL(),
          stream: false,
          think: false,
          tools,
          options: { num_predict: 600 },
          messages,
        }),
        signal: AbortSignal.timeout(300_000),
      });
      if (!res.ok) throw new Error(`LLM ${res.status}`);
      const msg = ((await res.json()) as { message?: OllamaMsg }).message;
      if (!msg) throw new Error("LLM returned no message");
      const calls = msg.tool_calls ?? [];
      if (calls.length === 0 || round === 5) return (msg.content ?? "").trim();
      messages.push(msg);
      for (const c of calls.slice(0, 4)) {
        const result = await executeTool(c.function.name, c.function.arguments ?? {}, ctx);
        messages.push({ role: "tool", content: result, tool_name: c.function.name });
      }
    }
    return "";
  };
}

export interface ChatTurnInput {
  personaId: string;
  personaName: string;
  channel: "playground" | "telegram";
  conversationId: string;
  message: string;
  userEventId: string;
  history: { role: "user" | "assistant"; content: string }[];
  mode?: "spoken" | "written";
  voiceNote?: boolean;
  /** Test hook: replace the generation call. */
  generate?: (system: string, user: string, history: ChatTurnInput["history"]) => Promise<string>;
}

export interface ChatTurnResult {
  reply: string;
  personaEventId: string;
  intent: string;
  clarifiedCaseId?: string;
  askedClarification?: string;
  invitedTopic?: string;
}

interface TurnLog {
  props: string[];
  episodic: string[];
  clarifiedCaseId?: string;
  invitedTopic?: string;
}

async function lastPersonaTurn(conversationId: string) {
  return prisma.updateEvent.findFirst({
    where: { conversationId, intentSource: "persona_turn" },
    orderBy: { createdAt: "desc" },
  });
}

/** If the previous persona turn asked a clarification and its case is still
 * open, this message is the answer — route it back through distillation. */
export async function routeClarificationAnswer(
  conversationId: string,
  userEventId: string
): Promise<string | null> {
  const prev = await lastPersonaTurn(conversationId);
  const log = prev?.retrievalLog as TurnLog | null;
  if (!log?.clarifiedCaseId) return null;
  const kase = await prisma.reconCase.findUnique({ where: { id: log.clarifiedCaseId } });
  if (!kase || kase.status !== "open") return null;
  await prisma.updateEvent.update({
    where: { id: userEventId },
    data: { retrievalLog: { clarifiesCaseId: kase.id } },
  });
  await prisma.loopJob.create({
    data: { personaId: kase.personaId, kind: "clarify", eventId: userEventId },
  });
  kickLoopQueue();
  return kase.id;
}

async function conversationBudget(conversationId: string): Promise<{ clarified: boolean; invited: boolean }> {
  const turns = await prisma.updateEvent.findMany({
    where: { conversationId, intentSource: "persona_turn" },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { retrievalLog: true },
  });
  let clarified = false;
  let invited = false;
  for (const t of turns) {
    const log = t.retrievalLog as TurnLog | null;
    if (log?.clarifiedCaseId) clarified = true;
    if (log?.invitedTopic) invited = true;
  }
  return { clarified, invited };
}

export async function runChatTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
  const cfg = loopConfig();
  const mode = input.mode ?? "written";
  const persona = { id: input.personaId, name: input.personaName };

  // ── Prompt assembly (all DB reads, no LLM) ────────────────────────────
  const fpRow = await prisma.styleFingerprint.findUnique({ where: { personaId: persona.id } });
  if (!fpRow) throw new Error("no style fingerprint — run persona2 fingerprint first");
  const fp = (mode === "spoken" ? fpRow.spoken : fpRow.written) as unknown as ModeFingerprint;
  const { values, heuristics } = await valuesAndHeuristics(persona.id);
  const exemplars: Exemplar[] = await fs
    .readFile(path.join(process.cwd(), "corpus", "persona2", persona.id, "exemplars.json"), "utf8")
    .then(JSON.parse)
    .catch(() => []);
  const core = renderPersonaCore({ name: persona.name, values, heuristics, fingerprint: fp, mode });

  const intent = routeIntent(input.message);
  const pastFramed = isPastFramed(input.message);
  const hotNotesBlock = await renderHotNotes(persona.id);

  // Style-delta rules from corrections extend the contract; the capabilities
  // block tells the persona what it CAN do (anti-confabulation: it must never
  // describe itself as static or tool-less).
  const deltaRules = readStyleDelta(persona.id);
  const { renderCapabilities } = await import("./tools");
  let contract = `${renderCapabilities()}\n\n${renderResponseContract({ name: persona.name, voiceNote: Boolean(input.voiceNote) })}`;
  if (deltaRules.length > 0) {
    contract += `\n\nAdditional standing rules from the real person's corrections:\n${deltaRules
      .slice(-12)
      .map((r) => `- ${r}`)
      .join("\n")}`;
  }

  const turnLog: TurnLog = { props: [], episodic: [] };
  let system: string;
  let user: string;
  let bestDistance: number | null = null;

  if (intent === "explicit_recall") {
    const eps = await retrieveEpisodic(persona.id, input.message, { k: 3 });
    turnLog.episodic = eps.map((e) => e.origin);
    ({ system, user } = buildRecallPrompt({ core, episodic: eps, question: input.message }));
  } else {
    const notes =
      intent === "knowledge"
        ? await retrievePropositions(persona.id, input.message, { k: 4, includeHistorical: pastFramed })
        : [];
    turnLog.props = notes.map((n) => n.id);
    bestDistance = notes[0]?.distance ?? null;
    ({ system, user } = buildPrompt({
      core,
      notes,
      contract,
      exemplars,
      mode,
      question: input.message,
    }));
  }

  // Hot notes at the END region, right before the final question (strongest
  // position — they must change behavior on this very turn).
  if (hotNotesBlock) {
    const marker = "Now reply to this message:";
    user = user.includes(marker)
      ? user.replace(marker, `${hotNotesBlock}\n\n${marker}`)
      : `${user}\n\n${hotNotesBlock}`;
  }

  // ── Generation — persona voice with the platform's hands: native Ollama
  // tool calling (web_search / fetch_url / run_skill / read_notes) inside
  // the loop, max 5 tool rounds. A tool failure never breaks the reply.
  const generate =
    input.generate ??
    (await defaultToolLoopGenerate({ channel: input.channel, conversationId: input.conversationId }));
  let reply = await generate(system, user, input.history);

  // ── Solicitation: one clarification OR one invitation per conversation ─
  const budget = await conversationBudget(input.conversationId);
  let askedClarification: string | undefined;
  let invitedTopic: string | undefined;

  if (!budget.clarified && intent !== "smalltalk") {
    const kase = await prisma.reconCase.findFirst({
      where: { personaId: persona.id, status: "open", askedInChat: false, question: { not: null } },
      orderBy: { createdAt: "asc" },
    });
    if (kase?.question) {
      reply += `\n\n${kase.question}`;
      askedClarification = kase.question;
      turnLog.clarifiedCaseId = kase.id;
      await prisma.reconCase.update({
        where: { id: kase.id },
        data: { askedInChat: true, askedInConversation: input.conversationId, askedAt: new Date() },
      });
    }
  }

  if (!askedClarification && !budget.invited && intent === "knowledge") {
    const gap = await logWeakRetrieval(persona.id, input.message, bestDistance);
    if (gap?.readyToInvite) {
      reply += invitationText(gap.topic);
      invitedTopic = gap.topic;
      await markInvited(persona.id, gap.topic);
    }
  } else if (intent === "knowledge") {
    await logWeakRetrieval(persona.id, input.message, bestDistance); // still count gaps
  }

  // ── Record the persona turn with its retrieval log ────────────────────
  const personaEventId = await recordPersonaTurn({
    personaId: persona.id,
    channel: input.channel,
    conversationId: input.conversationId,
    replyText: reply,
    retrievalLog: turnLog as unknown as { props: string[]; episodic: string[] },
    inReplyToEventId: input.userEventId,
  });

  void cfg; // thresholds already consumed by helpers
  return {
    reply,
    personaEventId,
    intent,
    clarifiedCaseId: turnLog.clarifiedCaseId,
    askedClarification,
    invitedTopic,
  };
}
