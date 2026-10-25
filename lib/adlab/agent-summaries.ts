import type { SupabaseClient } from '@supabase/supabase-js';
import { identityClaims, priorsByDimension, topVocBySection, type InsightFact, type VocInsightRow } from '@/lib/brand-object/insights';
import { loadLiveBrandFacts } from '@/lib/brand-object/live-facts';
import { firstRealBody } from '@/lib/brand-identity/creative-text';
import { slugify } from '@/lib/creative-engine/brand-context/ingest';
import { checkA4Rows, readA4Tables } from '@/worker/creatives/check';
import { loadClientRows } from '@/worker/creatives/facts';
import { roundZeroStatusOf } from '@/worker/creatives/run';
import { readSegments } from './agent-api';
import { loadBrandProfile } from './brand-profile';
import { ADLAB_ORG_ID } from './org';
import { buildCompetitorDashboard, listCompetitorsWithCounts } from './pages/ads';
import { feedHeadline } from './sim-text';
import type { Spacetime } from './spacetime-http';

/*
 * What the Scout and the Strategist read before planning (docs/AGENT_API.md): the brand's own
 * story from its live brand facts, the competitors from the same code as the Competitor Analysis
 * page, and whether A4's rows and round 0 are ready for a run.
 */

export interface SummaryDeps {
  spacetime: Spacetime;
  db: SupabaseClient;
}

const MEMO_MS = 5 * 60_000;
type Memo = Map<string, { at: number; value: Promise<unknown> }>;
const memo: Memo = ((globalThis as { __adlabSummaryMemo?: Memo }).__adlabSummaryMemo ??= new Map());

/** Caches `fn` for 5 minutes per key (per process); `fresh` recomputes. A failure is never cached. */
export function memoized<T>(key: string, fresh: boolean, fn: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (!fresh && hit && Date.now() - hit.at < MEMO_MS) return hit.value as Promise<T>;
  const value = fn().catch((err: unknown) => {
    memo.delete(key);
    throw err;
  });
  memo.set(key, { at: Date.now(), value });
  return value;
}

// ── Brand ────────────────────────────────────────────────────────────────────

export interface VocItem {
  label: string;
  quote: string;
  frequency: number;
  platforms: string[];
}

export interface BrandSummary {
  brand: { name: string; positioning: string; proof_points: string[] };
  pains: VocItem[];
  desires: VocItem[];
  objections: VocItem[];
  personas: Array<{ segment_id: string; name: string; share: number }>;
}

const vocItem = (row: VocInsightRow): VocItem => ({
  label: row.label,
  quote: row.verbatim ?? '',
  frequency: row.frequency,
  platforms: row.platforms.map((p) => p.platform),
});

/** Magic Spoon's positioning, proof points and top customer voice, plus the segments the sim uses. */
export function brandSummaryOf(name: string, facts: InsightFact[], segments: BrandSummary['personas']): BrandSummary {
  const voc = topVocBySection(facts, 3);
  return {
    brand: {
      name,
      positioning: identityClaims(facts, ['positioning'], 1)[0]?.statement ?? '',
      proof_points: identityClaims(facts, ['proof_point'], 3).map((claim) => claim.statement),
    },
    pains: (voc.voc_pain ?? []).map(vocItem),
    desires: (voc.voc_desire ?? []).map(vocItem),
    objections: (voc.voc_objection ?? []).map(vocItem),
    personas: segments,
  };
}

export function brandSummary(deps: SummaryDeps, opts: { fresh?: boolean } = {}): Promise<BrandSummary> {
  return memoized('brand', Boolean(opts.fresh), async () => {
    const profile = await loadBrandProfile(deps.db);
    const [facts, segments] = await Promise.all([
      loadLiveBrandFacts(deps.db, { organizationId: ADLAB_ORG_ID, brandProfileId: profile.id }),
      readSegments(deps.spacetime),
    ]);
    return brandSummaryOf(profile.brand_name, facts, segments);
  });
}

// ── Competitors ──────────────────────────────────────────────────────────────

export interface CompetitorSummary {
  competitors: Array<{ name: string; ads: number; winners: number }>;
  winners: Array<{ brand: string; angle: string; hook: string; headline: string; days_running: number; image_url: string; creative_id: string }>;
  patterns: Array<{ concept: string; share: number }>;
}

const firstSentence = (text: string) => text.split(/(?<=[.!?])\s|\n/)[0]?.trim() ?? text;

