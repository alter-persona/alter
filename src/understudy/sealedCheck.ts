import "@/lib/loadEnv";
import fs from "node:fs";
import { prisma } from "@/lib/db";

/** Standalone sealed-quarantine proof: run with
 *  npx tsx src/understudy/sealedCheck.ts  */
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

async function main() {
  const name = process.env.UNDERSTUDY_NAME ?? "You";
  const p = await prisma.persona.findUnique({ where: { name } });
  if (!p) throw new Error(`persona ${name} not found`);
  const sealedRows = await prisma.response.findMany({
    where: { question: { isValidation: true }, transcript: { not: null } },
    select: { transcript: true },
  });
  let checked = 0;
  for (const s of sealedRows) {
    const probe = norm(s.transcript!).slice(0, 80).replace(/[%_]/g, "");
    if (probe.length < 40) continue;
    checked++;
    for (const table of ["VectorChunkPrivate", "VectorChunkPublic", "PropositionPrivate", "PropositionPublic"]) {
      const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(*) AS n FROM "${table}" WHERE "personaId" = $1 AND LOWER(REGEXP_REPLACE(text, '\\s+', ' ', 'g')) LIKE $2`,
        p.id,
        `%${probe}%`
      );
      if (Number(rows[0].n) > 0) throw new Error(`SEALED LEAK in ${table}`);
    }
  }
  console.log(`sealed quarantine verified: ${checked} answers absent from all 4 stores`);
  const exPath = `corpus/persona2/${p.id}/exemplars.json`;
  if (fs.existsSync(exPath)) {
    const ex = JSON.parse(fs.readFileSync(exPath, "utf8")) as { mode: string }[];
    console.log(`exemplars: ${ex.length} | spoken: ${ex.filter((e) => e.mode === "spoken").length}`);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(String(e).slice(0, 300));
  process.exit(1);
});
