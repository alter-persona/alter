import fs from "node:fs";
import path from "node:path";

/** Minimal .env loader for tsx CLIs (never overrides existing process env). */
export function loadEnv(root = process.cwd()): void {
  const p = path.join(root, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const [k, ...rest] = t.split("=");
    const v = rest.join("=").trim().replace(/^"|"$/g, "");
    if (!(k.trim() in process.env)) process.env[k.trim()] = v;
  }
}

// Side-effect on import: every CLI does `import "@/lib/loadEnv"` expecting the
// env to be loaded (previously it worked only because Prisma's dotenv ran).
loadEnv();
