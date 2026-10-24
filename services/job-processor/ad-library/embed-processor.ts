import type { SupabaseClient } from '@supabase/supabase-js';
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  contentHashFor,
  embedTexts,
  primaryBody,
  toPgVectorLiteral,
} from '@/services/ad-library/embeddings';
import type { Job } from '../types';
import { adlibEmbedBatchPayloadSchema } from './types';

interface AdToEmbed {
  id: string;
  creative_bodies: string[] | null;
}

interface ExistingEmbedding {
  library_ad_id: string;
  embedding_model: string;
  content_hash: string;
}

/**
 * A sibling org's already-computed embedding row, read back over PostgREST.
 * `embedding` is the pgvector TEXT LITERAL ("[a,b,...]") — copied VERBATIM as an
 * opaque string; never parsed or re-serialized (a round-trip through JS would
 * lose precision and change the vector).
 */
interface SiblingEmbedding {
  content_hash: string;
  embedding_model: string;
  embedding: string;
  embedding_dims: number;
}

/** Max ids per PostgREST `.in()` filter to stay within URL/statement limits. */
const HASH_LOOKUP_CHUNK = 100;

/**
 * adlib_embed_batch — embeds a batch of library ads' primary creative body and
 * upserts ad_embeddings rows (idempotent: ads whose existing row already
 * matches the current model + content hash are skipped, upsert is keyed on
 * library_ad_id). One vector per ad; the vector + model + dims + content hash
 * are stored together so a future model swap is detectable and read-time
 * clustering only compares same-model vectors.
 */
export class AdLibraryEmbedBatchProcessor {
  constructor(private readonly _db: SupabaseClient) {}

  async process(job: Job, signal: AbortSignal): Promise<void> {
    const { organizationId, libraryAdIds } = adlibEmbedBatchPayloadSchema.parse(
      job.payload
    );

    const { data: ads, error: adsError } = await this._db
      .from('library_ads')
      .select('id, creative_bodies')
      .eq('organization_id', organizationId)
      .in('id', libraryAdIds);
    if (adsError) throw adsError;

    const { data: existing, error: existingError } = await this._db
      .from('ad_embeddings')
      .select('library_ad_id, embedding_model, content_hash')
      .eq('organization_id', organizationId)
      .in('library_ad_id', libraryAdIds);
    if (existingError) throw existingError;
    const existingById = new Map(
      ((existing ?? []) as ExistingEmbedding[]).map((row) => [
        String(row.library_ad_id),
        row,
      ])
    );

    // Resolve the text to embed per ad, dropping ads with no copy and ads whose
    // current embedding already matches (same model + same content hash).
    const pending: Array<{ id: string; text: string; hash: string }> = [];
    for (const ad of (ads ?? []) as AdToEmbed[]) {
      const text = primaryBody(ad.creative_bodies);
      if (!text) continue;
      const hash = contentHashFor(text);
      const prior = existingById.get(ad.id);
      if (prior && prior.embedding_model === EMBEDDING_MODEL && prior.content_hash === hash) {
        continue;
      }
      pending.push({ id: ad.id, text, hash });
    }

    if (pending.length === 0) {
      console.log(`[AdLibEmbed] Job ${job.id}: nothing to embed (all current or no copy)`);
      return;
    }

    const nowIso = new Date().toISOString();

    // Cross-org reuse: embeddings are a pure function of (model, content), so the
    // same public ad tracked by another org already has an identical-hash row we
    // can copy instead of paying OpenAI again. Fails OPEN — any error here warns
    // and falls through to embedding every remaining ad normally.
    const copied = await this.copySiblingEmbeddings(pending, organizationId, nowIso, job.id);
    const toEmbed = pending.filter((p) => !copied.has(p.id));

    if (toEmbed.length === 0) {
      console.log(
        `[AdLibEmbed] Job ${job.id}: reused ${copied.size}/${libraryAdIds.length} sibling embeddings, none left for OpenAI`
      );
      return;
    }

    // Retryable provider failures (LlmProviderError.retryable) propagate so the
    // queue retries the job up to max_attempts.
    const vectors = await embedTexts(
      toEmbed.map((p) => p.text),
      { signal }
    );

    const rows = toEmbed.map((p, i) => ({
      organization_id: organizationId,
      library_ad_id: p.id,
      embedding: toPgVectorLiteral(vectors[i]),
      embedding_model: EMBEDDING_MODEL,
      embedding_dims: EMBEDDING_DIMENSIONS,
      content_hash: p.hash,
      embedded_at: nowIso,
      updated_at: nowIso,
    }));

    const { error: upsertError } = await this._db
      .from('ad_embeddings')
      .upsert(rows, { onConflict: 'library_ad_id' });
    if (upsertError) throw upsertError;

    console.log(
      `[AdLibEmbed] Job ${job.id}: embedded ${rows.length}/${libraryAdIds.length} ads with ${EMBEDDING_MODEL}` +
        (copied.size > 0 ? ` (reused ${copied.size} sibling embeddings)` : '')
    );
  }

