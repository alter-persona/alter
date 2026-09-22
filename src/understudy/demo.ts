import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { renderPersonaCore, renderResponseContract, buildPrompt } from "@/persona2/prompt";
import { routeIntent } from "@/persona2/gate";
import type { ModeFingerprint } from "@/persona2/fingerprint";
import type { Exemplar } from "@/persona2/exemplars";
import type { RetrievedProposition } from "@/persona2/retrieve";
import { tokenize } from "@/persona2/lexicon";

/**
 * `alter demo`: a reply from a persona in under five minutes with nothing
 * installed but Node and a model endpoint. It loads a persona pack from disk
 * (by default the synthetic sample in packs/sample/), assembles the same
 * position-disciplined prompt the runtime uses, selects memory notes by
 * keyword overlap instead of pgvector, and calls any OpenAI-compatible
 * endpoint. No database, no whisper, no interview.
 *
 * What it demonstrates is the register firewall: memory reaches the model as
 * third-person archivist notes, voice reaches it as a fingerprint plus a few
 * exemplars, and the two never mix.
 */

export interface SamplePack {
  dir: string;
  spec: {
    persona: { id: string; name: string };
    disclosure?: string;
    synthetic?: boolean;
    values_ranked: string[];
    decision_heuristics: string[];
    fingerprint: { spoken: ModeFingerprint; written: ModeFingerprint };
  };
  propositions: { id: string; type: string; text: string; strength?: string | null; topics?: string[] }[];
  exemplars: Exemplar[];
}

export function loadSamplePack(dir = path.join(process.cwd(), "packs", "sample")): SamplePack {
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  const spec = read("persona-spec.json");
  const propositions = read("propositions.json");
  const exemplars = read("exemplars.json");
  if (!spec?.persona?.name || !spec.fingerprint?.spoken || !spec.fingerprint?.written) {
    throw new Error(`${dir}/persona-spec.json is missing persona.name or fingerprint.{spoken,written}`);
  }
  if (!Array.isArray(propositions) || propositions.length === 0) throw new Error(`${dir}/propositions.json is empty`);
  if (!Array.isArray(exemplars) || exemplars.length < 3) throw new Error(`${dir}/exemplars.json needs at least 3 passages`);
  return { dir, spec, propositions, exemplars };
}

const STOP = new Set(["about", "after", "again", "also", "and", "are", "because", "been", "being", "but", "can", "could", "did", "does", "doing", "for", "from", "had", "has", "have", "her", "here", "him", "his", "how", "into", "its", "just", "like", "more", "most", "not", "now", "one", "only", "other", "our", "out", "over", "own", "same", "she", "should", "some", "such", "than", "that", "the", "their", "them", "then", "there", "these", "they", "this", "those", "through", "too", "under", "very", "was", "were", "what", "when", "where", "which", "while", "who", "why", "will", "with", "would", "you", "your", "yours", "yourself", "does", "tell", "think", "say", "know"]);

function keywords(text: string): Set<string> {
  return new Set(tokenize(text).map((t) => t.toLowerCase()).filter((t) => t.length > 2 && !STOP.has(t)).map(stem));
}

/** Crude stemmer: enough to match "radios" to "radio" and "swimming" to "swim". */
function stem(w: string): string {
  return w.replace(/(ing|ers|er|es|ed|s)$/i, (m) => (w.length - m.length >= 3 ? "" : m));
}

/** Memory notes by keyword overlap: the demo's stand-in for vector retrieval.
 * Same contract as retrievePropositions: a few short items, or nothing. */
