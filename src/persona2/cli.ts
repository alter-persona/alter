import { loadEnv } from "@/lib/loadEnv";
loadEnv();
import { ensureDefaultPersona, resolvePersona } from "@/lib/personas";
import { distill } from "./distill";
import { reflect } from "./reflect";
import { buildFingerprint } from "./fingerprint";
import { curateExemplars } from "./exemplars";
import { buildSkillPackV2, SkillGenError } from "./skillgen";
import { runBattery } from "./validate";

function usage(): never {
  console.log(`Usage: npm run persona2 -- <command> [--persona <id|name>] [options]

Commands:
  distill      Distill raw corpus into neutral-register propositions (LLM, resumable)
  reflect      Cluster propositions and write insight records (LLM)
  fingerprint  Compute spoken+written style fingerprints (mechanical)
  exemplars    Curate the 8-12 passage exemplar bank (LLM)
  pack         Build the v2 skill pack (+ --install-hermes to refresh Telegram skills)
  validate     Run the 20-question A/B harness (v1 vs v2) and write the report
  all          distill → reflect → fingerprint → exemplars → pack --install-hermes

Options: --limit N (distill), --no-llm (fail fast where LLM is required)`);
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
  if (args.includes("--no-llm") && ["distill", "reflect", "exemplars", "all"].includes(cmd)) {
    console.error(`"${cmd}" requires the build-time LLM; --no-llm has nothing to run here.`);
    process.exit(1);
  }
  const lIdx = args.indexOf("--limit");
  const limit = lIdx >= 0 ? Number(args[lIdx + 1]) : undefined;

  const t0 = Date.now();
  try {
    if (cmd === "distill" || cmd === "all") {
      const stats = await distill(persona.id, {
        limit,
        onProgress: (s) =>
          process.stdout.write(
            `\r[distill] items ${s.itemsProcessed} · props ${s.propositionsStored} · lint-rejected ${s.lintRejected} · llm-errors ${s.llmErrors}   `
          ),
      });
      console.log(`\n[distill] done: ${JSON.stringify(stats)}`);
    }
    if (cmd === "reflect" || cmd === "all") {
      console.log(`[reflect] ${JSON.stringify(await reflect(persona.id))}`);
    }
    if (cmd === "fingerprint" || cmd === "all") {
      const fp = await buildFingerprint(persona.id);
      console.log(
        `[fingerprint] spoken ${fp.spoken.totalWords}w (${fp.spoken.fillerRates.length} filler terms), written ${fp.written.totalWords}w, ${fp.spoken.markerRates.length}+${fp.written.markerRates.length} distinctive markers`
      );
    }
    if (cmd === "exemplars" || cmd === "all") {
      const bank = await curateExemplars(persona.id);
      console.log(`[exemplars] selected ${bank.length}: ${bank.map((e) => `${e.mode}/${e.topic}`).join(", ")}`);
    }
    if (cmd === "pack" || cmd === "all") {
      const result = await buildSkillPackV2(persona.id, {
        installHermes: cmd === "all" || args.includes("--install-hermes"),
      });
      console.log(`[pack] v${result.version} → ${result.dir}`);
    }
    if (cmd === "validate") {
      const { v1, v2, reportPath } = await runBattery(persona.id, persona.name);
      console.log(`[validate] v1 copy-flag ${v1.copyFlagRatePct}% delta ${v1.delta} | v2 copy-flag ${v2.copyFlagRatePct}% delta ${v2.delta} (self ${v2.deltaSelf})`);
      console.log(`[validate] report: ${reportPath}`);
    }
    if (!["distill", "reflect", "fingerprint", "exemplars", "pack", "validate", "all"].includes(cmd)) usage();
  } catch (e) {
    if (e instanceof SkillGenError) {
      console.error(`\n${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
  console.log(`(${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  process.exit(0);
}

void main();
