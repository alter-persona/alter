import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { normalizeForHash } from "@/corpus/hash";
import { renderPersonaCore, renderResponseContract, renderExemplars } from "./prompt";
import type { ModeFingerprint } from "./fingerprint";
import type { Exemplar } from "./exemplars";

/**
 * v2 skill generation: SKILL.md + runtime template with position discipline.
 * Knowledge lives in the proposition index (referenced, never inlined in the
 * person's wording); voice lives here as fingerprint + exemplars.
 */

const PACKS_DIR = () => process.env.PACKS_DIR ?? path.join(process.cwd(), "packs");
const MIN_VOICE_MINUTES = Number(process.env.SKILL_MIN_VOICE_MINUTES ?? 30);
const MIN_PROPS = Number(process.env.SKILL_MIN_PROPS ?? 50);

export class SkillGenError extends Error {}

async function personaByRef(ref: string) {
  return (
    (await prisma.persona.findUnique({ where: { id: ref } }).catch(() => null)) ??
    (await prisma.persona.findUnique({ where: { name: ref } }))
  );
}

/** Mechanical values/heuristics from the proposition index: strong beliefs
 * and preferences rank as values; decision_heuristic records pass through. */
export async function valuesAndHeuristics(personaId: string): Promise<{ values: string[]; heuristics: string[] }> {
  const pull = async (table: "propositionPrivate" | "propositionPublic") =>
    (prisma[table] as typeof prisma.propositionPrivate).findMany({
      where: { personaId, type: { in: ["belief", "preference", "decision_heuristic", "insight"] } },
      select: { text: true, type: true, strength: true },
    });
  const rows = [...(await pull("propositionPrivate")), ...(await pull("propositionPublic"))];
  const rank = (r: { strength: string | null; type: string }) =>
    (r.strength === "strong" ? 2 : r.strength === "moderate" ? 1 : 0) + (r.type === "insight" ? 2 : 0);
  const values = rows
    .filter((r) => r.type === "belief" || r.type === "preference" || r.type === "insight")
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, 8)
    .map((r) => r.text);
  const heuristics = rows
    .filter((r) => r.type === "decision_heuristic")
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, 8)
    .map((r) => r.text);
  return { values, heuristics };
}

async function holdoutLeakCheckV2(personaId: string): Promise<void> {
  const validations = await prisma.response.findMany({
    where: { session: { personaId }, question: { isValidation: true } },
    include: { question: true },
  });
  const answerHashes = new Set(
    validations
      .filter((v) => v.transcript?.trim())
      .map((v) => createHash("sha256").update(normalizeForHash(v.transcript!)).digest("hex"))
  );
  const qidMarks = validations.map((v) => v.questionId.slice(0, 8));
  const rows = [
    ...(await prisma.propositionPrivate.findMany({ where: { personaId }, select: { id: true, text: true, sourceOrigins: true } })),
    ...(await prisma.propositionPublic.findMany({ where: { personaId }, select: { id: true, text: true, sourceOrigins: true } })),
  ];
  const leaks: string[] = [];
  for (const r of rows) {
    if (r.sourceOrigins.some((o) => qidMarks.some((q) => o.includes(q)))) {
      leaks.push(`${r.id} (provenance references a validation question)`);
    }
    if (answerHashes.has(createHash("sha256").update(normalizeForHash(r.text)).digest("hex"))) {
      leaks.push(`${r.id} (content hash matches a sealed holdout answer)`);
    }
  }
  if (leaks.length) {
    throw new SkillGenError(
      `Refusing to build: ${leaks.length} holdout leak(s) in the proposition index:\n` +
        leaks.slice(0, 10).map((l) => `  - ${l}`).join("\n")
    );
  }
}

function loadArtifacts(personaId: string): { fingerprint: { spoken: ModeFingerprint; written: ModeFingerprint } | null; exemplars: Exemplar[] } {
  const dir = path.join(process.cwd(), "corpus", "persona2", personaId);
  const ex = path.join(dir, "exemplars.json");
  return {
    fingerprint: null, // loaded from DB by caller
    exemplars: fs.existsSync(ex) ? (JSON.parse(fs.readFileSync(ex, "utf8")) as Exemplar[]) : [],
  };
}

