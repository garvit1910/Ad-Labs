import { z } from 'zod';
import type { BrandMention } from './types';
import { PRESENCE_ROLES, THEME_KINDS } from './types';

const sourceStatusSchema = z
  .object({
    id: z.string(),
    source_type: z.string(),
    uri: z.string(),
    label: z.string().nullable(),
    status: z.string(),
    last_synced_at: z.string().nullable(),
    /** Resolved card parked on the founder-confirm gate (server-derived
     * from meta) — excluded from pipeline-activity indicators. */
    awaitingConfirm: z.boolean().optional(),
  })
  .passthrough();

const countsSchema = z
  .object({
    total: z.number(),
    kept: z.number(),
    brand: z.number(),
    brandKept: z.number(),
    competitor: z.number(),
    competitorKept: z.number(),
    category: z.number(),
    categoryKept: z.number(),
    relevant: z.number(),
    irrelevant: z.number(),
    pending: z.number(),
    topSubreddits: z.array(
      z.object({ subreddit: z.string(), count: z.number() }).passthrough(),
    ),
  })
  .passthrough();

export const brandPresenceStatusSchema = z
  .object({
    profileStatus: z.string().nullable(),
    sources: z.array(sourceStatusSchema),
    counts: countsSchema.nullable(),
    activeJobs: z.array(
      z
        .object({ id: z.string(), type: z.string(), status: z.string() })
        .passthrough(),
    ),
  })
  .passthrough();
export type BrandPresenceStatus = z.infer<typeof brandPresenceStatusSchema>;

const brandMentionSchema = z
  .object({
    id: z.string(),
    platform: z.string(),
    data_type: z.enum(['post', 'comment', 'review']),
    scope: z.enum(['brand', 'competitor', 'category']),
    relevance: z.enum(['pending', 'relevant', 'irrelevant', 'not_required']),
    title: z.string().nullable(),
    body: z.string().nullable(),
    url: z.string().nullable(),
    posted_at: z.string().nullable(),
  })
  .passthrough()
  .transform((value) => value as unknown as BrandMention);

export const mentionsListResponseSchema = z
  .object({
    mentions: z.array(brandMentionSchema),
    themesByMention: z
      .record(
        z.array(
          z
            .object({
              id: z.string(),
              label: z.string(),
              kind: z.string(),
            })
            .passthrough(),
        ),
      )
      .optional(),
    total: z.number(),
    page: z.number(),
    pageSize: z.number(),
    truncated: z.boolean().optional(),
  })
  .passthrough();
export type MentionsListResponse = z.infer<typeof mentionsListResponseSchema>;

export const mentionRoomsResponseSchema = z
  .object({
    rooms: z.array(
      z
        .object({
          parent: z
            .object({
              id: z.string(),
              externalId: z.string(),
              url: z.string(),
              caption: z.string().nullable(),
              postedAt: z.string().nullable(),
              commentCount: z.number(),
              commentsIngested: z.number(),
              kind: z.string().optional(),
            })
            .passthrough(),
          comments: z.array(brandMentionSchema),
          commentTotal: z.number(),
        })
        .passthrough(),
    ),
    total: z.number(),
    page: z.number(),
    pageSize: z.number(),
  })
  .passthrough();
export type MentionRoomsResponse = z.infer<typeof mentionRoomsResponseSchema>;

const themeRepresentativeSchema = z
  .object({
    id: z.string(),
    phrase: z.string(),
    paraphrase: z.string().nullable(),
    mention_id: z.string(),
  })
  .passthrough();
const themeSliceSchema = z
  .object({
    frequency: z.number(),
    mentionCount: z.number(),
    avgSentiment: z.number().nullable(),
    avgRating: z.number().nullable(),
    phrases: z.array(z.string()),
  })
  .passthrough();
export const brandThemeSchema = z
  .object({
    id: z.string(),
    kind: z.enum(THEME_KINDS),
    scope: z.enum(['brand', 'category']),
    label: z.string(),
    summary: z.string().nullable(),
    is_catchall: z.boolean(),
    frequency: z.number(),
    mention_count: z.number(),
    avg_sentiment: z.number().nullable(),
    representatives: z.array(themeRepresentativeSchema),
    slice: themeSliceSchema.nullable().optional(),
  })
  .passthrough();
export type BrandThemeWithReps = z.infer<typeof brandThemeSchema>;

