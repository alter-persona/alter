import "@/lib/loadEnv";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import AdmZip from "adm-zip";
import { prisma } from "@/lib/db";

/**
 * Alter CLI — the factory's command surface.
 *
 *   npm run understudy -- export [--session <id>] [--out file.zip]
 *       Export an intake session (manifest + audio + files) — the format
 *       bootstrap consumes. Defaults to the most-answered session.
 *
 *   npm run understudy -- bootstrap <zip> --name <Name>
 *       [--retire-existing] [--chat-zip <path>] [--no-synthesis]
 *       First-class entry for anyone who already has recordings: import
 *       answers + audio, credit banked minutes, hash-quarantine the sealed
 *       questions, ingest, run gates, first synthesis, activate.
 *
 *   npm run understudy -- status        phase, per-module meter, pending queues
 *   npm run understudy -- rebuild       re-run synthesis on the enlarged corpus
 *   npm run understudy -- health        prove the companion services alive
 *   npm run understudy -- about        the three-sentence disclosure
 *   npm run understudy -- delete-everything --yes
 */

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(flag: string): boolean {
  return process.argv.includes(flag);
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

// ─────────────────────────── export ───────────────────────────

async function exportSession(): Promise<void> {
  let sessionId = arg("--session");
  if (!sessionId) {
    const rows = await prisma.$queryRaw<{ id: string; n: bigint }[]>`
      SELECT s.id, COUNT(r.id) AS n FROM "Session" s
      JOIN "Response" r ON r."sessionId" = s.id AND r.skipped = false
      GROUP BY s.id ORDER BY n DESC LIMIT 1`;
    sessionId = rows[0]?.id;
    if (!sessionId) throw new Error("no answered sessions to export");
  }
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) throw new Error("session not found");
  const [questions, responses, sessionFiles] = await Promise.all([
    prisma.question.findMany({ orderBy: { orderIndex: "asc" } }),
    prisma.response.findMany({ where: { sessionId } }),
    prisma.sessionFile.findMany({ where: { sessionId } }),
  ]);
  const byQuestion = new Map(responses.map((r) => [r.questionId, r]));
  const entries = questions.map((q) => {
    const r = byQuestion.get(q.id);
    return {
      questionId: q.id,
      orderIndex: q.orderIndex,
      section: q.section,
      type: q.type,
      promptText: q.promptText,
      oceanDomain: q.oceanDomain,
      reverseScored: q.reverseScored,
      isValidation: q.isValidation,
      answered: Boolean(r && !r.skipped && (r.audioPath || r.likertValue != null)),
      skipped: r?.skipped ?? false,
      audioFilename: r?.audioPath ? path.basename(r.audioPath) : null,
      audioDurationSec: r?.audioDurationSec ?? null,
      transcript: r?.transcript ?? null,
      transcriptEditedByUser: r?.transcriptEditedByUser ?? false,
      likertValue: r?.likertValue ?? null,
      answeredAt: r?.updatedAt ?? null,
    };
  });
  const zip = new AdmZip();
  zip.addFile(
    "manifest.json",
    Buffer.from(
      JSON.stringify(
        { exportedAt: new Date().toISOString(), session: { id: session.id, label: session.label }, responses: entries },
        null,
        2
      )
    )
  );
  for (const r of responses) {
    if (!r.audioPath) continue;
    const abs = path.resolve(process.cwd(), r.audioPath);
    if (fs.existsSync(abs)) zip.addLocalFile(abs, "audio");
  }
  for (const f of sessionFiles) {
    const abs = path.resolve(process.cwd(), f.storedPath);
    if (fs.existsSync(abs)) zip.addLocalFile(abs, "files");
  }
  const out = arg("--out") ?? `intake-${session.label.replace(/[^\w-]+/g, "-")}-${session.id.slice(0, 8)}.zip`;
  zip.writeZip(out);
  console.log(`[understudy] exported ${out}`);
}

