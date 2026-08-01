/**
 * The Alter curriculum — single source of truth.
 *
 * Four modules ordered by information gain toward earliest usefulness:
 * a thin identity spine first (voice + values + decision habits), then
 * communication situations (grounds the email-drafting bar; real artifacts
 * beat description), then work & craft, then interests. The eight sealed
 * validation questions are unchanged and quarantined.
 *
 * Consumed by:
 *   prisma/seed.ts          — fresh installs get the full new order
 *   src/curriculum/cli.ts   — idempotent migration for a live DB (answered
 *                             questions keep their data; trimmed ones are
 *                             deactivated, never deleted)
 *   moduleCoverage()        — the progress meter, per module
 */

export const MODULES = [
  { key: "identity-values", label: "Identity & values" },
  { key: "communication", label: "Communication situations" },
  { key: "work-craft", label: "Work & craft" },
  { key: "interests", label: "Interests & passions" },
  { key: "validation", label: "Validation (held out)" },
] as const;

export type ModuleKey = (typeof MODULES)[number]["key"];

export interface CurriculumQuestion {
  text: string;
  module: ModuleKey;
  artifactInvite?: boolean;
}

/** New questions introduced by the rebalance (2026-07-28). */
export const NEW_QUESTIONS: CurriculumQuestion[] = [
  // ── Communication situations: 10 questions + 3 artifact invitations ──
  { module: "communication", text: "How do you typically open and close an email? Any phrases you reach for again and again — greetings, sign-offs, the way you get to the point?" },
  { module: "communication", text: "Someone asks you for something you don't have time for. Say no to them, out loud, the way you actually would — then tell me about a real time you had to." },
  { module: "communication", text: "How do you disagree with someone senior to you? And how is that different from how you'd push back on a peer?" },
  { module: "communication", text: "Walk me through delivering bad news — a project slipping, a mistake that was yours. What do you say first, and what do you refuse to say?" },
  { module: "communication", text: "What does your praise sound like? Say what you'd actually tell someone who just did genuinely great work." },
  { module: "communication", text: "How do you chase someone who owes you something — a reply, a decision, a deliverable — without souring the relationship? Give me the actual words." },
  { module: "communication", text: "How does your tone shift between a close colleague, your boss, and a stranger you're writing to cold? Show me the same request in each register if you can." },
  { module: "communication", text: "How do you ask for help when you're genuinely stuck? What do you say, and what do you make sure to include?" },
  { module: "communication", text: "How do you apologize when you got something wrong? Talk me through a real one if you're willing." },
  { module: "communication", text: "What communication habits in other people annoy you — in email, in meetings, in chat — and what do you do instead?" },
  { module: "communication", artifactInvite: true, text: "Upload two or three real emails you're proud of — ones where the tone came out exactly right. Demonstrated style beats described style. (Drop the files here or paste the text; names and addresses get redacted at ingest.)" },
  { module: "communication", artifactInvite: true, text: "Upload something formal you've written — a proposal, a report, a letter that had to be official." },
  { module: "communication", artifactInvite: true, text: "Upload something casual — a chat thread, an informal note, anything written in your relaxed voice." },

  // ── Work & craft: 7 new (join the 5 kept from the original set) ──
  { module: "work-craft", text: "Describe an ordinary working day, start to finish — the real one, not the ideal one. Where does the time actually go?" },
  { module: "work-craft", text: "What decisions do you make over and over in your work? Pick one and walk me through how you actually make it." },
  { module: "work-craft", text: "Which parts of your job do you love, and which do you quietly dread? Be specific about both." },
  { module: "work-craft", text: "Who do you answer to, and who answers to you? How do those relationships actually work day to day — not the org chart, the reality." },
  { module: "work-craft", text: "What does genuinely good work look like in your field, in your own words? What separates it from merely acceptable work?" },
  { module: "work-craft", text: "What are you working on right now? What state is it in, and what's blocking it?" },
  { module: "work-craft", text: "When you look at someone else's work in your field, what do you check first to judge whether they're good?" },

  // ── Interests & passions: 7 new (join one kept take question) ──
  { module: "interests", text: "What do you read, watch, or follow regularly? What do you never miss, and why that?" },
  { module: "interests", text: "What topic could you happily talk about for an hour with zero preparation? Prove it — give me the first five minutes." },
  { module: "interests", text: "What are you learning right now, or itching to learn next? What's drawing you to it?" },
  { module: "interests", text: "What did you love as a teenager that you still care about today? What survived and what didn't?" },
  { module: "interests", text: "What do you collect, practice, or tinker with? What does the time you sink into it give you back?" },
  { module: "interests", text: "What's a take you hold about your field or a hobby that gets pushback? Make the case for it." },
  { module: "interests", text: "If work vanished tomorrow, what would fill your weeks within a month? Be honest, not aspirational." },
];

