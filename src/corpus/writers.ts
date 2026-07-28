import fs from "node:fs";
import path from "node:path";

/** Atomic write: temp file in the same directory, then rename over the target. */
export function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}`
  );
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
}

export function writeJsonl(filePath: string, rows: unknown[]): void {
  writeFileAtomic(filePath, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

export function writeJson(filePath: string, value: unknown): void {
  writeFileAtomic(filePath, JSON.stringify(value, null, 2) + "\n");
}
