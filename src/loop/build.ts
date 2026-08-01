import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";

/**
 * In-process persona synthesis — the same sequence as `understudy rebuild`
 * (which lives in the CLI and self-executes on import, so the adapter can't
 * import it). Used by the interview's auto-build-at-threshold.
 */
export async function synthesizePersona(
  personaId: string,
  personaName: string
): Promise<{ version: number }> {
  const { distill } = await import("@/persona2/distill");
  const { reflect } = await import("@/persona2/reflect");
  const { buildFingerprint } = await import("@/persona2/fingerprint");
  const { curateExemplars } = await import("@/persona2/exemplars");
  const { buildSkillPackV2 } = await import("@/persona2/skillgen");

  await distill(personaId, {}); // idempotent: skips already-distilled origins
  await reflect(personaId, {});
  const fp = await buildFingerprint(personaId);
  await prisma.styleFingerprint.upsert({
    where: { personaId },
    create: { personaId, spoken: fp.spoken as unknown as object, written: fp.written as unknown as object },
    update: { spoken: fp.spoken as unknown as object, written: fp.written as unknown as object },
  });
  const bank = await curateExemplars(personaId);
  const dir = path.join(process.cwd(), "corpus", "persona2", personaId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "exemplars.json"), JSON.stringify(bank, null, 2));
  const pack = await buildSkillPackV2(personaId, {});
  return { version: pack.version };
}