/**
 * Live-DB migration map for the ORIGINAL 70-question deployment: orderIndex →
 * module + active. Answered data is never touched; trimmed questions are
 * deactivated (out of the meter and future interviews, still in the corpus).
 * `expect` guards against applying to a reordered database.
 */
export const EXISTING_ASSIGNMENTS: {
  orderIndex: number;
  expect: string; // promptText prefix guard
  module: ModuleKey;
  active: boolean;
}[] = [
  // A. Warm-up
  { orderIndex: 0, expect: "Introduce yourself", module: "identity-values", active: true },
  { orderIndex: 1, expect: "Describe the room", module: "identity-values", active: false },
  { orderIndex: 2, expect: "Walk me through what a typical Tuesday", module: "identity-values", active: false },
  { orderIndex: 3, expect: "What did you have for your last meal", module: "identity-values", active: false },
  { orderIndex: 4, expect: "If a friend called you right now", module: "identity-values", active: true },
  // B. Life story
  { orderIndex: 8, expect: "Tell me about where you grew up", module: "identity-values", active: true },
  { orderIndex: 9, expect: "Describe a moment from your childhood", module: "identity-values", active: false },
  { orderIndex: 10, expect: "What was a fork in the road", module: "identity-values", active: true },
  { orderIndex: 11, expect: "Tell me about a period of your life that was genuinely hard", module: "identity-values", active: true },
  { orderIndex: 12, expect: "What is something you have done that you are quietly proud", module: "identity-values", active: false },
  { orderIndex: 13, expect: "How are you different from the person you were ten years ago", module: "identity-values", active: true },
  // C. Values and beliefs
  { orderIndex: 17, expect: "What is something you believe that most people", module: "identity-values", active: true },
  { orderIndex: 18, expect: "What makes you lose respect", module: "identity-values", active: true },
  { orderIndex: 19, expect: "Describe a time you changed your mind", module: "identity-values", active: true },
  { orderIndex: 20, expect: "What do you think makes a life well lived", module: "identity-values", active: true },
  { orderIndex: 21, expect: "When you have to make a big decision", module: "identity-values", active: true },
  // D. Relationships and social life
  { orderIndex: 25, expect: "Describe your closest friend", module: "identity-values", active: false },
  { orderIndex: 26, expect: "What role do you tend to play in a group", module: "identity-values", active: true },
  { orderIndex: 27, expect: "Tell me about a conflict you had", module: "identity-values", active: false },
  { orderIndex: 28, expect: "What do people misunderstand about you", module: "identity-values", active: true },
  { orderIndex: 29, expect: "How do you show someone you care", module: "identity-values", active: false },
  // E. Work and ambition — all five join work-craft
  { orderIndex: 33, expect: "Explain what you do for work", module: "work-craft", active: true },
  { orderIndex: 34, expect: "Tell me about a project or piece of work you consider your best", module: "work-craft", active: true },
  { orderIndex: 35, expect: "Describe a failure at work", module: "work-craft", active: true },
  { orderIndex: 36, expect: "What would you work on if money", module: "work-craft", active: true },
  { orderIndex: 37, expect: "What does ambition mean to you", module: "work-craft", active: true },
  // F. Emotions and stress
  { orderIndex: 40, expect: "What does stress feel like", module: "identity-values", active: false },
  { orderIndex: 41, expect: "Tell me about the last time you were really angry", module: "identity-values", active: false },
  { orderIndex: 42, expect: "What reliably makes you laugh", module: "identity-values", active: false },
  { orderIndex: 43, expect: "When you are sad or low", module: "identity-values", active: false },
  { orderIndex: 44, expect: "Describe a moment recently when you felt completely at ease", module: "identity-values", active: false },
  // G. Habits, tastes and everyday life
  { orderIndex: 47, expect: "Describe your ideal Saturday", module: "identity-values", active: false },
  { orderIndex: 48, expect: "What is a strong opinion you hold about food, music", module: "interests", active: true },
  { orderIndex: 49, expect: "What small daily ritual", module: "identity-values", active: false },
  { orderIndex: 50, expect: "What do you do when you can't sleep", module: "identity-values", active: false },
  { orderIndex: 51, expect: "Tell me about something you own that you would never sell", module: "identity-values", active: false },
  // H. Self-reflection and future
  { orderIndex: 54, expect: "What is a flaw of yours", module: "identity-values", active: true },
  { orderIndex: 55, expect: "What compliment do you receive most often", module: "identity-values", active: false },
  { orderIndex: 56, expect: "What are you avoiding right now", module: "identity-values", active: false },
  { orderIndex: 57, expect: "Where do you hope to be in ten years", module: "identity-values", active: false },
  { orderIndex: 58, expect: "If you could send one sentence back to yourself", module: "identity-values", active: false },
  { orderIndex: 59, expect: "What do you want people to say about you", module: "identity-values", active: true },
];

