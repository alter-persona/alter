import AdmZip from "adm-zip";
import fs from "node:fs";
import path from "node:path";
import { CorpusError } from "../../types";
import type { ChatExportProvider, ChatParseResult } from "./types";
import { claudeProvider } from "./claude";
import { openaiProvider } from "./openai";

/** Registered providers, tried in order. */
export const PROVIDERS: ChatExportProvider[] = [claudeProvider, openaiProvider];

/** Detect + parse one zip buffer with whichever provider recognizes it. */
export function parseChatZip(
  zip: AdmZip,
  zipName: string
): { provider: string; parsed: ChatParseResult } | null {
  const provider = PROVIDERS.find((p) => {
    try {
      return p.detect(zip);
    } catch {
      return false;
    }
  });
  if (!provider) return null;
  return { provider: provider.name, parsed: provider.parse(zip, zipName) };
}

export interface ChatDirResult {
  results: { zipName: string; provider: string; parsed: ChatParseResult }[];
  skippedFiles: { file: string; reason: string }[];
}

export function parseChatExportDir(dir: string): ChatDirResult {
  const out: ChatDirResult = { results: [], skippedFiles: [] };
  if (!fs.existsSync(dir)) return out;

  const zips = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".zip"));
  for (const zipName of zips) {
    const zipPath = path.join(dir, zipName);
    let zip: AdmZip;
    try {
      zip = new AdmZip(zipPath);
      zip.getEntries(); // force central-directory parse so corruption surfaces here
    } catch (e) {
      out.skippedFiles.push({
        file: `sources/chat-export/${zipName}`,
        reason: `unreadable zip (${String(e)})`,
      });
      continue;
    }

    const provider = PROVIDERS.find((p) => {
      try {
        return p.detect(zip);
      } catch {
        return false;
      }
    });
    if (!provider) {
      out.skippedFiles.push({
        file: `sources/chat-export/${zipName}`,
        reason: `no provider recognized this export format (available: ${PROVIDERS.map((p) => p.name).join(", ")})`,
      });
      continue;
    }

    try {
      out.results.push({ zipName, provider: provider.name, parsed: provider.parse(zip, zipName) });
    } catch (e) {
      out.skippedFiles.push({
        file: `sources/chat-export/${zipName}`,
        reason: e instanceof CorpusError ? e.message : `parse failed (${String(e)})`,
      });
    }
  }
  return out;
}
