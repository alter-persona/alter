/**
 * The register firewall's machine check: every proposition must be in a flat,
 * third-person archivist register before it may be embedded. A proposition
 * containing first-person pronouns referring to the subject, or the subject's
 * own distinctive collocations, fails the lint and is never stored.
 */

const FIRST_PERSON = /\b(i|i'm|i've|i'd|i'll|me|my|mine|myself|we|our|ours|us)\b/i;
const SECOND_PERSON = /\byou know\b|\byou see\b/i;
const FILLER = /\b(um|uh|erm|gonna|wanna|kinda|sorta|y'know)\b/i;

export interface LintResult {
  ok: boolean;
  reasons: string[];
}

export function lintProposition(
  text: string,
  distinctiveCollocations: string[] = []
): LintResult {
  const reasons: string[] = [];
  const t = text.trim();

  if (FIRST_PERSON.test(t)) reasons.push("contains first-person pronoun");
  if (SECOND_PERSON.test(t)) reasons.push("contains second-person idiom");
  if (FILLER.test(t)) reasons.push("contains spoken filler/colloquialism");
  if (/[!?]{1,}$/.test(t)) reasons.push("exclamatory/interrogative register");
  if (t.length > 0 && t.split(/\s+/).length > 60)
    reasons.push("too long for an atomic proposition (>60 words)");

  const low = ` ${t.toLowerCase()} `;
  for (const c of distinctiveCollocations) {
    const cc = c.trim().toLowerCase();
    if (cc.split(" ").length >= 2 && low.includes(` ${cc} `)) {
      reasons.push(`contains subject's distinctive collocation: "${cc}"`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}
