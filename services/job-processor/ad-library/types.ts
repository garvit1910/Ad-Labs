import { z } from 'zod';

export const ADLIB_SYNC_COMPETITOR_JOB_TYPE = 'adlib_sync_competitor';
export const ADLIB_LABEL_BATCH_JOB_TYPE = 'adlib_label_batch';
export const ADLIB_EMBED_BATCH_JOB_TYPE = 'adlib_embed_batch';
export const ADLIB_MEDIA_REHOST_JOB_TYPE = 'adlib_media_rehost';

export const adlibSyncCompetitorPayloadSchema = z.object({
  organizationId: z.string().uuid(),
  competitorId: z.string().uuid(),
});

export type AdlibSyncCompetitorPayload = z.infer<
  typeof adlibSyncCompetitorPayloadSchema
>;

export const adlibLabelBatchPayloadSchema = z.object({
  organizationId: z.string().uuid(),
  libraryAdIds: z.array(z.string().uuid()).min(1),
});

export type AdlibLabelBatchPayload = z.infer<
  typeof adlibLabelBatchPayloadSchema
>;

export const adlibEmbedBatchPayloadSchema = z.object({
  organizationId: z.string().uuid(),
  libraryAdIds: z.array(z.string().uuid()).min(1),
});

export type AdlibEmbedBatchPayload = z.infer<
  typeof adlibEmbedBatchPayloadSchema
>;

export const adlibMediaRehostPayloadSchema = z.object({
  organizationId: z.string().uuid(),
  libraryAdIds: z.array(z.string().uuid()).min(1),
});

export type AdlibMediaRehostPayload = z.infer<
  typeof adlibMediaRehostPayloadSchema
>;
