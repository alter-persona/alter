import { createHash } from "node:crypto";

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Normalization used for identity and dedup: casing/whitespace-insensitive. */
export function normalizeForHash(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Stable content-hash id: same source, origin, and text always yield the same
 * id, so re-runs after adding files change only what changed.
 */
export function itemId(sourceType: string, origin: string, text: string): string {
  return sha256(`${sourceType}|${origin}|${normalizeForHash(text)}`).slice(0, 16);
}

export function chunkId(baseId: string, index: number, total: number): string {
  return total === 1 ? baseId : `${baseId}-c${String(index).padStart(2, "0")}`;
}
