import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { runChatTurn } from "@/loop/runtime";
import { improvementLlm, parseJson } from "@/loop/llm";

/**
 * Evaluation battery — written into the test, not left to vibes.
 *
 *  sealed:   re-run the eight sealed questions on the persona; emit
 *            (a) the blind discrimination sheet (real vs persona, shuffled,
 *                answer key separate),
 *            (b) Burrows's Delta + copy metrics (via the drift spot-check),
 *            (c) decision agreement — an LLM judgment of whether each persona
 *                answer lands the same substantive position/decision as the
 *                real answer, for the owner to audit.
 *  battery:  ten utility tasks — eight fixed + every real forwarded email
 *            dropped in eval/inbox/*.txt ("reply to this") — rendered as an
 *            owner scoring sheet (1-5 per task).
 * Output under eval/.
 */

const EVAL_DIR = () => path.join(process.cwd(), "eval");

async function personaAnswer(personaId: string, personaName: string, q: string): Promise<string> {
  const turn = await runChatTurn({
    personaId,
    personaName,
    channel: "playground",
    conversationId: `eval-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`,
    message: q,
    userEventId: (
      await prisma.updateEvent.create({
        data: {
          personaId, channel: "playground", conversationId: "eval", kind: "text",
          rawText: q, intent: "chat", intentSource: "hint", status: "none_needed",
        },
      })
    ).id,
    history: [],
    mode: "written",
  });
  return turn.reply;
}

const AGREEMENT_SYSTEM = `You judge whether two answers to the same personal question take the SAME substantive position or decision — not whether they share wording. Output STRICT JSON: {"agrees": true|false, "rationale": str}. Judge substance only: same advice, same choice, same stance. Different anecdotes with the same underlying position still agree.`;

export async function evalSealed(personaId: string, personaName: string): Promise<string> {
  const sealed = await prisma.question.findMany({
    where: { isValidation: true },
    orderBy: { orderIndex: "asc" },
  });
  const rows: { q: string; real: string; persona: string; agrees: boolean | null; rationale: string }[] = [];
  for (const q of sealed) {
    const real = (
      await prisma.response.findFirst({
        where: { questionId: q.id, transcript: { not: null } },
        orderBy: { createdAt: "desc" },
      })
    )?.transcript;
    if (!real) continue;
    const persona = await personaAnswer(personaId, personaName, q.promptText);
    let agrees: boolean | null = null;
    let rationale = "";
    try {
      const raw = await improvementLlm()(
        AGREEMENT_SYSTEM,
        `Question: ${q.promptText}\n\nAnswer A (the real person, spoken):\n"""${real.slice(0, 1500)}"""\n\nAnswer B (persona):\n"""${persona.slice(0, 1500)}"""`
      );
      const j = parseJson<{ agrees: boolean; rationale: string }>(raw);
      agrees = Boolean(j.agrees);
      rationale = j.rationale ?? "";
    } catch {
      /* judged manually via the sheet */
    }
    rows.push({ q: q.promptText, real, persona, agrees, rationale });
  }

  fs.mkdirSync(EVAL_DIR(), { recursive: true });

  // Blind discrimination sheet: A/B shuffled per item; key kept separate.
  const key: string[] = [];
  const sheet = rows
    .map((r, i) => {
      const personaFirst = Math.random() < 0.5;
      key.push(`${i + 1}: real = ${personaFirst ? "B" : "A"}`);
      const [a, b] = personaFirst ? [r.persona, r.real] : [r.real, r.persona];
      return `## ${i + 1}. ${r.q}\n\n**A.** ${a}\n\n**B.** ${b}\n\n_Which is the real ${personaName}? A / B / cannot tell_\n`;
    })
    .join("\n---\n\n");
  fs.writeFileSync(
    path.join(EVAL_DIR(), "blind-sheet.md"),
    `# Blind discrimination sheet — ${new Date().toISOString().slice(0, 10)}\nLabel each item, THEN open blind-sheet-key.md. Near-50% accuracy means the persona is indistinguishable.\n\n${sheet}`
  );
  fs.writeFileSync(path.join(EVAL_DIR(), "blind-sheet-key.md"), key.join("\n") + "\n");

  const agreed = rows.filter((r) => r.agrees === true).length;
  const judged = rows.filter((r) => r.agrees !== null).length;
  const report = [
    `# Sealed-question report — ${new Date().toISOString().slice(0, 10)}`,
    ``,
    `Decision agreement: ${agreed}/${judged} judged agreements (audit each below; the metric is substance, not wording).`,
    ``,
    ...rows.map(
      (r, i) =>
        `## ${i + 1}. ${r.q}\n- agreement: **${r.agrees === null ? "unjudged" : r.agrees ? "AGREES" : "DIFFERS"}** — ${r.rationale}\n- real: ${r.real.slice(0, 300)}…\n- persona: ${r.persona.slice(0, 300)}…\n`
    ),
  ].join("\n");
  const p = path.join(EVAL_DIR(), "sealed-report.md");
  fs.writeFileSync(p, report);
  return p;
}

const FIXED_TASKS: string[] = [
  "Draft a short LinkedIn-style post announcing something you shipped recently. Your real voice, not marketing voice.",
  "A colleague asks, in chat, whether they should take a counter-offer from their current employer or leave. Answer them.",
  "Write the opening two paragraphs of a proposal arguing for a tool or approach you genuinely believe in.",
  "Someone you respect published something you think is wrong. Draft the comment you would actually leave.",
  "Summarize your professional background in five sentences for someone considering hiring you.",
  "A friend asks what you honestly think about AI taking over creative work. Give them your real take.",
  "Write a short note declining an invitation to speak at an event — you're interested but genuinely too busy.",
  "Draft a message chasing an overdue invoice from a client you like and want to keep.",
];

export async function evalBattery(personaId: string, personaName: string): Promise<string> {
  const inboxDir = path.join(EVAL_DIR(), "inbox");
  fs.mkdirSync(inboxDir, { recursive: true });
  const emails = fs
    .readdirSync(inboxDir)
    .filter((f) => f.endsWith(".txt"))
    .map((f) => ({ name: f, body: fs.readFileSync(path.join(inboxDir, f), "utf8") }));

  const tasks: { label: string; prompt: string }[] = [
    ...emails.map((e) => ({
      label: `email-reply: ${e.name}`,
      prompt: `The following email was forwarded to you. Reply to it as yourself — your position, tone, and phrasing.\n\n"""${e.body.slice(0, 4000)}"""`,
    })),
    ...FIXED_TASKS.map((t, i) => ({ label: `task-${i + 1}`, prompt: t })),
  ].slice(0, Math.max(10, emails.length + 8));

  const out: string[] = [
    `# Utility battery — ${new Date().toISOString().slice(0, 10)}`,
    ``,
    `Score each 1-5: “Is this recognizably me — position, tone, phrasing — needing only light corrections?”`,
    `Email-reply tasks are the bar that matters most. ${emails.length === 0 ? "\n> No forwarded emails found in eval/inbox/*.txt — drop at least two real ones and re-run for the full battery." : ""}`,
    ``,
  ];
  for (const t of tasks) {
    const reply = await personaAnswer(personaId, personaName, t.prompt);
    out.push(`## ${t.label}\n\n> ${t.prompt.split("\n")[0].slice(0, 140)}\n\n${reply}\n\n**Score (1-5): ____**  Corrections:\n\n---\n`);
  }
  const p = path.join(EVAL_DIR(), "utility-battery.md");
  fs.writeFileSync(p, out.join("\n"));
  return p;
}
