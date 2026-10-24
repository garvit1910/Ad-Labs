'use client';

/**
 * Org-level Brand Object portfolio read (agency multi-brand): one row per
 * brand profile with report health. Feeds the Manage Brands strip AND the
 * source-nav completion dots — both consumers share this single org-keyed
 * cache entry, so the layout adds zero extra requests. Polls only while some
 * brand has an active build chain.
 */
import { useQuery } from '@tanstack/react-query';
import { useOrganization } from '@/contexts/OrganizationContext';
import { getAuthHeaders } from '@/hooks/use-organization-queries/auth-headers';
import { useBrandReportEnabled } from '@/hooks/brand-object/useBrandReportEnabled';
import { CodedError, errorCodeFromBody } from '@/lib/i18n/localize-error';

export interface BrandPortfolioProfile {
  profileId: string;
  brandName: string;
  websiteUrl: string | null;
  profileStatus: 'draft' | 'confirmed';
  boStatus: string | null;
  completenessOverall: number | null;
  liveFactCount: number;
  activeJobTypes: string[];
  taggedCompetitorCount: number;
}

export interface BrandPortfolioView {
  orgCompetitorCount: number;
  profiles: BrandPortfolioProfile[];
}

export function brandPortfolioKey(organizationId: string | undefined) {
  return ['brand-object', 'portfolio', organizationId] as const;
}

async function fetchPortfolio(
  organizationId: string,
): Promise<BrandPortfolioView> {
  const headers = await getAuthHeaders();
  const response = await fetch('/api/brand-object/portfolio', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ organizationId }),
  });
  const payload = (await response.json().catch(() => null)) as {
    data?: BrandPortfolioView;
    reason?: string;
  } | null;
  if (!response.ok) {
    // CodedError keeps the English message and adds `code`/`status` so the
    // render site can localize it (`useLocalizeError`).
    throw new CodedError(payload?.reason ?? `Request failed (${response.status})`, {
      code: errorCodeFromBody(payload),
      status: response.status,
    });
  }
  return payload?.data ?? { orgCompetitorCount: 0, profiles: [] };
}

export function useBrandPortfolio() {
  const { currentOrganization } = useOrganization();
  const organizationId = currentOrganization?.id;
  // The portfolio route 404s off the Brand Presence allowlist, and the section
  // nav mounts this on every Brand Identity page - never fire it there.
  const reportEnabled = useBrandReportEnabled();

  return useQuery({
    queryKey: brandPortfolioKey(organizationId),
    enabled: !!organizationId && reportEnabled,
    staleTime: 30_000,
    queryFn: () => fetchPortfolio(organizationId as string),
    // Poll only while a build chain is draining somewhere in the portfolio.
    refetchInterval: (query) =>
      (query.state.data?.profiles ?? []).some(
        (profile) => profile.activeJobTypes.length > 0,
      )
        ? 15_000
        : false,
  });
}
