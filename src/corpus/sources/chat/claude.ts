import type AdmZip from "adm-zip";
import { CorpusError } from "../../types";
import type { CorpusItem, HumanMessage } from "../../types";
import type { ChatExportProvider, ChatParseResult } from "./types";

interface ClaudeMessage {
  uuid: string;
  text: string;
  content?: { type: string; text?: string }[];
  sender: "human" | "assistant";
  created_at: string;
}

interface ClaudeConversation {
  uuid: string;
  name: string;
  created_at: string;
  chat_messages: ClaudeMessage[];
  project?: { uuid?: string; name?: string } | null;
  project_uuid?: string;
}

interface ClaudeProject {
  uuid: string;
  name: string;
  description?: string;
  docs?: { uuid: string; filename: string; content: string; created_at?: string }[];
  created_at?: string;
}

function messageText(m: ClaudeMessage): string {
  if (m.text && m.text.trim()) return m.text.trim();
  if (Array.isArray(m.content)) {
    return m.content
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text!.trim())
      .join("\n\n")
      .trim();
  }
  return "";
}

export const claudeProvider: ChatExportProvider = {
  name: "claude",

  detect(zip: AdmZip): boolean {
    const entry = zip.getEntry("conversations.json");
    if (!entry) return false;
    // Claude exports are a top-level JSON array of objects with chat_messages;
    // OpenAI exports use a mapping tree instead.
    const head = zip.readAsText(entry).slice(0, 4000);
    return head.trimStart().startsWith("[") && head.includes('"chat_messages"');
  },

  parse(zip: AdmZip, zipName: string): ChatParseResult {
    const convEntry = zip.getEntry("conversations.json");
    if (!convEntry) throw new CorpusError(`${zipName}: conversations.json missing`);

    let conversations: ClaudeConversation[];
    try {
      conversations = JSON.parse(zip.readAsText(convEntry));
    } catch (e) {
      throw new CorpusError(`${zipName}: conversations.json is not valid JSON (${String(e)})`);
    }
    if (!Array.isArray(conversations)) {
      throw new CorpusError(`${zipName}: conversations.json is not an array`);
    }

    // Projects: uuid -> name map for association, plus corpus items for docs.
    const projects = new Map<string, ClaudeProject>();
    const projectDocs: CorpusItem[] = [];
    for (const entry of zip.getEntries()) {
      if (!/^projects\/[^/]+\.json$/.test(entry.entryName)) continue;
      let project: ClaudeProject;
      try {
        project = JSON.parse(zip.readAsText(entry));
      } catch {
        continue; // malformed single project file: skip, conversations still parse
      }
      if (!project?.uuid) continue;
      projects.set(project.uuid, project);

      const headerText = [project.name, project.description].filter((s) => s && s.trim()).join("\n\n");
      if (headerText && project.description?.trim()) {
        projectDocs.push({
          text: headerText,
          sourceType: "project_doc",
          label: "project-description",
          domain: null,
          date: project.created_at ?? null,
          sensitivity: "private",
          origin: `${zipName}#project:${project.name ?? project.uuid.slice(0, 8)}`,
        });
      }
      for (const doc of project.docs ?? []) {
        if (!doc.content || !doc.content.trim()) continue;
        projectDocs.push({
          text: doc.content.trim(),
          sourceType: "project_doc",
          label: "project-doc",
          domain: null,
          date: doc.created_at ?? project.created_at ?? null,
          sensitivity: "private",
          origin: `${zipName}#project:${project.name ?? "?"}/${doc.filename}`,
        });
      }
    }

    const messages: CorpusItem[] = [];
    const humanMessages: HumanMessage[] = [];
    let humanCount = 0;
    let assistantCount = 0;

    for (const conv of conversations) {
      const projectName =
        conv.project?.name ??
        (conv.project_uuid ? projects.get(conv.project_uuid)?.name : undefined) ??
        null;
      for (const m of conv.chat_messages ?? []) {
        if (m.sender === "assistant") {
          assistantCount++;
          continue; // assistant text is context only; never enters the corpus
        }
        if (m.sender !== "human") continue;
        humanCount++;
        const text = messageText(m);
        if (!text) continue;

        const convLabel = conv.name?.trim() || conv.uuid.slice(0, 8);
        humanMessages.push({
          text,
          date: m.created_at ?? conv.created_at ?? null,
          conversation: convLabel,
          conversationId: conv.uuid,
          project: projectName,
        });
        messages.push({
          text,
          sourceType: "chat_export",
          label: "chat-message",
          domain: projectName,
          date: m.created_at ?? conv.created_at ?? null,
          sensitivity: "private",
          origin: `${zipName}#conv:"${convLabel}"(${conv.uuid.slice(0, 8)})#msg:${m.uuid.slice(0, 8)}`,
        });
      }
    }

    return {
      messages,
      projectDocs,
      humanMessages,
      stats: {
        conversations: conversations.length,
        humanMessages: humanCount,
        assistantMessages: assistantCount,
        projects: projects.size,
      },
    };
  },
};
