export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Re-kick the background transcription worker on server boot so any
    // responses left in transcriptStatus=pending from a previous run
    // (crash, restart) get processed without user action.
    const { kickTranscriptionQueue } = await import("./src/lib/transcriptionQueue");
    kickTranscriptionQueue();
    const { kickIngestQueue } = await import("./src/lib/ingestQueue");
    kickIngestQueue();
    // Improvement loop: resume any tier-2 jobs left queued by a restart.
    const { kickLoopQueue } = await import("./src/loop/queue");
    kickLoopQueue();
  }
}
