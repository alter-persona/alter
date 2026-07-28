import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { CorpusError } from "../../types";
import type { Sensitivity } from "../../types";

export interface WorkManifestEntry {
  path: string; // file path or glob, relative to sources/work/
  label: string;
  domain: string;
  sensitivity: Sensitivity;
  note?: string;
}

/**
 * Minimal glob support for manifest paths: `**` crosses directories, `*` stays
 * within one path segment, `?` is a single character. Anything else is literal.
 */
export function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // "**/" also matches zero directories
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export function loadWorkManifest(workDir: string): WorkManifestEntry[] {
  const manifestPath = path.join(workDir, "manifest.yaml");
  if (!fs.existsSync(manifestPath)) {
    throw new CorpusError(
      `sources/work/manifest.yaml is missing. Every work file needs a manifest entry ` +
        `declaring label, domain, and sensitivity. Create it with at least:\n\nfiles: []\n`
    );
  }
  const raw = yaml.load(fs.readFileSync(manifestPath, "utf8"));
  const files = (raw as { files?: unknown })?.files;
  if (!Array.isArray(files)) {
    throw new CorpusError(`sources/work/manifest.yaml must contain a top-level "files:" list.`);
  }

  const entries: WorkManifestEntry[] = [];
  files.forEach((f, i) => {
    const e = f as Partial<WorkManifestEntry>;
    for (const field of ["path", "label", "domain", "sensitivity"] as const) {
      if (!e[field] || typeof e[field] !== "string") {
        throw new CorpusError(
          `sources/work/manifest.yaml files[${i}] is missing required field "${field}" ` +
            `(needs: path, label, domain, sensitivity).`
        );
      }
    }
    if (e.sensitivity !== "private" && e.sensitivity !== "public") {
      throw new CorpusError(
        `sources/work/manifest.yaml files[${i}] ("${e.path}"): sensitivity must be "private" or "public", got "${e.sensitivity}".`
      );
    }
    entries.push(e as WorkManifestEntry);
  });
  return entries;
}

/** First matching entry wins. Returns null when no entry covers the file. */
export function matchManifest(
  relPath: string,
  entries: WorkManifestEntry[]
): WorkManifestEntry | null {
  for (const e of entries) {
    if (globToRegex(e.path).test(relPath)) return e;
  }
  return null;
}
