import { simpleParser } from "mailparser";

/**
 * Email loader: keeps only the author's own written text. Quoted replies,
 * forwarded blocks, and signatures are stripped.
 */
export async function loadEml(_filePath: string, buffer: Buffer): Promise<string> {
  const mail = await simpleParser(buffer);
  const text = (mail.text ?? "").replace(/\r\n/g, "\n");
  return stripQuotedAndSignature(text);
}

export function stripQuotedAndSignature(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Signature delimiter: everything after is signature.
    if (/^--\s?$/.test(line)) break;
    // "On <date>, <person> wrote:" reply header — quoted thread follows.
    if (/^On .{5,120} wrote:\s*$/.test(line)) break;
    // Outlook-style embedded original message header block.
    if (/^-{3,}\s*(Original Message|Forwarded message)\s*-{3,}$/i.test(line)) break;
    if (/^From:\s.+$/.test(line) && lines[i + 1] !== undefined && /^(Sent|Date|To):\s/.test(lines[i + 1] ?? "")) break;
    // Quoted line.
    if (/^\s*>/.test(line)) continue;

    kept.push(line);
  }

  // Trim common closing signatures without a "-- " delimiter: a short trailing
  // block starting with a valediction.
  const out = kept.join("\n").trim();
  const valediction =
    /\n(?:best|best regards|regards|cheers|thanks|thank you|sincerely|warm regards|kind regards)[,!.]?\s*\n[\s\S]{0,120}$/i;
  return out.replace(valediction, "\n").trim();
}