/** One verbatim praise/complaint surfaced on the Pulse Overview. camelCase
 * (unlike the snake_case `brandMentionSchema`) — the highlights route projects
 * its own compact shape. `.passthrough()` keeps additive server fields safe. */
const highlightMentionSchema = z
  .object({
    id: z.string(),
    platform: z.string(),
    dataType: z.string(),
    title: z.string().nullable(),
    body: z.string(),
    url: z.string().nullable(),
    rating: z.number().nullable(),
    postedAt: z.string().nullable(),
    sentiment: z.number(),
    gist: z.string().nullable(),
  })
  .passthrough();
export type HighlightMention = z.infer<typeof highlightMentionSchema>;

export const brandHighlightsResponseSchema = z
  .object({
    negative: z.array(highlightMentionSchema),
    positive: z.array(highlightMentionSchema),
  })
  .passthrough();
export type BrandHighlightsResponse = z.infer<
  typeof brandHighlightsResponseSchema
>;

export const brandThemesResponseSchema = z
  .object({
    themes: z.array(brandThemeSchema),
    hookQuotes: z.array(
      z
        .object({
          id: z.string(),
          mention_id: z.string(),
          phrase: z.string(),
          sentiment: z.number().nullable(),
          scope: z.string(),
          created_at: z.string(),
        })
        .passthrough(),
    ),
    pendingExtraction: z.number(),
    extracting: z.boolean(),
    clustering: z.boolean(),
    reviewStats: z
      .object({
        total: z.number(),
        avgRating: z.number().nullable(),
        histogram: z.object({
          1: z.number(),
          2: z.number(),
          3: z.number(),
          4: z.number(),
          5: z.number(),
        }),
        verified: z.number().nullable(),
      })
      .passthrough()
      .nullable()
      .optional(),
    truncated: z.boolean().optional(),
  })
  .passthrough();
export type BrandThemesResponse = z.infer<typeof brandThemesResponseSchema>;

/** The Brand Identity report's competitive-landscape read
 * (`insights/competitive-landscape`). Mirrors `CompetitiveLandscape` in
 * `lib/brand-presence/competitive-landscape.ts`; `.passthrough()` keeps
 * additive server fields safe. */
const landscapeThemeSchema = z
  .object({
    kind: z.enum(THEME_KINDS),
    label: z.string(),
    summary: z.string().nullable(),
    frequency: z.number(),
    mentionCount: z.number(),
    avgSentiment: z.number().nullable(),
  })
  .passthrough();

const landscapeQuoteSchema = z
  .object({
    body: z.string(),
    platform: z.string(),
    url: z.string().nullable(),
    rating: z.number().nullable(),
    postedAt: z.string().nullable(),
    sentiment: z.number(),
  })
  .passthrough();

const landscapeSentimentSchema = z
  .object({
    score: z.number().nullable(),
    positivePct: z.number(),
    neutralPct: z.number(),
    negativePct: z.number(),
    scoredWeight: z.number(),
  })
  .passthrough();

const profileVoiceSchema = z
  .object({
    profileId: z.string(),
    brandName: z.string(),
    role: z.enum(PRESENCE_ROLES).nullable(),
    keptMentions: z.number(),
    platforms: z.array(
      z.object({ platform: z.string(), kept: z.number() }).passthrough(),
    ),
    sentiment: landscapeSentimentSchema.nullable(),
    themesByKind: z.object({
      pain: z.array(landscapeThemeSchema),
      desire: z.array(landscapeThemeSchema),
      objection: z.array(landscapeThemeSchema),
      praise: z.array(landscapeThemeSchema),
    }),
    topPraise: landscapeQuoteSchema.nullable(),
    topComplaint: landscapeQuoteSchema.nullable(),
    hookQuotes: z.array(z.string()),
    lastSyncedAt: z.string().nullable(),
  })
  .passthrough();

export const competitiveLandscapeResponseSchema = z
  .object({
    self: profileVoiceSchema,
    competitors: z.array(profileVoiceSchema),
    contrasts: z.array(
      z
        .object({
          competitorId: z.string(),
          kind: z.enum(['ahead', 'behind', 'level', 'unmeasured']),
          headline: z.string(),
          caption: z.string(),
        })
        .passthrough(),
    ),
    generatedAt: z.string(),
  })
  .passthrough();
export type CompetitiveLandscapeResponse = z.infer<
  typeof competitiveLandscapeResponseSchema
>;
