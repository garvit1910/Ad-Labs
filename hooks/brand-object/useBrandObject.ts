'use client';

/**
 * React Query hooks for the Layer-3 Brand Object report surface. All reads
 * are POST-with-body (brand-presence family convention) against the
 * /api/brand-object/* AF routes; the AI narrative rides the org-scoped
 * synthesis route. The page is REPORT-ONLY — no decide/confirm hooks; the
 * decide API routes remain for MCP/agent corrections.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale } from 'next-intl';
import { getAuthHeaders } from '@/hooks/use-organization-queries/auth-headers';
import { applyLocalizedProse } from '@/lib/i18n/localized-synthesis';
import { brandPortfolioKey } from '@/hooks/brand-object/useBrandPortfolio';
import { useBrandIdentityScope } from '@/hooks/brand-object/useBrandIdentityScope';
import { useBrandReportEnabled } from '@/hooks/brand-object/useBrandReportEnabled';
import type {
  BrandObjectStatus,
  BrandSection,
  Completeness,
  EvidenceRef,
  FactMetrics,
} from '@/lib/brand-object/types';
import type {
  BrandSynthesis,
  BrandSynthesisStaleness,
} from '@/lib/brand-object/synthesis/types';
import type { OwnAdAngleMix } from '@/lib/brand-object/own-angles';
import { CodedError, errorCodeFromBody } from '@/lib/i18n/localize-error';
import { usePlanLimitPrompt } from '@/components/billing/PlanLimitDialog';

export interface BrandFactView {
  id: string;
  section: BrandSection;
  fact_key: string;
  statement: string;
  details: Record<string, unknown>;
  confidence: number;
  source: string;
  status: 'candidate' | 'confirmed';
  evidence: EvidenceRef[];
  metrics: FactMetrics;
  valid_from: string;
}

/** Server-side source of truth: loadBuildProgress in
 * app/api/brand-object/status/route.ts (route files must not export types). */
export interface BrandBuildProgress {
  competitors: { tagged: number; synced: number; syncing: number };
  listening: {
    keptMentions: number;
    activeJobs: number;
    activeSources: number;
  };
}

export interface BrandObjectStatusView {
  state: {
    status: BrandObjectStatus;
    completeness: Completeness | Record<string, never>;
    cost: Record<string, { llmCalls?: number }>;
  } | null;
  activeJobs: Array<{ type: string; status: string }>;
  progress?: BrandBuildProgress;
}

export interface BrandSynthesisView {
  /** The latest narrative — its prose already in the viewer's language when `translated`. */
  synthesis: BrandSynthesis | null;
  staleness: BrandSynthesisStaleness;
  /** True when the prose is an AI translation of the English narrative (i18n WS4). */
  translated?: boolean;
}

