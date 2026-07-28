/**
 * Retrieval gate: route each message by intent.
 *  - explicit_recall: "what did I actually say about X" → episodic store,
 *    answer with attributed quotes (the only path where raw text may appear).
 *  - smalltalk: greetings/reactions → retrieve nothing; the persona core
 *    carries these alone.
 *  - knowledge: everything else → propositions + insights.
 */

export type Intent = "knowledge" | "explicit_recall" | "smalltalk";

const RECALL_PATTERNS: RegExp[] = [
  /\bwhat (did|have) (i|you) (say|said|write|written|tell|told)\b/i,
  /\bwhat exactly did (i|you)\b/i,
  /\bmy exact words\b/i,
  /\bquote (me|my|what)\b/i,
  /\bverbatim\b/i,
  /\bin (my|your) (interview|answers?|transcripts?)\b.*\b(say|said|describe)\b/i,
  /\bdid i ever (say|mention|write)\b/i,
];

const SMALLTALK_PATTERNS: RegExp[] = [
  /^\s*(hi|hey|hello|yo|hiya|good (morning|afternoon|evening)|morning|evening)[\s!.,]*$/i,
  /^\s*(how are you|how's it going|how are things|what's up|you ok|you good)[\s?!.]*$/i,
  /^\s*(hi|hey|hello|yo|hiya)[,!.\s]+(how are you|how's it going|how are things|what's up|you (ok|good)|good (morning|afternoon|evening))[\s?!.]*$/i,
  /^\s*(thanks|thank you|cheers|nice|cool|great|ha|haha|lol|ok|okay|got it|makes sense)[\s!.,]*((that )?makes sense|got it|appreciated|appreciate it)?[\s!.,]*$/i,
  /^\s*(bye|goodbye|see you|later|good night)[\s!.,]*$/i,
];

/** Explicitly past-framed questions additionally retrieve historical chunks
 * (how have you changed / what did you used to think). */
const PAST_FRAMED_PATTERNS: RegExp[] = [
  /\bhow have (you|i) changed\b/i,
  /\bused to (think|believe|feel|be|do|say)\b/i,
  /\bback then\b/i,
  /\b(earlier|previously|in the past)[,]? (you|i) (thought|believed|felt|were|said)\b/i,
  /\bwhat did (you|i) (think|believe|feel)\b.*\b(before|then|previously|back)\b/i,
  /\bhave (your|my) (views?|opinions?|feelings?) changed\b/i,
];

export function isPastFramed(message: string): boolean {
  return PAST_FRAMED_PATTERNS.some((re) => re.test(message.trim()));
}

export function routeIntent(message: string): Intent {
  const m = message.trim();
  if (RECALL_PATTERNS.some((re) => re.test(m))) return "explicit_recall";
  if (SMALLTALK_PATTERNS.some((re) => re.test(m))) return "smalltalk";
  // Very short reactive fragments with no question mark are smalltalk too.
  if (m.split(/\s+/).length <= 3 && !m.includes("?")) return "smalltalk";
  return "knowledge";
}
