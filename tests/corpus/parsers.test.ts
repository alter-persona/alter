import { test } from "node:test";
import assert from "node:assert/strict";
import AdmZip from "adm-zip";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeProvider } from "../../src/corpus/sources/chat/claude";
import { parseChatExportDir } from "../../src/corpus/sources/chat";
import { parseInterviewDir } from "../../src/corpus/sources/interview";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "corpus-test-"));
}

// --- Claude export fixture matching the documented structure ---

const CONVERSATIONS = [
  {
    uuid: "11111111-aaaa-bbbb-cccc-000000000001",
    name: "Planning the corpus pipeline",
    summary: "",
    created_at: "2025-03-01T10:00:00Z",
    updated_at: "2025-03-01T11:00:00Z",
    account: { uuid: "acct-1" },
    chat_messages: [
      {
        uuid: "m1",
        text: "I want to build a corpus pipeline that ingests my interview answers and chat exports, normalizes everything into one corpus, and emits inputs for a synthesis stage downstream.",
        content: [],
        sender: "human",
        created_at: "2025-03-01T10:00:00Z",
        updated_at: "2025-03-01T10:00:00Z",
        attachments: [],
        files: [],
        parent_message_uuid: null,
      },
      {
        uuid: "m2",
        text: "Great idea! Here is a plan with twelve steps...",
        content: [],
        sender: "assistant",
        created_at: "2025-03-01T10:01:00Z",
        updated_at: "2025-03-01T10:01:00Z",
        attachments: [],
        files: [],
        parent_message_uuid: "m1",
      },
      {
        uuid: "m3",
        text: "ok thanks",
        content: [],
        sender: "human",
        created_at: "2025-03-01T10:02:00Z",
        updated_at: "2025-03-01T10:02:00Z",
        attachments: [],
        files: [],
        parent_message_uuid: "m2",
      },
    ],
  },
  {
    uuid: "22222222-aaaa-bbbb-cccc-000000000002",
    name: "Content blocks conversation",
    summary: "",
    created_at: "2025-04-05T09:00:00Z",
    updated_at: "2025-04-05T09:30:00Z",
    account: { uuid: "acct-1" },
    chat_messages: [
      {
        uuid: "m4",
        text: "",
        content: [
          { type: "text", text: "This message lives in content blocks rather than the text field, which some export versions produce, and it should still be extracted correctly." },
        ],
        sender: "human",
        created_at: "2025-04-05T09:00:00Z",
        updated_at: "2025-04-05T09:00:00Z",
        attachments: [],
        files: [],
        parent_message_uuid: null,
      },
    ],
  },
];

const PROJECT = {
  uuid: "33333333-aaaa-bbbb-cccc-000000000003",
  name: "Persona Project",
  description: "Build a digital persona from personal writing.",
  created_at: "2025-02-01T00:00:00Z",
  docs: [
    {
      uuid: "d1",
      filename: "notes.md",
      content: "The persona should capture my writing voice across professional and personal registers.",
      created_at: "2025-02-02T00:00:00Z",
    },
  ],
};

function buildClaudeZip(): AdmZip {
  const zip = new AdmZip();
  zip.addFile("conversations.json", Buffer.from(JSON.stringify(CONVERSATIONS)));
  zip.addFile("projects/p1.json", Buffer.from(JSON.stringify(PROJECT)));
  zip.addFile("memories.json", Buffer.from("{}"));
  zip.addFile("users.json", Buffer.from("[]"));
  return zip;
}

test("claude parser extracts human messages only, with metadata", () => {
  const zip = buildClaudeZip();
  assert.equal(claudeProvider.detect(zip), true);
  const parsed = claudeProvider.parse(zip, "export.zip");

  // 3 human messages (short one included — the short-drop is a pipeline rule), 0 assistant.
  assert.equal(parsed.stats.humanMessages, 3);
  assert.equal(parsed.stats.assistantMessages, 1);
  assert.equal(parsed.messages.length, 3);
  assert.ok(parsed.messages.every((m) => m.sourceType === "chat_export"));
  assert.ok(parsed.messages.every((m) => !m.text.includes("twelve steps")));

  // Metadata: conversation name + date preserved.
  const first = parsed.messages[0];
  assert.ok(first.origin.includes("Planning the corpus pipeline"));
  assert.equal(first.date, "2025-03-01T10:00:00Z");
  assert.equal(first.sensitivity, "private");

  // Content-block message extracted.
  assert.ok(parsed.messages.some((m) => m.text.includes("content blocks rather than")));

  // Project name/description + doc become project material.
  assert.equal(parsed.projectDocs.length, 2);
  assert.ok(parsed.projectDocs.every((d) => d.sourceType === "project_doc"));
  assert.ok(parsed.projectDocs.some((d) => d.text.includes("digital persona")));
  assert.ok(parsed.projectDocs.some((d) => d.origin.includes("notes.md")));
});