/** The GET's `data`: a non-English viewer also gets `localized` + `translated`. */
interface BrandSynthesisPayload extends BrandSynthesisView {
  localized?: Partial<BrandSynthesis> | null;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const headers = await getAuthHeaders();
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as {
    data?: T;
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
  return payload?.data as T;
}

async function getJson<T>(url: string): Promise<T> {
  const headers = await getAuthHeaders();
  const response = await fetch(url, { headers });
  const payload = (await response.json().catch(() => null)) as {
    data?: T;
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
  return payload?.data as T;
}

function useScope() {
  const scope = useBrandIdentityScope();
  return {
    organizationId: scope.organizationId,
    brandProfileId: scope.selectedProfileId,
    enabled: Boolean(scope.organizationId && scope.selectedProfileId),
  };
}

export function useBrandObjectStatus(options: { poll?: boolean } = {}) {
  const { organizationId, brandProfileId, enabled } = useScope();
  return useQuery({
    queryKey: ['brand-object', 'status', organizationId, brandProfileId],
    enabled,
    refetchInterval: options.poll ? 5000 : false,
    queryFn: () =>
      postJson<BrandObjectStatusView>('/api/brand-object/status', {
        organizationId,
        brandProfileId,
      }),
  });
}

/**
 * Refresh the report when the build settles: on the `activeJobs > 0 → 0`
 * TRANSITION (never on an initial mount already at 0 — the presence-hook
 * true→false pattern), invalidate the brand-object tree (facts, status,
 * synthesis) + the portfolio strip. Without this, `useBrandFacts` never
 * refetches while a build runs (it is only invalidated on build START), so
 * the report stayed empty until a manual reload even after the chain
 * finished.
 */
export function useBrandBuildSettleRefresh(
  status: BrandObjectStatusView | undefined,
) {
  const queryClient = useQueryClient();
  const { organizationId, brandProfileId } = useScope();
  const [wasBuilding, setWasBuilding] = useState(false);
  const buildingNow = (status?.activeJobs.length ?? 0) > 0;

  useEffect(() => {
    if (buildingNow) {
      if (!wasBuilding) setWasBuilding(true);
      return;
    }
    if (!wasBuilding) return;
    setWasBuilding(false);
    void queryClient.invalidateQueries({
      queryKey: ['brand-object'],
      predicate: (query) =>
        query.queryKey.includes(organizationId) &&
        query.queryKey.includes(brandProfileId),
    });
    void queryClient.invalidateQueries({
      queryKey: brandPortfolioKey(organizationId),
    });
  }, [buildingNow, wasBuilding, organizationId, brandProfileId, queryClient]);
}

export function useBrandFacts() {
  const { organizationId, brandProfileId, enabled } = useScope();
  return useQuery({
    queryKey: ['brand-object', 'facts', organizationId, brandProfileId],
    enabled,
    queryFn: () =>
      postJson<{
        facts: BrandFactView[];
        pendingSuggestionsByFactId: Record<string, number>;
      }>('/api/brand-object/facts', { organizationId, brandProfileId }),
  });
}

/**
 * The org's own advertised angle mix — Chapter 05's counterpart evidence for
 * the winning-angles column. ORG-scoped on purpose: `own_ad_labels` carries no
 * brand_profile_id, so keying this by profile would only fragment the cache
 * into identical copies. It is deliberately NOT invalidated by a Brand Object
 * build either — own ads are labeled by the nightly own-ad-label cron, and a
 * distillation run cannot change them.
 */
export function useOwnAdAngles() {
  const { organizationId } = useScope();
  // Org-scoped, so the profile-scope gate doesn't cover it: gate on the
  // report allowlist directly (the route 404s for everyone else).
  const reportEnabled = useBrandReportEnabled();
  return useQuery({
    queryKey: ['brand-object', 'own-ad-angles', organizationId],
    enabled: Boolean(organizationId) && reportEnabled,
    queryFn: () =>
      postJson<{ mix: OwnAdAngleMix }>('/api/brand-object/own-ad-angles', {
        organizationId,
      }),
  });
}

function useInvalidateBrandObject() {
  const queryClient = useQueryClient();
  const { organizationId, brandProfileId } = useScope();
  return () =>
    queryClient.invalidateQueries({
      queryKey: ['brand-object'],
      predicate: (query) =>
        query.queryKey.includes(organizationId) &&
        query.queryKey.includes(brandProfileId),
    });
}

/**
 * Arm + run the Brand Object build for a profile. The optional explicit
 * `brandProfileId` MUST win over the scope resolution: `useBrandIdentityScope`
 * pins demo orgs to the newest BUILT brand (liveFactCount > 0), so callers
 * acting on a specific brand (the setup wizard's own profile, the Creative
 * Studio blocked panel's selected brand) would otherwise silently rebuild the
 * already-built brand and never arm the new one. Scope resolution stays as
 * the fallback for the report page's Build/Refresh button, where acting on
 * the scope-resolved brand is the intent.
 */
export function useBuildBrandObject(brandProfileId?: string) {
  const scope = useScope();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateBrandObject();
  // Plan limit (402 on a brand's first build): the shell's plan-limit dialog
  // shows it; callers skip their own toast for it (`isBillingPromptError`).
  const { handleBillingError } = usePlanLimitPrompt({ feature: 'brand_identity_reports' });
  const targetProfileId = brandProfileId ?? scope.brandProfileId;
  return useMutation({
    mutationFn: (force?: boolean) =>
      postJson<{ jobId: string }>('/api/brand-object/build', {
        organizationId: scope.organizationId,
        brandProfileId: targetProfileId,
        force: force ?? false,
      }),
    onSuccess: () => {
      void invalidate();
      // The portfolio drives every "is a build running?" poll (its
      // refetchInterval only arms while activeJobTypes is non-empty), so it
      // must learn about the just-enqueued build immediately.
      void queryClient.invalidateQueries({
        queryKey: brandPortfolioKey(scope.organizationId),
      });
    },
    onError: (error) => {
      handleBillingError(error);
    },
  });
}

/** Latest AI Brand Narrative + a facts-fingerprint staleness verdict. */
export function useBrandSynthesis() {
  const { organizationId, brandProfileId, enabled } = useScope();
  const locale = useLocale();
  return useQuery({
    // The UI locale rides the key: the GET returns the prose in the viewer's language.
    queryKey: ['brand-object', 'synthesis', organizationId, brandProfileId, locale],
    enabled,
    queryFn: async (): Promise<BrandSynthesisView> => {
      const view = await getJson<BrandSynthesisPayload>(
        `/api/organizations/${organizationId}/brand-identity/synthesis?brandProfileId=${brandProfileId}`,
      );
      // Merge the translated prose over the English row, so the panel AND the brand
      // book export (`useBrandBookInput`) both read the viewer's language.
      const { row, translated } = applyLocalizedProse(view?.synthesis ?? null, view);
      return { synthesis: row, staleness: view?.staleness, translated };
    },
  });
}

/** Generate the AI Brand Narrative now (one gated LLM call, server cooldown). */
export function useRunBrandSynthesis() {
  const { organizationId, brandProfileId } = useScope();
  const invalidate = useInvalidateBrandObject();
  return useMutation({
    mutationFn: (input: { force?: boolean } = {}) =>
      postJson<BrandSynthesis>(
        `/api/organizations/${organizationId}/brand-identity/synthesis`,
        { brandProfileId, force: input.force ?? false },
      ),
    onSettled: () => void invalidate(),
  });
}
