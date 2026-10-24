import { z } from 'zod';

/**
 * Layer 3 (Brand Object) job family. The `brand_object_` prefix scopes the
 * partial unique dedupe index (idx_job_queue_brand_object_active_dedupe,
 * migration 0132); dedupe keys use the `bo_` prefix. Constants exist for the
 * whole DAG; BRAND_OBJECT_JOB_TYPES lists only types with a REGISTERED
 * processor (extended per milestone — an unregistered type in the claim list
 * would make getProcessor throw).
 *
 * DAG: build → crawl → identity → promote → market → personas → chunks;
 * the Layer-2 cluster-finalize hook feeds promote incrementally.
 */
export const BRAND_OBJECT_CRAWL_JOB_TYPE = 'brand_object_crawl';
export const BRAND_OBJECT_IDENTITY_JOB_TYPE = 'brand_object_identity';
export const BRAND_OBJECT_PROMOTE_JOB_TYPE = 'brand_object_promote';
export const BRAND_OBJECT_MARKET_JOB_TYPE = 'brand_object_market';
export const BRAND_OBJECT_PERSONAS_JOB_TYPE = 'brand_object_personas';
export const BRAND_OBJECT_CHUNKS_JOB_TYPE = 'brand_object_chunks';

export const BRAND_OBJECT_JOB_TYPES = [
  BRAND_OBJECT_CRAWL_JOB_TYPE,
  BRAND_OBJECT_IDENTITY_JOB_TYPE,
  BRAND_OBJECT_PROMOTE_JOB_TYPE,
  BRAND_OBJECT_MARKET_JOB_TYPE,
  BRAND_OBJECT_PERSONAS_JOB_TYPE,
  BRAND_OBJECT_CHUNKS_JOB_TYPE,
] as const;

/** Shared base — every brand-object payload is org + profile scoped. */
const baseFields = {
  organizationId: z.string().uuid(),
  brandProfileId: z.string().uuid(),
};

export const brandObjectPromotePayloadSchema = z.object({
  ...baseFields,
  /** Full-build chain: finalize enqueues the next DAG stage. */
  chain: z.boolean().optional().default(false),
});
export type BrandObjectPromotePayload = z.infer<
  typeof brandObjectPromotePayloadSchema
>;

export const brandObjectChunksPayloadSchema = z.object({
  ...baseFields,
});
export type BrandObjectChunksPayload = z.infer<
  typeof brandObjectChunksPayloadSchema
>;

export const brandObjectCrawlPayloadSchema = z.object({
  ...baseFields,
  force: z.boolean().optional().default(false),
  chain: z.boolean().optional().default(false),
});
export type BrandObjectCrawlPayload = z.infer<
  typeof brandObjectCrawlPayloadSchema
>;

export const brandObjectIdentityPayloadSchema = z.object({
  ...baseFields,
  /** R2 keys of the crawl pages to extract from. */
  crawlRefs: z.array(z.string()).optional().default([]),
  chain: z.boolean().optional().default(false),
});
export type BrandObjectIdentityPayload = z.infer<
  typeof brandObjectIdentityPayloadSchema
>;

export const brandObjectMarketPayloadSchema = z.object({
  ...baseFields,
  chain: z.boolean().optional().default(false),
});
export type BrandObjectMarketPayload = z.infer<
  typeof brandObjectMarketPayloadSchema
>;

export const brandObjectPersonasPayloadSchema = z.object({
  ...baseFields,
  chain: z.boolean().optional().default(false),
});
export type BrandObjectPersonasPayload = z.infer<
  typeof brandObjectPersonasPayloadSchema
>;
