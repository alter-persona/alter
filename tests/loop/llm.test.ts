import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLoopLlmRequest, parseJson } from "../../src/loop/llm";

/**
 * The Ollama think-mode branch, without a server. Anything on :11434 must go
 * to the native /api/chat route with think:false; anything else is a plain
 * OpenAI-compatible chat completion.
 */

test("ollama refs use native /api/chat with think:false", () => {
  const r = buildLoopLlmRequest({ provider: "openai_compatible", url: "http://127.0.0.1:11434/v1", model: "local-small:latest" }, "SYS", "USR");
  assert.equal(r.native, true);
  assert.equal(r.target, "http://127.0.0.1:11434/api/chat");
  const body = r.body as any;
  assert.equal(body.think, false);
  assert.equal(body.stream, false);
  assert.equal(body.model, "local-small:latest");
  assert.deepEqual(body.messages.map((m: any) => m.role), ["system", "user"]);
  assert.equal(body.messages[0].content, "SYS");
});

test("non-ollama refs use /chat/completions with no think flag", () => {
  const r = buildLoopLlmRequest({ provider: "openai_compatible", url: "http://127.0.0.1:4000/v1/", model: "gpt-x" }, "SYS", "USR");
  assert.equal(r.native, false);
  assert.equal(r.target, "http://127.0.0.1:4000/v1/chat/completions");
  const body = r.body as any;
  assert.equal("think" in body, false);
  assert.equal(body.temperature, 0.2);
});

test("default url is the local ollama", () => {
  const r = buildLoopLlmRequest({ provider: "openai_compatible", model: "m" } as any, "s", "u");
  assert.equal(r.target, "http://127.0.0.1:11434/api/chat");
});

test("parseJson recovers an object wrapped in fences or prose, and rejects thinking-only output", () => {
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJson('Sure — here you go: {"intent":"chat","confidence":0.4} hope that helps'), { intent: "chat", confidence: 0.4 });
  assert.throws(() => parseJson("Let me analyze this carefully before answering."), SyntaxError);
});
