import type {
  ArmRow,
  ArmStat,
  BrandRow,
  CreativeRow,
  Decision,
  Learning,
  Round,
  Run,
  SegmentRow,
} from '@/lib/spacetime/bindings/types';
import {
  type Offsets,
  TOKENS_PER_CALL,
  USD_PER_MILLION_TOKENS,
  costPerOrder,
  parseJson,
  words,
} from './format';

// Pure functions from SpacetimeDB rows to what each /sim view draws. No React here, so they are
// unit-tested directly (selectors.test.ts).

// The decision row's json columns (sim/src/engine.ts DecisionRow).
export type FeedRaw = { tap: Record<string, number>; believes: number };
export type FeedCal = { tap: Record<string, number> };
export type PageRaw = { stay: number; buy: number; objection: Record<string, number> };
export type PageCal = { stay: number; buy: number; guard: 0 | 1 };
export type Options = { state_hash: string; order?: string[]; objections?: string[] };
export type Draw = { tap?: number; stay?: number | null; buy?: number | null };

export type RunCalibration = {
  offsets?: Offsets;
  warm_up_fit?: { p_tap: number; bounce_rate: number; p_buy_given_stay: number; visit_to_purchase: number };
  probe_jev?: { calls: number; input_tokens: number };
};

export const CONTROL_COLOR = 'var(--muted-foreground)';
// Recipe colours: the brand magenta (--chart-1) first, then hues spaced far enough apart to tell
// 11 recipes apart on the dark theme (ShopSim's CREATIVE_COLORS repeated pinks and golds past 8).
// No greys, so no recipe reads as the control.
export const RECIPE_COLORS = [
  'var(--chart-1)',
  '#9b7be0',
  '#2fb4a4',
  '#e3a33a',
  '#3fbf6b',
  '#3d8de0',
  '#eb6834',
  '#a3c43a',
  '#5fc8e8',
  '#e8d24a',
  '#e04a4a',
  '#6a5ae0',
];

export function armLabel(a: ArmRow | undefined): string {
  if (!a) return 'unknown arm';
  return a.strategy === 'control' ? "Magic Spoon's current ads" : `${words(a.angle)} × ${words(a.hook)}`;
}

export function armColors(arms: readonly ArmRow[]): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  for (const a of [...arms].sort((x, y) => x.armId.localeCompare(y.armId))) {
    out.set(a.armId, a.strategy === 'control' ? CONTROL_COLOR : RECIPE_COLORS[i++ % RECIPE_COLORS.length]!);
  }
  return out;
}

// --- Allocation river -------------------------------------------------------------------------

export type RiverSeries = { id: string; name: string; color: string; perDay: number[] };

// Impressions per arm per run-wide sim day, from the feed decision rows (one per impression).
export function riverSeries(
  decisions: readonly Decision[],
  creatives: readonly CreativeRow[],
  arms: readonly ArmRow[],
): { series: RiverSeries[]; days: number } {
  const armOf = new Map(creatives.map((c) => [c.creativeId, c.armId]));
  const colors = armColors(arms);
  const feed = decisions.filter((d) => d.kind === 'feed');
  const days = feed.reduce((m, d) => Math.max(m, d.tick + 1), 0);
  const counts = new Map<string, number[]>();
  for (const d of feed) {
    const arm = armOf.get(d.creativeId) || 'unknown';
    const row = counts.get(arm) ?? new Array<number>(days).fill(0);
    row[d.tick] = (row[d.tick] ?? 0) + 1;
    counts.set(arm, row);
  }
  const byId = new Map(arms.map((a) => [a.armId, a]));
  // Control first (the river's fixed baseline band), then recipes by id.
  const ids = [...counts.keys()].sort((a, b) => {
    const ca = byId.get(a)?.strategy === 'control' ? 0 : 1;
    const cb = byId.get(b)?.strategy === 'control' ? 0 : 1;
    return ca - cb || a.localeCompare(b);
  });
  return {
    days,
    series: ids.map((id) => ({
      id,
      name: armLabel(byId.get(id)),
      color: colors.get(id) ?? CONTROL_COLOR,
      perDay: Array.from({ length: days }, (_, i) => counts.get(id)![i] ?? 0),
    })),
  };
}

