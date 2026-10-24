/**
 * Uncertainty quantification for the eval harness (metric-honesty plan extension).
 *
 * Every pass-rate cell on the harness board is a point estimate over a SMALL number
 * of live reps (`AGENT_L2_REPS` defaults to 3). A bare `0.800` hides whether that is
 * 4/5 (huge interval) or 80/100 (tight) — the documented "lucky 3/3 was really 2/3"
 * failure mode. These pure helpers attach the interval so a reader sees the `n` and
 * the confidence band, never a naked rate.
 *
 * Two tools, deliberately scoped:
 *   - `wilsonInterval` — the Wilson score interval for a binomial pass-rate. Shown on
 *     EVERY cell (cheap, always honest). It is NOT a hypothesis test; it is the band
 *     the true rate plausibly sits in. The Wilson form (not normal-approx) behaves at
 *     the extremes (3/3, 0/3) where the harness lives.
 *   - `pairedBootstrapDelta` — a paired bootstrap on the per-case delta between a
 *     candidate run and its baseline. Reserved for the no-regression GATE (the only
 *     place a real comparison happens): same scenarios run on both, so the cases pair
 *     by index. "Confidently worse" = the whole delta CI sits below 0 — the powered
 *     version of the fixed-ε threshold, not a p-value sprayed across every cell.
 *
 * This file is also the repo's home for shared statistical primitives outside the
 * harness: `lib/creative-engine/loop/refresh-outcome.ts` imports `proportionCIsOverlap`,
 * and the creative engine's belief layer (Workstream D) imports `mulberry32`,
 * `sampleBeta`, and `betaMoments` — statistical primitives live HERE and consumers
 * import them; never fork a private copy.
 *
 * Pure + deterministic (seeded PRNG) so they unit-test without disk, network, or a
 * wall clock — matching `usage-meter.ts`'s `computeLatencyStats` discipline.
 */

/** A binomial proportion with its confidence band. */
export interface ProportionCI {
  /** Observed rate `successes / n` (0 when `n === 0`). */
  point: number;
  /** Lower bound of the confidence interval, clamped to [0,1]. */
  lo: number;
  /** Upper bound of the confidence interval, clamped to [0,1]. */
  hi: number;
  /** Sample size. */
  n: number;
  /** Half-width `(hi - lo) / 2` — a one-number "how uncertain" handle. */
  margin: number;
}

/** z for a two-sided 95% interval (the harness default). */
export const Z_95 = 1.959963984540054;

/**
 * Wilson score interval for a binomial pass-rate. Well-behaved at the extremes the
 * harness actually hits (3/3 → [0.44, 1.0], not the normal-approx's degenerate [1,1]).
 * `successes` is clamped to `[0, n]`; `n === 0` returns the maximally-uncertain
 * `[0,1]` band so an unmeasured cell can never read as confident.
 */
