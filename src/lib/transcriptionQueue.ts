import path from "node:path";
import { prisma } from "./db";
import { getTranscriber } from "./transcriber";

/**
 * In-process background transcription worker. Never on the critical path:
 * saving a voice answer just marks transcriptStatus=pending and kicks this
 * loop, which drains pending rows one at a time (transcription is CPU/GPU
 * bound, so concurrency 1 keeps recording responsive).
 *
 * State lives on globalThis so dev-mode HMR doesn't spawn duplicate workers,
 * and instrumentation.ts re-kicks the loop on server boot so pending rows
 * from a previous run are picked up.
 */
const g = globalThis as unknown as { __txRunning?: boolean };

export function kickTranscriptionQueue(): void {
  if (g.__txRunning) return;
  g.__txRunning = true;
  void drain().finally(() => {
    g.__txRunning = false;
  });
}

async function drain(): Promise<void> {
  for (;;) {
    const next = await prisma.response.findFirst({
      where: { transcriptStatus: "pending", audioPath: { not: null } },
      orderBy: { updatedAt: "asc" },
    });
    if (!next) return;

    let transcriberName = "unknown";
    try {
      const transcriber = getTranscriber();
      transcriberName = transcriber.name;
      const abs = path.resolve(process.cwd(), next.audioPath!);
      const { text, engine } = await transcriber.transcribe(abs);

      // Guard on updatedAt: if the answer was re-recorded (or edited) while we
      // were transcribing, this stale result must not clobber the newer state.
      const updated = await prisma.response.updateMany({
        where: {
          id: next.id,
          transcriptStatus: "pending",
          transcriptEditedByUser: false,
          updatedAt: next.updatedAt,
        },
        data: { transcript: text, transcriptStatus: "done", transcriptSource: engine },
      });
      if (updated.count === 0) {
        console.log(`[transcription] result for ${next.id} discarded (row changed mid-job)`);
      } else {
        // Transcript ready → feed the persona's index + stylometry (the
        // ingest job itself skips sealed validation answers).
        try {
          const { enqueueResponseIngest } = await import("./ingestQueue");
          const { personaForSession } = await import("./personas");
          const persona = await personaForSession(next.sessionId);
          await enqueueResponseIngest(persona.id, next.id);
        } catch (e) {
          console.error("[transcription] ingest enqueue failed:", e);
        }
      }
    } catch (err) {
      console.error(`[transcription] failed for response ${next.id}:`, err);
      await prisma.response.updateMany({
        where: { id: next.id, transcriptStatus: "pending", updatedAt: next.updatedAt },
        data: { transcriptStatus: "failed", transcriptSource: transcriberName },
      });
    }
  }
}