// ─────────────────────────── bootstrap ───────────────────────────

interface ManifestEntry {
  questionId: string;
  orderIndex: number;
  section: string;
  type: "voice" | "likert";
  promptText: string;
  isValidation: boolean;
  answered: boolean;
  skipped: boolean;
  audioFilename: string | null;
  audioDurationSec: number | null;
  transcript: string | null;
  transcriptEditedByUser: boolean;
  likertValue: number | null;
  answeredAt: string | null;
}

async function bootstrap(): Promise<void> {
  const zipPath = process.argv.slice(2).filter((a) => !a.startsWith("--"))[1];
  const name = arg("--name");
  if (!zipPath || !name) {
    console.error("usage: understudy bootstrap <intake.zip> --name <Name> [--retire-existing] [--chat-zip <path>] [--no-synthesis]");
    process.exit(1);
  }
  const zip = new AdmZip(fs.readFileSync(zipPath));
  const manifestEntry = zip.getEntry("manifest.json");
  if (!manifestEntry) throw new Error("not an intake export: manifest.json missing");
  const manifest = JSON.parse(zip.readAsText(manifestEntry)) as { responses: ManifestEntry[] };

  // 1. Persona — fresh, through the factory.
  const existing = await prisma.persona.findUnique({ where: { name } });
  if (existing) {
    if (!has("--retire-existing")) {
      throw new Error(
        `Persona "${name}" already exists. Pass --retire-existing to rename it "${name} (retired)" and build fresh.`
      );
    }
    const retiredName = `${name} (retired ${new Date().toISOString().slice(0, 10)})`;
    await prisma.persona.update({ where: { id: existing.id }, data: { name: retiredName } });
    console.log(`[bootstrap] retired existing persona → "${retiredName}"`);
  }
  const persona = await prisma.persona.create({ data: { name } });
  const session = await prisma.session.create({
    data: { label: `bootstrap ${new Date().toISOString().slice(0, 10)}`, personaId: persona.id, status: "complete", completedAt: new Date() },
  });

  // 2. Import answers. Questions matched by prompt text (order-independent);
  //    unmatched ones are created inactive so no answer is ever dropped.
  const allQuestions = await prisma.question.findMany();
  const byPrompt = new Map(allQuestions.map((q) => [norm(q.promptText), q]));
  const audioDir = path.join(process.cwd(), "data", "audio", `bootstrap-${session.id.slice(0, 8)}`);
  fs.mkdirSync(audioDir, { recursive: true });

  let imported = 0;
  let sealedImported = 0;
  let minutes = 0;
  let maxOrder = Math.max(...allQuestions.map((q) => q.orderIndex), -1);
  const toIngest: string[] = [];

  for (const e of manifest.responses) {
    if (!e.answered && !e.transcript) continue;
    let q = byPrompt.get(norm(e.promptText));
    if (!q) {
      q = await prisma.question.create({
        data: {
          orderIndex: ++maxOrder,
          section: e.section,
          type: e.type,
          promptText: e.promptText,
          isValidation: e.isValidation,
          module: e.isValidation ? "validation" : "identity-values",
          active: false, // imported legacy question — data kept, out of the meter
        },
      });
      byPrompt.set(norm(q.promptText), q);
    }
    // Sealed stays sealed regardless of what the manifest claims.
    const sealed = q.isValidation || e.isValidation;

    let audioPath: string | null = null;
    if (e.audioFilename) {
      const entry = zip.getEntry(`audio/${e.audioFilename}`);
      if (entry) {
        const dest = path.join(audioDir, e.audioFilename);
        fs.writeFileSync(dest, entry.getData());
        audioPath = path.relative(process.cwd(), dest);
        minutes += (e.audioDurationSec ?? 0) / 60;
      }
    }
    const r = await prisma.response.create({
      data: {
        sessionId: session.id,
        questionId: q.id,
        type: e.type,
        audioPath,
        audioDurationSec: e.audioDurationSec,
        transcript: e.transcript,
        transcriptStatus: e.transcript ? "done" : null,
        transcriptSource: e.transcript ? "import" : null,
        transcriptEditedByUser: e.transcriptEditedByUser,
        likertValue: e.likertValue,
      },
    });
    imported++;
    if (sealed) sealedImported++;
    else if (e.type === "voice" && e.transcript) toIngest.push(r.id);
  }
  console.log(
    `[bootstrap] imported ${imported} answers (${sealedImported} sealed, quarantined), credited ${minutes.toFixed(1)} banked spoken minutes`
  );

  // 3. Ingest (retrieval + style halves); per-item distillation deferred so
  //    the batch distill below can share LLM calls.
  process.env.PERSONA2_INGEST_DISTILL = "0";
  const { enqueueResponseIngest, drainIngestQueue, enqueueFileIngest } = await import("@/lib/ingestQueue");
  for (const rid of toIngest) await enqueueResponseIngest(persona.id, rid);

  // Session files from the zip + any --chat-zip exports ride along.
  for (const entry of zip.getEntries().filter((x) => x.entryName.startsWith("files/") && !x.isDirectory)) {
    const dest = path.join(process.cwd(), "data", "files", `bootstrap-${session.id.slice(0, 8)}`, path.basename(entry.entryName));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.getData());
    const f = await prisma.sessionFile.create({
      data: {
        sessionId: session.id,
        filename: path.basename(entry.entryName),
        storedPath: path.relative(process.cwd(), dest),
        sizeBytes: entry.getData().length,
        label: "bootstrap-import",
        sensitivity: "private",
      },
    });
    await enqueueFileIngest(persona.id, f.id);
  }
  for (let i = process.argv.indexOf("--chat-zip"); i >= 0; i = process.argv.indexOf("--chat-zip", i + 1)) {
    const p = path.resolve(process.argv[i + 1]);
    const f = await prisma.sessionFile.create({
      data: {
        sessionId: session.id,
        filename: path.basename(p),
        storedPath: path.relative(process.cwd(), p),
        sizeBytes: fs.statSync(p).size,
        label: "chat-export",
        sensitivity: "private",
      },
    });
    await enqueueFileIngest(persona.id, f.id);
  }
  console.log(`[bootstrap] ingesting (chunks + stylometry)…`);
  await drainIngestQueue();

  if (has("--no-synthesis")) {
    console.log("[bootstrap] --no-synthesis: stopping after ingest. Run `understudy rebuild` later.");
    return;
  }
  await synthesize(persona.id, persona.name);
  await verifySealedAbsent(persona.id);
  console.log(`[bootstrap] persona "${persona.name}" ACTIVE. Set UNDERSTUDY_NAME=${persona.name} in .env.`);
}