test("malformed zip is skipped with a reason, not a crash", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "broken.zip"), Buffer.from("this is not a zip file at all"));
  const result = parseChatExportDir(dir);
  assert.equal(result.results.length, 0);
  assert.equal(result.skippedFiles.length, 1);
  assert.match(result.skippedFiles[0].reason, /unreadable zip|no provider/);
});

test("unrecognized export format is reported", () => {
  const dir = tmpDir();
  const zip = new AdmZip();
  zip.addFile("conversations.json", Buffer.from(JSON.stringify({ mapping: {} }))); // OpenAI-style object
  zip.writeZip(path.join(dir, "openai.zip"));
  const result = parseChatExportDir(dir);
  assert.equal(result.results.length, 0);
  assert.match(result.skippedFiles[0].reason, /no provider recognized/);
});

// --- Interview export fixture (intake app manifest shape) ---

const INTAKE_MANIFEST = {
  exportedAt: "2026-07-25T00:00:00Z",
  session: { id: "sess-1", label: "Trial", isTrial: true, status: "complete" },
  totals: { totalVoiceAudioDurationSec: 1800 },
  responses: [
    {
      questionId: "q-aaaa1111", orderIndex: 0, section: "A. Warm-up", type: "voice",
      promptText: "Introduce yourself?", oceanDomain: null, reverseScored: false,
      isValidation: false, answered: true, skipped: false,
      audioFilename: "q-aaaa1111.webm", audioDurationSec: 90,
      transcript: "Hi, I am the test subject and this transcript is the edited ground truth version.",
      transcriptEditedByUser: true, transcriptStatus: "done", likertValue: null,
      answeredAt: "2026-07-20T13:00:00Z",
    },
    {
      questionId: "q-bbbb2222", orderIndex: 5, section: "Personality inventory", type: "likert",
      promptText: "Am the life of the party.", oceanDomain: "E", reverseScored: false,
      isValidation: false, answered: true, skipped: false,
      audioFilename: null, audioDurationSec: null, transcript: null,
      transcriptEditedByUser: false, transcriptStatus: null, likertValue: 4,
      answeredAt: "2026-07-20T13:05:00Z",
    },
    {
      questionId: "q-cccc3333", orderIndex: 62, section: "Validation (held out)", type: "voice",
      promptText: "V1: What would you say to a friend who lost their job?", oceanDomain: null,
      reverseScored: false, isValidation: true, answered: true, skipped: false,
      audioFilename: "q-cccc3333.webm", audioDurationSec: 60,
      transcript: "This is a sealed validation answer that must never appear in the corpus.",
      transcriptEditedByUser: false, transcriptStatus: "done", likertValue: null,
      answeredAt: "2026-07-20T14:00:00Z",
    },
  ],
};

test("interview parser splits corpus items from sealed holdout", async () => {
  const dir = tmpDir();
  const zip = new AdmZip();
  zip.addFile("manifest.json", Buffer.from(JSON.stringify(INTAKE_MANIFEST)));
  zip.writeZip(path.join(dir, "intake.zip"));

  const result = await parseInterviewDir(dir);
  assert.equal(result.items.length, 1); // voice non-validation only
  assert.equal(result.items[0].label, "A. Warm-up");
  assert.equal(result.items[0].sensitivity, "private");
  assert.ok(result.items[0].text.includes("ground truth"));

  assert.equal(result.holdout.length, 1);
  assert.ok(result.holdout[0].answer?.includes("sealed validation"));
  // Validation answers never leak into corpus items.
  assert.ok(result.items.every((i) => !i.text.includes("sealed validation")));

  assert.equal(result.audioMinutes, 30);
});

test("session-attached files become work_file items with their configuration", async () => {
  const dir = tmpDir();
  const zip = new AdmZip();
  const manifest = {
    ...INTAKE_MANIFEST,
    files: [
      {
        id: "f1", filename: "bio.md", exportName: "f1______bio.md",
        label: "bio", domain: "product-management", sensitivity: "public",
        note: null, addedAt: "2026-07-26T10:00:00Z",
      },
      {
        id: "f2", filename: "missing.md", exportName: "f2______missing.md",
        label: "spec", domain: null, sensitivity: "private",
        note: null, addedAt: null,
      },
    ],
  };
  zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest)));
  zip.addFile("files/f1______bio.md", Buffer.from("A professional bio attached through the session Files panel."));
  zip.writeZip(path.join(dir, "intake.zip"));

  const result = await parseInterviewDir(dir);
  const fileItems = result.items.filter((i) => i.sourceType === "work_file");
  assert.equal(fileItems.length, 1);
  assert.equal(fileItems[0].label, "bio");
  assert.equal(fileItems[0].domain, "product-management");
  assert.equal(fileItems[0].sensitivity, "public");
  assert.ok(fileItems[0].text.includes("professional bio"));
  // Missing zip entry is reported, not fatal.
  assert.ok(result.skippedFiles.some((s) => s.reason.includes("missing from zip")));
});
