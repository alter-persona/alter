import { prisma } from "@/lib/db";

/**
 * Tier-2 async worker over the LoopJob table — same Postgres-backed
 * FOR UPDATE SKIP LOCKED pattern as IngestJob. No Redis.
 */

const g = globalThis as unknown as { __loopPromise?: Promise<void> };

function startDrain(): Promise<void> {
  if (!g.__loopPromise) {
    g.__loopPromise = drain().finally(() => {
      g.__loopPromise = undefined;
    });
  }
  return g.__loopPromise;
}

export function kickLoopQueue(): void {
  // Tests drive the queue explicitly via drainLoopQueue().
  if (process.env.LOOP_QUEUE_MANUAL === "1") return;
  void startDrain();
}

/** Awaitable drain for tests and the CLI — waits out any in-flight drain,
 * then drains again so jobs enqueued meanwhile are also processed. */
export async function drainLoopQueue(): Promise<void> {
  await startDrain();
  await startDrain();
}

interface JobRow {
  id: string;
  personaId: string;
  kind: string;
  eventId: string;
  attempts: number;
}

async function claimNext(): Promise<JobRow | null> {
  const rows = await prisma.$queryRaw<JobRow[]>`
    UPDATE "LoopJob" SET status = 'running', attempts = attempts + 1, "updatedAt" = NOW()
    WHERE id = (
      SELECT id FROM "LoopJob"
      WHERE status = 'queued'
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, "personaId", kind, "eventId", attempts`;
  return rows[0] ?? null;
}

async function drain(): Promise<void> {
  for (;;) {
    const job = await claimNext();
    if (!job) return;
    try {
      await processJob(job);
      await prisma.loopJob.update({ where: { id: job.id }, data: { status: "done", error: null } });
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err).slice(0, 500);
      console.error(`[loop] job ${job.id} (${job.kind}) failed:`, message);
      await prisma.loopJob.update({ where: { id: job.id }, data: { status: "failed", error: message } });
      await prisma.updateEvent
        .update({ where: { id: job.eventId }, data: { status: "failed", error: message } })
        .catch(() => {});
    }
  }
}

async function processJob(job: JobRow): Promise<void> {
  const event = await prisma.updateEvent.findUnique({ where: { id: job.eventId } });
  if (!event) throw new Error("event not found");

  if (job.kind === "classify") {
    // Async refinement of a low-confidence heuristic call.
    const { llmClassify } = await import("./classify");
    const { writeHotNote } = await import("./hotnotes");
    let previous: string | null = null;
    if (event.replyToEventId) {
      const p = await prisma.updateEvent.findUnique({ where: { id: event.replyToEventId } });
      previous = p?.rawText ?? null;
    }
    const r = await llmClassify(event.rawText ?? "", { previousPersonaReply: previous });
    if (r.intent === "chat" || r.confidence < 0.6) {
      await prisma.updateEvent.update({ where: { id: event.id }, data: { status: "none_needed" } });
      return;
    }
    await prisma.updateEvent.update({
      where: { id: event.id },
      data: { intent: r.intent, intentSource: "classifier" },
    });
    if ((r.intent === "correction" || r.intent === "meta") && event.rawText) {
      const existing = await prisma.hotNote.findFirst({ where: { sourceEventId: event.id } });
      if (!existing) await writeHotNote(event.personaId, event.id, event.rawText);
    }
    await prisma.loopJob.create({
      data: { personaId: event.personaId, kind: r.intent, eventId: event.id },
    });
    return;
  }

  await prisma.updateEvent.update({ where: { id: event.id }, data: { status: "distilling" } });

  if (job.kind === "correction" || job.kind === "meta") {
    const { distillCorrection } = await import("./corrections");
    await distillCorrection(event);
  } else if (job.kind === "material") {
    // Delta report: what the upload actually bought, surfaced conversationally
    // by whichever channel is watching this event.
    const { snapshotCorpus, diffCorpus, renderDelta } = await import("./delta");
    const before = await snapshotCorpus(event.personaId);
    const { distillMaterial } = await import("./material");
    await distillMaterial(event);
    const after = await snapshotCorpus(event.personaId);
    const report = renderDelta(event.filename ?? "your material", diffCorpus(before, after));
    await prisma.updateEvent.update({
      where: { id: event.id },
      data: { retrievalLog: { deltaReport: report } },
    });
  } else if (job.kind === "clarify") {
    // The person answered an in-chat clarification — route it back through
    // reconciliation (usually produces the merged augment chunk).
    const log = event.retrievalLog as { clarifiesCaseId?: string } | null;
    if (!log?.clarifiesCaseId) throw new Error("clarify job missing case id");
    const { resolveWithAnswer } = await import("./reconcile");
    await resolveWithAnswer(log.clarifiesCaseId, event.rawText ?? "", event.id);
  } else {
    throw new Error(`unknown loop job kind "${job.kind}"`);
  }

  await prisma.updateEvent.update({ where: { id: event.id }, data: { status: "distilled" } });

  // Drift control: spot-check cadence counter.
  const { maybeSpotCheck } = await import("./drift");
  await maybeSpotCheck(event.personaId).catch((e) =>
    console.error(`[loop] spot check failed: ${String(e).slice(0, 150)}`)
  );
}