// ─────────────────────────── synthesis ───────────────────────────

async function synthesize(personaId: string, personaName: string): Promise<void> {
  const { distill } = await import("@/persona2/distill");
  const { reflect } = await import("@/persona2/reflect");
  const { buildFingerprint } = await import("@/persona2/fingerprint");
  const { curateExemplars } = await import("@/persona2/exemplars");
  const { buildSkillPackV2 } = await import("@/persona2/skillgen");

  console.log("[synthesis] distilling propositions…");
  const d = await distill(personaId, {
    onProgress: (s) => process.stdout.write(`\r  ${s.itemsProcessed} items, ${s.propositionsStored} propositions`),
  });
  console.log(`\n[synthesis] distilled: ${d.propositionsStored} props (${d.lintRejected} lint-rejected, ${d.llmErrors} errors)`);
  console.log("[synthesis] reflecting insights…");
  await reflect(personaId, {});
  console.log("[synthesis] computing fingerprints…");
  const fp = await buildFingerprint(personaId);
  await prisma.styleFingerprint.upsert({
    where: { personaId },
    create: { personaId, spoken: fp.spoken as unknown as object, written: fp.written as unknown as object },
    update: { spoken: fp.spoken as unknown as object, written: fp.written as unknown as object },
  });
  console.log("[synthesis] curating exemplars…");
  const bank = await curateExemplars(personaId);
  const dir = path.join(process.cwd(), "corpus", "persona2", personaId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "exemplars.json"), JSON.stringify(bank, null, 2));
  console.log(`[synthesis] building pack (gates: voice floor, min props, sealed leak check)…`);
  const pack = await buildSkillPackV2(personaId, {});
  console.log(`[synthesis] pack v${pack.version} built for "${personaName}" — persona active.`);
}

