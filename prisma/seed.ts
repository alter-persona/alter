/**
 * Seed for FRESH installs: builds the full Understudy curriculum (v2,
 * four modules ordered by information gain) from src/curriculum/curriculum.ts.
 * No external file needed. The Mini-IPIP (Donnellan, Oberauer, Baird & Lucas,
 * 2006; public-domain, ipip.ori.org) interleaves with module 1.
 *
 * Existing deployments do NOT re-seed — they run `npm run curriculum -- apply`,
 * which migrates a live database without touching answered data.
 */
import { PrismaClient, QuestionType, OceanDomain } from "@prisma/client";
import {
  MODULES,
  KEPT_QUESTIONS,
  NEW_QUESTIONS,
  VALIDATION_QUESTIONS,
  type CurriculumQuestion,
} from "../src/curriculum/curriculum";

const prisma = new PrismaClient();

interface LikertItem {
  text: string;
  domain: OceanDomain;
  reverse: boolean;
}

const LIKERT_ITEMS: LikertItem[] = [
  { text: "Am the life of the party.", domain: "E", reverse: false },
  { text: "Sympathize with others' feelings.", domain: "A", reverse: false },
  { text: "Get chores done right away.", domain: "C", reverse: false },
  { text: "Have frequent mood swings.", domain: "N", reverse: false },
  { text: "Have a vivid imagination.", domain: "O", reverse: false },
  { text: "Don't talk a lot.", domain: "E", reverse: true },
  { text: "Am not interested in other people's problems.", domain: "A", reverse: true },
  { text: "Often forget to put things back in their proper place.", domain: "C", reverse: true },
  { text: "Am relaxed most of the time.", domain: "N", reverse: true },
  { text: "Am not interested in abstract ideas.", domain: "O", reverse: true },
  { text: "Talk to a lot of different people at parties.", domain: "E", reverse: false },
  { text: "Feel others' emotions.", domain: "A", reverse: false },
  { text: "Like order.", domain: "C", reverse: false },
  { text: "Get upset easily.", domain: "N", reverse: false },
  { text: "Have difficulty understanding abstract ideas.", domain: "O", reverse: true },
  { text: "Keep in the background.", domain: "E", reverse: true },
  { text: "Am not really interested in others.", domain: "A", reverse: true },
  { text: "Make a mess of things.", domain: "C", reverse: true },
  { text: "Seldom feel blue.", domain: "N", reverse: true },
  { text: "Do not have a good imagination.", domain: "O", reverse: true },
];

const LIKERT_SECTION = "Personality inventory";

async function main() {
  const responseCount = await prisma.response.count();
  if (responseCount > 0 && process.env.FORCE_RESEED !== "1") {
    console.error(
      `Seed aborted: ${responseCount} responses already exist and re-seeding would\n` +
        `orphan them. This database should migrate instead:\n  npm run curriculum -- apply\n` +
        `(FORCE_RESEED=1 wipes questions AND responses; \`npm run db:reset\` for a clean slate.)`
    );
    process.exit(1);
  }
  if (responseCount > 0) await prisma.response.deleteMany();
  await prisma.question.deleteMany();

  type Row = {
    orderIndex: number;
    section: string;
    type: QuestionType;
    promptText: string;
    oceanDomain: OceanDomain | null;
    facet: string | null;
    reverseScored: boolean;
    isValidation: boolean;
    module: string;
    active: boolean;
    artifactInvite: boolean;
  };

  const rows: Row[] = [];
  let order = 0;
  const label = (key: string) => MODULES.find((m) => m.key === key)!.label;

  const pushVoice = (q: CurriculumQuestion) =>
    rows.push({
      orderIndex: order++,
      section: label(q.module),
      type: "voice",
      promptText: q.text,
      oceanDomain: null,
      facet: null,
      reverseScored: false,
      isValidation: false,
      module: q.module,
      active: true,
      artifactInvite: q.artifactInvite ?? false,
    });

  // Module 1: identity spine with the IPIP interleaved every 4 voice questions.
  const identity = KEPT_QUESTIONS.filter((q) => q.module === "identity-values");
  let likertCursor = 0;
  identity.forEach((q, i) => {
    pushVoice(q);
    if ((i + 1) % 3 === 0) {
      const batch = LIKERT_ITEMS.slice(likertCursor, likertCursor + 4);
      likertCursor += batch.length;
      for (const item of batch) {
        rows.push({
          orderIndex: order++,
          section: LIKERT_SECTION,
          type: "likert",
          promptText: item.text,
          oceanDomain: item.domain,
          facet: null,
          reverseScored: item.reverse,
          isValidation: false,
          module: "identity-values",
          active: true,
          artifactInvite: false,
        });
      }
    }
  });
  for (const item of LIKERT_ITEMS.slice(likertCursor)) {
    rows.push({
      orderIndex: order++,
      section: LIKERT_SECTION,
      type: "likert",
      promptText: item.text,
      oceanDomain: item.domain,
      facet: null,
      reverseScored: item.reverse,
      isValidation: false,
      module: "identity-values",
      active: true,
      artifactInvite: false,
    });
  }

  // Modules 2-4 in usefulness order: communication, then work (kept + new),
  // then interests (kept + new).
  for (const q of NEW_QUESTIONS.filter((q) => q.module === "communication")) pushVoice(q);
  for (const q of KEPT_QUESTIONS.filter((q) => q.module === "work-craft")) pushVoice(q);
  for (const q of NEW_QUESTIONS.filter((q) => q.module === "work-craft")) pushVoice(q);
  for (const q of KEPT_QUESTIONS.filter((q) => q.module === "interests")) pushVoice(q);
  for (const q of NEW_QUESTIONS.filter((q) => q.module === "interests")) pushVoice(q);

  // Sealed validation, at the very end.
  for (const text of VALIDATION_QUESTIONS) {
    rows.push({
      orderIndex: order++,
      section: label("validation"),
      type: "voice",
      promptText: text,
      oceanDomain: null,
      facet: null,
      reverseScored: false,
      isValidation: true,
      module: "validation",
      active: true,
      artifactInvite: false,
    });
  }

  await prisma.question.createMany({ data: rows });
  const voice = rows.filter((r) => r.type === "voice" && !r.isValidation).length;
  console.log(
    `Seeded ${rows.length} questions: ${voice} voice across 4 modules, ` +
      `${LIKERT_ITEMS.length} Likert (Mini-IPIP), ${VALIDATION_QUESTIONS.length} sealed validation.`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
