// Calibration ("The Jev calls" > "Calibration"): one log-odds offset per gate,
//   p_cal = σ(logit(p_raw) + b_gate)
// fitted on the warm-up round's raw answers by bisection, then frozen on the run. The shift
// moves the average into researched ranges and keeps who-is-hotter-than-whom exactly the same.

export type Gate = "tap" | "stay" | "buy";
export type Offsets = Record<Gate, number>;

export const ZERO_OFFSETS: Offsets = { tap: 0, stay: 0, buy: 0 };

// Researched base-rate bands, copied from ShopSim's contracts.ts (FUNNEL_BANDS). Calibrate to
// these; never "accelerate" to them. The cart bands have no gate here (tap → stay → buy).
export const FUNNEL_BANDS = {
  p_click: [0.005, 0.02],
  bounce_rate: [0.45, 0.55],
  visit_to_purchase: [0.01, 0.03],
} as const;

// The middle of each band: tap 1% per ad, stay 50%, buy given stay 4% (so about 2% of visits
// end in a purchase).
export const TARGETS: Offsets = { tap: 0.01, stay: 0.5, buy: 0.04 };

// Jev returns exact 0s and 1s on Choice answers (SPIKE.md), which have no logit.
export const P_MIN = 0.005;
export const P_MAX = 0.995;

export function logit(p: number): number {
  return Math.log(p / (1 - p));
}

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function calibrate(pRaw: number, offset: number): number {
  const p = Math.min(P_MAX, Math.max(P_MIN, pRaw));
  // σ(logit(p)) only round-trips to within float error; a zero offset keeps p exactly.
  return offset === 0 ? p : sigmoid(logit(p) + offset);
}

const BISECT_LO = -20;
const BISECT_HI = 20;
const BISECT_STEPS = 100;

// The offset b where f(b) = target. f must increase with b, as every calibrated mean does.
export function bisect(f: (b: number) => number, target: number): number {
  let lo = BISECT_LO;
  let hi = BISECT_HI;
  for (let i = 0; i < BISECT_STEPS; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export type Sample = { p_raw: Offsets; guard: 0 | 1 };

export type FitReport = {
  n: number;
  offsets: Offsets;
  // Calibrated rates on the warm-up's own impressions, each conditional on the gate before it.
  p_tap: number;
  bounce_rate: number;
  p_buy_given_stay: number;
  visit_to_purchase: number;
  in_band: { p_click: boolean; bounce_rate: boolean; visit_to_purchase: boolean };
};

const weighted = (xs: number[], ws: number[]) => {
  const W = ws.reduce((a, b) => a + b, 0);
  return W > 0 ? xs.reduce((a, x, i) => a + x * ws[i]!, 0) / W : 0;
};

// Each gate is fitted in funnel order, as the rate among shoppers who reached it (DECISIONS
// D49): tap over every impression; stay weighted by P_cal(tap), so it is the rate among
// visitors; buy weighted by P_cal(tap) × P_cal(stay), with the budget guard applied, so it is
// the realised rate among shoppers who stayed.
export function fitOffsets(samples: readonly Sample[]): FitReport {
  if (samples.length === 0) throw new Error("calibration needs warm-up impressions");
  const tapRaw = samples.map((s) => s.p_raw.tap);
  const tapB = bisect((b) => weighted(tapRaw.map((p) => calibrate(p, b)), tapRaw.map(() => 1)), TARGETS.tap);
  const tapCal = tapRaw.map((p) => calibrate(p, tapB));

  const stayRaw = samples.map((s) => s.p_raw.stay);
  const stayB = bisect((b) => weighted(stayRaw.map((p) => calibrate(p, b)), tapCal), TARGETS.stay);
  const stayCal = stayRaw.map((p) => calibrate(p, stayB));

  const reach = tapCal.map((t, i) => t * stayCal[i]!);
  const buyAt = (b: number) => samples.map((s) => (s.guard ? calibrate(s.p_raw.buy, b) : 0));
  const buyB = bisect((b) => weighted(buyAt(b), reach), TARGETS.buy);
  const buyCal = buyAt(buyB);

  const p_tap = weighted(tapCal, tapCal.map(() => 1));
  const stay = weighted(stayCal, tapCal);
  const p_buy_given_stay = weighted(buyCal, reach);
  const visit_to_purchase = stay * p_buy_given_stay;
  const bounce_rate = 1 - stay;
  const inBand = (x: number, [lo, hi]: readonly [number, number]) => x >= lo && x <= hi;
  return {
    n: samples.length,
    offsets: { tap: tapB, stay: stayB, buy: buyB },
    p_tap,
    bounce_rate,
    p_buy_given_stay,
    visit_to_purchase,
    in_band: {
      p_click: inBand(p_tap, FUNNEL_BANDS.p_click),
      bounce_rate: inBand(bounce_rate, FUNNEL_BANDS.bounce_rate),
      visit_to_purchase: inBand(visit_to_purchase, FUNNEL_BANDS.visit_to_purchase),
    },
  };
}
