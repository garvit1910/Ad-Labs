/**
 * brand_object_chunks — maintains the DERIVED retrieval representation.
 * Live facts → chunk rows (lib/brand-object/chunks.ts): stale chunks
 * (superseded/rejected fact, or content changed) are DELETED — the one
 * sanctioned Layer-3 delete, themes-rebuild precedent — missing chunks are
 * inserted without vectors, then embedding waves fill them
 * (content_hash-idempotent; same-model stamp). Long backlogs pause via
 * FunctionTimeoutError (attempt-refunded) instead of self-re-enqueueing —
 * the per-brand dedupe key would resolve a self-enqueue to this very job.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildFactChunk, type BuiltChunk } from '@/lib/brand-object/chunks';
import { BRAND_OBJECT_CONFIG } from '@/lib/brand-object/config';
import {
  EMBEDDING_MODEL,
  embedTexts,
  toPgVectorLiteral,
} from '@/services/ad-library/embeddings';
import type { FunctionTimeoutTracker } from '../function-timeout';
import { FunctionTimeoutError } from '../function-timeout';
import type { Job } from '../types';
import { loadLiveFacts } from './fact-writer';
import { brandObjectChunksPayloadSchema } from './types';

const IN_CHUNK = 150;

export class BrandObjectChunksProcessor {
  constructor(private readonly _db: SupabaseClient) {}

  async process(
    job: Job,
    signal: AbortSignal,
    timeoutTracker?: FunctionTimeoutTracker,
  ): Promise<void> {
    const payload = brandObjectChunksPayloadSchema.parse(job.payload);
    const { organizationId, brandProfileId } = payload;
    const label = `[BrandObject] Chunks ${brandProfileId}`;

    const liveFacts = await loadLiveFacts(
      this._db,
      organizationId,
      brandProfileId,
    );
    const built = liveFacts.map((fact) => buildFactChunk(fact));
    const builtByFactHash = new Map(
      built.map((chunk) => [`${chunk.factId}:${chunk.contentHash}`, chunk]),
    );

    const { data: existingRows, error: existingError } = await this._db
      .from('brand_chunks')
      .select('id, fact_id, content_hash')
      .eq('organization_id', organizationId)
      .eq('brand_profile_id', brandProfileId);
    if (existingError) throw existingError;
    const existing = existingRows ?? [];
    const existingKeys = new Set(
      existing.map((row) => `${row.fact_id}:${row.content_hash}`),
    );

    // Delete stale chunk rows (fact no longer live, or content changed).
    const staleIds = existing
      .filter((row) => !builtByFactHash.has(`${row.fact_id}:${row.content_hash}`))
      .map((row) => String(row.id));
    for (let i = 0; i < staleIds.length; i += IN_CHUNK) {
      const chunk = staleIds.slice(i, i + IN_CHUNK);
      const { error } = await this._db
        .from('brand_chunks')
        .delete()
        .eq('organization_id', organizationId)
        .eq('brand_profile_id', brandProfileId)
        .in('id', chunk);
      if (error) throw error;
    }

    // Insert missing chunks (no vector yet).
    const missing: BuiltChunk[] = built.filter(
      (chunk) => !existingKeys.has(`${chunk.factId}:${chunk.contentHash}`),
    );
    if (missing.length > 0) {
      const { error } = await this._db.from('brand_chunks').insert(
        missing.map((chunk) => ({
          organization_id: organizationId,
          brand_profile_id: brandProfileId,
          fact_id: chunk.factId,
          content: chunk.content,
          section: chunk.section,
          persona_key: chunk.personaKey,
          awareness_stage: chunk.awarenessStage,
          source_type: chunk.sourceType,
          metadata: chunk.metadata,
          content_hash: chunk.contentHash,
        })),
      );
      if (error) throw error;
    }

    // Embedding waves until the backlog drains or the budget runs out.
    let embedded = 0;
    for (;;) {
      if (signal.aborted) throw new Error('Brand object job aborted');
      if (timeoutTracker?.shouldStop()) {
        throw new FunctionTimeoutError(
          'Function timeout - will resume on next cron',
        );
      }
      const { data: unembedded, error } = await this._db
        .from('brand_chunks')
        .select('id, content')
        .eq('organization_id', organizationId)
        .eq('brand_profile_id', brandProfileId)
        .is('embedding', null)
        .limit(BRAND_OBJECT_CONFIG.chunks.maxEmbedPerRun);
      if (error) throw error;
      const wave = unembedded ?? [];
      if (wave.length === 0) break;

      const vectors = await embedTexts(
        wave.map((row) => String(row.content)),
        { signal },
      );
      for (let i = 0; i < wave.length; i++) {
        const { error: updateError } = await this._db
          .from('brand_chunks')
          .update({
            embedding: toPgVectorLiteral(vectors[i]),
            embedding_model: EMBEDDING_MODEL,
          })
          .eq('id', wave[i].id)
          .eq('organization_id', organizationId);
        if (updateError) throw updateError;
      }
      embedded += wave.length;
      if (wave.length < BRAND_OBJECT_CONFIG.chunks.maxEmbedPerRun) break;
    }

    console.log(
      `${label}: ${built.length} live chunks (${missing.length} inserted, ${staleIds.length} stale deleted, ${embedded} embedded)`,
    );
  }
}