/** Sealed validation questions live at orderIndex 62-69 in the original
 * deployment; they are assigned module "validation" and never touched
 * otherwise. The Likert inventory (Mini-IPIP) is assigned identity-values. */

/** Full texts of kept questions, for FRESH installs (the live-DB migration
 * uses EXISTING_ASSIGNMENTS instead and never rewrites prompt text). */
export const KEPT_QUESTIONS: CurriculumQuestion[] = [
  { module: "identity-values", text: "Introduce yourself the way you would to someone interesting you just met at a small dinner party — name, what you do, and whatever else feels natural." },
  { module: "identity-values", text: 'If a friend called you right now and asked "how are you, really?" — what would you actually say?' },
  { module: "identity-values", text: "Tell me about where you grew up and what kind of kid you were." },
  { module: "identity-values", text: "What was a fork in the road in your life — a decision that could have gone another way — and how did you choose?" },
  { module: "identity-values", text: "Tell me about a period of your life that was genuinely hard, and how you got through it." },
  { module: "identity-values", text: "How are you different from the person you were ten years ago?" },
  { module: "identity-values", text: "What is something you believe that most people around you disagree with?" },
  { module: "identity-values", text: "What makes you lose respect for someone almost instantly?" },
  { module: "identity-values", text: "Describe a time you changed your mind about something important. What moved you?" },
  { module: "identity-values", text: "What do you think makes a life well lived?" },
  { module: "identity-values", text: "When you have to make a big decision, what do you actually do — walk me through your process with a real example." },
  { module: "identity-values", text: "What role do you tend to play in a group — at work, in your family, among friends?" },
  { module: "identity-values", text: "What do people misunderstand about you when they first meet you?" },
  { module: "identity-values", text: "What is a flaw of yours that you have made peace with, and one you are still fighting?" },
  { module: "identity-values", text: "What do you want people to say about you when you are not in the room?" },
  { module: "work-craft", text: "Explain what you do for work as if to a curious twelve-year-old, and tell me whether you actually enjoy it." },
  { module: "work-craft", text: "Tell me about a project or piece of work you consider your best. What made it good?" },
  { module: "work-craft", text: "Describe a failure at work or on a project — what happened, and what did you do next?" },
  { module: "work-craft", text: "What would you work on if money were completely irrelevant?" },
  { module: "work-craft", text: "What does ambition mean to you, and how much of it do you have?" },
  { module: "interests", text: "What is a strong opinion you hold about food, music, or entertainment? Defend it." },
];

/** The eight sealed validation questions (generic, no personal data — safe to
 * ship). Asked last; excluded from every ingestion path by id + content hash. */
export const VALIDATION_QUESTIONS: string[] = [
  "A close friend calls you and says they just lost their job. What do you say to them, word for word?",
  "Someone cuts in front of you in a long line. What goes through your head, and what do you actually do?",
  "You have a completely free evening alone at home. Narrate what you actually end up doing.",
  "Explain to a skeptical stranger why your favorite hobby or interest is worth their time.",
  "You wake up to an email saying you have received ten thousand dollars, no strings attached. Talk through what you do with it.",
  "A younger colleague asks you for the single most important piece of career advice you have. What do you tell them?",
  "Describe your perfect meal — where you are, who is there, what is served — in as much sensory detail as you can.",
  "You have thirty seconds in an elevator to convince someone to read your favorite book or watch your favorite film. Go.",
];

export interface ModuleCoverage {
  key: ModuleKey;
  label: string;
  total: number;
  answered: number;
  pct: number;
}

import type { PrismaClient } from "@prisma/client";

/** The progress meter: per-module coverage over ACTIVE questions. */
export async function moduleCoverage(prisma: PrismaClient): Promise<ModuleCoverage[]> {
  const rows = await prisma.$queryRawUnsafe<
    { module: string | null; total: bigint; answered: bigint }[]
  >(
    `SELECT q.module,
            COUNT(*) AS total,
            COUNT(*) FILTER (
              WHERE EXISTS (
                SELECT 1 FROM "Response" r
                WHERE r."questionId" = q.id AND r.skipped = false
                  AND (r."audioPath" IS NOT NULL OR r."likertValue" IS NOT NULL OR r.transcript IS NOT NULL)
              )
            ) AS answered
     FROM "Question" q
     WHERE q.active = true
     GROUP BY q.module`
  );
  const byKey = new Map(rows.map((r) => [r.module, r]));
  return MODULES.map((m) => {
    const r = byKey.get(m.key);
    const total = Number(r?.total ?? 0);
    const answered = Number(r?.answered ?? 0);
    return { key: m.key, label: m.label, total, answered, pct: total ? Math.round((answered / total) * 100) : 0 };
  });
}

export function renderMeter(cov: ModuleCoverage[]): string {
  return cov
    .filter((c) => c.key !== "validation")
    .map((c) => `${c.label}: ${c.answered}/${c.total} (${c.pct}%)`)
    .join(" · ");
}
