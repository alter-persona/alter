import { test } from "node:test";
import assert from "node:assert/strict";
import { encode } from "gpt-tokenizer";
import { redact } from "../../src/corpus/redact";
import { chunkText } from "../../src/corpus/chunk";
import { dedupe } from "../../src/corpus/dedup";
import { itemId, chunkId } from "../../src/corpus/hash";
import { stripQuotedAndSignature } from "../../src/corpus/sources/work/loaders/eml";
import type { CorpusItem } from "../../src/corpus/types";

test("redaction replaces secrets and personal data with [REDACTED]", () => {
  const input = [
    "My key is sk-ant-abc123def456ghi789jkl012 and don't share it.",
    "SSN 123-45-6789, card 4111 1111 1111 1111.",
    "Reach me at jane.doe@example.com or 555-867-5309.",
    "password: hunter2secret",
    "I live at 42 Maple Street, Apt 3.",
  ].join("\n");

  const r = redact(input);
  assert.ok(!r.text.includes("sk-ant-"), "api key redacted");
  assert.ok(!r.text.includes("123-45-6789"), "ssn redacted");
  assert.ok(!r.text.includes("4111"), "card redacted (Luhn-valid)");
  assert.ok(!r.text.includes("jane.doe@example.com"), "email redacted");
  assert.ok(!r.text.includes("867-5309"), "phone redacted");
  assert.ok(!r.text.includes("hunter2secret"), "password value redacted");
  assert.ok(!r.text.includes("42 Maple Street"), "street address redacted");
  assert.ok(r.text.includes("[REDACTED]"));
  assert.ok(r.total >= 7, `expected >=7 redactions, got ${r.total}`);
  assert.ok((r.counts["api_key"] ?? 0) >= 1);
  assert.ok((r.counts["gov_id"] ?? 0) >= 1);
  assert.ok((r.counts["financial_card"] ?? 0) >= 1);
});

test("redaction leaves Luhn-invalid digit runs alone", () => {
  const r = redact("The order number is 1234 5678 9012 3456 which is not a card.");
  assert.ok(r.text.includes("1234 5678 9012 3456"));
  assert.equal(r.counts["financial_card"] ?? 0, 0);
});

test("chunking keeps short items whole and bounds long ones", () => {
  const short = "A short paragraph that fits comfortably in one chunk.";
  assert.deepEqual(chunkText(short, 400, 300), [short]);

  const long = Array.from({ length: 120 }, (_, i) =>
    `Sentence number ${i} contains a reasonable amount of words to inflate the token count of this synthetic paragraph.`
  ).join(" ");
  const chunks = chunkText(long, 400, 300);
  assert.ok(chunks.length > 1, "long text split into multiple chunks");
  for (const c of chunks) {
    assert.ok(encode(c).length <= 400, `chunk exceeds 400 tokens: ${encode(c).length}`);
  }
  // No content dropped (allowing whitespace normalization at boundaries).
  const rejoined = chunks.join(" ").replace(/\s+/g, " ");
  assert.equal(rejoined, long.replace(/\s+/g, " "));
});

test("near-duplicates are dropped, distinct items kept", () => {
  const base: Omit<CorpusItem, "text" | "origin"> = {
    sourceType: "chat_export",
    label: "chat-message",
    domain: null,
    date: null,
    sensitivity: "private",
  };
  const items: CorpusItem[] = [
    { ...base, origin: "a", text: "I think the corpus pipeline should normalize every source into one unified format with stable identifiers for each chunk." },
    { ...base, origin: "b", text: "I think the corpus pipeline should normalize every source into one unified format with stable identifiers for every chunk." },
    { ...base, origin: "c", text: "Completely different topic: the weather in Denver has been unusually warm for late July this year." },
  ];
  const { kept, dropped } = dedupe(items, 0.88);
  assert.equal(dropped, 1);
  assert.equal(kept.length, 2);
  assert.ok(kept.some((k) => k.text.includes("weather in Denver")));
});

test("ids are stable content hashes", () => {
  const a = itemId("interview", "zip#q1", "Hello   world");
  const b = itemId("interview", "zip#q1", "hello world"); // normalization-insensitive
  const c = itemId("interview", "zip#q2", "Hello world");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(chunkId(a, 0, 1), a);
  assert.equal(chunkId(a, 1, 3), `${a}-c01`);
});

test("eml stripping removes quoted replies and signatures", () => {
  const mail = [
    "Thanks for the update — I reviewed the spec and I think the approach is right.",
    "Let's ship the first milestone next week.",
    "",
    "Best regards,",
    "Sam",
    "",
    "On Mon, Jul 21, 2026 at 9:00 AM Someone <someone@example.com> wrote:",
    "> Here is my original very long message",
    "> with several quoted lines",
  ].join("\n");
  const stripped = stripQuotedAndSignature(mail);
  assert.ok(stripped.includes("reviewed the spec"));
  assert.ok(!stripped.includes("original very long message"), "quoted reply removed");
  assert.ok(!stripped.includes("Best regards"), "signature removed");
});