export function wilsonInterval(successes: number, n: number, z: number = Z_95): ProportionCI {
  if (!Number.isFinite(n) || n <= 0) {
    return { point: 0, lo: 0, hi: 1, n: 0, margin: 0.5 };
  }
  const k = Math.min(Math.max(successes, 0), n);
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half =
    (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const lo = Math.max(0, center - half);
  const hi = Math.min(1, center + half);
  return { point: p, lo, hi, n, margin: (hi - lo) / 2 };
}

/**
 * One-line rate-with-interval, e.g. `0.800 (n=5, 95% CI [0.376–0.964])`. An
 * unmeasured cell (`n === 0`) renders `— (n=0)` so it can't masquerade as a score.
 */
export function formatProportionCI(successes: number, n: number, z: number = Z_95): string {
  if (n <= 0) return '— (n=0)';
  const ci = wilsonInterval(successes, n, z);
  return `${ci.point.toFixed(3)} (n=${n}, 95% CI [${ci.lo.toFixed(3)}–${ci.hi.toFixed(3)}])`;
}

/** One side of a two-proportion overlap check. */
export interface ProportionCIsOverlapResult {
  /** Wilson CI for side A (`{successes, n}`). */
  aCI: ProportionCI;
  /** Wilson CI for side B. */
  bCI: ProportionCI;
  /** True when the two intervals share any point (`a.lo ≤ b.hi && b.lo ≤ a.hi`). */
  overlap: boolean;
  /**
   * True when the intervals do NOT overlap — the conservative CI-overlap test's
   * verdict that the two rates differ. Non-overlap ⇒ significant difference;
   * overlap is INCONCLUSIVE (it does not prove equality). Deliberately weaker
   * (higher bar for "significant") than a formal two-proportion z-test, so a
   * borderline pair is called not-significant rather than falsely significant.
   */
  significant: boolean;
}

/**
 * Conservative two-proportion significance via Wilson-CI overlap. Each side is a
 * binomial `{successes, n}` (e.g. an old ad's clicks/impressions vs a new ad's);
 * the two Wilson intervals are compared and the difference is called SIGNIFICANT
 * only when they do NOT overlap.
 *
 * This is intentionally the CONSERVATIVE test (two non-overlapping 95% CIs imply
 * a difference well beyond p<0.05, so it under-calls significance): for a
 * winner/loser verdict we would rather withhold "significant" than fabricate one
 * on thin data. An empty side (`n === 0`) yields the maximally-uncertain `[0,1]`
 * band → it overlaps everything → never significant (an unmeasured side can
 * never win or lose). Pure + deterministic.
 */
export function proportionCIsOverlap(
  a: { successes: number; n: number },
  b: { successes: number; n: number },
  z: number = Z_95,
): ProportionCIsOverlapResult {
  const aCI = wilsonInterval(a.successes, a.n, z);
  const bCI = wilsonInterval(b.successes, b.n, z);
  const overlap = aCI.lo <= bCI.hi && bCI.lo <= aCI.hi;
  return { aCI, bCI, overlap, significant: !overlap };
}

/**
 * A deterministic PRNG so seeded draws are reproducible across runs and in CI.
 * Exported (2026-08-18): the creative engine's Thompson sampler injects this as its
 * randomness source — the repo already had four private copies; do not add a fifth.
 * Note the return range is [0, 1) and CAN be exactly 0 — consumers feeding a log
 * (Box–Muller) must use `1 - rng()`.
 */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Percentile (linear-interpolated) over an ASCENDING-sorted list of finite numbers.
 * Exported (2026-08-23): the creative engine's lifecycle rules (Workstream F) need a
 * median and this is the one percentile shape in the repo — import it, never fork.
 * An empty list returns 0 (the bootstrap's historical contract); callers that need
 * empty to be distinguishable should use `median`, which returns null.
 */
export function percentile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = q * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

/**
 * Median of an unordered list of finite numbers (linear-interpolated at even
 * lengths, via `percentile(…, 0.5)`). Returns `null` for an empty list —
 * honesty over convenience: a caller must decide what "no cohort" means, and a
 * silent 0 would read as a real (terrible) median CTR. Input is copied, never
 * mutated. Callers supply finite numbers; a NaN in the input is an upstream bug.
 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return percentile(sorted, 0.5);
}

export interface PairedBootstrapResult {
  /** Observed mean per-case delta `mean(candidate[i] − baseline[i])`. */
  delta: number;
  /** Lower bound of the bootstrap CI on the mean delta. */
  lo: number;
  /** Upper bound of the bootstrap CI on the mean delta. */
  hi: number;
  /** Number of paired cases. */
  n: number;
  /** Bootstrap resample count. */
  iterations: number;
  /** Whole delta CI below 0 → confidently worse than baseline (a real regression). */
  regressed: boolean;
  /** Whole delta CI above 0 → confidently better than baseline. */
  improved: boolean;
}

export interface PairedBootstrapOptions {
  /** Resample count (default 2000). */
  iterations?: number;
  /** Confidence level (default 0.95). */
  ciLevel?: number;
  /** PRNG seed (default 1) — fixed so the gate verdict is reproducible. */
  seed?: number;
}

/**
 * Paired bootstrap on the per-case delta between a candidate and its baseline. The two
 * arrays MUST be aligned by case (same scenarios, same order) and equal length — that
 * is what makes the comparison paired and the variance low. Each entry is a per-case
 * score in [0,1] (a binary pass, or a multi-rep mean pass for that case).
 *
 * `regressed` (whole CI < 0) is the gate's "confidently worse" signal — the powered
 * replacement for a fixed-ε scalar threshold. Empty input → a zero, non-regressed
 * result (nothing measured can't be a regression). Throws on length mismatch so a
 * caller can't silently compare misaligned corpora.
 */
export function pairedBootstrapDelta(
  candidate: number[],
  baseline: number[],
  opts: PairedBootstrapOptions = {},
): PairedBootstrapResult {
  if (candidate.length !== baseline.length) {
    throw new Error(
      `pairedBootstrapDelta: misaligned corpora (candidate ${candidate.length} vs baseline ${baseline.length}). ` +
        'Pairing requires the SAME held-out cases in the same order.',
    );
  }
  const iterations = opts.iterations ?? 2000;
  const ciLevel = opts.ciLevel ?? 0.95;
  const n = candidate.length;
  if (n === 0) {
    return { delta: 0, lo: 0, hi: 0, n: 0, iterations: 0, regressed: false, improved: false };
  }
  const diffs = candidate.map((c, i) => c - baseline[i]);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const delta = mean(diffs);

  const rng = mulberry32(opts.seed ?? 1);
  const means: number[] = new Array(iterations);
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      sum += diffs[(rng() * n) | 0];
    }
    means[it] = sum / n;
  }
  means.sort((a, b) => a - b);
  const alpha = (1 - ciLevel) / 2;
  const lo = percentile(means, alpha);
  const hi = percentile(means, 1 - alpha);
  return { delta, lo, hi, n, iterations, regressed: hi < 0, improved: lo > 0 };
}

