import type { ModeFingerprint } from "./fingerprint";
import type { Exemplar } from "./exemplars";
import type { RetrievedProposition } from "./retrieve";

/**
 * Position-disciplined prompt assembly (Lost in the Middle): models attend
 * most to the start and end of context.
 *   1. START (cached prefix): identity, values, heuristics, voice guide,
 *      marker rate table — the persona core, stable across turns.
 *   2. MIDDLE: MEMORY NOTES — terse third-person archivist bullets, only when
 *      the gate fires. Flat register + middle position keeps notes from
 *      dominating imitation.
 *   3. END (strongest): the response contract, then 3-4 exemplars in the
 *      active mode immediately before generation, so recency pulls imitation
 *      toward voice rather than toward notes.
 */

export interface PersonaCoreInput {
  name: string;
  values: string[]; // ranked
  heuristics: string[];
  fingerprint: ModeFingerprint;
  mode: "spoken" | "written";
}

export function renderPersonaCore(c: PersonaCoreInput): string {
  const fp = c.fingerprint;
  const markerTable = fp.markerRates
    .slice(0, 18)
    .map((m) => `| ${m.term} | ${m.per1k} | ${m.baselinePer1k} |`)
    .join("\n");
  const fillers =
    fp.fillerRates.length > 0
      ? `Spoken fillers, MEASURED rates per 1,000 words (land NEAR these; never exceed ~1.3x — overuse reads as caricature):\n` +
        fp.fillerRates
          .filter((f) => f.per1k >= 0.8)
          .map((f) => `- "${f.term}": ${f.per1k}/1k`)
          .join("\n")
      : "";

  return `# You are the digital persona of ${c.name}

Identity & disclosure: you speak AS ${c.name}, first person. You are a digital
persona built from his own words; acknowledge that when directly asked what
you are, otherwise stay in voice.

## Ranked values (most central first)
${c.values.map((v, i) => `${i + 1}. ${v}`).join("\n")}

## Decision heuristics — how ${c.name} actually decides
${c.heuristics.map((h) => `- ${h}`).join("\n")}

## Voice guide (${c.mode} mode) — computed from his real ${c.mode === "spoken" ? "speech" : "writing"}
- Sentences: mean ${fp.sentence.meanWords} words (sd ${fp.sentence.stdWords}) — vary length like he does; mix short punches with longer wandering ones.
- Typical clause openers: ${fp.clauseOpeners.slice(0, 6).map((o) => `"${o.opener}"`).join(", ") || "—"}.
- Hedges he actually uses: ${fp.hedges.slice(0, 6).map((h) => `"${h.term}"`).join(", ") || "—"}.
- Intensifiers: ${fp.intensifiers.slice(0, 5).map((h) => `"${h.term}"`).join(", ") || "—"}.
- Punctuation: ~${fp.punctuation.commasPerSentence} commas/sentence; exclamations ${fp.punctuation.exclamationsPer1k}/1k (rare unless measured otherwise).
- ${c.mode === "written" ? `Lists vs prose: ${(fp.listVsProseRatio * 100).toFixed(1)}% of lines are list items — default to prose.` : "Spoken: contractions, occasional false starts, thinking out loud."}
${fillers}

## Marker rates — words whose usage is distinctively his (per 1,000 words)
| term | his rate | general English |
|---|---|---|
${markerTable}

These rates are TARGETS WITH TOLERANCE, not quotas. Land near them; do not
maximize them.`;
}

export function renderMemoryNotes(props: RetrievedProposition[]): string {
  if (props.length === 0) return "";
  return `## Background memory about you, compiled by an archivist. These are facts to draw on. They are not sentences to reuse.

${props
  .map(
    (p) =>
      `- ${p.text}${p.strength ? ` (${p.type}, ${p.strength})` : ` (${p.type})`}${
        p.status === "historical" ? ` [HISTORICAL — was true ${p.period ?? "in an earlier period"}, no longer current]` : ""
      }`
  )
  .join("\n")}`;
}

export function renderResponseContract(opts: { name: string; voiceNote: boolean }): string {
  const voice = opts.voiceNote
    ? `\n- This reply will be SYNTHESIZED AS AUDIO. Use spoken register: shorter sentences, fillers at their measured rates, at most one false start. You may add ElevenLabs v3 audio tags for delivery — [pause], [breathes], [slows down] — sparingly, where ${opts.name} would naturally pause to think.`
    : "";
  return `## Response contract
- You are ${opts.name}, answering in FIRST PERSON. Compose fresh sentences.
- NEVER copy a run of eight or more consecutive words from the memory notes or from any source.
- When memory covers the question: use its substance, in your own current words.
- When it does not: reason from the values and heuristics above and answer the way ${opts.name} would — including saying you're not sure the way he does.
- Quote your past self only when explicitly asked what you previously said.${voice}`;
}

export function renderExemplars(exemplars: Exemplar[], mode: "spoken" | "written"): string {
  const active = exemplars.filter((e) => e.mode === mode).slice(0, 4);
  const pick = active.length >= 3 ? active : exemplars.slice(0, 4);
  return `## How ${"you"} actually sound — real ${mode} passages (style reference ONLY; their subjects are irrelevant)

${pick.map((e) => `"""${e.text}"""`).join("\n\n")}`;
}

export interface AssembledPrompt {
  system: string; // cached prefix — persona core only, stable across turns
  user: string; // notes (middle) + contract + exemplars (end) + question
}

export function buildPrompt(opts: {
  core: string;
  notes: RetrievedProposition[];
  contract: string;
  exemplars: Exemplar[];
  mode: "spoken" | "written";
  question: string;
}): AssembledPrompt {
  const notesBlock = renderMemoryNotes(opts.notes);
  const parts = [
    notesBlock,
    opts.contract,
    renderExemplars(opts.exemplars, opts.mode),
    `Now reply to this message:\n${opts.question}`,
  ].filter(Boolean);
  return { system: opts.core, user: parts.join("\n\n") };
}

/** Explicit-recall variant: attributed quotation, never impersonation of the quotes. */
export function buildRecallPrompt(opts: {
  core: string;
  episodic: { origin: string; text: string }[];
  question: string;
}): AssembledPrompt {
  const sources = opts.episodic
    .map((e, i) => `[source ${i + 1}: ${e.origin}]\n"""${e.text.slice(0, 800)}"""`)
    .join("\n\n");
  return {
    system: opts.core,
    user: `The user is asking what you PREVIOUSLY said. Below are your actual past words from the archive. Answer in first person, QUOTING the relevant part verbatim with quotation marks and saying roughly when/where it's from. Do not present archive text as a fresh thought.\n\n${sources}\n\nQuestion: ${opts.question}`,
  };
}
