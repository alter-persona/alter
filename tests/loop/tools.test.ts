import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "../../src/lib/loadEnv";

/**
 * Tool palette tests, no model and no database:
 *   1. the extension point loads a module from ALTER_TOOLS_EXTENSION, merges
 *      its tools into the palette, routes execution to it, and appends its
 *      capabilities text; a missing path degrades to built-in tools only
 *   2. the native tool loop round-trips a tool call through executeTool,
 *      feeds the result back, and returns the model's prose
 *   3. the loop demands prose after the tool budget (round 4) and returns it
 *   4. the loop stitches a length-truncated answer with a continuation call
 */

import { loadToolsExtension, resetToolsExtensionForTests } from "../../src/loop/extensions";
import { personaTools, executeTool, renderCapabilities } from "../../src/loop/tools";
import { createToolLoopGenerate } from "../../src/loop/runtime";

let tmp: string;
let extPath: string;
const savedEnv = process.env.ALTER_TOOLS_EXTENSION;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alter-ext-"));
  extPath = path.join(tmp, "ext.mjs");
  fs.writeFileSync(
    extPath,
    `export function tools() {
       return [{ type: "function", function: { name: "echo_test", description: "echo", parameters: { type: "object", properties: { s: { type: "string" } } } } }];
     }
     export async function execute(name, args) {
       if (name !== "echo_test") return null;
       return "echoed:" + String(args.s ?? "");
     }
     export function capabilities() { return "- echo_test: echoes text (test extension)"; }`
  );
});

after(() => {
  if (savedEnv === undefined) delete process.env.ALTER_TOOLS_EXTENSION;
  else process.env.ALTER_TOOLS_EXTENSION = savedEnv;
  resetToolsExtensionForTests();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("extension point: loads, merges tools, routes execution, appends capabilities; missing path degrades", async () => {
  resetToolsExtensionForTests();
  delete process.env.ALTER_TOOLS_EXTENSION;
  await loadToolsExtension();
  const baseNames = personaTools().map((t) => t.function.name);
  assert.ok(baseNames.includes("web_search"));
  assert.ok(!baseNames.includes("echo_test"));
  assert.equal(await executeTool("echo_test", { s: "x" }), 'error: unknown tool "echo_test"');
  assert.ok(!renderCapabilities().includes("echo_test"));

  process.env.ALTER_TOOLS_EXTENSION = extPath;
  const ext = await loadToolsExtension();
  assert.ok(ext, "extension loaded");
  const names = personaTools().map((t) => t.function.name);
  assert.ok(names.includes("echo_test"), "extension tool merged into the palette");
  assert.ok(names.includes("web_search"), "built-ins still present");
  assert.equal(await executeTool("echo_test", { s: "hello" }), "echoed:hello");
  assert.ok(renderCapabilities().includes("- echo_test: echoes text"), "capabilities text appended");
  assert.equal(await executeTool("nonexistent_tool", {}), 'error: unknown tool "nonexistent_tool"');

  resetToolsExtensionForTests();
  process.env.ALTER_TOOLS_EXTENSION = path.join(tmp, "does-not-exist.mjs");
  assert.equal(await loadToolsExtension(), null, "missing module degrades to null");
  assert.ok(!personaTools().map((t) => t.function.name).includes("echo_test"));
});

/** A scripted fake model: each call pops the next response. Records bodies. */
function fakeOllama(responses: object[]) {
  const bodies: any[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const next = responses.shift();
    if (!next) throw new Error("fake model: no scripted response left");
    return new Response(JSON.stringify(next), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { impl, bodies };
}

test("tool loop: a tool call round-trips through executeTool and the result feeds the next round", async () => {
  resetToolsExtensionForTests();
  process.env.ALTER_TOOLS_EXTENSION = extPath;
  const fake = fakeOllama([
    { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "echo_test", arguments: { s: "ping" } } }] }, done_reason: "stop" },
    { message: { role: "assistant", content: "The tool said ping." }, done_reason: "stop" },
  ]);
  const gen = await createToolLoopGenerate({ channel: "playground", conversationId: "t" }, fake.impl);
  const reply = await gen("SYS", "USR", []);
  assert.equal(reply, "The tool said ping.");
  assert.equal(fake.bodies.length, 2);
  assert.equal(fake.bodies[0].think, false, "think is off on the native route");
  assert.ok(fake.bodies[0].tools.some((t: any) => t.function.name === "echo_test"), "palette sent to the model");
  const toolMsg = fake.bodies[1].messages.find((m: any) => m.role === "tool");
  assert.ok(toolMsg, "tool result appended as a tool message");
  assert.equal(toolMsg.content, "echoed:ping");
  assert.equal(toolMsg.tool_name, "echo_test");
});