function assertBetaParams(fnName: string, alpha: number, beta: number): void {
  if (!Number.isFinite(alpha) || !Number.isFinite(beta) || alpha <= 0 || beta <= 0) {
    throw new Error(
      `${fnName}: invalid Beta(${alpha}, ${beta}) — both parameters must be finite and > 0. ` +
        'An invalid shape is an upstream bug (a prior floor should keep α,β ≥ 1), never sample through it.',
    );
  }
}

/**
 * Standard normal draw via Box–Muller. `1 - rng()` keeps both log/trig arguments in
 * (0, 1] — `mulberry32` can emit exactly 0, and `Math.log(0)` is `-Infinity`.
 * Exported (2026-09-14): the creative-engine arena's world model imports it — never fork.
 */
export function sampleStandardNormal(rng: () => number): number {
  const u = 1 - rng();
  const v = 1 - rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Gamma(shape, 1) draw via Marsaglia–Tsang (2000). Handles fractional shapes
 * (decayed counts are fractional); `shape < 1` uses the standard boost —
 * `Gamma(shape + 1) · U^(1/shape)` — with `1 - rng()` so U is never exactly 0
 * (0^(1/shape) would collapse tiny-shape draws to 0 more often than the math says).
 * Exported (2026-09-14): the creative-engine arena's world model imports it — never fork.
 */
export function sampleGamma(shape: number, rng: () => number): number {
  if (shape < 1) {
    const u = 1 - rng();
    return sampleGamma(shape + 1, rng) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = sampleStandardNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = 1 - rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/**
 * One draw from Beta(alpha, beta) using the injected uniform source — the Thompson
 * sampler's raffle ticket. Deterministic under a seeded rng (`mulberry32(seed)`), so
 * any past decision replays exactly. Every uniform consumed comes from `rng`; this
 * function must never touch `Math.random`.
 *
 * Numerically safe at both extremes the creative engine actually produces: huge
 * near-symmetric shapes (Ember-scale Beta(3000, 90000) — Marsaglia–Tsang is designed
 * for large shape) and tiny fractional shapes (the α<1 boost). The one pathological
 * corner — BOTH gamma draws underflowing to 0 at very small α AND β — returns the
 * exact mean rather than NaN.
 */
export function sampleBeta(alpha: number, beta: number, rng: () => number): number {
  assertBetaParams('sampleBeta', alpha, beta);
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  if (!(x + y > 0)) return alpha / (alpha + beta);
  return x / (x + y);
}

/** Summary moments of a Beta belief curve. */
export interface BetaMoments {
  /** Exact posterior mean `α / (α + β)`. */
  mean: number;
  /** Exact posterior standard deviation. */
  sd: number;
  /**
   * Normal-approximation credible interval clamped to [0, 1]. Honest at large
   * effective sample sizes; crude (conservative-wide, symmetric) for tiny or
   * heavily skewed curves — the accepted trade vs shipping an inverse incomplete
   * beta. The WIDTH ordering is what consumers rely on (more evidence ⇒ narrower),
   * and that ordering the approximation preserves.
   */
  ci95: [number, number];
}

/** Exact mean/sd of Beta(alpha, beta) plus the clamped normal-approx interval. */
export function betaMoments(alpha: number, beta: number, z: number = Z_95): BetaMoments {
  assertBetaParams('betaMoments', alpha, beta);
  const total = alpha + beta;
  const mean = alpha / total;
  const sd = Math.sqrt((alpha * beta) / (total * total * (total + 1)));
  const lo = Math.max(0, mean - z * sd);
  const hi = Math.min(1, mean + z * sd);
  return { mean, sd, ci95: [lo, hi] };
}

/**
 * One draw from Binomial(n, p) using the injected uniform source — EXACT, no
 * normal approximation. Added 2026-09-14 for the creative-engine arena (the
 * offline simulator's clicks-per-impression and purchases-per-click draws).
 *
 * Method: the waiting-time (geometric-skip) sampler. In a Bernoulli sequence
 * the number of failures before the next success is Geometric(p), so the draw
 * walks success to success and costs O(n·p + 1) uniforms — ~45 for a Meta ad
 * day of 17,500 impressions at a 0.25% CTR — and never more than n. `p > 0.5`
 * is handled by symmetry (`n − Binomial(n, 1 − p)`) so the walk stays short at
 * both ends. Every uniform comes from `rng`; never `Math.random`.
 */
export function sampleBinomial(n: number, p: number, rng: () => number): number {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`sampleBinomial: n must be a non-negative integer (got ${String(n)})`);
  }
  if (!(p >= 0 && p <= 1)) {
    throw new Error(`sampleBinomial: p must be in [0, 1] (got ${String(p)})`);
  }
  if (n === 0 || p === 0) return 0;
  if (p === 1) return n;
  if (p > 0.5) return n - sampleBinomial(n, 1 - p, rng);
  const logFailure = Math.log(1 - p); // strictly negative: 0 < p <= 0.5
  let successes = 0;
  let position = 0;
  for (;;) {
    // Geometric(p) gap — `1 - rng()` keeps the log argument in (0, 1].
    const gap = Math.floor(Math.log(1 - rng()) / logFailure);
    position += gap + 1;
    if (position > n) return successes;
    successes += 1;
  }
}

/**
 * One draw from Multinomial(n, probs) via sequential conditional binomials —
 * exact, and the categories always sum to n. `probs` need not be normalized
 * (only non-negative, finite, with a positive total); a zero-probability
 * category always receives 0. Added 2026-09-14 for the creative-engine arena's
 * impression allocator.
 */
export function sampleMultinomial(
  n: number,
  probs: readonly number[],
  rng: () => number
): number[] {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`sampleMultinomial: n must be a non-negative integer (got ${String(n)})`);
  }
  if (probs.length === 0) {
    throw new Error('sampleMultinomial: probs must contain at least one category');
  }
  let total = 0;
  for (const p of probs) {
    if (!Number.isFinite(p) || p < 0) {
      throw new Error(`sampleMultinomial: every probability must be finite and >= 0 (got ${String(p)})`);
    }
    total += p;
  }
  if (!(total > 0)) {
    throw new Error('sampleMultinomial: probabilities must sum to a positive number');
  }
  const out = new Array<number>(probs.length).fill(0);
  let remaining = n;
  let remainingMass = total;
  for (let i = 0; i < probs.length - 1 && remaining > 0; i += 1) {
    const restMass = remainingMass - probs[i];
    // The last positive-mass category takes everything that is left; guarding
    // on the remainder (not a ratio) keeps float error from stranding a count
    // in a zero-probability tail.
    const share = restMass <= 0 ? 1 : Math.min(1, Math.max(0, probs[i] / remainingMass));
    const draw = sampleBinomial(remaining, share, rng);
    out[i] = draw;
    remaining -= draw;
    remainingMass = restMass;
    if (remainingMass <= 0) break;
  }
  out[probs.length - 1] += remaining;
  return out;
}

