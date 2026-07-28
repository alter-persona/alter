import fs from "node:fs";
import path from "node:path";
import { config, ALL_SOURCES, type SourceKey } from "./config";
import { chunkText } from "./chunk";
import { dedupe } from "./dedup";
import { itemId, chunkId } from "./hash";
import { redact, mergeCounts } from "./redact";
import { renderReport } from "./report";
import { buildProfile } from "./profile/profile";
import { parseInterviewDir } from "./sources/interview";
import { parseChatExportDir } from "./sources/chat";
import { parseWorkDir } from "./sources/work";
import { writeJson, writeJsonl, writeFileAtomic } from "./writers";
import type {
  CorpusChunk,
  CorpusItem,
  HoldoutEntry,
  HumanMessage,
  RunReport,
  SourceStats,
} from "./types";

export interface BuildOptions {
  sources: SourceKey[];
  dryRun: boolean;
  noLlm: boolean;
}

interface SourceCache {
  items: CorpusItem[];
  stats: SourceStats;
  holdout?: HoldoutEntry[];
  humanMessages?: HumanMessage[];
  audioMinutes?: number;
}

function emptyStats(): SourceStats {
  return {
    itemsIn: 0,
    itemsKept: 0,
    chunks: 0,
    privateChunks: 0,
    publicChunks: 0,
    redactions: {},
    shortDropped: 0,
    dedupDropped: 0,
    skippedFiles: [],
    dateMin: null,
    dateMax: null,
    notes: [],
  };
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Redact + (optionally) short-drop + dedup one source's items. */
function processItems(
  items: CorpusItem[],
  stats: SourceStats,
  opts: { applyShortDrop: boolean }
): CorpusItem[] {
  stats.itemsIn = items.length;

  const redacted: CorpusItem[] = [];
  for (const item of items) {
    const r = redact(item.text);
    mergeCounts(stats.redactions, r.counts);
    if (opts.applyShortDrop && item.sourceType === "chat_export" && wordCount(r.text) < config.minWords) {
      stats.shortDropped++;
      continue;
    }
    redacted.push({ ...item, text: r.text });
  }

  const { kept, dropped } = dedupe(redacted, config.dedupThreshold);
  stats.dedupDropped = dropped;
  stats.itemsKept = kept.length;

  for (const item of kept) {
    if (!item.date) continue;
    if (!stats.dateMin || item.date < stats.dateMin) stats.dateMin = item.date;
    if (!stats.dateMax || item.date > stats.dateMax) stats.dateMax = item.date;
  }
  return kept;
}

function toChunks(items: CorpusItem[], stats: SourceStats): CorpusChunk[] {
  const chunks: CorpusChunk[] = [];
  for (const item of items) {
    const pieces = chunkText(item.text, config.chunkMaxTokens, config.chunkTargetTokens);
    const base = itemId(item.sourceType, item.origin, item.text);
    pieces.forEach((text, i) => {
      chunks.push({
        id: chunkId(base, i, pieces.length),
        text,
        source_type: item.sourceType,
        label: item.label,
        domain: item.domain,
        date: item.date,
        sensitivity: item.sensitivity,
        origin: item.origin,
      });
      stats.chunks++;
      if (item.sensitivity === "private") stats.privateChunks++;
      else stats.publicChunks++;
    });
  }
  return chunks;
}

function cachePath(source: SourceKey): string {
  return path.join(config.cacheDir, `${source}.json`);
}

function loadCache(source: SourceKey): SourceCache | null {
  try {
    return JSON.parse(fs.readFileSync(cachePath(source), "utf8")) as SourceCache;
  } catch {
    return null;
  }
}

export async function build(opts: BuildOptions): Promise<{ report: string; reportData: RunReport }> {
  const caches: Record<SourceKey, SourceCache | null> = {
    interview: null,
    "chat-export": null,
    work: null,
  };

  // Sources not selected this run are restored from the previous run's cache
  // so --source rebuilds one source without losing the others' output.
  for (const source of ALL_SOURCES) {
    if (!opts.sources.includes(source)) caches[source] = loadCache(source);
  }

  for (const source of opts.sources) {
    const stats = emptyStats();

    if (source === "interview") {
      const parsed = await parseInterviewDir(config.interviewDir);
      stats.skippedFiles = parsed.skippedFiles;
      stats.notes = parsed.notes;
      // Holdout answers get the same redaction as everything else stored.
      const holdout = parsed.holdout.map((h) => ({
        ...h,
        answer: h.answer ? redact(h.answer).text : h.answer,
      }));
      const items = processItems(parsed.items, stats, { applyShortDrop: false });
      caches.interview = { items, stats, holdout, audioMinutes: parsed.audioMinutes };
    }

    if (source === "chat-export") {
      const parsed = parseChatExportDir(config.chatExportDir);
      stats.skippedFiles = parsed.skippedFiles;
      const rawItems: CorpusItem[] = [];
      const humanMessages: HumanMessage[] = [];
      for (const r of parsed.results) {
        rawItems.push(...r.parsed.messages, ...r.parsed.projectDocs);
        humanMessages.push(...r.parsed.humanMessages);
        stats.notes.push(
          `${r.zipName} (${r.provider}): ${r.parsed.stats.conversations} conversations, ` +
            `${r.parsed.stats.humanMessages} human msgs, ${r.parsed.stats.assistantMessages} assistant msgs (excluded), ` +
            `${r.parsed.stats.projects} projects`
        );
      }
      const items = processItems(rawItems, stats, { applyShortDrop: true });
      // Profile input mirrors corpus rules: redacted, short messages dropped.
      const profileMessages = humanMessages
        .map((m) => ({ ...m, text: redact(m.text).text }))
        .filter((m) => wordCount(m.text) >= config.minWords);
      caches["chat-export"] = { items, stats, humanMessages: profileMessages };
    }

    if (source === "work") {
      const parsed = await parseWorkDir(config.workDir); // throws on manifest violations
      stats.skippedFiles = parsed.skippedFiles;
      stats.notes = parsed.notes;
      const items = processItems(parsed.items, stats, { applyShortDrop: false });
      caches.work = { items, stats };
    }
  }

  // Assemble outputs from all sources (fresh + cached).
  const allChunks: CorpusChunk[] = [];
  const perSource: Record<string, SourceStats> = {};
  for (const source of ALL_SOURCES) {
    const cache = caches[source];
    if (!cache) continue;
    // Recompute chunk counts fresh each assembly for accurate reporting.
    cache.stats.chunks = 0;
    cache.stats.privateChunks = 0;
    cache.stats.publicChunks = 0;
    allChunks.push(...toChunks(cache.items, cache.stats));
    perSource[source] = cache.stats;
  }

  const privateChunks = allChunks.filter((c) => c.sensitivity === "private");
  const publicChunks = allChunks.filter((c) => c.sensitivity === "public");
  const sortKey = (c: CorpusChunk) => `${c.source_type}|${c.origin}|${c.id}`;
  privateChunks.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  publicChunks.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  const holdout = caches.interview?.holdout ?? [];
  const chatMessages = caches["chat-export"]?.humanMessages ?? [];
  const chatRedactions = Object.values(caches["chat-export"]?.stats.redactions ?? {}).reduce(
    (a, b) => a + b,
    0
  );

  const { profile, generatedBy, llmError } = await buildProfile(chatMessages, {
    noLlm: opts.noLlm,
    redactionsApplied: chatRedactions,
    inputType: "claude-export",
  });
  if (llmError && caches["chat-export"]) {
    caches["chat-export"].stats.notes.push(`profile LLM call failed: ${llmError.slice(0, 200)}`);
  }

  const reportData: RunReport = {
    generatedAt: new Date().toISOString(),
    dryRun: opts.dryRun,
    sourcesRun: opts.sources,
    perSource,
    interviewAudioMinutes: caches.interview ? caches.interview.audioMinutes ?? 0 : null,
    holdoutCount: holdout.length,
    totals: {
      items: Object.values(perSource).reduce((a, s) => a + s.itemsKept, 0),
      chunks: allChunks.length,
      private: privateChunks.length,
      public: publicChunks.length,
    },
    profileGeneratedBy: generatedBy,
  };
  const report = renderReport(reportData);

  if (!opts.dryRun) {
    // Two physically separate corpus files — the public index can be built
    // without ever reading private material.
    writeJsonl(path.join(config.corpusDir, "private.jsonl"), privateChunks);
    writeJsonl(path.join(config.corpusDir, "public.jsonl"), publicChunks);
    writeJson(path.join(config.corpusDir, "profile.json"), profile);
    writeFileAtomic(path.join(config.corpusDir, "report.md"), report);
    // Sealed holdout: written here and nowhere else.
    writeJsonl(path.join(config.holdoutDir, "validation.jsonl"), holdout);
    for (const source of ALL_SOURCES) {
      if (caches[source]) writeJson(cachePath(source), caches[source]);
    }
  }

  return { report, reportData };
}