// --- Leaderboard ------------------------------------------------------------------------------

export type LeaderRow = {
  armId: string;
  label: string;
  strategy: string;
  isControl: boolean;
  impressions: number;
  pBest: number;
  cpo: number | null;
  cpoLow: number | null;
  cpoHigh: number | null;
  postMean: number;
};
export type SegmentBoard = {
  segmentId: string;
  name: string;
  round: number;
  rows: LeaderRow[];
  control: LeaderRow | null;
  // This segment's generation candidate: the top non-control arm by p_best, ties to the lower arm
  // id (sim/src/run.ts generation(); the worker then keeps at most 3 across segments).
  topRecipe: LeaderRow | null;
};

// The latest refreshed arm stats (they are replaced every sim day), per segment, ranked by
// expected cost per order. The range is the cost per order at the posterior mean ± 2 sd.
export function leaderboard(
  armStats: readonly ArmStat[],
  arms: readonly ArmRow[],
  segments: readonly SegmentRow[],
): SegmentBoard[] {
  if (armStats.length === 0) return [];
  const round = armStats.reduce((m, s) => Math.max(m, s.round), 0);
  const current = armStats.filter((s) => s.round === round);
  const byId = new Map(arms.map((a) => [a.armId, a]));
  const row = (s: ArmStat): LeaderRow => {
    const a = byId.get(s.armId);
    return {
      armId: s.armId,
      label: armLabel(a),
      strategy: a?.strategy ?? '',
      isControl: a?.strategy === 'control',
      impressions: s.impressions,
      pBest: s.pBest,
      cpo: s.estCostPerOrderUsd ?? null,
      cpoLow: costPerOrder(s.postMean + 2 * s.postSd),
      cpoHigh: costPerOrder(s.postMean - 2 * s.postSd),
      postMean: s.postMean,
    };
  };
  return segments
    .map((seg) => {
      const rows = current
        .filter((s) => s.segmentId === seg.segmentId)
        .map(row)
        .sort((a, b) => b.postMean - a.postMean || a.armId.localeCompare(b.armId));
      const recipes = rows.filter((r) => !r.isControl);
      const topRecipe = [...recipes]
        .sort((a, b) => a.armId.localeCompare(b.armId))
        .reduce<LeaderRow | null>((best, r) => (!best || r.pBest > best.pBest ? r : best), null);
      return { segmentId: seg.segmentId, name: seg.name, round, rows, control: rows.find((r) => r.isControl) ?? null, topRecipe };
    })
    .filter((b) => b.rows.length > 0);
}

// --- Decision ticker --------------------------------------------------------------------------

export type TickerRow = {
  key: string;
  round: number;
  tick: number;
  shopperId: string;
  shopperName: string;
  creativeId: string;
  headline: string;
  brand: string;
  pTap: number;
  draw: number | null;
  action: string;
  pStay: number | null;
  pBuy: number | null;
  pageAction: string | null;
};

// The latest feed decisions, newest first, each with our ad's calibrated tap chance and the dice,
// joined to that impression's page call (stay and buy chances, outcome).
export function ticker(
  decisions: readonly Decision[],
  creatives: readonly CreativeRow[],
  brands: readonly BrandRow[],
  shopperNames: ReadonlyMap<string, string>,
  limit = 50,
): TickerRow[] {
  const creative = new Map(creatives.map((c) => [c.creativeId, c]));
  const brandName = new Map(brands.map((b) => [b.brandId, b.name]));
  const page = new Map<string, Decision>();
  for (const d of decisions) if (d.kind === 'page') page.set(`${d.shopperId}|${d.tick}`, d);
  const feed = decisions
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.kind === 'feed')
    .sort((a, b) => b.d.tick - a.d.tick || b.i - a.i)
    .slice(0, limit);
  return feed.map(({ d }) => {
    const c = creative.get(d.creativeId);
    const cal = parseJson<FeedCal>(d.pCal, { tap: {} });
    const draw = parseJson<Draw>(d.draw, {});
    const p = page.get(`${d.shopperId}|${d.tick}`);
    const pc = p ? parseJson<PageCal | null>(p.pCal, null) : null;
    return {
      key: `${d.shopperId}|${d.tick}`,
      round: d.round,
      tick: d.tick,
      shopperId: d.shopperId,
      shopperName: shopperNames.get(d.shopperId) ?? d.shopperId,
      creativeId: d.creativeId,
      headline: c?.headline ?? d.creativeId,
      brand: c ? (brandName.get(c.brandId) ?? c.brandId) : '',
      pTap: cal.tap[d.creativeId] ?? 0,
      draw: draw.tap ?? null,
      action: d.action,
      pStay: pc?.stay ?? null,
      pBuy: pc?.buy ?? null,
      pageAction: p?.action ?? null,
    };
  });
}