/**
 * One draw from Geometric(p) on {0, 1, 2, …} — the number of FAILURES before
 * the first success, `P(k) = (1 − p)^k · p`, mean `(1 − p) / p`. Added
 * 2026-09-16 for the creative-engine arena's delayed-conversion model (the
 * days between a click and its attributed purchase). `p = 1` returns 0
 * without consuming randomness; `p = 0` is rejected (the draw would never
 * terminate). `1 - rng()` keeps the log argument in (0, 1]. Every uniform
 * comes from `rng`; never `Math.random`.
 */
export function sampleGeometric(p: number, rng: () => number): number {
  if (!(p > 0 && p <= 1)) {
    throw new Error(`sampleGeometric: p must be in (0, 1] (got ${String(p)})`);
  }
  if (p === 1) return 0;
  return Math.floor(Math.log(1 - rng()) / Math.log(1 - p));
}

/**
 * Spearman rank correlation of two equal-length series (ranks by sort order; ties
 * take the order they sort in, which is fine for the continuous series this serves).
 * Exported (2026-09-17): the creative-engine arena's static baseline is calibrated
 * to a rank correlation with the truth, and its allocator test measures one — never fork.
 */
export function spearmanRank(x: readonly number[], y: readonly number[]): number {
  if (x.length !== y.length) throw new Error(`spearmanRank: length mismatch (${x.length} vs ${y.length})`);
  const n = x.length;
  if (n < 2) throw new Error('spearmanRank: needs at least two pairs');
  const rank = (v: readonly number[]): number[] => {
    const order = v.map((value, i) => ({ value, i })).sort((a, b) => a.value - b.value || a.i - b.i);
    const out = new Array<number>(v.length);
    order.forEach((entry, r) => {
      out[entry.i] = r;
    });
    return out;
  };
  const rx = rank(x);
  const ry = rank(y);
  const d2 = rx.reduce((acc, r, i) => acc + (r - ry[i]) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
}
