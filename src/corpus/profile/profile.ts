import type { HumanMessage } from "../types";
import { computeMechanical } from "./mechanical";
import { getLlmProvider } from "./llm/types";

/**
 * corpus/profile.json — conversation-history profile. Mechanical fields are
 * computed deterministically in code; judgment fields come from a build-time
 * LLM call (provider + model via env) and are null under --no-llm or when no
 * provider is configured.
 */

interface JudgmentFields {
  interests: { topic: string; description: string; intensity: string; frequency: string }[] | null;
  domains_of_expertise: { domain: string; level: string; signals: string }[] | null;
  active_projects: { name: string; description: string; status: string; goals: string }[] | null;
  style: {
    tone: string;
    formality: string;
    vocabulary: string;
    formatting_habits: string;
    question_style: string;
    quirks: string;
  } | null;
  recurring_questions_and_needs: string[] | null;
  values_and_priorities: string[] | null;
  tools_and_stack: string[] | null;
  temporal_trends: { period: string; shift: string }[] | null;
  notable_exemplars: string[] | null;
  confidence: { overall_confidence: string; gaps: string[]; notes: string } | null;
}

const NULL_JUDGMENT: JudgmentFields = {
  interests: null,
  domains_of_expertise: null,
  active_projects: null,
  style: null,
  recurring_questions_and_needs: null,
  values_and_priorities: null,
  tools_and_stack: null,
  temporal_trends: null,
  notable_exemplars: null,
  confidence: null,
};

const JUDGMENT_SYSTEM = `You are analyzing a person's own messages to AI assistants to build a factual profile of their interests, expertise, projects, communication style, and values. Work only from the evidence in the messages. Be specific and cite patterns, not single occurrences. Output STRICT JSON matching the schema in the user message — no markdown fences, no commentary.`;

function judgmentPrompt(messages: HumanMessage[], redactionNote: string): string {
  // Sample across the full date range so temporal trends are visible: take an
  // even spread, truncate long messages, cap total size.
  const sorted = [...messages].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  const MAX_MSGS = 220;
  const step = Math.max(1, Math.floor(sorted.length / MAX_MSGS));
  const sample = sorted.filter((_, i) => i % step === 0).slice(0, MAX_MSGS);

  const lines = sample.map((m) => {
    const d = m.date?.slice(0, 10) ?? "????-??-??";
    const proj = m.project ? ` [project: ${m.project}]` : "";
    const text = m.text.length > 600 ? m.text.slice(0, 600) + "…" : m.text;
    return `[${d}]${proj} (conv: ${m.conversation})\n${text}`;
  });

  return `Below are ${sample.length} messages this person wrote to AI assistants between ${
    sorted[0]?.date?.slice(0, 10)
  } and ${sorted[sorted.length - 1]?.date?.slice(0, 10)} (sampled evenly from ${
    messages.length
  } total). ${redactionNote}

Return STRICT JSON with exactly these keys:
{
  "interests": [{"topic": str, "description": str, "intensity": "high|medium|low", "frequency": str}],
  "domains_of_expertise": [{"domain": str, "level": "expert|advanced|intermediate|novice", "signals": str}],
  "active_projects": [{"name": str, "description": str, "status": str, "goals": str}],
  "style": {"tone": str, "formality": str, "vocabulary": str, "formatting_habits": str, "question_style": str, "quirks": str},
  "recurring_questions_and_needs": [str],
  "values_and_priorities": [str],
  "tools_and_stack": [str],
  "temporal_trends": [{"period": str, "shift": str}],
  "notable_exemplars": [str],
  "confidence": {"overall_confidence": "high|medium|low", "gaps": [str], "notes": str}
}
notable_exemplars: 3-5 short verbatim quotes that are strongly characteristic of how this person writes.

MESSAGES:
${lines.join("\n---\n")}`;
}

