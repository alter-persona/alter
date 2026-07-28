import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { encode } from "gpt-tokenizer";
import { prisma } from "./db";
import { embed, toVectorLiteral } from "./embedder";
import { updateStylometry } from "./stylometry";
import { redact } from "@/corpus/redact";
import { chunkText } from "@/corpus/chunk";
import { itemId, chunkId } from "@/corpus/hash";
import { config as corpusConfig } from "@/corpus/config";
import { LOADERS } from "@/corpus/sources/work/loaders";
import { parseChatZip, PROVIDERS } from "@/corpus/sources/chat";
import type { CorpusItem } from "@/corpus/types";

/**
 * Background ingest worker (Postgres-backed queue, FOR UPDATE SKIP LOCKED).
 * Uploading a file — or finishing an interview transcript — enqueues a job;
 * each job runs BOTH halves of invariant 3:
 *   retrieval half: parse → redact → chunk → embed → upsert pgvector rows
 *   style half:     update the persona's stylometry from their own text
 * Content-hash chunk ids make re-ingestion of identical content a no-op.
 */

const g = globalThis as unknown as { __ingestRunning?: boolean };

export function kickIngestQueue(): void {
  if (g.__ingestRunning) return;
  g.__ingestRunning = true;
  void drain().finally(() => {
    g.__ingestRunning = false;
  });
}

/** Awaitable drain for tests and the backfill CLI. */
export async function drainIngestQueue(): Promise<void> {
  if (g.__ingestRunning) return;
  g.__ingestRunning = true;
  try {
    await drain();
  } finally {
    g.__ingestRunning = false;
  }
}

interface JobRow {
  id: string;
  personaId: string;
  kind: string;
  fileId: string | null;
  responseId: string | null;
  zipPath: string | null;
  attempts: number;
}

async function claimNext(): Promise<JobRow | null> {
  const rows = await prisma.$queryRaw<JobRow[]>`
    UPDATE "IngestJob" SET status = 'running', attempts = attempts + 1, "updatedAt" = NOW()
    WHERE id = (
      SELECT id FROM "IngestJob"
      WHERE status = 'queued'
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, "personaId", kind, "fileId", "responseId", "zipPath", attempts`;
  return rows[0] ?? null;
}

async function drain(): Promise<void> {
  for (;;) {
    const job = await claimNext();
    if (!job) return;
    try {
      await processJob(job);
      await prisma.ingestJob.update({
        where: { id: job.id },
        data: { status: "embedded", error: null },
      });
      if (job.fileId) {
        await prisma.sessionFile
          .update({ where: { id: job.fileId }, data: { ingestStatus: "embedded", ingestError: null } })
          .catch(() => {});
      }
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err).slice(0, 500);
      console.error(`[ingest] job ${job.id} (${job.kind}) failed:`, message);
      await prisma.ingestJob.update({
        where: { id: job.id },
        data: { status: "failed", error: message },
      });
      if (job.fileId) {
        await prisma.sessionFile
          .update({ where: { id: job.fileId }, data: { ingestStatus: "failed", ingestError: message } })
          .catch(() => {});
      }
    }
  }
}

interface IngestPayload {
  items: CorpusItem[]; // retrieval half input
  ownText: string[]; // style half input — the person's own words only
}

async function processJob(job: JobRow): Promise<IngestPayload> {
  let payload: IngestPayload;
  if (job.kind === "interview") payload = await payloadFromResponse(job);
  else if (job.kind === "chat_zip") payload = await payloadFromChatZip(job.zipPath!, path.basename(job.zipPath!));
  else payload = await payloadFromFile(job);

  // Re-ingest consistency: drop chunks from previous versions of the same
  // origins (edited transcript, re-uploaded file) so the index never holds
  // stale content. Both tables are cleared because a re-upload may flip the
  // file's sensitivity. Identical content re-inserts identical ids — a no-op.
  const origins = [...new Set(payload.items.map((i) => i.origin))];
  if (origins.length > 0 && origins.length <= 100) {
    const where = { personaId: job.personaId, origin: { in: origins } };
    await prisma.vectorChunkPrivate.deleteMany({ where });
    await prisma.vectorChunkPublic.deleteMany({ where });
  }

  // Retrieval half: redact → chunk → embed → upsert. Invariant 2: the table
  // itself is the sensitivity — private and public are physically separate.
  for (const item of payload.items) {
    const table = item.sensitivity === "public" ? "VectorChunkPublic" : "VectorChunkPrivate";
    const r = redact(item.text);
    const pieces = chunkText(r.text, corpusConfig.chunkMaxTokens, corpusConfig.chunkTargetTokens);
    const base = itemId(item.sourceType, item.origin, r.text);
    for (let i = 0; i < pieces.length; i++) {
      const id = chunkId(base, i, pieces.length);
      const vec = toVectorLiteral(await embed(pieces[i]));
      await prisma.$executeRawUnsafe(
        `INSERT INTO "${table}"
           (id, "personaId", "sourceType", label, domain, date, origin, text, tokens, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector)
         ON CONFLICT (id) DO UPDATE
           SET label = EXCLUDED.label, domain = EXCLUDED.domain`,
        id,
        job.personaId,
        item.sourceType,
        item.label,
        item.domain,
        item.date ? new Date(item.date) : null,
        item.origin,
        pieces[i],
        encode(pieces[i]).length,
        vec
      );
    }
  }

  // Style half: only the person's own text, post-redaction.
  for (const text of payload.ownText) {
    await updateStylometry(job.personaId, redact(text).text);
  }

  // Invariant 3 (v2): distill this item into neutral-register propositions
  // for the retrieval index. Best-effort — requires the build-time LLM; a
  // failure here never fails the ingest (raw + style already landed), and
  // the migration CLI can always re-distill by origin.
  // Skipped in test mode (EMBED_FAKE) and skippable via PERSONA2_INGEST_DISTILL=0.
  if (
    payload.items.length > 0 &&
    process.env.EMBED_FAKE !== "1" &&
    process.env.PERSONA2_INGEST_DISTILL !== "0"
  ) {
    try {
      const { distill } = await import("@/persona2/distill");
      await distill(job.personaId, {
        onlyOrigins: [...new Set(payload.items.map((i) => i.origin))],
      });
    } catch (e) {
      console.error(`[ingest] distillation deferred: ${String(e).slice(0, 150)}`);
    }
  }
  return payload;
}