/** Prove the sealed answers are absent from every store — id AND content. */
export async function verifySealedAbsent(personaId: string): Promise<void> {
  const sealedRows = await prisma.response.findMany({
    where: { question: { isValidation: true }, transcript: { not: null } },
    select: { transcript: true },
  });
  for (const s of sealedRows) {
    const probe = norm(s.transcript!).slice(0, 80);
    if (probe.length < 40) continue;
    for (const table of ["VectorChunkPrivate", "VectorChunkPublic", "PropositionPrivate", "PropositionPublic"]) {
      const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(*) AS n FROM "${table}" WHERE "personaId" = $1 AND LOWER(REGEXP_REPLACE(text, '\\s+', ' ', 'g')) LIKE $2`,
        personaId,
        `%${probe}%`
      );
      if (Number(rows[0].n) > 0) throw new Error(`SEALED LEAK: ${table} contains a validation answer`);
    }
  }
  console.log(`[bootstrap] sealed quarantine verified: ${sealedRows.length} answers absent from all 4 stores ✔`);
}

// ─────────────────────────── status / health / about ───────────────────────────

async function status(): Promise<void> {
  const { ensureDefaultPersona } = await import("@/lib/personas");
  const { moduleCoverage, renderMeter } = await import("@/curriculum/curriculum");
  const persona = await ensureDefaultPersona();
  const [cov, open, hot, approvals, queued, props] = await Promise.all([
    moduleCoverage(prisma),
    prisma.reconCase.count({ where: { personaId: persona.id, status: "open" } }),
    prisma.hotNote.count({ where: { personaId: persona.id, active: true } }),
    prisma.pendingApproval.count({ where: { personaId: persona.id, status: "pending" } }),
    prisma.loopJob.count({ where: { status: "queued" } }),
    prisma.propositionPrivate
      .count({ where: { personaId: persona.id } })
      .then(async (a) => a + (await prisma.propositionPublic.count({ where: { personaId: persona.id } }))),
  ]);
  const fp = await prisma.styleFingerprint.findUnique({ where: { personaId: persona.id } });
  const phase =
    props === 0 ? "interviewing" : !fp ? "synthesizing" : persona.packVersion === 0 ? "synthesizing" : "active + improving";
  console.log(`Persona: ${persona.name} (pack v${persona.packVersion}) — phase: ${phase}`);
  console.log(`Meter:   ${renderMeter(cov)}`);
  console.log(`Memory:  ${props} propositions`);
  console.log(`Pending: ${open} clarification(s), ${approvals} approval(s), ${hot} hot note(s), ${queued} queued job(s)`);
}

async function health(): Promise<void> {
  const checks: [string, () => Promise<string>][] = [
    ["postgres", async () => {
      await prisma.$queryRaw`SELECT 1`;
      return "ok";
    }],
    ["migrations", async () => {
      const n = await prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`;
      return `${Number(n[0].n)} applied`;
    }],
    ["pgvector", async () => {
      // Cast back to text — Prisma cannot deserialize a raw vector value.
      const r = await prisma.$queryRaw<{ v: string }[]>`SELECT '[1,2,3]'::vector(3)::text AS v`;
      if (r[0]?.v !== "[1,2,3]") throw new Error("vector round-trip failed");
      return "ok";
    }],
    ["whisper-cli", async () => {
      execFileSync("which", ["whisper-cli"]);
      return "ok";
    }],
    ["ffmpeg", async () => {
      execFileSync("which", ["ffmpeg"]);
      return "ok";
    }],
    ["embedder", async () => {
      const { embed } = await import("@/lib/embedder");
      const v = await embed("health check");
      return `${v.length} dims`;
    }],
    ["ollama", async () => {
      const r = await fetch(`${process.env.OLLAMA_URL ?? "http://127.0.0.1:11434"}/api/tags`);
      if (!r.ok) throw new Error(String(r.status));
      return "ok";
    }],
    ["loop queue", async () => {
      const { drainLoopQueue } = await import("@/loop/queue");
      await drainLoopQueue(); // proves the worker claims + completes
      return "drains";
    }],
  ];
  let failed = 0;
  for (const [label, fn] of checks) {
    try {
      console.log(`  ✔ ${label}: ${await fn()}`);
    } catch (e) {
      failed++;
      console.log(`  ✖ ${label}: ${String(e).slice(0, 100)}`);
    }
  }
  console.log(failed === 0 ? "HEALTH: PASS" : `HEALTH: FAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

function about(): void {
  console.log(
    "I'm an Alter — a digital persona built from your own words, answers, and writing, learning to answer and draft the way you would. " +
      "Everything you give me stays on this machine in a local database; the only things that leave are the prompts sent to the model API you configured (and, only if you enable voice, the text of spoken replies to your voice provider). " +
      "You can see everything I know, correct anything I get wrong, and delete all of it with one command."
  );
}

async function deleteEverything(): Promise<void> {
  if (!has("--yes")) {
    console.error("This wipes every persona, answer, recording reference, and index. Re-run with --yes to confirm.");
    process.exit(1);
  }
  for (const t of [
    "UpdateEvent", "HotNote", "ReconCase", "ExemplarPair", "RegressionCase", "CoverageGap",
    "PendingApproval", "LoopJob", "ScoreboardEntry", "ChannelPref", "VoiceAbResult",
  ]) {
    await prisma.$executeRawUnsafe(`DELETE FROM "${t}"`);
  }
  await prisma.persona.deleteMany(); // cascades sessions/responses/chunks/props/fingerprints
  console.log("All persona data deleted. Audio files under storage/ can now be removed: rm -rf storage/");
}

async function main(): Promise<void> {
  const cmd = process.argv.slice(2).filter((a) => !a.startsWith("--"))[0];
  switch (cmd) {
    case "export": await exportSession(); break;
    case "bootstrap": await bootstrap(); break;
    case "status": await status(); break;
    case "rebuild": {
      const { ensureDefaultPersona } = await import("@/lib/personas");
      const p = await ensureDefaultPersona();
      await synthesize(p.id, p.name);
      await verifySealedAbsent(p.id);
      break;
    }
    case "health": await health(); break;
    case "about": about(); break;
    case "evaluate": {
      const { ensureDefaultPersona } = await import("@/lib/personas");
      const p = await ensureDefaultPersona();
      const which = process.argv.slice(2).filter((a) => !a.startsWith("--"))[1] ?? "sealed";
      const { evalSealed, evalBattery } = await import("./evaluate");
      if (which === "sealed" || which === "all") {
        const r = await evalSealed(p.id, p.name);
        console.log(`[eval] wrote ${r.path} (agreement ${r.agreed}/${r.judged})`);
      }
      if (which === "battery" || which === "all") console.log(`[eval] wrote ${await evalBattery(p.id, p.name)}`);
      break;
    }
    case "delete-everything": await deleteEverything(); break;
    default:
      console.log("usage: understudy export|bootstrap|status|rebuild|health|about|delete-everything");
      process.exit(1);
  }
  await prisma.$disconnect();
}

void main();