  /**
   * Copies any sibling org's ad_embeddings row whose (content_hash, model)
   * matches a pending ad, upserting a row for OUR ad. Returns the set of pending
   * ad ids successfully copied (excluded from the OpenAI call). Fails OPEN: on
   * any read/write error it warns and returns whatever was copied so far, so the
   * remaining ads fall through to normal embedding — the copy is a cost
   * optimization, never a correctness dependency.
   */
  private async copySiblingEmbeddings(
    pending: Array<{ id: string; text: string; hash: string }>,
    organizationId: string,
    nowIso: string,
    jobId: string
  ): Promise<Set<string>> {
    const copied = new Set<string>();
    try {
      // First sibling row per hash (embeddings are model-deterministic, so any
      // matching hash+model row is interchangeable — dedupe to one).
      const byHash = new Map<string, SiblingEmbedding>();
      const hashes = [...new Set(pending.map((p) => p.hash))];
      for (let i = 0; i < hashes.length; i += HASH_LOOKUP_CHUNK) {
        const chunk = hashes.slice(i, i + HASH_LOOKUP_CHUNK);
        // No organization_id filter: the service-role client sees all orgs and a
        // matching hash+model from ANY org is a valid copy source.
        const { data, error } = await this._db
          .from('ad_embeddings')
          .select('content_hash, embedding_model, embedding, embedding_dims')
          .eq('embedding_model', EMBEDDING_MODEL)
          .in('content_hash', chunk);
        if (error) throw error;
        for (const row of (data ?? []) as SiblingEmbedding[]) {
          if (!byHash.has(row.content_hash)) byHash.set(row.content_hash, row);
        }
      }

      // Copy the vector literal VERBATIM as an opaque string for our ad.
      const rows = pending
        .map((p) => {
          const sib = byHash.get(p.hash);
          if (!sib) return null;
          copied.add(p.id);
          return {
            organization_id: organizationId,
            library_ad_id: p.id,
            embedding: sib.embedding,
            embedding_model: sib.embedding_model,
            embedding_dims: sib.embedding_dims,
            content_hash: sib.content_hash,
            embedded_at: nowIso,
            updated_at: nowIso,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      if (rows.length > 0) {
        const { error: upsertError } = await this._db
          .from('ad_embeddings')
          .upsert(rows, { onConflict: 'library_ad_id' });
        if (upsertError) throw upsertError;
      }

      return copied;
    } catch (err) {
      console.warn(
        `[AdLibEmbed] Job ${jobId}: sibling embedding copy failed, embedding remaining ads directly`,
        err
      );
      // Reset so ambiguous partial state can't skip an OpenAI embedding: any ad
      // we don't have a proven upserted row for is re-embedded below.
      copied.clear();
      return copied;
    }
  }
}
