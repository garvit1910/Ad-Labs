// Which ads get an image (scripts/sim-images.ts), from one run's decision rows. Pure, so it's
// unit-tested in tests/unit/sim-images-select.test.ts.
//
// An impression's reward is the sim's own: P(tap) × P(stay) × P(buy | stay), calibrated, with the
// budget guard already in P(buy) (sim/src/engine.ts).

export type Decision = { round: number; tick: number; shopper_id: string; kind: string; creative_id: string; p_cal: string };
export type Ad = { creative_id: string; arm_id: string; segment_id: string; origin: string; status: string; round_created: number };
export type ArmStat = { round: number; segment_id: string; arm_id: string; post_mean: number; est_cost_per_order_usd: number | null };

export type Score = { creative_id: string; n: number; mean: number };
export type Winner = Score & { segment_id: string; arm_id: string; cpo: number | null; control_cpo: number | null };

// Mean reward per creative over the matching feed impressions.
export function scoreAds(decisions: readonly Decision[], keep: (d: Decision) => boolean): Map<string, Score> {
  const page = new Map<string, { stay: number; buy: number }>();
  for (const d of decisions) if (d.kind === 'page') page.set(`${d.shopper_id}|${d.tick}`, JSON.parse(d.p_cal));
  const acc = new Map<string, { n: number; sum: number }>();
  for (const d of decisions) {
    if (d.kind !== 'feed' || !keep(d)) continue;
    const p = page.get(`${d.shopper_id}|${d.tick}`);
    if (!p) continue;
    const tap = (JSON.parse(d.p_cal) as { tap: Record<string, number> }).tap[d.creative_id] ?? 0;
    const a = acc.get(d.creative_id) ?? { n: 0, sum: 0 };
    a.n += 1;
    a.sum += tap * p.stay * p.buy;
    acc.set(d.creative_id, a);
  }
  return new Map([...acc].map(([id, a]) => [id, { creative_id: id, n: a.n, mean: a.sum / a.n }]));
}

const byMean = (a: Score, b: Score) => b.mean - a.mean || b.n - a.n || a.creative_id.localeCompare(b.creative_id);

// The best round-0 ads: A5's round-0 creatives ranked by their reward in the run's warm-up, where
// every recipe gets equal impressions.
export function topRound0(decisions: readonly Decision[], ads: readonly Ad[], top = 15, minImpressions = 5): Score[] {
  const round0 = new Set(ads.filter((a) => a.origin === 'generated' && a.round_created === 0 && a.status === 'ranked').map((a) => a.creative_id));
  const scores = scoreAds(decisions, (d) => d.round === 0 && round0.has(d.creative_id));
  return [...scores.values()].filter((s) => s.n >= minImpressions).sort(byMean).slice(0, top);
}

// The dominant ad per segment at the end of a run: the segment's top recipe by posterior mean in the
// last round (never the control), then that recipe's ad with the best reward among the segment's
// shoppers (at least minImpressions, else its most-shown ad).
export function winners(
  decisions: readonly Decision[],
  ads: readonly Ad[],
  stats: readonly ArmStat[],
  segmentOf: ReadonlyMap<string, string>,
  controlArmId: string,
  minImpressions = 30,
): Winner[] {
  const last = Math.max(...stats.map((s) => s.round));
  const arm = new Map(ads.map((a) => [a.creative_id, a.arm_id]));
  const out: Winner[] = [];
  for (const segment of [...new Set(stats.map((s) => s.segment_id))].sort()) {
    const rows = stats.filter((s) => s.round === last && s.segment_id === segment);
    const top = rows.filter((s) => s.arm_id !== controlArmId).sort((a, b) => b.post_mean - a.post_mean)[0];
    if (!top) continue;
    const scores = [
      ...scoreAds(decisions, (d) => segmentOf.get(d.shopper_id) === segment && arm.get(d.creative_id) === top.arm_id).values(),
    ];
    if (!scores.length) continue;
    const enough = scores.filter((s) => s.n >= minImpressions);
    const best = enough.length ? enough.sort(byMean)[0]! : scores.sort((a, b) => b.n - a.n || byMean(a, b))[0]!;
    const control = rows.find((s) => s.arm_id === controlArmId);
    out.push({ ...best, segment_id: segment, arm_id: top.arm_id, cpo: top.est_cost_per_order_usd, control_cpo: control?.est_cost_per_order_usd ?? null });
  }
  return out;
}
