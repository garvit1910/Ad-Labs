/**
 * React Query key builders for the Brand Presence hooks. Internal to
 * `use-brand-presence/` — deliberately NOT re-exported from the public
 * `useBrandPresence` barrel. Other components share these caches, so the key
 * VALUES are a contract: never reshape an array here without migrating every
 * reader (pinned by `tests/unit/hooks/brand-presence/use-brand-presence-split.test.ts`).
 */

/** Root of every Brand Presence key — invalidating it refreshes everything. */
export const brandPresenceRootKey = () => ['brand-presence'] as const;

export const sourcesKey = (
  organizationId: string | undefined,
  brandProfileId: string | undefined,
) => ['brand-presence', 'sources', organizationId, brandProfileId] as const;
export const statusKey = (
  organizationId: string | undefined,
  brandProfileId: string | undefined,
) => ['brand-presence', 'status', organizationId, brandProfileId] as const;
export const activityStatusKey = (
  organizationId: string | undefined,
  brandProfileId: string | undefined,
) => [...statusKey(organizationId, brandProfileId), 'activity'] as const;
export const statsStatusKey = (
  organizationId: string | undefined,
  brandProfileId: string | undefined,
) => [...statusKey(organizationId, brandProfileId), 'full'] as const;
export const mentionsKey = (
  organizationId: string | undefined,
  brandProfileId: string | undefined,
  filters: Record<string, unknown>,
) =>
  ['brand-presence', 'mentions', organizationId, brandProfileId, filters] as const;
export const threadsKey = (
  organizationId: string | undefined,
  brandProfileId: string | undefined,
  params: Record<string, unknown>,
) =>
  ['brand-presence', 'threads', organizationId, brandProfileId, params] as const;
export const roomsKey = (
  organizationId: string | undefined,
  brandProfileId: string | undefined,
  params: Record<string, unknown>,
) => ['brand-presence', 'rooms', organizationId, brandProfileId, params] as const;
export const insightsKey = (
  organizationId: string | undefined,
  brandProfileId: string | undefined,
) => ['brand-presence', 'insights', organizationId, brandProfileId] as const;
export const amazonProductsKey = (
  organizationId: string | undefined,
  brandProfileId: string | undefined,
) =>
  ['brand-presence', 'amazon-products', organizationId, brandProfileId] as const;
export const googlePlaceKey = (
  organizationId: string | undefined,
  brandProfileId: string | undefined,
) =>
  ['brand-presence', 'google-place', organizationId, brandProfileId] as const;
export const googleInsightsKey = (
  organizationId: string | undefined,
  brandProfileId: string | undefined,
) =>
  ['brand-presence', 'google-insights', organizationId, brandProfileId] as const;
export const trustpilotKey = (
  organizationId: string | undefined,
  brandProfileId: string | undefined,
) =>
  ['brand-presence', 'trustpilot-page', organizationId, brandProfileId] as const;
export const tiktokKey = (
  organizationId: string | undefined,
  brandProfileId: string | undefined,
) =>
  ['brand-presence', 'tiktok-profile', organizationId, brandProfileId] as const;
export const instagramKey = (
  organizationId: string | undefined,
  brandProfileId: string | undefined,
) =>
  [
    'brand-presence',
    'instagram-profile',
    organizationId,
    brandProfileId,
  ] as const;
export const themesKey = (
  organizationId: string | undefined,
  brandProfileId: string | undefined,
  scope?: string,
) =>
  ['brand-presence', 'themes', organizationId, brandProfileId, scope] as const;
export const highlightsKey = (
  organizationId: string | undefined,
  brandProfileId: string | undefined,
  limit: number,
) =>
  ['brand-presence', 'highlights', organizationId, brandProfileId, limit] as const;
export const themeMentionsKey = (
  organizationId: string | undefined,
  brandProfileId: string | undefined,
  themeId: string | undefined,
  page: number,
) =>
  [
    'brand-presence',
    'theme-mentions',
    organizationId,
    brandProfileId,
    themeId,
    page,
  ] as const;

// Prefix builders for broad (fuzzy) invalidation: each is a strict prefix of
// the matching full builder above, so it matches every filter/page/scope
// variant cached for one org + brand profile.

export const mentionsPrefixKey = (
  organizationId: string | undefined,
  brandProfileId: string | undefined,
) => ['brand-presence', 'mentions', organizationId, brandProfileId] as const;
export const threadsPrefixKey = (
  organizationId: string | undefined,
  brandProfileId: string | undefined,
) => ['brand-presence', 'threads', organizationId, brandProfileId] as const;
export const roomsPrefixKey = (
  organizationId: string | undefined,
  brandProfileId: string | undefined,
) => ['brand-presence', 'rooms', organizationId, brandProfileId] as const;
export const themesPrefixKey = (
  organizationId: string | undefined,
  brandProfileId: string | undefined,
) => ['brand-presence', 'themes', organizationId, brandProfileId] as const;
export const highlightsPrefixKey = (
  organizationId: string | undefined,
  brandProfileId: string | undefined,
) => ['brand-presence', 'highlights', organizationId, brandProfileId] as const;
