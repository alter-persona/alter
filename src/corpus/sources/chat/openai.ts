import type AdmZip from "adm-zip";
import { CorpusError } from "../../types";
import type { CorpusItem, HumanMessage } from "../../types";
import type { ChatExportProvider, ChatParseResult } from "./types";

/**
 * OpenAI (ChatGPT) data-export provider. The export's conversations.json is a
 * JSON array; each conversation holds a `mapping` tree of nodes. We walk every
 * node's message, keep ONLY author.role === "user", read text from
 * content.parts (string parts only — multimodal/tool parts are skipped), and
 * carry the conversation title and timestamps as metadata. Assistant, system,
 * and tool messages never enter the corpus.
 */

interface OpenAiContent {
  content_type?: string;
  parts?: unknown[];
  text?: string; // some content types (e.g. user_editable_context) use text
}

interface OpenAiNode {
  id?: string;
  message?: {
    id?: string;
    author?: { role?: string };
    create_time?: number | null;
    content?: OpenAiContent;
    metadata?: { is_visually_hidden_from_conversation?: boolean };
  } | null;
  parent?: string | null;
  children?: string[];
}

interface OpenAiConversation {
  id?: string;
  conversation_id?: string;
  title?: string | null;
  create_time?: number | null;
  update_time?: number | null;
  mapping?: Record<string, OpenAiNode>;
}

function epochToIso(t: number | null | undefined): string | null {
  if (!t || !Number.isFinite(t)) return null;
  try {
    return new Date(t * 1000).toISOString();
  } catch {
    return null;
  }
}

function userText(content: OpenAiContent | undefined): string {
  if (!content) return "";
  // The overwhelmingly common case: content_type "text" with string parts.
  // "multimodal_text" mixes strings with image objects — keep the strings.
  if (Array.isArray(content.parts)) {
    return content.parts
      .filter((p): p is string => typeof p === "string")
      .map((p) => p.trim())
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }
  return "";
}

function conversationEntries(zip: AdmZip) {
  return zip
    .getEntries()
    .filter((e) => /^conversations(-\d+)?\.json$/.test(e.entryName))
    .sort((a, b) => a.entryName.localeCompare(b.entryName));
}

export const openaiProvider: ChatExportProvider = {
  name: "openai",

  detect(zip: AdmZip): boolean {
    // Newer exports shard: conversations-000.json, -001.json, …; older ones
    // ship a single conversations.json. Either way the entries hold a
    // mapping tree (Claude exports hold chat_messages instead).
    const entry = conversationEntries(zip)[0];
    if (!entry) return false;
    const head = zip.readAsText(entry).slice(0, 4000);
    return head.trimStart().startsWith("[") && head.includes('"mapping"') && !head.includes('"chat_messages"');
  },

  parse(zip: AdmZip, zipName: string): ChatParseResult {
    const entries = conversationEntries(zip);
    if (entries.length === 0) throw new CorpusError(`${zipName}: no conversations*.json found`);

    const conversations: OpenAiConversation[] = [];
    for (const entry of entries) {
      let shard: OpenAiConversation[];
      try {
        shard = JSON.parse(zip.readAsText(entry));
      } catch (e) {
        throw new CorpusError(`${zipName}: ${entry.entryName} is not valid JSON (${String(e)})`);
      }
      if (!Array.isArray(shard)) {
        throw new CorpusError(`${zipName}: ${entry.entryName} is not an array`);
      }
      conversations.push(...shard);
    }

    const messages: CorpusItem[] = [];
    const humanMessages: HumanMessage[] = [];
    let humanCount = 0;
    let assistantCount = 0;

    for (const conv of conversations) {
      const convId = conv.conversation_id ?? conv.id ?? "unknown";
      const convLabel = conv.title?.trim() || convId.slice(0, 8);
      const convDate = epochToIso(conv.create_time);

      // Order user messages chronologically within the conversation: walk the
      // mapping and sort by create_time (the tree may hold branched retries —
      // every user-authored variant is the person's own writing; keep all,
      // deduplicated by message id).
      const nodes = Object.values(conv.mapping ?? {});
      const userNodes: { id: string; time: number; text: string }[] = [];
      const seen = new Set<string>();
      for (const node of nodes) {
        const m = node.message;
        if (!m) continue;
        const role = m.author?.role;
        if (role === "assistant") {
          assistantCount++;
          continue;
        }
        if (role !== "user") continue; // system/tool never enter
        if (m.metadata?.is_visually_hidden_from_conversation) continue; // injected context, not the person
        const id = m.id ?? node.id ?? "";
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const text = userText(m.content);
        if (!text) continue;
        humanCount++;
        userNodes.push({ id, time: m.create_time ?? 0, text });
      }
      userNodes.sort((a, b) => a.time - b.time);

      for (const n of userNodes) {
        const date = epochToIso(n.time) ?? convDate;
        humanMessages.push({
          text: n.text,
          date,
          conversation: convLabel,
          conversationId: convId,
          project: null,
        });
        messages.push({
          text: n.text,
          sourceType: "chat_export",
          label: "chat-message",
          domain: null,
          date,
          sensitivity: "private",
          origin: `${zipName}#conv:"${convLabel}"(${convId.slice(0, 8)})#msg:${n.id.slice(0, 8)}`,
        });
      }
    }

    return {
      messages,
      projectDocs: [], // OpenAI exports have no project docs
      humanMessages,
      stats: {
        conversations: conversations.length,
        humanMessages: humanCount,
        assistantMessages: assistantCount,
        projects: 0,
      },
    };
  },
};