export function selectNotes(message: string, props: SamplePack["propositions"], k = 4): RetrievedProposition[] {
  const q = keywords(message);
  if (q.size === 0) return [];
  const scored = props
    .map((p) => {
      const pk = keywords(p.text + " " + (p.topics ?? []).join(" "));
      let hits = 0;
      for (const w of q) if (pk.has(w)) hits++;
      return { p, score: hits / Math.sqrt(pk.size) };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  return scored.map(({ p, score }) => ({
    id: p.id,
    type: p.type,
    text: p.text,
    strength: p.strength ?? null,
    date: null,
    topics: p.topics ?? [],
    distance: 1 - Math.min(1, score),
    status: "active",
  }));
}

export interface DemoPrompt {
  system: string;
  user: string;
  intent: "knowledge" | "explicit_recall" | "smalltalk";
  notes: RetrievedProposition[];
}

export function assembleDemoPrompt(pack: SamplePack, message: string, mode: "spoken" | "written" = "written"): DemoPrompt {
  const name = pack.spec.persona.name;
  const intent = routeIntent(message);
  const notes = intent === "knowledge" ? selectNotes(message, pack.propositions) : [];
  let core = renderPersonaCore({
    name,
    values: pack.spec.values_ranked.slice(0, 8),
    heuristics: pack.spec.decision_heuristics.slice(0, 8),
    fingerprint: pack.spec.fingerprint[mode],
    mode,
  });
  if (pack.spec.synthetic) {
    core += `\n\n## Demo notice\n${pack.spec.disclosure ?? `${name} is a fictional demonstration persona.`} If asked whether you are real, say so plainly, then continue in voice.`;
  }
  const contract = renderResponseContract({ name, voiceNote: false });
  const { system, user } = buildPrompt({ core, notes, contract, exemplars: pack.exemplars, mode, question: message });
  return { system, user, intent, notes };
}

export interface DemoModelOptions {
  url: string; // OpenAI-compatible base, e.g. http://127.0.0.1:11434/v1
  model?: string; // omitted: first model the endpoint lists
  apiKey?: string;
  fetchImpl?: typeof fetch;
  history?: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
}

function headers(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

/** Pick the first model the endpoint advertises (GET /models). */
export async function firstModel(url: string, apiKey?: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${url.replace(/\/$/, "")}/models`, { headers: headers(apiKey), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${url}/models returned ${res.status}; pass --model explicitly`);
  const json = (await res.json()) as { data?: { id: string }[] };
  const id = json.data?.[0]?.id;
  if (!id) throw new Error(`${url}/models lists no models; pass --model explicitly`);
  return id;
}

export async function demoReply(pack: SamplePack, message: string, opts: DemoModelOptions): Promise<{ reply: string; prompt: DemoPrompt; model: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.url.replace(/\/$/, "");
  const model = opts.model ?? (await firstModel(base, opts.apiKey, fetchImpl));
  const prompt = assembleDemoPrompt(pack, message);
  const messages = [
    { role: "system", content: prompt.system },
    ...(opts.history ?? []).slice(-6),
    { role: "user", content: prompt.user },
  ];
  const res = await fetchImpl(`${base}/chat/completions`, {
    method: "POST",
    headers: headers(opts.apiKey),
    body: JSON.stringify({ model, messages, temperature: 0.8, max_tokens: opts.maxTokens ?? 600, chat_template_kwargs: { enable_thinking: false } }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`${base}/chat/completions returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const reply = (json.choices?.[0]?.message?.content ?? "").trim();
  if (!reply) throw new Error("the model returned an empty reply");
  return { reply, prompt, model };
}

// ── CLI ──────────────────────────────────────────────────────────────────

function argOf(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function demoDefaults(env = process.env): { url: string; model?: string; apiKey?: string } {
  const raw = env.ALTER_DEMO_URL ?? env.OLLAMA_URL ?? "http://127.0.0.1:11434";
  const url = /\/v1\/?$/.test(raw) ? raw : `${raw.replace(/\/$/, "")}/v1`;
  return { url, model: env.ALTER_DEMO_MODEL ?? env.TALK_MODEL, apiKey: env.ALTER_DEMO_API_KEY ?? env.OPENAI_API_KEY };
}

export async function runDemoCli(argv: string[]): Promise<void> {
  const d = demoDefaults();
  const url = argOf(argv, "--url") ?? d.url;
  const model = argOf(argv, "--model") ?? d.model;
  const apiKey = argOf(argv, "--api-key") ?? d.apiKey;
  const dir = argOf(argv, "--sample-dir");
  const pack = loadSamplePack(dir ? path.resolve(dir) : undefined);
  const name = pack.spec.persona.name;
  const dryRun = argv.includes("--dry-run");
  const one = argOf(argv, "--message");

  const answer = async (message: string, history: { role: "user" | "assistant"; content: string }[]) => {
    if (dryRun) {
      const p = assembleDemoPrompt(pack, message);
      console.log(`--- intent: ${p.intent}; memory notes: ${p.notes.length} ---\n\n=== system (cached prefix) ===\n${p.system}\n\n=== user ===\n${p.user}`);
      return "";
    }
    const t0 = Date.now();
    const r = await demoReply(pack, message, { url, model, apiKey, history });
    console.log(`\n${name}: ${r.reply}\n`);
    console.error(`[demo] ${r.model} · ${r.prompt.intent} · ${r.prompt.notes.length} memory notes · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return r.reply;
  };

  if (one) {
    await answer(one, []);
    return;
  }
  console.error(`[demo] ${name}, a synthetic persona · endpoint ${url}${model ? ` · model ${model}` : ""}. Type a message; empty line or Ctrl-D to quit.`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history: { role: "user" | "assistant"; content: string }[] = [];
  const ask = () =>
    rl.question("you: ", async (line) => {
      const msg = line.trim();
      if (!msg) { rl.close(); return; }
      try {
        const reply = await answer(msg, history);
        history.push({ role: "user", content: msg }, { role: "assistant", content: reply });
      } catch (e) {
        console.error(`[demo] ${String(e).slice(0, 300)}`);
      }
      ask();
    });
  ask();
  await new Promise<void>((resolve) => rl.on("close", resolve));
}
