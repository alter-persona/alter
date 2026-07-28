import fs from "node:fs";
import path from "node:path";
import { CorpusError } from "../../types";
import type { CorpusItem } from "../../types";
import { loadWorkManifest, matchManifest } from "./manifest";
import { LOADERS } from "./loaders";

export interface WorkParseResult {
  items: CorpusItem[];
  skippedFiles: { file: string; reason: string }[];
  notes: string[];
}

function walk(dir: string, base: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(".")) continue; // .DS_Store and friends
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full));
  }
  return out;
}

/**
 * Scan sources/work/. Every file must have a manifest.yaml entry declaring
 * label, domain, and sensitivity — files without one FAIL the run so nothing
 * enters the corpus with unknown provenance.
 */
export async function parseWorkDir(dir: string): Promise<WorkParseResult> {
  const result: WorkParseResult = { items: [], skippedFiles: [], notes: [] };
  if (!fs.existsSync(dir)) return result;

  const files = walk(dir, dir).filter((f) => path.basename(f) !== "manifest.yaml");
  if (files.length === 0) return result;

  const entries = loadWorkManifest(dir); // throws with a clear message if missing/invalid

  const unmatched = files.filter((f) => !matchManifest(f, entries));
  if (unmatched.length > 0) {
    throw new CorpusError(
      `Run failed: ${unmatched.length} file(s) in sources/work/ have no manifest.yaml entry ` +
        `(every file needs label, domain, sensitivity):\n` +
        unmatched.map((f) => `  - ${f}`).join("\n") +
        `\nAdd entries to sources/work/manifest.yaml and re-run.`
    );
  }

  for (const relPath of files) {
    const entry = matchManifest(relPath, entries)!;
    const ext = path.extname(relPath).toLowerCase();
    const loader = LOADERS[ext];
    if (!loader) {
      result.skippedFiles.push({
        file: `sources/work/${relPath}`,
        reason: `unsupported extension "${ext}" (supported: ${Object.keys(LOADERS).join(", ")})`,
      });
      continue;
    }

    const abs = path.join(dir, relPath);
    let text: string;
    try {
      text = await loader(abs, fs.readFileSync(abs));
    } catch (e) {
      result.skippedFiles.push({
        file: `sources/work/${relPath}`,
        reason: `loader failed: ${String(e)}`,
      });
      continue;
    }
    if (!text.trim()) {
      result.skippedFiles.push({
        file: `sources/work/${relPath}`,
        reason: "no extractable text",
      });
      continue;
    }

    result.items.push({
      text: text.trim(),
      sourceType: "work_file",
      label: entry.label,
      domain: entry.domain,
      date: fs.statSync(abs).mtime.toISOString(),
      sensitivity: entry.sensitivity,
      origin: `sources/work/${relPath}`,
    });
  }
  return result;
}
