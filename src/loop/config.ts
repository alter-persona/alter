import fs from "node:fs";
import path from "node:path";

/**
 * Improvement-loop configuration. All thresholds live in ONE file
 * (config/improvement.json); this module loads it once with typed defaults so
 * a missing key never crashes the loop.
 */

export interface ModelRef {
  provider: "openai_compatible" | "anthropic";
  model: string;
  url?: string;
}

export interface LoopConfig {
  improvementModel: { mode: "frontier" | "local"; frontier: ModelRef; local: ModelRef };
  classifierModel: ModelRef;
  hotNoteCap: number;
  gapSimilarityThreshold: number; // cosine DISTANCE above this = weak retrieval
  gapWeakCountForInvite: number;
  reconAutoConfidence: number;
  neighborCheckDistance: number; // new chunk vs neighbors closer than this get conflict-checked
  spotCheckEveryEvents: number;
  resynthesisChunkThreshold: number;
  resynthesisCorrectionThreshold: number;
  maxClarificationsPerConversation: number;
  maxInvitationsPerConversation: number;
  longMemoMaterialSeconds: number;
  /** Short-term session memory: how long turns keep shaping replies, and how
   * many turns enter the prompt. Purge = falling out of the window (events
   * are retained on disk for the loop and audit). */
  sessionRetentionHours: number;
  sessionMaxTurns: number;
}

const DEFAULTS: LoopConfig = {
  improvementModel: {
    mode: "frontier",
    frontier: { provider: "anthropic", model: "claude-sonnet-5" },
    local: { provider: "openai_compatible", url: "http://127.0.0.1:11434/v1", model: "local-large:latest" },
  },
  classifierModel: { provider: "openai_compatible", url: "http://127.0.0.1:11434/v1", model: "local-small:latest" },
  hotNoteCap: 10,
  gapSimilarityThreshold: 0.62,
  gapWeakCountForInvite: 3,
  reconAutoConfidence: 0.75,
  neighborCheckDistance: 0.45,
  spotCheckEveryEvents: 50,
  resynthesisChunkThreshold: 40,
  resynthesisCorrectionThreshold: 15,
  maxClarificationsPerConversation: 1,
  maxInvitationsPerConversation: 1,
  longMemoMaterialSeconds: 90,
  sessionRetentionHours: 12,
  sessionMaxTurns: 30,
};

let cached: LoopConfig | null = null;

export function loopConfig(): LoopConfig {
  if (cached) return cached;
  const p = path.join(process.cwd(), "config", "improvement.json");
  let fromFile: Partial<LoopConfig> = {};
  try {
    fromFile = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    /* defaults */
  }
  cached = { ...DEFAULTS, ...fromFile };
  // IMPROVEMENT_MODEL=local flips to the fully-offline path end to end.
  if (process.env.IMPROVEMENT_MODEL === "local") cached.improvementModel.mode = "local";
  if (process.env.IMPROVEMENT_MODEL === "frontier") cached.improvementModel.mode = "frontier";
  return cached;
}

export function resetLoopConfigForTests(): void {
  cached = null;
}
