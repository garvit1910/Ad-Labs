import { createHash } from 'node:crypto';
import { openAIEmbeddings } from '@/lib/llm/clients';
import type { LlmRetryProfile } from '@/lib/llm/clients';

/**
 * Per-ad copy embeddings for the replication signal. One vector per ad over
 * the same model the Knowledge Base uses (text-embedding-3-small, 1536 dims),
 * whose outputs are unit-normalized — so cosine similarity reduces to a dot
 * product downstream. Vectors are persisted to ad_embeddings and clustered at
 * read time; see lib/brand-identity/clustering.ts.
 */
export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;

/** Defensive cap so a pathological body can't blow the model token limit. */
const MAX_EMBED_CHARS = 8000;
/** Max inputs per embeddings request. */
const EMBED_BATCH_SIZE = 96;
/** A body that is nothing but an unrendered template token, e.g. "{{product.brand}}". */
const TEMPLATE_ONLY = /^\s*\{\{[^}]*\}\}\s*$/;

/**
 * The single text we embed for an ad: its first real creative body. Dynamic /
 * catalog ads put an unrendered template token like "{{product.brand}}" in
 * creative_bodies[0] (~26% of ads in practice) with the real copy in a later
 * slot — embedding the token would collapse unrelated ads into one bogus
 * cluster, so those placeholder-only bodies are skipped. Returns null when the
 * ad has no usable copy to embed.
 */
export function primaryBody(creativeBodies: string[] | null | undefined): string | null {
  for (const raw of creativeBodies ?? []) {
    const body = raw?.trim();
    if (!body || TEMPLATE_ONLY.test(body)) continue;
    return body.slice(0, MAX_EMBED_CHARS);
  }
  return null;
}

/** Stable hash of the embedded text — drives skip-if-unchanged + copy-drift detection. */
export function contentHashFor(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** pgvector text literal "[a,b,...]" — the format PostgREST accepts for a vector column. */
export function toPgVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

/**
 * Parses a vector read back from PostgREST (a "[a,b,...]" string) or an already
 * decoded number[]. Returns null for malformed/empty values.
 */
export function parseVectorLiteral(raw: unknown): number[] | null {
  if (Array.isArray(raw)) {
    return raw.every((n) => typeof n === 'number') ? (raw as number[]) : null;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) && parsed.every((n) => typeof n === 'number')
        ? (parsed as number[])
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

interface EmbeddingResponse {
  data?: Array<{ index: number; embedding: number[] }>;
}

/**
 * Embeds texts in order, batching requests. Uses the shared openAIEmbeddings
 * client so provider/quota failures are classified as retryable and propagate
 * to the queue's retry path. Returns one vector per input in input order.
 */
export async function embedTexts(
  texts: string[],
  opts: { signal?: AbortSignal; retryProfile?: LlmRetryProfile } = {}
): Promise<number[][]> {
  const all: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const response = (await openAIEmbeddings({
      body: {
        model: EMBEDDING_MODEL,
        input: batch,
        dimensions: EMBEDDING_DIMENSIONS,
      },
      signal: opts.signal,
      retryProfile: opts.retryProfile ?? 'background',
    })) as EmbeddingResponse;

    const data = response.data;
    if (!data || data.length !== batch.length) {
      throw new Error(
        `Embeddings response shape mismatch: expected ${batch.length}, got ${data?.length ?? 0}`
      );
    }
    // The API may return items out of order; sort by index before collecting.
    const sorted = [...data].sort((a, b) => a.index - b.index);
    for (const item of sorted) all.push(item.embedding);
  }
  return all;
}