// --- Shopper inspector ------------------------------------------------------------------------

export type ShopperStep = {
  round: number;
  tick: number;
  creativeId: string;
  order: string[];
  tap: { raw: number; cal: number; draw: number | null };
  stay: { raw: number; cal: number; draw: number | null } | null;
  buy: { raw: number; cal: number; draw: number | null; guarded: boolean } | null;
  believes: number | null;
  objection: string | null;
  action: string;
  pageAction: string | null;
};

// Every impression this shopper saw, oldest first: the questions' raw and calibrated chances,
// the dice and what happened. This is the "memory across rounds" the decision rows can show.
export function shopperHistory(decisions: readonly Decision[], shopperId: string): ShopperStep[] {
  const mine = decisions.filter((d) => d.shopperId === shopperId);
  const page = new Map(mine.filter((d) => d.kind === 'page').map((d) => [d.tick, d]));
  return mine
    .filter((d) => d.kind === 'feed')
    .sort((a, b) => a.tick - b.tick)
    .map((d) => {
      const raw = parseJson<FeedRaw>(d.pRaw, { tap: {}, believes: 0 });
      const cal = parseJson<FeedCal>(d.pCal, { tap: {} });
      const draw = parseJson<Draw>(d.draw, {});
      const opts = parseJson<Options>(d.options, { state_hash: '' });
      const p = page.get(d.tick);
      const praw = p ? parseJson<PageRaw | null>(p.pRaw, null) : null;
      const pcal = p ? parseJson<PageCal | null>(p.pCal, null) : null;
      const pdraw = p ? parseJson<Draw>(p.draw, {}) : {};
      return {
        round: d.round,
        tick: d.tick,
        creativeId: d.creativeId,
        order: opts.order ?? [],
        tap: { raw: raw.tap[d.creativeId] ?? 0, cal: cal.tap[d.creativeId] ?? 0, draw: draw.tap ?? null },
        stay: praw && pcal ? { raw: praw.stay, cal: pcal.stay, draw: pdraw.stay ?? null } : null,
        buy: praw && pcal ? { raw: praw.buy, cal: pcal.buy, draw: pdraw.buy ?? null, guarded: pcal.guard === 0 } : null,
        believes: d.believesClaim ?? null,
        objection: p?.objection ?? null,
        action: d.action,
        pageAction: p?.action ?? null,
      };
    });
}

// The page state Jev read (shopper.state_text) split into its blocks; the lines a what-if may
// remove are the SHOPPER block's shopping line and every MEMORY line.
export type StateBlocks = { shopper: string[]; memory: string[]; rest: string[] };
export function stateBlocks(stateText: string): StateBlocks {
  const blocks = stateText.split('\n\n');
  const take = (title: string) => {
    const b = blocks.find((x) => x.startsWith(`${title}\n`));
    return b ? b.split('\n').slice(1) : [];
  };
  return { shopper: take('SHOPPER'), memory: take('MEMORY'), rest: blocks.filter((b) => !/^(SHOPPER|MEMORY)\n/.test(b)) };
}

