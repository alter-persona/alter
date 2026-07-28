/**
 * Redaction runs before anything is stored. Each matched span is replaced with
 * [REDACTED] and counted by rule name. Regex-based redaction is deterministic
 * but not exhaustive — the run report carries a note that free-text mentions
 * of third parties are only covered to the extent the patterns below match
 * (emails, phone numbers, street addresses, IDs).
 */

const REDACTED = "[REDACTED]";

interface Rule {
  name: string;
  re: RegExp;
  /** Optional post-filter on the matched text; return false to keep the match unredacted. */
  filter?: (match: string) => boolean;
  /** When set, only this capture group is replaced (used for key=value assignments). */
  valueGroup?: number;
}

function luhnValid(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const RULES: Rule[] = [
  // --- API keys / tokens / secrets ---
  { name: "api_key", re: /\b(?:sk|pk|rk)-(?:[A-Za-z0-9_-]{4,20}-)?[A-Za-z0-9_-]{16,}\b/g },
  { name: "api_key", re: /\b(?:xkeysib|xoxb|xoxp|xoxa|xoxs)-[A-Za-z0-9-]{10,}\b/g },
  { name: "api_key", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: "api_key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "api_key", re: /\bwhsec_[A-Za-z0-9]{16,}\b/g },
  { name: "api_key", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g }, // JWT
  { name: "bearer_token", re: /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{20,}/g },
  {
    name: "credential_assignment",
    re: /\b(?:api[_-]?key|apikey|access[_-]?key|client[_-]?secret|secret[_-]?key|auth[_-]?token|token|secret|password|passwd|pwd)\b(\s*[:=]\s*["']?)([^\s"'`,;]{6,})/gi,
    valueGroup: 2,
  },
  // --- government identifiers ---
  // US SSN. Passport-style formats are intentionally not pattern-matched:
  // 2-letters+digits regexes false-positive on ordinary reference codes.
  { name: "gov_id", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  // --- financial ---
  { name: "financial_card", re: /\b(?:\d[ -]?){13,19}\b/g, filter: luhnValid },
  { name: "financial_iban", re: /\b[A-Z]{2}\d{2}[A-Z0-9]{12,30}\b/g },
  {
    name: "financial_account",
    re: /\b(?:account|acct|routing)\s*(?:number|no\.?|#)?\s*[:=]?\s*(\d{6,17})\b/gi,
    valueGroup: 1,
  },
  // --- contact details / third-party personal data (regex-coverable part) ---
  { name: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  {
    name: "phone",
    re: /(?<!\d)(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)/g,
  },
  {
    name: "street_address",
    re: /\b\d{1,5}\s+(?:[A-Z][A-Za-z'-]+\s+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Court|Ct|Place|Pl|Boulevard|Blvd|Circle|Cir|Terrace|Ter|Way|Highway|Hwy|Parkway|Pkwy)\b\.?(?:\s*,?\s*(?:Apt|Unit|Suite|Ste|#)\s*\w+)?/g,
  },
];

export interface RedactionResult {
  text: string;
  counts: Record<string, number>;
  total: number;
}

export function redact(input: string): RedactionResult {
  let text = input;
  const counts: Record<string, number> = {};
  let total = 0;

  for (const rule of RULES) {
    text = text.replace(rule.re, (match, ...groups) => {
      if (rule.filter && !rule.filter(match)) return match;
      counts[rule.name] = (counts[rule.name] ?? 0) + 1;
      total++;
      if (rule.valueGroup !== undefined) {
        const value = groups[rule.valueGroup - 1] as string;
        return match.replace(value, REDACTED);
      }
      return REDACTED;
    });
  }

  return { text, counts, total };
}

export function mergeCounts(
  into: Record<string, number>,
  from: Record<string, number>
): void {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
}
