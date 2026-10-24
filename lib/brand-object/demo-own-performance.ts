/**
 * Demo-only synthetic own-ad performance for the "What's working for you"
 * chapter.
 *
 * Same reason, same gate and same call sites as `demo-own-angles.ts`: the
 * pinned demo orgs report on Magic Spoon, a demo brand with no connected ad
 * account, so `own_ad_labels` + `ad_daily_metrics` are empty and the chapter
 * would never render. For those orgs ONLY (`isBrandIdentityPinnedToBuiltBrand`,
 * applied by `effectiveOwnPerformance` at the exact places `demoOwnAngleMix`
 * is applied) this fabricates a coherent synthetic model. It must NEVER be
 * used for a real org, whose empty read is the honest "nothing labeled yet".
 *
 * Coherence with Chapter 05: the angles and their AD COUNTS are taken verbatim
 * from `demoOwnAngleMix(market)` — the mix Chapter 05's "Your angles" column
 * shows — so the two chapters can never disagree about what the brand runs.
 * Hooks, formats and offers are taken from the market formula's own top
 * segments, with fixed taxonomy tokens only when a dimension is missing.
 *
 * Deterministic: no randomness, no clock in the numbers. The synthetic rows
 * run through the REAL `buildOwnPerformanceModel`, so the demo shows exactly
 * the arithmetic a real org gets. Flagged `demo: true` (the panel shows a
 * "Demo data" chip).
 */
import type { MarketFormulaStep } from './insights';
import { demoOwnAngleMix } from './demo-own-angles';
import {
  buildOwnPerformanceModel,
  isOwnPerformanceEmpty,
  type OwnPerformanceInputRow,
  type OwnPerformanceModel,
} from './own-performance';

const DEMO_WINDOW_DAYS = 30;
const DEMO_CURRENCY = 'USD';

/** Fallback tokens (label-taxonomy vocabulary) when the market lacks a step. */
const FALLBACK_HOOKS = ['problem_callout', 'testimonial'];
const FALLBACK_FORMATS = ['ugc', 'product_demo'];
const FALLBACK_OFFERS = ['subscribe_save'];
const DEMO_PERSONAS = ['professionals', 'parents_family'];
const DEMO_FUNNEL_STAGES = ['tof_problem', 'mof_solution', 'bof_offer'];

/**
 * Per-angle economics, by the angle's position in the mix: the top winning
 * angle the brand runs returns best, the signature own-only angle spends
 * steadily at a weaker return — a story the chapter can tell honestly.
 */
const ANGLE_PROFILES = [
  { spendPerAd: 420, roas: 3.4, cpa: 34 },
  { spendPerAd: 300, roas: 2.2, cpa: 48 },
  { spendPerAd: 260, roas: 1.5, cpa: 66 },
];

/** Spend the demo's unlabeled ads add on top, as a share of labeled spend. */
const DEMO_UNLABELED_SPEND_SHARE = 0.16;
const DEMO_UNLABELED_ADS = 3;

function stepValues(
  market: MarketFormulaStep[],
  key: MarketFormulaStep['key'],
  fallback: string[],
): string[] {
  const values = (market.find((step) => step.key === key)?.segments ?? [])
    .slice(0, 2)
    .map((segment) => segment.value);
  return values.length > 0 ? values : fallback;
}

/** Small deterministic spread so ads in one angle are not identical. */
function spread(index: number): number {
  return 1 + (((index * 7) % 5) - 2) * 0.06;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Synthesize the demo model from the computed market formula. Returns null
 * when there are no winning angles to build against (the same null
 * `demoOwnAngleMix` returns), so an un-run competitor analysis keeps the
 * chapter hidden.
 */
export function demoOwnPerformance(
  market: MarketFormulaStep[],
  now: Date = new Date(),
): OwnPerformanceModel | null {
  const mix = demoOwnAngleMix(market);
  if (!mix) return null;
  const angles = Object.entries(mix.byAngle).filter(([, count]) => count > 0);
  if (angles.length === 0) return null;

  const hooks = stepValues(market, 'hook_archetype', FALLBACK_HOOKS);
  const formats = stepValues(market, 'format', FALLBACK_FORMATS);
  const offers = stepValues(market, 'offer_type', FALLBACK_OFFERS);

  const rows: OwnPerformanceInputRow[] = [];
  let adIndex = 0;
  angles.forEach(([angle, count], angleIndex) => {
    const profile = ANGLE_PROFILES[Math.min(angleIndex, ANGLE_PROFILES.length - 1)];
    for (let j = 0; j < count; j += 1) {
      const spend = Math.round(profile.spendPerAd * spread(adIndex));
      const purchases = Math.max(1, Math.round(spend / profile.cpa));
      const impressions = Math.round(spend * 55);
      rows.push({
        adId: `demo-ad-${adIndex + 1}`,
        platform: 'meta',
        labels: {
          angle,
          angleUniversal: null,
          // Pairs of ads share a hook and alternate formats, so the busiest
          // angles form two-ad hook × angle × format cells.
          hookArchetype: hooks[Math.floor(j / 2) % hooks.length],
          format: formats[j % formats.length],
          offerType: offers[(angleIndex + j) % offers.length],
          persona: DEMO_PERSONAS[(angleIndex + j) % DEMO_PERSONAS.length],
          funnelStage: DEMO_FUNNEL_STAGES[j % DEMO_FUNNEL_STAGES.length],
        },
        spend,
        impressions,
        clicks: Math.round(impressions * 0.012 * spread(adIndex + 1)),
        purchases,
        purchaseValue: Math.round(spend * profile.roas * spread(adIndex + 2)),
      });
      adIndex += 1;
    }
  });

  const labeledSpend = rows.reduce((sum, row) => sum + row.spend, 0);
  const end = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const start = new Date(end.getTime() - (DEMO_WINDOW_DAYS - 1) * 24 * 60 * 60 * 1000);

  return buildOwnPerformanceModel({
    rows,
    windowDays: DEMO_WINDOW_DAYS,
    from: isoDay(start),
    to: isoDay(end),
    currency: DEMO_CURRENCY,
    coverage: {
      labeledAdsWithSpend: rows.length,
      totalAdsWithSpend: rows.length + DEMO_UNLABELED_ADS,
      labeledSpend,
      totalSpend: Math.round(labeledSpend * (1 + DEMO_UNLABELED_SPEND_SHARE)),
    },
    scope: { pooled: false, brandCount: 1 },
    demo: true,
  });
}

/**
 * The model a report surface renders: the real read, except for a pinned demo
 * org whose real read is empty — then the synthetic model. The ONE place the
 * substitution rule lives, so the on-screen chapter and the Brand Book cannot
 * disagree. A real org always gets its real (possibly empty) model.
 */
export function effectiveOwnPerformance(params: {
  real: OwnPerformanceModel | null | undefined;
  isPinnedDemoOrg: boolean;
  market: MarketFormulaStep[];
  now?: Date;
}): OwnPerformanceModel | null {
  const real = params.real ?? null;
  if (params.isPinnedDemoOrg && isOwnPerformanceEmpty(real)) {
    return demoOwnPerformance(params.market, params.now);
  }
  return real;
}
