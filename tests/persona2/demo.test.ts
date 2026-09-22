import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadSamplePack, selectNotes, assembleDemoPrompt, demoReply, demoDefaults } from "../../src/understudy/demo";
import { lintProposition } from "../../src/persona2/registerLint";

/**
 * The sample persona and the demo path: no database, no model. The pack must
 * pass the same register firewall as a real persona, notes must route by
 * intent, the prompt must keep memory and voice apart, and the model call
 * must be a plain OpenAI-compatible chat completion.
 */

const pack = loadSamplePack(path.join(process.cwd(), "packs", "sample"));

test("sample pack: shape, synthetic flag, and archivist register on every proposition", () => {
  assert.equal(pack.spec.synthetic, true);
  assert.equal(pack.spec.persona.name, "Maren Holt");
  assert.ok(pack.propositions.length >= 40);
  assert.ok(pack.exemplars.length >= 8 && pack.exemplars.length <= 12);
  assert.equal(pack.spec.values_ranked.length, 8);
  assert.equal(pack.spec.decision_heuristics.length, 8);
  const types = new Set(pack.propositions.map((p) => p.type));
  for (const t of ["fact", "belief", "preference", "decision_heuristic", "experience", "story_summary", "insight"]) assert.ok(types.has(t), `type ${t} present`);
  for (const p of pack.propositions) {
    const verdict = lintProposition(p.text, pack.spec.fingerprint.spoken.collocations);
    assert.equal(verdict.ok, true, `proposition ${p.id} fails the register lint: ${verdict.reasons.join("; ")}`);
  }
  for (const e of pack.exemplars) {
    const words = e.text.split(/\s+/).length;
    assert.ok(words >= 40 && words <= 120, `exemplar "${e.topic}" is ${words} words`);
  }
});

test("notes route by intent: knowledge questions get memory, smalltalk gets none", () => {
  const radio = selectNotes("What do you do with old radios?", pack.propositions);
  assert.ok(radio.length > 0 && radio.length <= 4);
  assert.ok(radio.some((n) => /radio/i.test(n.text)), "a radio proposition surfaced");
  assert.equal(selectNotes("hi", pack.propositions).length, 0);
  const p = assembleDemoPrompt(pack, "hello there!");
  assert.equal(p.intent, "smalltalk");
  assert.equal(p.notes.length, 0);
  assert.ok(!p.user.includes("Background memory"), "no memory block on smalltalk");
});

test("prompt keeps memory and voice apart and carries the demo disclosure", () => {
  const p = assembleDemoPrompt(pack, "Why do you swim in the sea in winter?");
  assert.equal(p.intent, "knowledge");
  assert.ok(p.notes.length > 0);
  assert.match(p.system, /digital persona of Maren Holt/);
  assert.match(p.system, /fictional demonstration persona/);
  assert.match(p.user, /Background memory about you, compiled by an archivist/);
  assert.match(p.user, /## Response contract/);
  assert.match(p.user, /How you actually sound/);
  // Register firewall: exemplar wording never appears inside the memory block.
  const notesBlock = p.user.split("## Response contract")[0];
  for (const e of pack.exemplars) assert.ok(!notesBlock.includes(e.text.slice(0, 40)), "exemplar text leaked into memory notes");
  assert.ok(p.user.trim().endsWith("Why do you swim in the sea in winter?"));
});

test("demoReply posts an OpenAI-compatible chat completion and returns the reply", async () => {
  const seen: { url: string; body: any; auth?: string }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (u.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "fake-model" }] }), { status: 200 });
    seen.push({ url: u, body: JSON.parse(String(init?.body)), auth });
    return new Response(JSON.stringify({ choices: [{ message: { content: "Well, the thing is, I don't." } }] }), { status: 200 });
  }) as typeof fetch;
  const r = await demoReply(pack, "Do you own a smartphone?", { url: "http://example.test/v1/", apiKey: "k", fetchImpl });
  assert.equal(r.model, "fake-model", "model discovered from /models when not given");
  assert.equal(r.reply, "Well, the thing is, I don't.");
  assert.equal(seen[0].url, "http://example.test/v1/chat/completions");
  assert.equal(seen[0].auth, "Bearer k");
  assert.equal(seen[0].body.model, "fake-model");
  assert.deepEqual(seen[0].body.messages.map((m: any) => m.role), ["system", "user"]);
  assert.match(seen[0].body.messages[0].content, /Maren Holt/);
});

test("demo defaults: ollama-style URL gains /v1; env overrides win", () => {
  assert.equal(demoDefaults({} as any).url, "http://127.0.0.1:11434/v1");
  assert.equal(demoDefaults({ OLLAMA_URL: "http://10.0.0.5:11434" } as any).url, "http://10.0.0.5:11434/v1");
  assert.equal(demoDefaults({ ALTER_DEMO_URL: "https://api.example.com/v1", ALTER_DEMO_MODEL: "m" } as any).model, "m");
});
