'use client';

/**
 * The active brand for the BRAND IDENTITY report.
 *
 * For most orgs this is just the shared active-brand scope
 * (`useBrandProfileScope`) — switched via Brand Presence. For a pinned demo
 * org (Nimbus), the report is pinned to the brand that actually has a built
 * report (the newest profile with live facts), regardless of which brand is
 * selected in Brand Presence, because Brand Identity has no switcher of its
 * own and Nimbus runs report-less brands in its Brand Presence portfolio. See
 * `lib/brand-object/brand-identity-brand-pin.ts`.
 *
 * The pin needs the portfolio's per-brand report health (`liveFactCount`), so
 * while that resolves it reports "loading" and defers the report's data reads
 * rather than briefly resolving the wrong (report-less) brand and flashing the
 * build card.
 */
import { useMemo } from 'react';
import {
  useBrandProfileScope,
  type BrandProfileScope,
} from '@/hooks/brand-presence/useBrandProfileScope';
import { useBrandPortfolio } from '@/hooks/brand-object/useBrandPortfolio';
import type { BrandPortfolioProfile } from '@/hooks/brand-object/useBrandPortfolio';
import { isBrandIdentityPinnedToBuiltBrand } from '@/lib/brand-object/brand-identity-brand-pin';

/**
 * Pure resolution of the Brand Identity report scope from the shared scope +
 * the portfolio's report-health rows. Kept pure and unit-tested; the hook is a
 * thin wrapper. `portfolioProfiles` is `null` while the portfolio is still
 * loading (distinct from `[]` = loaded-but-empty).
 */
export function resolveBrandIdentityScope(params: {
  scope: BrandProfileScope;
  portfolioProfiles: BrandPortfolioProfile[] | null;
}): BrandProfileScope {
  const { scope, portfolioProfiles } = params;

  if (!isBrandIdentityPinnedToBuiltBrand(scope.organizationId)) return scope;

  // Portfolio (report health) still loading: defer — don't resolve a
  // report-less brand and flash the build card. Nulling the selection also
  // holds the brand-object data reads until we know the pinned brand.
  if (portfolioProfiles === null) {
    return {
      ...scope,
      selectedProfileId: undefined,
      selectedProfile: null,
      isLoading: true,
      isReady: false,
    };
  }

  const builtIds = new Set(
    portfolioProfiles
      .filter((profile) => profile.liveFactCount > 0)
      .map((profile) => profile.profileId),
  );
  // `scope.profiles` is newest-first; take the newest brand with a report.
  const built = scope.profiles.find((profile) => builtIds.has(profile.id));
  // Nothing built yet, or the shared selection already points at the built
  // brand — leave the shared scope untouched.
  if (!built || built.id === scope.selectedProfileId) return scope;

  return {
    ...scope,
    selectedProfileId: built.id,
    selectedProfile: built,
  };
}

export function useBrandIdentityScope(): BrandProfileScope {
  const scope = useBrandProfileScope();
  const portfolio = useBrandPortfolio();
  // `null` = still loading (defer). On error (settled, no data) fall back to
  // `[]` so the resolver degrades to the shared scope rather than deferring
  // forever.
  const portfolioProfiles =
    portfolio.data?.profiles ?? (portfolio.isLoading ? null : []);

  return useMemo(
    () => resolveBrandIdentityScope({ scope, portfolioProfiles }),
    [scope, portfolioProfiles],
  );
}
