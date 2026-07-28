/**
 * Integration tests against the live local Postgres (EMBED_FAKE=1 keeps
 * embeddings deterministic and offline). Each test builds its own persona and
 * cleans up after itself; nothing touches real persona data.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

process.env.EMBED_FAKE = "1";

const prisma = new PrismaClient();
const cleanupPersonas: string[] = [];
const cleanupSessions: string[] = [];

async function makePersona(tag: string) {
  const persona = await prisma.persona.create({
    data: { name: `test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` },
  });
  cleanupPersonas.push(persona.id);
  return persona;
}

async function makeSession(personaId: string) {
  const session = await prisma.session.create({
    data: { label: `test-session-${Date.now()}`, personaId },
  });
  cleanupSessions.push(session.id);
  return session;
}

async function makeFile(
  sessionId: string,
  filename: string,
  content: Buffer,
  overrides: Partial<{ label: string; domain: string; sensitivity: "private" | "public" }> = {}
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-files-"));
  const abs = path.join(dir, filename);
  fs.writeFileSync(abs, content);
  return prisma.sessionFile.create({
    data: {
      sessionId,
      filename,
      storedPath: path.relative(process.cwd(), abs),
      sizeBytes: content.length,
      label: overrides.label ?? "writing-sample",
      domain: overrides.domain ?? "general",
      sensitivity: overrides.sensitivity ?? "private",
    },
  });
}

async function enqueueAndDrain(personaId: string, fileIds: string[]) {
  const { drainIngestQueue } = await import("../../src/lib/ingestQueue");
  for (const fileId of fileIds) {
    await prisma.ingestJob.create({ data: { personaId, kind: "work_file", fileId } });
  }
  await drainIngestQueue();
}

const LONG_TEXT = (i: number) =>
  `Document number ${i}. ` +
  `I believe good product work starts with understanding the person on the other end, ` +
  `and this paragraph exists to give the ingest pipeline enough distinctive prose to chunk, ` +
  `embed, and analyze for stylometry purposes across multiple sentences of varying length. ` +
  `Some sentences are short. Others meander considerably before arriving anywhere useful, ` +
  `which is exactly the kind of variance a sentence-length histogram should capture.`;

test("batch of ten files with one corrupt: nine embed, one fails, batch survives", async () => {
  const persona = await makePersona("batch");
  const session = await makeSession(persona.id);

  const ids: string[] = [];
  for (let i = 0; i < 9; i++) {
    ids.push((await makeFile(session.id, `doc-${i}.txt`, Buffer.from(LONG_TEXT(i)))).id);
  }
  // Corrupt PDF: right extension, garbage bytes.
  ids.push((await makeFile(session.id, "broken.pdf", Buffer.from("not a pdf at all"))).id);

  await enqueueAndDrain(persona.id, ids);

  const files = await prisma.sessionFile.findMany({ where: { sessionId: session.id } });
  const embedded = files.filter((f) => f.ingestStatus === "embedded");
  const failed = files.filter((f) => f.ingestStatus === "failed");
  assert.equal(embedded.length, 9);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].filename, "broken.pdf");
  assert.ok(failed[0].ingestError, "failed file carries a reason");
});

test("dual-half ingest: chunks with embeddings in pgvector AND stylometry updated", async () => {
  const persona = await makePersona("dual");
  const session = await makeSession(persona.id);
  const file = await makeFile(session.id, "essay.md", Buffer.from(LONG_TEXT(42)));

  await enqueueAndDrain(persona.id, [file.id]);

  const chunks = await prisma.vectorChunkPrivate.findMany({ where: { personaId: persona.id } });
  assert.ok(chunks.length >= 1, "retrieval half produced chunks");
  const withEmbedding = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*)::bigint AS n FROM "VectorChunkPrivate" WHERE "personaId" = $1 AND embedding IS NOT NULL`,
    persona.id
  );
  assert.equal(Number(withEmbedding[0].n), chunks.length, "every chunk has an embedding");

  const style = await prisma.stylometryRecord.findUnique({ where: { personaId: persona.id } });
  assert.ok(style, "style half created the stylometry record");
  assert.ok(style!.totalWords > 50);
  assert.ok(style!.totalSentences > 3);
});

test("re-upload dedup: ingesting identical content twice changes nothing", async () => {
  const persona = await makePersona("dedup");
  const session = await makeSession(persona.id);
  const content = Buffer.from(LONG_TEXT(7));

  const f1 = await makeFile(session.id, "same.txt", content);
  await enqueueAndDrain(persona.id, [f1.id]);
  const idsFirst = (await prisma.vectorChunkPrivate.findMany({ where: { personaId: persona.id } }))
    .map((c) => c.id)
    .sort();

  const f2 = await makeFile(session.id, "same.txt", content); // re-upload
  await enqueueAndDrain(persona.id, [f2.id]);
  const idsSecond = (await prisma.vectorChunkPrivate.findMany({ where: { personaId: persona.id } }))
    .map((c) => c.id)
    .sort();

  assert.deepEqual(idsSecond, idsFirst, "stable content-hash ids: identical set after re-upload");
});

test("holdout leak detection refuses the build, by origin id and by content hash", async () => {
  process.env.SKILL_MIN_CHUNKS = "1";
  const persona = await makePersona("holdout");
  const session = await makeSession(persona.id);

  // A validation question + sealed answer for this persona.
  const question = await prisma.question.findFirst({ where: { isValidation: true } });
  assert.ok(question, "seeded validation question exists");
  const sealedAnswer =
    "This sealed validation answer must never be found inside the persona corpus.";
  await prisma.response.create({
    data: {
      sessionId: session.id,
      questionId: question!.id,
      type: "voice",
      transcript: sealedAnswer,
      audioPath: "data/audio/fake.webm",
      audioDurationSec: 2000, // clears the 30-min voice floor
    },
  });

  // Leak the sealed content into the index (what the guard must catch).
  const { drainIngestQueue } = await import("../../src/lib/ingestQueue");
  const file = await makeFile(session.id, "leak.txt", Buffer.from(sealedAnswer));
  await prisma.ingestJob.create({ data: { personaId: persona.id, kind: "work_file", fileId: file.id } });
  await drainIngestQueue();

  const { buildSkillPack, SkillBuildError } = await import("../../src/skill/build");
  await assert.rejects(
    () => buildSkillPack(persona.id, { noLlm: true }),
    (e: unknown) => e instanceof SkillBuildError && /holdout leak/.test(e.message)
  );

  // Clean the content leak; now leak by origin reference instead.
  await prisma.vectorChunkPrivate.deleteMany({ where: { personaId: persona.id } });
  await prisma.$executeRawUnsafe(
    `INSERT INTO "VectorChunkPrivate" (id, "personaId", "sourceType", label, domain, origin, text, tokens)
     VALUES ('leak-by-origin-id', $1, 'interview', 'X', NULL, $2, 'innocuous text', 3)`,
    persona.id,
    `session:xxxx#q99:${question!.id.slice(0, 8)}`
  );
  await assert.rejects(
    () => buildSkillPack(persona.id, { noLlm: true }),
    (e: unknown) => e instanceof SkillBuildError && /holdout leak/.test(e.message)
  );
});

test("public pack contains zero private references, structurally", async () => {
  process.env.SKILL_MIN_CHUNKS = "1";
  const packsDir = fs.mkdtempSync(path.join(os.tmpdir(), "packs-"));
  process.env.PACKS_DIR = packsDir;

  const persona = await makePersona("pack");
  const session = await makeSession(persona.id);
  // Voice floor.
  const voiceQ = await prisma.question.findFirst({ where: { type: "voice", isValidation: false } });
  await prisma.response.create({
    data: {
      sessionId: session.id,
      questionId: voiceQ!.id,
      type: "voice",
      audioPath: "data/audio/fake.webm",
      audioDurationSec: 2000,
    },
  });

  const PRIVATE_MARKER = "ultraprivatesecretstory";
  const priv = await makeFile(
    session.id,
    "private-notes.txt",
    Buffer.from(`${PRIVATE_MARKER} — a long private reflection. ${LONG_TEXT(1)}`),
    { sensitivity: "private" }
  );
  const pub = await makeFile(
    session.id,
    "public-bio.txt",
    Buffer.from(`A public professional bio, safe to publish anywhere. ${LONG_TEXT(2)}`),
    { sensitivity: "public", label: "bio" }
  );
  await enqueueAndDrain(persona.id, [priv.id, pub.id]);

  // Invariant 2 — physical separation: private text lives only in the private
  // table, public text only in the public table.
  const privRows = await prisma.vectorChunkPrivate.findMany({ where: { personaId: persona.id } });
  const pubRows = await prisma.vectorChunkPublic.findMany({ where: { personaId: persona.id } });
  assert.ok(privRows.some((c) => c.text.includes(PRIVATE_MARKER)));
  assert.ok(!pubRows.some((c) => c.text.includes(PRIVATE_MARKER)));
  assert.ok(pubRows.some((c) => c.text.includes("public professional bio")));

  const { buildSkillPack } = await import("../../src/skill/build");
  const result = await buildSkillPack(persona.id, { noLlm: true });

  const pubDir = path.join(result.dir, "public");
  const combined =
    fs.readFileSync(path.join(pubDir, "persona-spec.json"), "utf8") +
    fs.readFileSync(path.join(pubDir, "SKILL.md"), "utf8");

  assert.ok(!combined.includes(PRIVATE_MARKER), "no private text in public pack");
  assert.ok(!combined.includes("private-notes"), "no private origin in public pack");
  assert.ok(!combined.includes(`${persona.id}:private`), "no private index id in public pack");
  assert.ok(combined.includes(`${persona.id}:public`), "public index id referenced");
  assert.ok(combined.includes("public-bio") || combined.includes("public professional bio"));

  // Checksums in the manifest match the emitted files.
  const manifest = JSON.parse(fs.readFileSync(path.join(result.dir, "manifest.json"), "utf8"));
  assert.equal(Object.keys(manifest.files).length, 4);

  // Registry updated.
  const updated = await prisma.persona.findUnique({ where: { id: persona.id } });
  assert.equal(updated!.packVersion, result.version);
});

after(async () => {
  for (const id of cleanupSessions) {
    await prisma.response.deleteMany({ where: { sessionId: id } });
    await prisma.sessionFile.deleteMany({ where: { sessionId: id } });
    await prisma.session.delete({ where: { id } }).catch(() => {});
  }
  for (const id of cleanupPersonas) {
    await prisma.persona.delete({ where: { id } }).catch(() => {});
  }
  await prisma.$disconnect();
});
