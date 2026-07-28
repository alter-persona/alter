import "@/lib/loadEnv";
import { prisma } from "@/lib/db";
import { ensureDefaultPersona } from "@/lib/personas";

/**
 * Improvement-loop CLI:
 *   npm run loop -- drain            process the tier-2 job queue
 *   npm run loop -- spot-check       regression replay + sealed harness now
 *   npm run loop -- resynth [--force]  run re-synthesis (blocked by open core cases)
 *   npm run loop -- core:rollback N  roll the persona core back to version N
 *   npm run loop -- status           counters, queue, open cases, hot notes
 */

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2).filter((a) => a !== "--");
  const persona = await ensureDefaultPersona();

  switch (cmd) {
    case "drain": {
      const { drainLoopQueue } = await import("./queue");
      await drainLoopQueue();
      console.log("[loop] queue drained");
      break;
    }
    case "spot-check": {
      const { runSpotCheck } = await import("./drift");
      const r = await runSpotCheck(persona.id, persona.name);
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case "resynth": {
      const { runResynthesis } = await import("./resynth");
      const r = await runResynthesis(persona.id, persona.name, { force: rest.includes("--force") });
      console.log(`[resynth] v${r.version} shipped=${r.shipped} — ${r.reason}`);
      break;
    }
    case "core:rollback": {
      const { rollbackCore, listCoreVersions } = await import("./resynth");
      const v = Number(rest[0]);
      if (Number.isNaN(v)) {
        console.log(`versions: ${listCoreVersions(persona.id).join(", ") || "(none)"}`);
        process.exit(1);
      }
      await rollbackCore(persona.id, v);
      console.log(`[loop] core rolled back to v${v}`);
      break;
    }
    case "status": {
      const [queued, failed, open, hot, events, due] = await Promise.all([
        prisma.loopJob.count({ where: { status: "queued" } }),
        prisma.loopJob.count({ where: { status: "failed" } }),
        prisma.reconCase.count({ where: { personaId: persona.id, status: "open" } }),
        prisma.hotNote.count({ where: { personaId: persona.id, active: true } }),
        prisma.updateEvent.count({ where: { personaId: persona.id } }),
        import("./resynth").then((m) => m.resynthesisDue(persona.id)),
      ]);
      console.log(
        JSON.stringify(
          { events, queue: { queued, failed }, openReconCases: open, activeHotNotes: hot, resynthesis: due },
          null,
          2
        )
      );
      break;
    }
    default:
      console.log("usage: npm run loop -- drain|spot-check|resynth|core:rollback N|status");
      process.exit(1);
  }
  await prisma.$disconnect();
}

void main();