async function payloadFromResponse(job: JobRow): Promise<IngestPayload> {
  const r = await prisma.response.findUnique({
    where: { id: job.responseId! },
    include: { question: true, session: true },
  });
  if (!r) throw new Error("response not found");
  // HARD GUARD: sealed validation answers never enter the index or stylometry.
  if (r.question.isValidation) return { items: [], ownText: [] };
  if (!r.transcript?.trim()) return { items: [], ownText: [] };
  const item: CorpusItem = {
    text: r.transcript.trim(),
    sourceType: "interview",
    label: r.question.section,
    domain: null,
    date: (r.updatedAt ?? r.createdAt).toISOString(),
    sensitivity: "private",
    origin: `session:${r.sessionId.slice(0, 8)}#q${r.question.orderIndex + 1}:${r.questionId.slice(0, 8)}`,
  };
  return { items: [item], ownText: [item.text] };
}

async function payloadFromFile(job: JobRow): Promise<IngestPayload> {
  const file = await prisma.sessionFile.findUnique({ where: { id: job.fileId! } });
  if (!file?.storedPath) throw new Error("file record or stored file missing");
  const abs = path.resolve(process.cwd(), file.storedPath);
  const buffer = fs.readFileSync(abs);
  const ext = path.extname(file.filename).toLowerCase();

  if (ext === ".zip") {
    return payloadFromChatZipBuffer(buffer, file.filename, file.sensitivity);
  }

  const loader = LOADERS[ext];
  if (!loader) throw new Error(`unsupported extension "${ext}"`);
  const text = (await loader(file.filename, buffer)).trim();
  if (!text) throw new Error("no extractable text");
  const item: CorpusItem = {
    text,
    sourceType: "work_file",
    label: file.label,
    domain: file.domain,
    date: file.createdAt.toISOString(),
    sensitivity: file.sensitivity,
    origin: `upload:${file.filename}`,
  };
  return { items: [item], ownText: [text] };
}

async function payloadFromChatZip(zipPath: string, name: string): Promise<IngestPayload> {
  return payloadFromChatZipBuffer(fs.readFileSync(zipPath), name, "private");
}

function payloadFromChatZipBuffer(
  buffer: Buffer,
  name: string,
  sensitivity: "private" | "public"
): IngestPayload {
  const zip = new AdmZip(buffer);
  const result = parseChatZip(zip, name);
  if (!result) {
    throw new Error("zip is not a recognized chat export (providers: claude, openai)");
  }
  const parsed = result.parsed;
  const minWords = corpusConfig.minWords;
  const items = [...parsed.messages, ...parsed.projectDocs]
    .filter(
      (m) =>
        m.sourceType !== "chat_export" ||
        m.text.split(/\s+/).filter(Boolean).length >= minWords
    )
    .map((m) => ({ ...m, sensitivity }));
  return {
    items,
    // Style half: human messages only — never assistant or third-party text.
    ownText: parsed.humanMessages.map((m) => m.text),
  };
}

/** True when the zip looks like a chat export rather than an archive of docs. */
export function isChatExportZip(buffer: Buffer): boolean {
  try {
    const zip = new AdmZip(buffer);
    return PROVIDERS.some((p) => {
      try {
        return p.detect(zip);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export async function enqueueFileIngest(personaId: string, fileId: string): Promise<void> {
  await prisma.ingestJob.create({ data: { personaId, kind: "work_file", fileId } });
  await prisma.sessionFile.update({
    where: { id: fileId },
    data: { ingestStatus: "queued", ingestError: null },
  });
  kickIngestQueue();
}

export async function enqueueResponseIngest(personaId: string, responseId: string): Promise<void> {
  await prisma.ingestJob.create({ data: { personaId, kind: "interview", responseId } });
  kickIngestQueue();
}
