import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { getTtsProvider, stripUnsupportedTags } from "@/lib/tts";

/**
 * Stage 5: blinded A/B pairs — same sentence rendered by ElevenLabs and by
 * the local voice, position randomized per pair. 16 sentences, half formal,
 * half conversational, drawn from real persona replies, none from the
 * training set (they're generated replies, not corpus text).
 */

export const AB_SENTENCES: { text: string; register: "formal" | "conversational" }[] = [
  { text: "The decision comes down to exit cost, not features.", register: "formal" },
  { text: "I would rather ship something small that works than something ambitious that doesn't.", register: "formal" },
  { text: "Scoping failures are almost always discovered too late to be cheap.", register: "formal" },
  { text: "The privacy trade-off deserves more attention than it usually gets.", register: "formal" },
  { text: "Good products respect the person on the other end of the screen.", register: "formal" },
  { text: "Constraints are what make a plan real instead of a wish.", register: "formal" },
  { text: "Most disagreements at work are actually about scope, not people.", register: "formal" },
  { text: "A tool you can leave easily is a tool you can trust.", register: "formal" },
  { text: "Yeah, I mean, that's kind of the whole point, isn't it?", register: "conversational" },
  { text: "Honestly, I'd just take the dog out and think about it tomorrow.", register: "conversational" },
  { text: "You know what, that first coffee in the morning is not negotiable.", register: "conversational" },
  { text: "So anyway, we ended up rebuilding the whole thing from scratch.", register: "conversational" },
  { text: "I'm not sure, to be honest — ask me again next week.", register: "conversational" },
  { text: "That's just stubbornness, and I don't argue with stubbornness.", register: "conversational" },
  { text: "Sort of a mess, really, but we got there in the end.", register: "conversational" },
  { text: "Right, let's just get everyone in a room and sort it out.", register: "conversational" },
];

export interface AbPair {
  idx: number;
  register: string;
  /** Which physical position holds the LOCAL clip — the blinding key. */
  positionOfLocal: "A" | "B";
  a: string; // audio file path relative to voice-ab/<persona>/
  b: string;
}

/** Deterministic blinded assignment from a seed — pure, unit-tested. */
export function assignBlinding(count: number, seed: string): ("A" | "B")[] {
  const out: ("A" | "B")[] = [];
  for (let i = 0; i < count; i++) {
    const h = createHash("sha256").update(`${seed}:${i}`).digest();
    out.push(h[0] % 2 === 0 ? "A" : "B");
  }
  return out;
}

export async function generateAbPairs(personaId: string): Promise<{ pairs: number; dir: string }> {
  const persona = await prisma.persona.findUnique({ where: { id: personaId } });
  if (!persona) throw new Error("persona not found");
  const dir = path.join(process.cwd(), "voice-ab", personaId);
  const localDir = path.join(dir, "local");
  const elDir = path.join(dir, "elevenlabs");
  fs.mkdirSync(elDir, { recursive: true });

  if (!fs.existsSync(localDir) || fs.readdirSync(localDir).filter((f) => f.endsWith(".wav")).length < AB_SENTENCES.length) {
    throw new Error(
      `Local renders missing: put ${AB_SENTENCES.length} wavs (00.wav … 15.wav, one per sentence in ` +
        `src/voice/abpairs.ts) in ${localDir} — generate them from the winning checkpoint after Stage 3.`
    );
  }

  // Render the ElevenLabs side (cached — only missing files are synthesized).
  const el = getTtsProvider({ provider: "elevenlabs", voiceRef: process.env.ELEVENLABS_VOICE_ID ?? "" });
  for (let i = 0; i < AB_SENTENCES.length; i++) {
    const out = path.join(elDir, `${String(i).padStart(2, "0")}.mp3`);
    if (fs.existsSync(out)) continue;
    const { audio } = await el.synthesize(stripUnsupportedTags(AB_SENTENCES[i].text, "elevenlabs"), process.env.ELEVENLABS_VOICE_ID ?? "");
    fs.writeFileSync(out, audio);
  }

  const blinding = assignBlinding(AB_SENTENCES.length, personaId);
  const pairs: AbPair[] = AB_SENTENCES.map((s, i) => {
    const local = `local/${String(i).padStart(2, "0")}.wav`;
    const elp = `elevenlabs/${String(i).padStart(2, "0")}.mp3`;
    const positionOfLocal = blinding[i];
    return {
      idx: i,
      register: s.register,
      positionOfLocal,
      a: positionOfLocal === "A" ? local : elp,
      b: positionOfLocal === "B" ? local : elp,
    };
  });
  fs.writeFileSync(path.join(dir, "pairs.json"), JSON.stringify({ personaId, pairs }, null, 2));
  return { pairs: pairs.length, dir };
}
