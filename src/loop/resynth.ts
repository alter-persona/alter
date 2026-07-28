import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { buildFingerprint } from "@/persona2/fingerprint";
import { curateExemplars, type Exemplar } from "@/persona2/exemplars";
import { valuesAndHeuristics } from "@/persona2/skillgen";
import { renderPersonaCore } from "@/persona2/prompt";
import { loopConfig } from "./config";
import { readStyleDelta } from "./corrections";
import { replayRegressions, type Generate } from "./drift";

/**
 * Re-synthesis: when accumulated deltas cross thresholds, rebuild the style
 * guide (fingerprints + style delta), re-curate the exemplar bank from the
 * enlarged corpus (correction exemplar pairs join the bank), and re-render
 * the persona core as a NEW VERSION. Every core version is kept; rollback to
 * any prior version is one command. An unresolved clarification touching core
 * identity BLOCKS core re-synthesis — rebuilding identity on top of an open
 * contradiction bakes the confusion in. A re-synthesis only ships if the
 * regression suite passes at least as well as the current version.
 */

const dir = (personaId: string) => path.join(process.cwd(), "corpus", "persona2", personaId);

export async function resynthesisDue(personaId: string): Promise<{
  due: boolean;
  blockedByOpenCoreCase: boolean;
  newChunks: number;
  corrections: number;
}> {
  const cfg = loopConfig();
  const last = await prisma.scoreboardEntry.findFirst({
    where: { personaId, kind: "resynthesis" },
    orderBy: { runAt: "desc" },
  });
  const since = last?.runAt ?? new Date(0);
  const [rows, corrections, coreOpen] = await Promise.all([
    prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT (SELECT COUNT(*) FROM "PropositionPrivate" WHERE "personaId" = $1 AND "createdAt" > $2)
            + (SELECT COUNT(*) FROM "PropositionPublic" WHERE "personaId" = $1 AND "createdAt" > $2) AS n`,
      personaId,
      since
    ),
    prisma.updateEvent.count({
      where: { personaId, intent: { in: ["correction", "meta"] }, createdAt: { gt: since } },
    }),
    prisma.reconCase.count({ where: { personaId, status: "open", tier: "core" } }),
  ]);
  const newChunks = Number(rows[0]?.n ?? 0);
  return {
    due: newChunks >= cfg.resynthesisChunkThreshold || corrections >= cfg.resynthesisCorrectionThreshold,
    blockedByOpenCoreCase: coreOpen > 0,
    newChunks,
    corrections,
  };
}

export async function runResynthesis(
  personaId: string,
  personaName: string,
  opts: { generate?: Generate; force?: boolean } = {}
): Promise<{ version: number; shipped: boolean; reason: string }> {
  const status = await resynthesisDue(personaId);
  if (status.blockedByOpenCoreCase && !opts.force) {
    throw new Error(
      "re-synthesis blocked: an open clarification touches core identity — resolve it first (review panel)."
    );
  }

  const d = dir(personaId);
  fs.mkdirSync(d, { recursive: true });
  const persona = await prisma.persona.findUnique({ where: { id: personaId } });
  const currentVersion = persona?.packVersion ?? 0;
  const nextVersion = currentVersion + 1;

  // Baseline: regression pass count under the CURRENT artifacts.
  const gen = opts.generate;
  const before = gen ? await replayRegressions(personaId, gen) : null;
  const beforePassed = before?.filter((r) => r.pass).length ?? null;

  // Snapshot current artifacts for rollback.
  const exemplarsPath = path.join(d, "exemplars.json");
  const prevExemplars = fs.existsSync(exemplarsPath) ? fs.readFileSync(exemplarsPath, "utf8") : null;
  if (prevExemplars && !fs.existsSync(path.join(d, `exemplars-v${currentVersion}.json`))) {
    fs.writeFileSync(path.join(d, `exemplars-v${currentVersion}.json`), prevExemplars);
  }

  // 1. Rebuild the style guide: fingerprints from the enlarged corpus.
  const fp = await buildFingerprint(personaId);
  await prisma.styleFingerprint.upsert({
    where: { personaId },
    create: { personaId, spoken: fp.spoken as unknown as object, written: fp.written as unknown as object },
    update: { spoken: fp.spoken as unknown as object, written: fp.written as unknown as object },
  });

  // 2. Re-curate the exemplar bank; correction pairs join it (my corrected
  //    versions are ground-truth voice).
  let bank: Exemplar[] = [];
  try {
    bank = await curateExemplars(personaId);
  } catch (e) {
    console.warn(`[resynth] exemplar curation unavailable (${String(e).slice(0, 100)}) — keeping existing bank`);
    bank = prevExemplars ? (JSON.parse(prevExemplars) as Exemplar[]) : [];
  }
  const pairs = await prisma.exemplarPair.findMany({
    where: { personaId },
    orderBy: { createdAt: "desc" },
    take: 4,
  });
  for (const p of pairs) {
    const words = p.correctedText.split(/\s+/).length;
    if (words >= 20 && words <= 140) {
      bank.push({ text: p.correctedText, mode: p.mode as "spoken" | "written", topic: "correction" });
    }
  }
  fs.writeFileSync(exemplarsPath, JSON.stringify(bank, null, 2));

  // 3. Re-render the persona core as a new version (both modes).
  const { values, heuristics } = await valuesAndHeuristics(personaId);
  const deltaRules = readStyleDelta(personaId);
  const renderCore = (mode: "spoken" | "written") => {
    let core = renderPersonaCore({ name: personaName, values, heuristics, fingerprint: mode === "spoken" ? fp.spoken : fp.written, mode });
    if (deltaRules.length > 0) {
      core += `\n\n## Standing corrections from the real person\n${deltaRules.map((r) => `- ${r}`).join("\n")}`;
    }
    return core;
  };
  const coreFile = path.join(d, `core-v${nextVersion}.md`);
  fs.writeFileSync(
    coreFile,
    `<!-- persona core v${nextVersion} — ${new Date().toISOString()} -->\n\n# SPOKEN\n\n${renderCore("spoken")}\n\n# WRITTEN\n\n${renderCore("written")}\n`
  );

  // 4. Ship only if regressions pass at least as well as before.
  let shipped = true;
  let reason = "regression suite not run (no generator) — shipped";
  if (gen && beforePassed !== null) {
    const after = await replayRegressions(personaId, gen);
    const afterPassed = after.filter((r) => r.pass).length;
    if (afterPassed < beforePassed) {
      // Roll back the exemplar bank; keep the core file for inspection but
      // do not bump the version pointer.
      if (prevExemplars) fs.writeFileSync(exemplarsPath, prevExemplars);
      shipped = false;
      reason = `regressions worsened (${afterPassed}/${after.length} vs ${beforePassed}/${before!.length}) — rolled back`;
    } else {
      reason = `regressions ${afterPassed}/${after.length} (was ${beforePassed}/${before!.length})`;
    }
  }

  if (shipped) {
    await prisma.persona.update({ where: { id: personaId }, data: { packVersion: nextVersion } });
  }
  await prisma.scoreboardEntry.create({
    data: {
      personaId,
      kind: "resynthesis",
      metrics: { version: nextVersion, shipped, reason, newChunks: status.newChunks, corrections: status.corrections } as object,
    },
  });
  return { version: nextVersion, shipped, reason };
}

/** Rollback to any prior core version — one command. */
export async function rollbackCore(personaId: string, version: number): Promise<void> {
  const d = dir(personaId);
  const coreFile = path.join(d, `core-v${version}.md`);
  if (version > 0 && !fs.existsSync(coreFile)) throw new Error(`no core-v${version}.md — versions: ${listCoreVersions(personaId).join(", ")}`);
  const exFile = path.join(d, `exemplars-v${version}.json`);
  if (fs.existsSync(exFile)) {
    fs.copyFileSync(exFile, path.join(d, "exemplars.json"));
  }
  await prisma.persona.update({ where: { id: personaId }, data: { packVersion: version } });
}

export function listCoreVersions(personaId: string): number[] {
  const d = dir(personaId);
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .map((f) => /^core-v(\d+)\.md$/.exec(f)?.[1])
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b);
}
