import type AdmZip from "adm-zip";
import type { CorpusItem, HumanMessage } from "../../types";

export interface ChatParseResult {
  /** Human-authored messages as corpus items (assistant text never included). */
  messages: CorpusItem[];
  /** Project names/descriptions/docs as corpus items tagged project material. */
  projectDocs: CorpusItem[];
  /** Raw human messages (post-parse, pre-chunk) for the profile builder. */
  humanMessages: HumanMessage[];
  stats: {
    conversations: number;
    humanMessages: number;
    assistantMessages: number;
    projects: number;
  };
}

/**
 * Provider interface for AI-assistant data exports. A provider inspects a zip
 * (detect) and, when it recognizes the format, parses it. Adding ChatGPT
 * support later means one new file implementing this interface:
 * an OpenAI export's conversations.json is a JSON array whose entries hold a
 * `mapping` tree of nodes; walk each node's message, keep those with
 * message.author.role === "user", and read text from message.content.parts.
 */
export interface ChatExportProvider {
  name: string;
  detect(zip: AdmZip): boolean;
  parse(zip: AdmZip, zipName: string): ChatParseResult;
}