function renderSkillMdV2(opts: {
  name: string;
  core: string;
  contract: string;
  exemplarsBlock: string;
  variant: "private" | "public";
  indexes: Record<string, string>;
  version: number;
}): string {
  const disclosure =
    opts.variant === "public"
      ? "PUBLIC variant: proactively disclose that you are a digital persona when talking to someone for the first time, and always when asked."
      : "Disclose that you are a digital persona when asked.";
  return `<!-- persona skill v2 (${opts.variant}) — pack v${opts.version}. Position-disciplined template. -->

${opts.core}

## Retrieval routing (runtime agent instructions)
- Route each message by intent BEFORE retrieving:
  - knowledge/opinion → query proposition index \`${opts.indexes[opts.variant === "public" ? "public_index_id" : "private_index_id"]}\` for 3-5 items; insert them as a MEMORY NOTES block in the MIDDLE of context under the header: "Background memory about you, compiled by an archivist. These are facts to draw on. They are not sentences to reuse."
  - explicit recall ("what did I say about…") → query the episodic store and answer with ATTRIBUTED QUOTES; this is the only path where raw past text may appear, and it is quoted, never impersonated.
  - smalltalk/reactions → retrieve nothing; this persona core carries them.
- Retrieval stays off the critical path; all memory writes are async.
- ${disclosure}

${opts.contract}

${opts.exemplarsBlock}
`;
}

