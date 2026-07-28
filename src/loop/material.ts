import fs from "node:fs";
import path from "node:path";
import { encode } from "gpt-tokenizer";
import { prisma } from "@/lib/db";
import { embed, toVectorLiteral } from "@/lib/embedder";
import { updateStylometry } from "@/lib/stylometry";
import { redact } from "@/corpus/redact";
import { chunkText } from "@/corpus/chunk";
import { itemId, chunkId } from "@/corpus/hash";
import { config as corpusConfig } from "@/corpus/config";
import { LOADERS } from "@/corpus/sources/work/loaders";
import type { CorpusItem } from "@/corpus/types";
import { nearNeighbors, reconcile } from "./reconcile";
import { isSealedContent } from "./sealed";

/**
 * Tier-2 material distillation: new source content about the person — a
 * dropped file, a long voice memo, a pasted writing sample. Runs the SAME
 * pipeline as the synthesis build (redact → chunk → embed → distill into
 * propositions), tags register by source, then checks each new proposition
 * against near neighbors; any disagreement enters reconciliation.
 */

interface EventRow {
  id: string;
  personaId: string;
  rawText: string | null;
  register: string | null;
  filePath: string | null;
  filename: string | null;
  sensitivity: string;
}

export async function distillMaterial(event: EventRow): Promise<void> {
  const sensitivity: "private" | "public" = event.sensitivity === "public" ? "public" : "private";
  const origin = `loop:${event.id.slice(0, 8)}`;

  let items: CorpusItem[];
  let ownText: string[];
  if (event.filePath) {
    const abs = path.resolve(process.cwd(), event.filePath);
    const buffer = fs.readFileSync(abs);
    const ext = path.extname(event.filename ?? event.filePath).toLowerCase();
    if (ext === ".zip") {
      // AI chat exports (Claude / OpenAI) route through the provider chain —
      // only the person's own messages enter, with title + date metadata.
      const AdmZip = (await import("adm-zip")).default;
      const { parseChatZip } = await import("@/corpus/sources/chat");
      const result = parseChatZip(new AdmZip(buffer), event.filename ?? "export.zip");
      if (!result) throw new Error("zip is not a recognized chat export (providers: claude, openai)");
      const minWords = corpusConfig.minWords;
      items = [...result.parsed.messages, ...result.parsed.projectDocs]
        .filter(
          (m) => m.sourceType !== "chat_export" || m.text.split(/\s+/).filter(Boolean).length >= minWords
        )
        .map((m) => ({ ...m, sensitivity }));
      ownText = result.parsed.humanMessages.map((m) => m.text);
    } else {
      const loader = LOADERS[ext];
      if (!loader) throw new Error(`unsupported extension "${ext}"`);
      const text = (await loader(event.filename ?? "file", buffer)).trim();
      if (!text) throw new Error("no extractable text");
      items = [
        {
          text,
          sourceType: "work_file", // written register by source
          label: "loop-material",
          domain: null,
          date: new Date().toISOString(),
          sensitivity,
          origin,
        },
      ];
      ownText = [text];
    }
  } else {
    const text = event.rawText?.trim();
    if (!text) throw new Error("material event has no content");
    items = [
      {
        text,
        // A spoken memo is the person's own speech → interview sourceType keeps
        // it in the spoken stylometry/fingerprint mode; typed text stays written.
        sourceType: event.register === "spoken" ? "interview" : "work_file",
        label: event.register === "spoken" ? "loop-memo" : "loop-material",
        domain: null,
        date: new Date().toISOString(),
        sensitivity,
        origin,
      },
    ];
    ownText = [text];
  }

  // Sealed-question firewall: holdout answers never enter any ingestion path.
  for (const item of items) {
    if (await isSealedContent(item.text)) {
      throw new Error("sealed validation content excluded from ingestion");
    }
  }

  // Retrieval half: redact → chunk → embed → upsert (episodic store).
  // Single-origin items adopt the event origin so recon/report can find them.
  const table = sensitivity === "public" ? "VectorChunkPublic" : "VectorChunkPrivate";
  const origins = new Set<string>();
  for (const item of items) {
    const itemOrigin = items.length === 1 ? origin : item.origin;
    origins.add(itemOrigin);
    const r = redact(item.text);
    const pieces = chunkText(r.text, corpusConfig.chunkMaxTokens, corpusConfig.chunkTargetTokens);
    const base = itemId(item.sourceType, itemOrigin, r.text);
    for (let i = 0; i < pieces.length; i++) {
      const id = chunkId(base, i, pieces.length);
      const vec = toVectorLiteral(await embed(pieces[i]));
      await prisma.$executeRawUnsafe(
        `INSERT INTO "${table}"
           (id, "personaId", "sourceType", label, domain, date, origin, text, tokens, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector)
         ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label`,
        id,
        event.personaId,
        item.sourceType,
        item.label,
        item.domain,
        item.date ? new Date(item.date) : new Date(),
        itemOrigin,
        pieces[i],
        encode(pieces[i]).length,
        vec
      );
    }
  }

  // Style half: the person's own words.
  for (const text of ownText) {
    await updateStylometry(event.personaId, redact(text).text);
  }

  // Distill into neutral-register propositions (standard v2 path).
  if (process.env.EMBED_FAKE !== "1" || process.env.LOOP_TEST_DISTILL === "1") {
    const { distill } = await import("@/persona2/distill");
    await distill(event.personaId, { onlyOrigins: [...origins] });
  }

  // Neighbor check: every proposition born from this material vs the index.
  const propTable = sensitivity === "public" ? "propositionPublic" : "propositionPrivate";
  const newProps = await (prisma as any)[propTable].findMany({
    where: { personaId: event.personaId, sourceOrigins: { hasSome: [...origins] }, status: "active" },
    select: { id: true, text: true },
  });
  const siblings = new Set(newProps.map((p: { id: string }) => p.id));
  for (const p of newProps as { id: string; text: string }[]) {
    const neighbors = (await nearNeighbors(event.personaId, p.text, p.id, sensitivity)).filter(
      (n) => !siblings.has(n.id)
    );
    if (neighbors[0]) {
      await reconcile({
        personaId: event.personaId,
        newPropId: p.id,
        oldPropId: neighbors[0].id,
        sourceEventId: event.id,
      }).catch((e) => console.error(`[loop] recon failed for ${p.id}: ${String(e).slice(0, 150)}`));
    }
  }
}