export type MemoryLine = { id: string; text: string };
export function memoryLines(stateText: string): MemoryLine[] {
  const { shopper, memory } = stateBlocks(stateText);
  const need = shopper.filter((l) => /^(Shopping for a new cereal|Not shopping for cereal)/.test(l));
  return [...need.map((text) => ({ id: `shopper:${text}`, text })), ...memory.map((text) => ({ id: `memory:${text}`, text }))];
}

// SHOPPER + MEMORY as Jev read them, optionally without one line.
export function shopperAndMemory(stateText: string, without?: string): string {
  const { shopper, memory } = stateBlocks(stateText);
  const keep = (lines: string[]) => lines.filter((l) => l !== without);
  return [['SHOPPER', ...keep(shopper)].join('\n'), ['MEMORY', ...keep(memory)].join('\n')].join('\n\n');
}

export function withoutLine(stateText: string, line: string): string {
  return stateText
    .split('\n\n')
    .map((block) => block.split('\n').filter((l) => l !== line).join('\n'))
    .join('\n\n');
}

// --- Learnings feed ---------------------------------------------------------------------------

export type LearningItem = Learning & { live: boolean; usedBy: CreativeRow[] };
export function learningsFeed(learnings: readonly Learning[], creatives: readonly CreativeRow[]): LearningItem[] {
  const used = new Map<string, CreativeRow[]>();
  for (const c of creatives) {
    for (const id of parseJson<string[]>(c.learningIds, [])) used.set(id, [...(used.get(id) ?? []), c]);
  }
  return [...learnings]
    .sort((a, b) => b.validFromRound - a.validFromRound || a.segmentId.localeCompare(b.segmentId) || a.learningId.localeCompare(b.learningId))
    .map((l) => ({ ...l, live: l.validToRound === undefined, usedBy: used.get(l.learningId) ?? [] }));
}

// --- Header strip -----------------------------------------------------------------------------

export type HeaderStats = {
  round: number | null;
  roundStatus: string | null;
  simDay: number | null;
  ticksPerRound: number;
  roundsPlanned: number;
  calls: number;
  cacheHitRate: number | null;
  costUsd: number;
  costIsEstimate: boolean;
  callsPerDay: number[];
};

export function headerStats(run: Run | undefined, rounds: readonly Round[], decisions: readonly Decision[]): HeaderStats {
  const ticksPerRound = run?.ticksPerRound ?? 3;
  const latest = [...rounds].sort((a, b) => b.round - a.round)[0];
  const maxTick = decisions.reduce((m, d) => Math.max(m, d.tick), -1);
  const cal = parseJson<RunCalibration>(run?.calibration, {});
  const probeCalls = cal.probe_jev?.calls ?? 0;
  // Finished rounds report their exact cost; a round still running is estimated from its calls.
  let cost = ((cal.probe_jev?.input_tokens ?? 0) / 1e6) * USD_PER_MILLION_TOKENS;
  let estimate = false;
  for (const r of rounds) {
    const s = parseJson<{ jev?: { cost_usd?: number } }>(r.summary, {});
    if (r.status === 'done' && s.jev?.cost_usd !== undefined) cost += s.jev.cost_usd;
    else {
      const calls = decisions.filter((d) => d.round === r.round).length;
      cost += (calls * TOKENS_PER_CALL * USD_PER_MILLION_TOKENS) / 1e6;
      estimate = true;
    }
  }
  const callsPerDay = Array.from({ length: maxTick + 1 }, () => 0);
  for (const d of decisions) callsPerDay[d.tick]! += 1;
  return {
    round: latest?.round ?? null,
    roundStatus: latest?.status ?? null,
    simDay: maxTick >= 0 ? (maxTick % ticksPerRound) + 1 : null,
    ticksPerRound,
    roundsPlanned: run?.roundsPlanned ?? 0,
    calls: decisions.length + probeCalls,
    cacheHitRate: decisions.length ? decisions.filter((d) => d.cacheHit).length / decisions.length : null,
    costUsd: cost,
    costIsEstimate: estimate,
    callsPerDay,
  };
}

export function latestRun(runs: readonly Run[]): Run | undefined {
  return [...runs].sort((a, b) => Number(b.createdAt.microsSinceUnixEpoch - a.createdAt.microsSinceUnixEpoch))[0];
}
