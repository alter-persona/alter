import { encode } from "gpt-tokenizer";

/**
 * Chunk long texts to roughly target tokens (items at or under maxTokens stay
 * whole). Splits prefer paragraph boundaries, then sentences, then a hard
 * token split as last resort, so chunks stay readable prose.
 */
export function chunkText(
  text: string,
  maxTokens: number,
  targetTokens: number
): string[] {
  if (encode(text).length <= maxTokens) return [text.trim()].filter(Boolean);

  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const units: string[] = [];
  for (const p of paragraphs) {
    if (encode(p).length <= maxTokens) {
      units.push(p);
    } else {
      // Paragraph too big: split into sentences.
      const sentences = p.match(/[^.!?\n]+[.!?]*\s*/g) ?? [p];
      let buf = "";
      for (const s of sentences) {
        if (encode(s).length > maxTokens) {
          if (buf.trim()) units.push(buf.trim());
          buf = "";
          units.push(...hardSplit(s, maxTokens));
        } else if (encode(buf + s).length > maxTokens) {
          if (buf.trim()) units.push(buf.trim());
          buf = s;
        } else {
          buf += s;
        }
      }
      if (buf.trim()) units.push(buf.trim());
    }
  }

  // Pack units into chunks around the target size.
  const chunks: string[] = [];
  let buf = "";
  for (const unit of units) {
    const candidate = buf ? `${buf}\n\n${unit}` : unit;
    const n = encode(candidate).length;
    if (n > maxTokens || (buf && n > targetTokens)) {
      if (buf) chunks.push(buf);
      buf = unit;
    } else {
      buf = candidate;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

function hardSplit(text: string, maxTokens: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let buf: string[] = [];
  for (const w of words) {
    buf.push(w);
    if (encode(buf.join(" ")).length >= maxTokens - 10) {
      out.push(buf.join(" "));
      buf = [];
    }
  }
  if (buf.length) out.push(buf.join(" "));
  return out;
}