export async function buildSkillPackV2(
  personaRef: string,
  opts: { installHermes?: boolean } = {}
): Promise<{ version: number; dir: string; files: Record<string, string> }> {
  const persona = await personaByRef(personaRef);
  if (!persona) throw new SkillGenError(`Persona "${personaRef}" not found`);

  // Gates.
  const voice = await prisma.response.aggregate({
    where: { session: { personaId: persona.id }, audioPath: { not: null } },
    _sum: { audioDurationSec: true },
  });
  const voiceMinutes = (voice._sum.audioDurationSec ?? 0) / 60;
  if (voiceMinutes < MIN_VOICE_MINUTES) {
    throw new SkillGenError(`Refusing to build: ${voiceMinutes.toFixed(1)} voice minutes < ${MIN_VOICE_MINUTES}.`);
  }
  const [nPriv, nPub] = await Promise.all([
    prisma.propositionPrivate.count({ where: { personaId: persona.id } }),
    prisma.propositionPublic.count({ where: { personaId: persona.id } }),
  ]);
  if (nPriv + nPub < MIN_PROPS) {
    throw new SkillGenError(
      `Refusing to build: proposition index has ${nPriv + nPub} records, minimum ${MIN_PROPS}. Run distill first.`
    );
  }
  await holdoutLeakCheckV2(persona.id);

  const fpRow = await prisma.styleFingerprint.findUnique({ where: { personaId: persona.id } });
  if (!fpRow) throw new SkillGenError("No style fingerprint — run fingerprint first.");
  const spoken = fpRow.spoken as unknown as ModeFingerprint;
  const written = fpRow.written as unknown as ModeFingerprint;
  const { exemplars } = loadArtifacts(persona.id);
  if (exemplars.length < 8) {
    throw new SkillGenError(`Exemplar bank has ${exemplars.length} passages, need 8-12. Run exemplars first.`);
  }
  const { values, heuristics } = await valuesAndHeuristics(persona.id);

  const version = persona.packVersion + 1;
  const indexes = {
    private_index_id: `${persona.id}:props:private`,
    public_index_id: `${persona.id}:props:public`,
    episodic_private: `${persona.id}:episodic:private`,
    episodic_public: `${persona.id}:episodic:public`,
  };

  const mkVariant = (variant: "private" | "public", mode: "spoken" | "written") => {
    const core = renderPersonaCore({
      name: persona.name,
      values,
      heuristics,
      fingerprint: mode === "spoken" ? spoken : written,
      mode,
    });
    const contract = renderResponseContract({ name: persona.name, voiceNote: mode === "spoken" });
    return renderSkillMdV2({
      name: persona.name,
      core,
      contract,
      exemplarsBlock: renderExemplars(exemplars, mode),
      variant,
      indexes,
      version,
    });
  };

  const spec = {
    schema_version: "2.0",
    encoding: "propositions+fingerprint",
    persona: { id: persona.id, name: persona.name },
    pack_version: version,
    generated_date: new Date().toISOString(),
    values_ranked: values,
    decision_heuristics: heuristics,
    fingerprint: { spoken, written },
    exemplars,
    indexes,
    voice: { voice_id: persona.voiceId, engine: persona.voiceId?.startsWith("elevenlabs:") ? "elevenlabs" : "f5-tts-mlx" },
    model_binding: persona.modelBinding,
    counts: { propositions_private: nPriv, propositions_public: nPub, voice_minutes: Math.round(voiceMinutes * 10) / 10 },
    anti_parrot: {
      register_firewall: true,
      copy_flag_ngram: 8,
      marker_rates_are_targets_not_quotas: true,
    },
  };
  // Public spec: no private index ids, exemplars only if their sources were public…
  // exemplars are curated style material; per design they carry no answer
  // material, but the PUBLIC pack still must not leak private text — filter to
  // exemplars from public sources is impossible post-hoc (origin kept in file),
  // so the public variant ships fingerprint-only voice with written exemplars
  // marked public-safe: currently all corpus is private, so public pack ships
  // WITHOUT exemplars until public-sensitivity text exists.
  const publicExemplars: Exemplar[] = [];
  const publicSpec = {
    ...spec,
    exemplars: publicExemplars,
    indexes: { public_index_id: indexes.public_index_id, episodic_public: indexes.episodic_public },
  };

  const dir = path.join(PACKS_DIR(), persona.id, `v${version}`);
  fs.mkdirSync(path.join(dir, "private"), { recursive: true });
  fs.mkdirSync(path.join(dir, "public"), { recursive: true });
  const outputs: Record<string, string> = {
    "private/persona-spec.json": JSON.stringify(spec, null, 2),
    "private/SKILL.md": mkVariant("private", "written"),
    "private/SKILL.spoken.md": mkVariant("private", "spoken"),
    "public/persona-spec.json": JSON.stringify(publicSpec, null, 2),
    "public/SKILL.md": renderSkillMdV2({
      name: persona.name,
      core: renderPersonaCore({ name: persona.name, values, heuristics, fingerprint: written, mode: "written" }),
      contract: renderResponseContract({ name: persona.name, voiceNote: false }),
      exemplarsBlock: "",
      variant: "public",
      indexes,
      version,
    }),
  };
  const checksums: Record<string, string> = {};
  for (const [rel, content] of Object.entries(outputs)) {
    fs.writeFileSync(path.join(dir, rel), content);
    checksums[rel] = createHash("sha256").update(content).digest("hex");
  }
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ persona_id: persona.id, version, encoding: "v2", files: checksums }, null, 2)
  );
  await prisma.persona.update({ where: { id: persona.id }, data: { packVersion: version } });

  if (opts.installHermes) {
    const skillMd = mkVariant("private", "written");
    // Refresh any installed persona skill variants for the configured profile.
    const skillNames = (process.env.HERMES_PERSONA_SKILLS ?? "persona,persona-fast").split(",").map((s) => s.trim());
    for (const name of skillNames) {
      const skillDir = path.join(os.homedir(), ".hermes", "profiles", process.env.HERMES_PROFILE ?? "default", "skills", name);
      if (fs.existsSync(skillDir)) {
        fs.writeFileSync(
          path.join(skillDir, "skill.md"),
          skillMd +
            `\n\nInput: JSON with { "message": string, "history": optional string }.\nOutput: ${persona.name}'s reply only — no preamble, no JSON wrapper.\n(Note: this runtime has no retrieval; answer from the core above.)\n`
        );
      }
    }
  }

  return { version, dir, files: checksums };
}
