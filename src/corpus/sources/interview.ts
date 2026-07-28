import AdmZip from "adm-zip";
import fs from "node:fs";
import path from "node:path";
import { CorpusError } from "../types";
import type { CorpusItem, HoldoutEntry } from "../types";
import { LOADERS } from "./work/loaders";

interface ManifestResponse {
  questionId: string;
  orderIndex: number;
  section: string;
  type: "voice" | "likert";
  promptText: string;
  oceanDomain: string | null;
  reverseScored: boolean;
  isValidation: boolean;
  answered: boolean;
  skipped: boolean;
  audioFilename: string | null;
  audioDurationSec: number | null;
  transcript: string | null;
  transcriptEditedByUser: boolean;
  transcriptStatus: string | null;
  likertValue: number | null;
  answeredAt: string | null;
}

interface ManifestFile {
  id: string;
  filename: string;
  exportName: string | null;
  label: string;
  domain: string | null;
  sensitivity: "private" | "public";
  note: string | null;
  addedAt: string | null;
}

interface IntakeManifest {
  session: { id: string; label: string; isTrial: boolean };
  totals: { totalVoiceAudioDurationSec: number };
  responses: ManifestResponse[];
  files?: ManifestFile[];
}

export interface InterviewParseResult {
  items: CorpusItem[];
  holdout: HoldoutEntry[];
  audioMinutes: number;
  skippedFiles: { file: string; reason: string }[];
  notes: string[];
}

/**
 * Parse every intake-app export zip in sources/interview/. Edited transcripts
 * are ground truth. The eight sealed validation questions never enter the
 * corpus — they go to holdout/ only. Session-attached files (uploaded via the
 * intake app's Files panel) are ingested as work_file items using the label,
 * domain, and sensitivity configured at upload time.
 */
export async function parseInterviewDir(dir: string): Promise<InterviewParseResult> {
  const result: InterviewParseResult = {
    items: [],
    holdout: [],
    audioMinutes: 0,
    skippedFiles: [],
    notes: [],
  };
  if (!fs.existsSync(dir)) return result;

  const zips = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".zip"));
  for (const zipName of zips) {
    const zipPath = path.join(dir, zipName);
    let manifest: IntakeManifest;
    let zip: AdmZip;
    try {
      zip = new AdmZip(zipPath);
      const entry = zip.getEntry("manifest.json");
      if (!entry) throw new CorpusError("no manifest.json inside zip");
      manifest = JSON.parse(zip.readAsText(entry)) as IntakeManifest;
      if (!Array.isArray(manifest.responses)) {
        throw new CorpusError("manifest.json has no responses array");
      }
    } catch (e) {
      result.skippedFiles.push({
        file: `sources/interview/${zipName}`,
        reason: e instanceof CorpusError ? e.message : `unreadable zip (${String(e)})`,
      });
      continue;
    }

    result.audioMinutes += (manifest.totals?.totalVoiceAudioDurationSec ?? 0) / 60;

    let likertSkipped = 0;
    for (const r of manifest.responses) {
      if (r.isValidation) {
        // Sealed: holdout only, never the corpus — even unanswered ones are
        // recorded so the holdout file mirrors the full validation set.
        result.holdout.push({
          questionId: r.questionId,
          orderIndex: r.orderIndex,
          section: r.section,
          question: r.promptText,
          answer: r.transcript,
          audioDurationSec: r.audioDurationSec,
        });
        continue;
      }
      if (r.type !== "voice") {
        likertSkipped++;
        continue; // Likert values carry no prose style; profile of OCEAN lives in the intake DB/export.
      }
      if (!r.transcript || !r.transcript.trim()) continue;

      result.items.push({
        text: r.transcript.trim(),
        sourceType: "interview",
        label: r.section,
        domain: null,
        date: r.answeredAt,
        sensitivity: "private",
        origin: `${zipName}#q${r.orderIndex + 1}:${r.questionId.slice(0, 8)}`,
      });
    }
    result.notes.push(
      `${zipName}: session "${manifest.session?.label ?? "?"}", ${likertSkipped} likert answers not corpus material (by design)`
    );

    // Session-attached files → work_file items with their configured provenance.
    for (const f of manifest.files ?? []) {
      const ref = `sources/interview/${zipName} → files/${f.exportName ?? f.filename}`;
      if (!f.exportName) {
        result.skippedFiles.push({ file: ref, reason: "no stored file in export" });
        continue;
      }
      const entry = zip.getEntry(`files/${f.exportName}`);
      if (!entry) {
        result.skippedFiles.push({ file: ref, reason: "listed in manifest but missing from zip" });
        continue;
      }
      const ext = path.extname(f.filename).toLowerCase();
      const loader = LOADERS[ext];
      if (!loader) {
        result.skippedFiles.push({ file: ref, reason: `unsupported extension "${ext}"` });
        continue;
      }
      try {
        const text = await loader(f.filename, entry.getData());
        if (!text.trim()) {
          result.skippedFiles.push({ file: ref, reason: "no extractable text" });
          continue;
        }
        result.items.push({
          text: text.trim(),
          sourceType: "work_file",
          label: f.label,
          domain: f.domain,
          date: f.addedAt,
          sensitivity: f.sensitivity,
          origin: `${zipName}#file:${f.filename}`,
        });
      } catch (e) {
        result.skippedFiles.push({ file: ref, reason: `loader failed: ${String(e)}` });
      }
    }
  }
  return result;
}