/** The market_prior facts as "dimension: value" patterns with their share of winning concepts (0..1), top 3 per dimension. */
export function patternsOf(facts: InsightFact[]): CompetitorSummary['patterns'] {
  return priorsByDimension(facts).flatMap((group) =>
    group.rows.slice(0, 3).map((row) => ({
      concept: `${group.key}: ${row.value}`,
      share: Math.round((row.share > 1 ? row.share / 100 : row.share) * 1000) / 1000,
    })),
  );
}

/**
 * The seven competitors with the Competitor Analysis page's own counts (self excluded), its top
 * six winners by win score, and the market's winning patterns. creative_id is the winner's live
 * creative row in SpacetimeDB (A4's `cr_live_<page>_<ad>`), or "" when A4 didn't keep it.
 */
export function competitorSummary(deps: SummaryDeps, opts: { fresh?: boolean } = {}): Promise<CompetitorSummary> {
  return memoized('competitors', Boolean(opts.fresh), async () => {
    const profile = await loadBrandProfile(deps.db);
    const [competitors, dashboard, facts, liveIds] = await Promise.all([
      listCompetitorsWithCounts(deps.db),
      buildCompetitorDashboard(deps.db, { platform: 'all' }),
      loadLiveBrandFacts(deps.db, { organizationId: ADLAB_ORG_ID, brandProfileId: profile.id }),
      deps.spacetime
        .sql<{ creative_id: string }>("SELECT * FROM creative WHERE origin = 'competitor_live'")
        .then((rows) => new Set(rows.map((row) => row.creative_id)))
        .catch(() => new Set<string>()),
    ]);
    const nameOf = new Map(competitors.map((c) => [String(c.id), c.name ?? c.meta_page_name ?? 'Unknown']));
    return {
      competitors: competitors
        .map((c) => ({ name: c.name ?? c.meta_page_name ?? 'Unknown', ads: c.adCount, winners: c.winnerCount }))
        .sort((a, b) => b.ads - a.ads || a.name.localeCompare(b.name)),
      winners: dashboard.winners.slice(0, 6).map(({ ad }) => {
        const brand = nameOf.get(String(ad.competitor_id)) ?? 'Unknown';
        const body = firstRealBody(ad.creative_bodies) ?? '';
        const liveId = `cr_live_${slugify(brand)}_${slugify(ad.external_ad_id)}`;
        return {
          brand,
          angle: ad.angle ?? '',
          hook: ad.hook_archetype ?? '',
          headline: feedHeadline(firstRealBody(ad.creative_link_titles) || ad.hook_text?.trim() || firstSentence(body)),
          days_running: Math.max(0, Math.round(Number(ad.longevity_days ?? 0))),
          image_url: ad.hosted_media_urls?.find((url): url is string => Boolean(url)) ?? ad.media_urls?.[0] ?? '',
          creative_id: liveIds.has(liveId) ? liveId : '',
        };
      }),
      patterns: patternsOf(facts),
    };
  });
}

// ── Contract check ───────────────────────────────────────────────────────────

export interface ContractBuildResult {
  recipes: Array<{ arm_id: string; strategy: string; angle: string; hook: string; rationale: string }>;
  segments: Array<{ segment_id: string; name: string; share: number }>;
  check: { ok: boolean; failures: string[]; warnings: string[] };
  round0: { complete: boolean; expected: number; ranked: number; gated_out: number; problems: string[] };
}

/** A4's rows checked the way A4 and A5 check them, and whether round 0 is complete. Writes nothing. */
export async function contractCheck(deps: SummaryDeps): Promise<ContractBuildResult> {
  const [tables, client] = await Promise.all([readA4Tables(deps.spacetime), loadClientRows(deps.db)]);
  const check = checkA4Rows(tables, client.rows);
  const round0 = roundZeroStatusOf(tables, client.rows);
  return {
    recipes: [...tables.arms]
      .filter((arm) => arm.strategy !== 'control')
      .sort((a, b) => (a.arm_id < b.arm_id ? -1 : 1))
      // ContractWorld's arm type leaves rationale out; the SQL row has it.
      .map((arm) => ({ arm_id: arm.arm_id, strategy: arm.strategy, angle: arm.angle, hook: arm.hook, rationale: String((arm as { rationale?: unknown }).rationale ?? '') })),
    segments: check.segments,
    check: { ok: check.failures.length === 0, failures: check.failures, warnings: check.warnings },
    round0: {
      complete: round0.complete,
      expected: round0.expected,
      ranked: round0.ranked.length,
      gated_out: round0.gatedOut.length,
      problems: round0.problems,
    },
  };
}
