import "@/lib/loadEnv";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import {
  MODULES,
  NEW_QUESTIONS,
  EXISTING_ASSIGNMENTS,
  moduleCoverage,
  renderMeter,
} from "./curriculum";

/**
 * Curriculum CLI:
 *   npm run curriculum -- apply    idempotent live-DB migration to the
 *                                  4-module curriculum (assigns modules,
 *                                  deactivates trims, inserts new questions;
 *                                  answered data is never touched)
 *   npm run curriculum -- status   the per-module progress meter
 *   npm run curriculum -- md       regenerate voice-personality-intake.md
 *                                  as human-readable documentation
 */

async function apply(): Promise<void> {
  let assigned = 0;
  let skippedGuard = 0;
  for (const a of EXISTING_ASSIGNMENTS) {
    const q = await prisma.question.findUnique({ where: { orderIndex: a.orderIndex } });
    if (!q || !q.promptText.startsWith(a.expect)) {
      skippedGuard++;
      continue; // reordered/unknown DB — leave untouched
    }
    await prisma.question.update({
      where: { id: q.id },
      data: { module: a.module, active: a.active },
    });
    assigned++;
  }

  // Likert inventory → identity-values; sealed validation → validation module.
  await prisma.question.updateMany({
    where: { type: "likert", module: null },
    data: { module: "identity-values" },
  });
  await prisma.question.updateMany({
    where: { isValidation: true },
    data: { module: "validation" },
  });

  // Insert new questions (idempotent on promptText), appended after the
  // current maximum orderIndex so existing ids/answers are undisturbed.
  const maxRow = await prisma.question.findFirst({ orderBy: { orderIndex: "desc" } });
  let next = (maxRow?.orderIndex ?? -1) + 1;
  let inserted = 0;
  for (const nq of NEW_QUESTIONS) {
    const exists = await prisma.question.findFirst({ where: { promptText: nq.text } });
    if (exists) {
      // Re-affirm module/flags in case of edits.
      await prisma.question.update({
        where: { id: exists.id },
        data: { module: nq.module, artifactInvite: nq.artifactInvite ?? false, active: true },
      });
      continue;
    }
    const label = MODULES.find((m) => m.key === nq.module)!.label;
    await prisma.question.create({
      data: {
        orderIndex: next++,
        section: label,
        type: "voice",
        promptText: nq.text,
        module: nq.module,
        artifactInvite: nq.artifactInvite ?? false,
        isValidation: false,
      },
    });
    inserted++;
  }

  console.log(
    `[curriculum] assigned ${assigned} existing (guard-skipped ${skippedGuard}), inserted ${inserted} new questions.`
  );
  console.log(`[curriculum] ${renderMeter(await moduleCoverage(prisma))}`);
}

function toMarkdown(): string {
  const byModule = new Map<string, typeof NEW_QUESTIONS>();
  for (const q of NEW_QUESTIONS) {
    byModule.set(q.module, [...(byModule.get(q.module) ?? []), q]);
  }
  const keeps = EXISTING_ASSIGNMENTS.filter((a) => a.active);
  return `# Alter intake curriculum (v2, 2026-07-28)

Four modules, ordered by information gain toward earliest usefulness. The
Mini-IPIP 20-item inventory interleaves with module 1. The eight validation
questions are sealed: asked last, never ingested, used only for evaluation.

## 1. Identity & values
Kept from the original McAdams-derived set (highest-information):
${keeps
  .filter((a) => a.module === "identity-values")
  .map((a) => `- ${a.expect}…`)
  .join("\n")}

## 2. Communication situations
${(byModule.get("communication") ?? [])
  .map((q, i) => `${i + 1}. ${q.artifactInvite ? "📎 " : ""}${q.text}`)
  .join("\n")}

## 3. Work & craft
Kept: ${keeps.filter((a) => a.module === "work-craft").map((a) => `${a.expect}…`).join(" · ")}
New:
${(byModule.get("work-craft") ?? []).map((q, i) => `${i + 1}. ${q.text}`).join("\n")}

## 4. Interests & passions
Kept: ${keeps.filter((a) => a.module === "interests").map((a) => `${a.expect}…`).join(" · ")}
New:
${(byModule.get("interests") ?? []).map((q, i) => `${i + 1}. ${q.text}`).join("\n")}

## Validation (sealed, unchanged)
Eight questions, quarantined by id and content hash from every ingestion path.
`;
}

async function main(): Promise<void> {
  const cmd = process.argv.slice(2).filter((a) => a !== "--")[0];
  if (cmd === "apply") await apply();
  else if (cmd === "status") console.log(renderMeter(await moduleCoverage(prisma)));
  else if (cmd === "md") {
    const p = path.join(process.cwd(), "voice-personality-intake.md");
    fs.writeFileSync(p, toMarkdown());
    console.log(`[curriculum] wrote ${p}`);
  } else {
    console.log("usage: npm run curriculum -- apply|status|md");
    process.exit(1);
  }
  await prisma.$disconnect();
}

void main();
