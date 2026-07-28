import { build } from "./pipeline";
import { ALL_SOURCES, type SourceKey } from "./config";
import { CorpusError } from "./types";

function usage(): never {
  console.log(`Usage: npm run corpus -- build [options]

Options:
  --source <interview|chat-export|work>   Rebuild only this source (repeatable).
                                          Others are restored from the last run's cache.
  --dry-run                               Print the report; write nothing.
  --no-llm                                Fill profile judgment fields with null (offline run).
`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== "build") usage();

  const sources: SourceKey[] = [];
  let dryRun = false;
  let noLlm = false;

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--no-llm") noLlm = true;
    else if (a === "--source") {
      const v = args[++i] as SourceKey;
      if (!ALL_SOURCES.includes(v)) {
        console.error(`Unknown source "${v}". Valid: ${ALL_SOURCES.join(", ")}`);
        process.exit(1);
      }
      sources.push(v);
    } else {
      console.error(`Unknown option "${a}"`);
      usage();
    }
  }

  try {
    const { report } = await build({
      sources: sources.length ? sources : [...ALL_SOURCES],
      dryRun,
      noLlm,
    });
    console.log(report);
    if (!dryRun) console.log("Written: corpus/private.jsonl, corpus/public.jsonl, corpus/profile.json, corpus/report.md, holdout/validation.jsonl");
  } catch (e) {
    if (e instanceof CorpusError) {
      console.error(`\n${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
}

void main();
