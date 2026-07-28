/**
 * Segmentation planning: cut long answers into training clips ONLY at
 * VAD-detected silences — never mid-word. Pure logic, unit-tested against
 * fixtures; ffmpeg silencedetect supplies the silence intervals.
 */

export interface Interval {
  start: number;
  end: number;
}

export const MIN_CLIP_SEC = 3;
export const MAX_CLIP_SEC = 15;
const EDGE_PAD_SEC = 0.15; // keep a little silence around cuts

/** Parse `ffmpeg -af silencedetect` stderr into silence intervals. */
export function parseSilences(ffmpegStderr: string): Interval[] {
  const out: Interval[] = [];
  let start: number | null = null;
  for (const line of ffmpegStderr.split("\n")) {
    const s = line.match(/silence_start:\s*([\d.]+)/);
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (s) start = parseFloat(s[1]);
    if (e && start !== null) {
      out.push({ start, end: parseFloat(e[1]) });
      start = null;
    }
  }
  return out;
}

/** Invert silences into speech spans over [0, totalDur]. */
export function speechSpans(silences: Interval[], totalDur: number): Interval[] {
  const spans: Interval[] = [];
  let cursor = 0;
  for (const s of [...silences].sort((a, b) => a.start - b.start)) {
    if (s.start > cursor + 0.05) spans.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (totalDur > cursor + 0.05) spans.push({ start: cursor, end: totalDur });
  return spans;
}

export interface PlannedClip {
  start: number;
  end: number;
}

/**
 * Sensitivity ladder: spans longer than MAX at the strict silence threshold
 * are subdivided at softer pauses (breath-level silences from more sensitive
 * detection passes). Still only ever cuts inside detected silences.
 */
export function refineSpans(spans: Interval[], finerSilenceLevels: Interval[][]): Interval[] {
  const out: Interval[] = [];
  for (const span of spans) {
    if (span.end - span.start <= MAX_CLIP_SEC) {
      out.push(span);
      continue;
    }
    let subdivided = false;
    for (const level of finerSilenceLevels) {
      const inside = level.filter((s) => s.start > span.start + 0.5 && s.end < span.end - 0.5);
      if (inside.length === 0) continue;
      const subSpans = speechSpans(inside, span.end).filter((s) => s.end > span.start);
      const adjusted = subSpans.map((s) => ({ start: Math.max(s.start, span.start), end: s.end }));
      if (adjusted.every((s) => s.end - s.start <= MAX_CLIP_SEC)) {
        out.push(...adjusted);
        subdivided = true;
        break;
      }
      // Partial win: recurse on the pieces with the remaining levels.
      out.push(...refineSpans(adjusted, finerSilenceLevels.slice(finerSilenceLevels.indexOf(level) + 1)));
      subdivided = true;
      break;
    }
    if (!subdivided) out.push(span); // planClips will drop it with a reason
  }
  return out;
}

export interface SegmentPlan {
  clips: PlannedClip[];
  dropped: { span: Interval; reason: string }[];
}

/**
 * Pack consecutive speech spans into clips of MIN..MAX seconds. A clip may
 * only end inside a silence (between spans) or at the audio end. Spans longer
 * than MAX with no internal silence are dropped (cutting mid-word is worse
 * than losing the span). Trailing groups under MIN are dropped.
 */
export function planClips(spans: Interval[], totalDur: number): SegmentPlan {
  const clips: PlannedClip[] = [];
  const dropped: SegmentPlan["dropped"] = [];
  let i = 0;
  while (i < spans.length) {
    const span = spans[i];
    if (span.end - span.start > MAX_CLIP_SEC) {
      dropped.push({ span, reason: `speech span ${(span.end - span.start).toFixed(1)}s exceeds ${MAX_CLIP_SEC}s with no silence to cut at` });
      i++;
      continue;
    }
    // Grow a clip from spans[i..j] while total stays within MAX.
    let j = i;
    while (j + 1 < spans.length && spans[j + 1].end - span.start <= MAX_CLIP_SEC) j++;
    const clipStart = Math.max(0, span.start - EDGE_PAD_SEC);
    const clipEnd = Math.min(totalDur, spans[j].end + EDGE_PAD_SEC);
    if (clipEnd - clipStart >= MIN_CLIP_SEC) {
      clips.push({ start: clipStart, end: clipEnd });
    } else {
      dropped.push({ span: { start: clipStart, end: clipEnd }, reason: `clip ${(clipEnd - clipStart).toFixed(1)}s under ${MIN_CLIP_SEC}s minimum` });
    }
    i = j + 1;
  }
  return { clips, dropped };
}