function parseJudgment(raw: string): JudgmentFields {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const j = JSON.parse(cleaned) as Record<string, unknown>;
  return {
    interests: (j.interests as JudgmentFields["interests"]) ?? null,
    domains_of_expertise: (j.domains_of_expertise as JudgmentFields["domains_of_expertise"]) ?? null,
    active_projects: (j.active_projects as JudgmentFields["active_projects"]) ?? null,
    style: (j.style as JudgmentFields["style"]) ?? null,
    recurring_questions_and_needs: (j.recurring_questions_and_needs as string[]) ?? null,
    values_and_priorities: (j.values_and_priorities as string[]) ?? null,
    tools_and_stack: (j.tools_and_stack as string[]) ?? null,
    temporal_trends: (j.temporal_trends as JudgmentFields["temporal_trends"]) ?? null,
    notable_exemplars: (j.notable_exemplars as string[]) ?? null,
    confidence: (j.confidence as JudgmentFields["confidence"]) ?? null,
  };
}

export interface ProfileBuildResult {
  profile: Record<string, unknown>;
  generatedBy: string;
  llmError: string | null;
}

export async function buildProfile(
  messages: HumanMessage[],
  opts: { noLlm: boolean; redactionsApplied: number; inputType: string }
): Promise<ProfileBuildResult> {
  const mech = computeMechanical(messages);
  const redactionNote =
    "Sensitive strings (keys, emails, phone numbers, addresses, IDs) were replaced with [REDACTED] before analysis.";

  let judgment = NULL_JUDGMENT;
  let generatedBy = "mechanical-only (--no-llm)";
  let llmError: string | null = null;

  if (!opts.noLlm && messages.length > 0) {
    const provider = getLlmProvider();
    if (!provider) {
      generatedBy = "mechanical-only (no CORPUS_LLM_PROVIDER configured)";
    } else {
      try {
        const raw = await provider.complete(JUDGMENT_SYSTEM, judgmentPrompt(messages, redactionNote));
        judgment = parseJudgment(raw);
        generatedBy = `${provider.name}:${provider.model}`;
      } catch (e) {
        llmError = String(e);
        generatedBy = `mechanical-only (LLM failed: ${llmError.slice(0, 120)})`;
      }
    }
  }

  const profile = {
    schema_version: "1.0",
    profile_type: "conversation-history",
    generated_by: generatedBy,
    generated_date: new Date().toISOString(),
    source: {
      input_type: opts.inputType,
      conversations_analyzed: mech.conversationsAnalyzed,
      date_range: mech.dateRange,
      coverage: `${mech.messagesAnalyzed} human messages across ${mech.conversationsAnalyzed} conversations`,
      coverage_note:
        "Human-authored messages only; assistant text was used for context, never as evidence of the person's voice.",
    },
    interests: judgment.interests,
    domains_of_expertise: judgment.domains_of_expertise,
    active_projects: judgment.active_projects,
    communication_style: {
      tone: judgment.style?.tone ?? null,
      formality: judgment.style?.formality ?? null,
      typical_message_length: `median ${mech.medianWords} words, mean ${mech.meanWords} words`,
      vocabulary: judgment.style?.vocabulary ?? null,
      formatting_habits: `${(mech.listVsProseRatio * 100).toFixed(1)}% of lines are list items${
        judgment.style?.formatting_habits ? "; " + judgment.style.formatting_habits : ""
      }`,
      question_style: judgment.style?.question_style ?? null,
      characteristic_phrases: mech.topPhrases.map((p) => `${p.phrase} (${p.count}×)`),
      quirks: judgment.style?.quirks ?? null,
    },
    recurring_questions_and_needs: judgment.recurring_questions_and_needs,
    values_and_priorities: judgment.values_and_priorities,
    tools_and_stack: judgment.tools_and_stack,
    temporal_trends: judgment.temporal_trends,
    notable_exemplars: judgment.notable_exemplars,
    confidence_and_gaps: judgment.confidence ?? {
      overall_confidence: null,
      gaps: null,
      notes: opts.noLlm
        ? "Judgment fields skipped (--no-llm); mechanical fields only."
        : "Judgment fields unavailable; mechanical fields only.",
    },
    privacy: {
      redaction_applied: opts.redactionsApplied > 0,
      redaction_note: `${opts.redactionsApplied} redactions applied across chat-export text before storage and analysis. ${redactionNote}`,
    },
  };

  return { profile, generatedBy, llmError };
}