test("tool loop: after the tool budget the loop demands prose and returns it", async () => {
  resetToolsExtensionForTests();
  process.env.ALTER_TOOLS_EXTENSION = extPath;
  const call = { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "echo_test", arguments: { s: "again" } } }] }, done_reason: "stop" };
  const fake = fakeOllama([call, call, call, call, call, { message: { role: "assistant", content: "Final prose." }, done_reason: "stop" }]);
  const gen = await createToolLoopGenerate({ channel: "playground", conversationId: "t" }, fake.impl);
  const reply = await gen("SYS", "USR", []);
  assert.equal(reply, "Final prose.");
  assert.equal(fake.bodies.length, 6, "five tool rounds then the prose round");
  const last = fake.bodies[5].messages;
  const nudge = last.filter((m: any) => m.role === "user").pop();
  assert.match(nudge.content, /Tool budget for this turn is used up/);
  assert.ok(!reply.includes("Tool budget"), "the nudge never leaks into the reply");
});

test("tool loop: a length-truncated answer is continued and stitched", async () => {
  resetToolsExtensionForTests();
  delete process.env.ALTER_TOOLS_EXTENSION;
  const fake = fakeOllama([
    { message: { role: "assistant", content: "First half" }, done_reason: "length" },
    { message: { role: "assistant", content: "second half." }, done_reason: "stop" },
  ]);
  const gen = await createToolLoopGenerate({ channel: "playground", conversationId: "t" }, fake.impl);
  const reply = await gen("SYS", "USR", []);
  assert.equal(reply, "First half\nsecond half.");
  const cont = fake.bodies[1].messages.pop();
  assert.match(cont.content, /Continue from EXACTLY where you stopped/);
});

// ── send_voice_note, with every outside-world piece stubbed ─────────────────
import { sendVoiceNoteTo, setVoiceNoteDepsForTests } from "../../src/loop/tools";

test("send_voice_note: synthesizes, converts, sends, and degrades to an error string", async () => {
  const sent: { chatId: string; bytes: number }[] = [];
  const base = {
    persona: async () => ({ voiceId: "elevenlabs:fixture-voice" }),
    synthesize: async (text: string) => Buffer.from(`MP3:${text}`),
    toOgg: async (audio: Buffer) => Buffer.concat([Buffer.from("OGG:"), audio]),
    send: async (chatId: string, ogg: Buffer) => {
      sent.push({ chatId, bytes: ogg.length });
      return { ok: true, status: 200 };
    },
  };
  try {
    setVoiceNoteDepsForTests(base);
    const ok = await sendVoiceNoteTo("12345", "Read *this* aloud.");
    assert.match(ok, /^voice note sent/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, "12345");
    assert.ok(sent[0].bytes > 4, "converted audio reached the sender");

    // No voice bound: refuses before synthesizing.
    setVoiceNoteDepsForTests({ ...base, persona: async () => ({ voiceId: null }) });
    assert.equal(await sendVoiceNoteTo("1", "x"), "error: no voice is bound for this persona");

    // Synthesis failure degrades to an error string, never a throw.
    setVoiceNoteDepsForTests({ ...base, synthesize: async () => { throw new Error("provider down"); } });
    assert.match(await sendVoiceNoteTo("1", "x"), /^error: .*provider down/);

    // Telegram rejection surfaces the status.
    setVoiceNoteDepsForTests({ ...base, send: async () => ({ ok: false, status: 403 }) });
    assert.equal(await sendVoiceNoteTo("1", "x"), "error: sendVoice 403");

    // Routed through executeTool: only Telegram conversations can receive one.
    setVoiceNoteDepsForTests(base);
    assert.match(await executeTool("send_voice_note", { text: "hi" }, { channel: "telegram", conversationId: "tg-999-777" }), /^voice note sent/);
    assert.equal(sent[sent.length - 1].chatId, "777");
    assert.match(await executeTool("send_voice_note", { text: "hi" }, { channel: "playground", conversationId: "p1" }), /only deliverable on Telegram/);
  } finally {
    setVoiceNoteDepsForTests(null);
  }
});
