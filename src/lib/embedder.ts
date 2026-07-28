import { createHash } from "node:crypto";

/**
 * Local embedding via transformers.js (bge-small-en-v1.5, 384 dims). The
 * model downloads once at first use and runs fully locally afterwards.
 *
 * EMBED_FAKE=1 swaps in a deterministic hash-based pseudo-embedding so tests
 * run offline and fast; dimensionality and normalization match the real thing.
 */
export const EMBEDDING_DIM = 384;
const MODEL_ID = "Xenova/bge-small-en-v1.5";

type FeaturePipeline = (
  text: string,
  opts: { pooling: "mean"; normalize: boolean }
) => Promise<{ data: Float32Array }>;

const g = globalThis as unknown as { __embedPipeline?: Promise<FeaturePipeline> };

async function getPipeline(): Promise<FeaturePipeline> {
  if (!g.__embedPipeline) {
    g.__embedPipeline = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      return (await pipeline("feature-extraction", MODEL_ID)) as unknown as FeaturePipeline;
    })();
  }
  return g.__embedPipeline;
}

function fakeEmbed(text: string): number[] {
  const out = new Array<number>(EMBEDDING_DIM).fill(0);
  // Derive deterministic values from repeated hashing; similar only for
  // identical text, which is all the tests need.
  let seed = createHash("sha256").update(text).digest();
  let i = 0;
  while (i < EMBEDDING_DIM) {
    for (let b = 0; b < seed.length && i < EMBEDDING_DIM; b += 2, i++) {
      out[i] = (seed.readInt16BE(b) / 32768) * 0.1;
    }
    seed = createHash("sha256").update(seed).digest();
  }
  const norm = Math.sqrt(out.reduce((a, v) => a + v * v, 0)) || 1;
  return out.map((v) => v / norm);
}

export async function embed(text: string): Promise<number[]> {
  if (process.env.EMBED_FAKE === "1") return fakeEmbed(text);
  const pipe = await getPipeline();
  const result = await pipe(text.slice(0, 4000), { pooling: "mean", normalize: true });
  return Array.from(result.data);
}

export function toVectorLiteral(v: number[]): string {
  return `[${v.map((x) => x.toFixed(6)).join(",")}]`;
}
