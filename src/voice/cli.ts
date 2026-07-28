import { loadEnv } from "@/lib/loadEnv";
loadEnv();
import { buildDataset, DatasetError } from "./dataset";
import { generateAbPairs } from "./abpairs";
import { ensureDefaultPersona, resolvePersona } from "@/lib/personas";

function usage(): never {
  console.log(`Usage: npm run voice -- <command> [--persona <id|name>] [options]

Commands:
  dataset    Build the TTS training dataset from intake audio + transcripts
             (--attest-own-voice on first run; --allow-unreviewed to accept
              machine transcripts, logged)
  abgen      Generate blinded A/B pairs for the listening test (requires the
             local checkpoint's samples in voice-ab/<persona>/local/)

Stage 2 (training) is scripts/voice-train-runbook.sh.
Stage 3 (checkpoint eval) is scripts/voice_eval.py.`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd) usage();
  const pIdx = args.indexOf("--persona");
  const persona = pIdx >= 0 ? await resolvePersona(args[pIdx + 1]) : await ensureDefaultPersona();
  if (!persona) {
    console.error("persona not found");
    process.exit(1);
  }

  try {
    if (cmd === "dataset") {
      const summary = await buildDataset(persona.id, {
        attestOwnVoice: args.includes("--attest-own-voice"),
        allowUnreviewed: args.includes("--allow-unreviewed"),
      });
      console.log(JSON.stringify(summary, null, 2));
      console.log(
        `\nDataset ready: ${summary.clips} clips, ${summary.keptMinutes} min kept ` +
          `(${summary.droppedMinutes} min dropped). Next: scripts/voice-train-runbook.sh`
      );
    } else if (cmd === "abgen") {
      console.log(JSON.stringify(await generateAbPairs(persona.id), null, 2));
    } else usage();
  } catch (e) {
    if (e instanceof DatasetError) {
      console.error(`\n${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
  process.exit(0);
}

void main();
