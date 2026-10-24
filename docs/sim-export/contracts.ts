/**
 * ShopSim contracts, rendered in TypeScript for the Jev rebuild.
 *
 * Source: shopsim @ b208e33e04812ebd5f4286cdde1d3b55707a5108
 * (branch phase-7-calibration-evals). These types are a faithful rendering of
 * ShopSim's Python contracts. Nothing here is redesigned: the changes I'd
 * recommend are in SIM_NOTES.md §8, not in these types.
 *
 * Python sources of truth:
 *   engine/shopsim/contracts/{enums,evidence,types,ids}.py
 *   engine/shopsim/minds/calibration.py · engine/shopsim/hydramem/schema.py
 *   engine/shopsim/population/factory.py · engine/shopsim/runner/{config,results,steps}.py
 *   engine/shopsim/eval/trace.py · engine/shopsim/runner/preview.py
 *
 * Conventions:
 *   - Every id is an integer from one allocation map (see `ID_RANGES`).
 *   - Time is epoch seconds. One tick is one sim-day (86_400 s).
 *   - Values marked "0..1" are clamped by the producer, not the consumer.
 *   - `null` means abstention (no knowledge). It never means zero.
 */

// ---------------------------------------------------------------------------
// Ids & closed vocabularies (Law 11: membership changes are contract changes)
// ---------------------------------------------------------------------------

export type Id = number;
/** Epoch seconds. */
export type Epoch = number;

export const ID_RANGES = {
  segment: [1_000, 4_999],
  concept: [5_000, 5_499],
  category: [5_500, 5_999],
  brand: [6_000, 6_999],
  /** Unallocated gap used for anchor nodes (pricebook 7001, catalog 7002, trust aspect 7101, quality aspect 7102). */
  anchor: [7_000, 7_999],
  /** 1_000_000 + run_index * 100_000 + offset. Every rng key uses the OFFSET, never the id. */
  shopper: [1_000_000, 1_999_999],
  creative: [2_000_000, 2_999_999],
  product: [3_000_000, 3_999_999],
  page: [4_000_000, 4_999_999],
  /** A new id is allocated for every belief VERSION. */
  belief: [8_000_000, Number.MAX_SAFE_INTEGER],
} as const;

/** Sentinel valid_to for a live (current) version. */
export const VALID_TO_LIVE = 9_007_199_254_740_991;

/** Closed claim/attribute vocabulary. Perception maps anything unknown to OTHER. */
export const Concept = {
  PERFORMANCE: 5000, COMFORT: 5001, DURABILITY: 5002, ECO_FRIENDLY: 5003,
  RECYCLED_MATERIALS: 5004, LIGHTWEIGHT: 5005, CUSHIONING: 5006, BREATHABLE: 5007,
  WATERPROOF: 5008, VEGAN: 5009, PREMIUM: 5010, DISCOUNT: 5011, VALUE_PRICED: 5012,
  FREE_SHIPPING: 5013, FAST_SHIPPING: 5014, FREE_RETURNS: 5015, WARRANTY: 5016,
  STYLE: 5017, INNOVATIVE: 5018, SUSTAINABLE_PACKAGING: 5019, LOCALLY_MADE: 5020,
  HANDCRAFTED: 5021, LIMITED_EDITION: 5022, AWARD_WINNING: 5023, EXPERT_ENDORSED: 5024,
  WIDE_SIZES: 5025, ARCH_SUPPORT: 5026, GRIP: 5027, MACHINE_WASHABLE: 5028, OTHER: 5029,
} as const;
export type ConceptId = (typeof Concept)[keyof typeof Concept];

export const Category = {
  CASUAL_SHOES: 5500, TRAIL_SHOES: 5501, SANDALS: 5502, SOCKS: 5503,
  RUNNING_SHOES: 5504, APPAREL: 5505, ACCESSORIES: 5506, FITNESS_EQUIPMENT: 5507,
  RECOVERY: 5508, OUTDOOR_GEAR: 5509,
} as const;
export type CategoryId = (typeof Category)[keyof typeof Category];

/** Behavioral motifs may appear in a DecisionContext. Explanatory motifs appear in traces only. */
export type BehavioralMotifType =
  | "preference_fit"
  | "goal_fit"
  | "brand_semantic_fatigue"
  | "expectation_violation"
  | "concept_saturation" // P1: retrieved but unread at P0
  | "social_proof"; // P1: read only when w_social > 0
export type ExplanatoryMotifType = "experience_path" | "habit_path";
export type MotifType = BehavioralMotifType | ExplanatoryMotifType;

/** Episodic events (stored) + log-only NEED_* records. IGNORE is derived and is never an event. */
export type EpisodicEventType =
  | "SAW" | "CLICKED" | "VISITED" | "BROWSED" | "BOUNCED"
  | "CARTED" | "ABANDONED" | "BOUGHT" | "PRICE_SEEN" | "EXPERIENCED";
export type LogOnlyEventType = "NEED_ACTIVATED" | "NEED_EXPIRED" | "NEED_SATISFIED";
export type EventType = EpisodicEventType | LogOnlyEventType;

/**
 * decide() output. This is the DEEPEST stage reached.
 * Funnel: creative → IGNORE | CLICK. Page → BOUNCE | BROWSE | CART | BUY.
 * A resumed cart → BUY | ABANDON.
 */
export type Action = "IGNORE" | "CLICK" | "BOUNCE" | "BROWSE" | "CART" | "ABANDON" | "BUY";

/** The four gates, in draw order. */
export type Stage = "CLICK" | "BROWSE" | "CART" | "BUY";
export const STAGES: readonly Stage[] = ["CLICK", "BROWSE", "CART", "BUY"];

export type StimulusKind = "creative" | "page";

// ---------------------------------------------------------------------------
// Personas (Law 12: three families, each with exactly one entry point)
// ---------------------------------------------------------------------------

/** One segment, exactly as authored in fixtures/<brand>/personas.json. */
export interface SegmentSpec {
  segment_id: Id; // 1000+
  name: string; // e.g. "eco_enthusiast"
  archetype?: string; // prose, not read by code
  /** Population share. Shares across segments must sum to 1.0. */
  share: number;
  /**
   * Family 1: preference priors, as concept id → mean w.
   * Each shopper draws w ~ N(mean, prior_sd) clipped to [0.05, 0.95].
   * These are seeded as PREFERS edges with E0 = 2 and are NEVER re-multiplied
   * in appraisal.
   */
  prior_means: Record<string /* ConceptId */, number>;
  /** Family 2: segment means, each drawn N(mean, trait_sd) and clipped to [0, 1]. */
  traits: AppraisalTraits;
  /** Family 3: segment means for the choice coefficients. */
  coeffs: {
    impulsivity: number; // drawn N(mean, 0.15), clipped to [0.4, 2.0]
    price_sensitivity: number; // drawn N(mean, 0.10), clipped to [0.05, 1.5]
    /** [mean, sd] in dollars. Drawn and floored at $30. A total for the RUN, never replenished. */
    budget: [number, number];
  };
  /** Additive shift on the population θ_s, e.g. {"CLICK": 0.5} (makes clicking harder). */
  theta_adjust: Partial<Record<Stage, number>>;
}

export interface PersonaFile {
  comment?: string;
  prior_sd?: number; // 0.08
  trait_sd_default?: number; // 0.08
  theta_jitter_sd?: number; // 0.15
  segments: SegmentSpec[];
}

/** appraise() only. novelty_seeking is drawn but has NO consumer at P0 (registry row 19 is P1). */
export interface AppraisalTraits {
  trust_orientation: number; // 0..1, tilts low-confidence credibility
  deal_proneness: number; // 0..1, multiplies the PERCEIVED claimed discount
  novelty_seeking: number; // 0..1, unused at P0
}

/** decide() only. */
export interface ChoiceCoeffs {
  /** Logistic temperature τ. Its ONLY entry point. */
  impulsivity: number;
  /** Multiplies the realised price gap (post-click gates only). Losses count ×2. */
  price_sensitivity: number;
  budget: number;
  switching_inertia: number; // P1, 0 at P0
  risk_aversion: number; // P1, 0 at P0
  /** θ_s = calibration base + segment theta_adjust + N(0, 0.15), drawn per shopper. */
  stage_bases: Record<Stage, number>;
}

/** A drawn shopper. Identity depends only on (seed, offset), so growing the population never changes existing shoppers. */
export interface Shopper {
  shopper_id: Id;
  offset: number;
  segment_id: Id;
  budget: number;
  priors: Array<[ConceptId, number]>;
  traits: AppraisalTraits;
  coeffs: ChoiceCoeffs;
}

// ---------------------------------------------------------------------------
// Shopper state: the six families (PLAN.md §0.1). Every subjective edge is
// bitemporal: supersede = close the old version (valid_to = now) + create a
// new one. Nothing is ever overwritten.
// ---------------------------------------------------------------------------

export interface Bitemporal {
  /** When this version opened. */
  t: Epoch;
  /** VALID_TO_LIVE while current. */
  valid_to: Epoch;
}

/** Why a learned version exists: the provenance receipt. */
export interface Cause {
  cause_kind: EpisodicEventType | "SEED";
  cause_id: Id; // the creative/page/product the event was about (0 for SEED)
}

// --- 1. Objective world (shared truth, never seen directly by a mind) -------

export interface Product {
  product_id: Id;
  name: string;
  brand_id: Id; // SOLD_BY
  category_id: CategoryId; // IN_CATEGORY
  list_price: number;
  /** HAS_ATTR. Catalog truth, never LLM output. EXPERIENCED teaches preferences ONLY on these. */
  attr_concept_ids: ConceptId[];
  /**
   * Law 15: hidden. Read by the fulfillment step only, to draw satisfaction.
   * Must never appear in any payload a mind (or Jev) sees.
   */
  latent_quality?: never;
}

export interface PricedAt extends Bitemporal {
  product_id: Id;
  price: number;
}

/** A creative as PERCEIVED. Claims and offers come from the frozen perception cache. */
export interface CreativeFacts {
  creative_id: Id;
  brand_id: Id; // PROMOTES
  /** CLAIMS{strength}, 0..1, concepts restricted to the closed enum. */
  claims: Partial<Record<ConceptId, number>>;
  /** OFFERS{claimed_pct}: product → the PERCEIVED discount, 0..0.95 (0 = no offer). */
  offers: Record<string /* product id */, number>;
  /** Copy is perception input + cache key only. It has ZERO runtime effect. */
  headline?: string;
  body?: string;
  image?: string;
}

export interface PageFacts {
  page_id: Id;
  product_id: Id; // PAGE_FOR
  /** SHOWS. An EXPECTS concept the page does not show is a violation candidate. */
  shows_concept_ids: ConceptId[];
}

export interface ObjectiveWorld {
  products: Product[];
  prices: PricedAt[];
  creatives: CreativeFacts[];
  pages: PageFacts[];
}

// --- 2. Episodic (what happened: raw, chronological, replayable) ----------

export interface EpisodicEvent {
  type: EventType;
  shopper_id: Id;
  /** Every event of tick k carries t = t0 + k * tick_seconds. Order within a tick = emission order. */
  t: Epoch;
  run: number;
  /** creative (SAW/CLICKED), page (VISITED/BROWSED/BOUNCED), product (CARTED/ABANDONED/BOUGHT/PRICE_SEEN/EXPERIENCED), category (NEED_*) */
  subject: Id;
  price?: number; // BOUGHT, PRICE_SEEN
  sat?: number; // EXPERIENCED, 0..1
  /** JSONL only. Attributes page/product events to the ad that caused them. */
  cause_creative?: Id;
  // NEED_ACTIVATED props:
  strength?: number;
  budget_cap?: number;
  deadline_t?: Epoch;
  source?: "seeded" | "scripted";
  // NEED_SATISFIED props:
  cause_kind?: "BOUGHT";
  cause_id?: Id;
}

// --- 3. Subjective worldview (what they believe, with confidence) ----------

/** Reified Belief node. A new id per version; liveness lives on the HOLDS edge. */
export interface Belief extends Bitemporal {
  belief_id: Id;
  about_id: Id; // brand
  that_id: 7101 | 7102; // trust | quality (quality is P1)
  value: number; // 0..1
  evidence: number; // E, capped at 8
  derived_from: DerivedFrom[];
}

/** One provenance row per cause target, folded across versions. */
export interface DerivedFrom {
  kind: EpisodicEventType;
  target: Id;
  count: number;
  first_t: Epoch;
  last_t: Epoch;
  weight: number;
}

/** What a shopper believes a brand SAYS about a concept (taught by SAW/CLICK, α = 0.2). */
export interface Expects extends Bitemporal {
  concept_id: ConceptId;
  about: Id; // brand
  strength: number; // 0..1
  cause_id: Id; // the creative
}

export interface ReferencePrice extends Bitemporal {
  product_id: Id;
  /** Exponential smoothing of PRICE_SEEN, α = 0.3. The first sighting sets it outright. */
  price: number;
}

// --- 4. Preferences & habits (the supersession chain IS the taste history) --

export interface Prefers extends Bitemporal, Cause {
  concept_id: ConceptId;
  w: number; // 0..1
  evidence: number; // E, capped at 8. Priors start at 2.
  source: "prior" | "learned";
}

/** P1. Strength = E / (E + 2). */
export interface Habit extends Bitemporal {
  brand_id: Id;
  evidence: number;
}

// --- 5. Goal state (exogenous demand: the sim captures it, never creates it) --

export interface Need extends Bitemporal {
  category_id: CategoryId;
  strength: number; // 0..1, seeded U[0.5, 0.9]
  /** Absolute dollars. decide() only: BUY prob ×0.25 when price > cap. */
  budget_cap: number;
  deadline_t: Epoch; // urgency = clamp01(1 − (deadline_t − now) / 7 days)
  source: "seeded" | "scripted";
  /** Set when the need closes: BOUGHT + product, or NEED_EXPIRED + 0. */
  closed_cause_kind?: "BOUGHT" | "NEED_EXPIRED";
  closed_cause_id?: Id;
}

// --- 6. Social context (P1, opt-in) -----------------------------------------

/**
 * Seeded Watts-Strogatz small world. Stored in both directions.
 * Reads are as-of the previous tick, so there is no intra-tick feedback.
 */
export interface TrustsPerson {
  peer_id: Id;
  w: number; // U[0.4, 0.9]
}

/** Everything one shopper carries. History = all versions; "live" = valid_to === VALID_TO_LIVE. */
export interface ShopperState {
  shopper: Shopper;
  episodic: EpisodicEvent[];
  beliefs: Belief[];
  expects: Expects[];
  reference_prices: ReferencePrice[];
  prefers: Prefers[];
  habits: Habit[];
  needs: Need[];
  trusts: TrustsPerson[];
}

// ---------------------------------------------------------------------------
// The decision-time view: DecisionContext (C1). This is what a mind sees.
// ---------------------------------------------------------------------------

export interface BeliefScalar {
  value: number;
  evidence: number;
  /** = E / (E + 0.7), denormalised. Validated to ±0.005. */
  confidence: number;
}

export interface ActiveNeed {
  category: CategoryId;
  strength: number;
  urgency: number;
  budget_cap: number;
}

export interface Scalars {
  // --- the v3 MemoryPacket (first nine, byte-compatible) ---
  shopper_id: Id;
  /** Any SAW of a creative PROMOTES-ing the stimulus brand within the 14-tick window. */
  aware_of_brand: boolean;
  /** Σ exp-decay(age, half-life 2 days) over same-brand SAWs in the window. ≥ 0. */
  adstock: number;
  /** SAWs of THIS creative (or VISITs of THIS page) in the last 72h. */
  exposures_72h: number;
  last_seen_t: Epoch | null;
  /** The shopper's smoothed reference price for the stimulus product(s). EMPTY until a PRICE_SEEN is consolidated. */
  reference_price: Record<string /* product id */, number>;
  /** (current − reference) / reference for the primary product. Negative = realised deal. 0 with no reference. */
  current_price_gap: number;
  /** budget − Σ BOUGHT.price over the whole run. */
  budget_left: number;
  /** Carted product ids not yet resolved by a later BOUGHT/ABANDONED. */
  cart: Id[];
  // --- worldview scalars ---
  /** null = unknown brand = abstention (credibility floors to 0.2 ± tilt). */
  trust_belief: BeliefScalar | null;
  quality_belief: BeliefScalar | null; // P1, always null at P0
  /** Present iff a goal_fit motif is present (a validated biconditional). */
  active_need: ActiveNeed | null;
  habit: { stim_brand: number; rival_max: number } | null; // P1
}

/** A path alternates node ids and edge-type strings, has odd length ≥ 3 and maxLen ≤ 4 hops. */
export type MotifPath = Array<Id | string>;

interface MotifBase<T extends MotifType> {
  type: T;
  path: MotifPath;
}

/** PREFERS ∩ stimulus CLAIMS. The strongest single hit is kept (w × claim strength ranking). Floors: w ≥ 0.05, claim ≥ 0.05. */
export interface PreferenceFitMotif extends MotifBase<"preference_fit"> {
  strength: number; // the PREFERS w
  evidence: number;
  recency: number; // exp-decay(now − PREFERS.t, half-life 30 days)
}
/** NEEDS → category ← IN_CATEGORY product ← OFFERS / PAGE_FOR stimulus. */
export interface GoalFitMotif extends MotifBase<"goal_fit"> {
  strength: number;
  urgency: number;
}
/** Past SAWs of OTHER same-brand creatives sharing ≥ 1 claimed concept. strength = min(1, Σ recency / 3), with recency half-life 3 days. */
export interface BrandSemanticFatigueMotif extends MotifBase<"brand_semantic_fatigue"> {
  strength: number;
  recency: number; // of the most recent contributor
  brand: Id;
}
/** Page stimuli only: EXPECTS(about = page brand), strength ≥ 0.5, concept not in SHOWS. */
export interface ExpectationViolationMotif extends MotifBase<"expectation_violation"> {
  strength: number;
}
/** The same construction as fatigue but OTHER brands, normaliser 4. P1: unread. */
export interface ConceptSaturationMotif extends MotifBase<"concept_saturation"> {
  strength: number;
}
/** A trusted peer BOUGHT the stimulus product before this tick. The highest-trust peer is kept. */
export interface SocialProofMotif extends MotifBase<"social_proof"> {
  /** clamp01((peer_trust · (2·experience − 1) + 1) / 2) */
  valence: number;
  peer_trust: number;
  /** The peer's latest EXPERIENCED sat for that product, else 1.0 (bought, not yet delivered). */
  experience: number;
}
export type BehavioralMotif =
  | PreferenceFitMotif | GoalFitMotif | BrandSemanticFatigueMotif
  | ExpectationViolationMotif | ConceptSaturationMotif | SocialProofMotif;

export interface DecisionContext {
  scalars: Scalars;
  /** An empty list is valid: no paths = no knowledge. Nothing is ever fabricated to fill a field. */
  motifs: BehavioralMotif[];
}

/** The five P0 dims, all 0..1 (P1 dims nullable). */
export interface Appraisal {
  relevance: number;
  credibility: number;
  brand_message_fatigue: number;
  offer_attractiveness: number;
  /** 1.0 at the ad stage. 1 − violation strength on pages. */
  expectation_alignment: number;
  novelty: number | null; // P1, always null
  /** Reported whenever the motif is present. Moves credibility only if w_social > 0. */
  social_proof: number | null;
}

// ---------------------------------------------------------------------------
// Decision record: one row per decision. Store the INPUTS (so any candidate
// calibration can be replayed) plus what happened.
// ---------------------------------------------------------------------------

export interface DecisionRecord {
  run_id: string;
  arm: string;
  tick: number;
  offset: number;
  segment_id: Id;
  stimulus: { id: Id; kind: StimulusKind; brand_id: Id; page_id: Id | null };
  /** For pages: the creative whose click led here (attribution + concept source for learning). */
  cause_creative: Id | null;
  /** True when this page decision resumes an existing cart (starts at the BUY gate). */
  resumed_cart: boolean;
  context: DecisionContext;
  /** Inputs. Traits/coeffs are engine-internal in ShopSim (Law 12/15 kept them off the API). */
  traits: AppraisalTraits;
  coeffs: ChoiceCoeffs;
  /** Stimulus-side input that bypasses the context: max claimed_pct over offers. */
  claimed_pct: number;
  // Outputs:
  appraisal: Appraisal;
  /** Creative: {CLICK}. Page: {BROWSE, CART, BUY}. These are per-gate CONDITIONALS, not reach products. */
  gate_probabilities: Partial<Record<Stage, number>>;
  /** The same context with active_need + goal_fit removed (only present when a need was live). */
  counterfactual_need_off: { appraisal: Appraisal; gate_probabilities: Partial<Record<Stage, number>> } | null;
  /** One uniform per gate reached, in stage order. Seed key: (seed, "decide", offset, tick, stimulus_id). */
  draws: number[];
  action: Action;
  emitted_events: EpisodicEvent[];
}

/** consolidate() output. A mind never writes; the engine folds these per (kind, object) per tick. */
export interface EvidenceDelta {
  kind: "edge" /* PREFERS */ | "belief" | "belief:quality" | "expects" | "ref_price" | "need_satisfy" | "habit";
  subject: Id; // shopper
  object: Id; // concept | brand | product | category
  target: number;
  weight: number;
  cause_kind: EventType;
  cause_id: Id;
}

// ---------------------------------------------------------------------------
// Run config + run summary (C3)
// ---------------------------------------------------------------------------

export interface ScheduleRow {
  creative_id: Id;
  start_tick: number;
  end_tick: number; // inclusive
  /** Per-shopper per-tick Bernoulli reach. */
  reach_prob: number;
  page_id?: Id;
  /** Filter applied AFTER the reach draw (so the stream shape is audience-independent). */
  audience_segments?: Id[];
  /** Seeded per-shopper A/B split. The (seed, "page", offset, creative) draw is stable for the run. */
  page_ids?: Id[];
}

export interface AllocationConfig {
  enabled: boolean;
  prior_exposures: number; // 120
  prior_clicks: number; // 6 (prior CTR 5%)
  floor_share: number; // 0.05
  power: number; // 2.0. share ∝ smoothed_ctr^power
}

export interface ArmSpec {
  name: string;
  goal_overrides?: { scripted_enabled?: boolean; waves_enabled?: boolean; extra_waves?: GoalWave[]; wave_scale?: number };
  branch_from?: string;
  /** Replay the parent's log to here, then diverge. Shared prefix dilutes cross-arm deltas. */
  divergence_tick?: number;
  exposure_overrides?: Record<string, unknown>;
  promo_overrides?: Record<string, unknown>;
}

export interface GoalWave {
  name?: string;
  category_id: CategoryId;
  start_tick: number;
  end_tick: number;
  rate_multiplier: number;
}

export interface GoalConfig {
  /** segment id → category id → P(arrival) per tick. */
  arrival_rates_per_tick: Record<string, Record<string, number>>;
  need_defaults: {
    strength_range: [number, number]; // [0.5, 0.9]
    deadline_ticks_range: [number, number]; // [4, 8]
    budget_cap_by_category: Record<string, number>;
  };
  waves: GoalWave[];
  scripted: Array<{ name: string; shopper_id: Id; category_id: CategoryId; activate_tick: number; strength: number; budget_cap: number; deadline_tick: number }>;
}

export interface RunConfig {
  label: string;
  seed: number;
  ticks: number;
  t0: Epoch;
  tick_seconds: number; // 86_400
  population: { size: number; personas: string; social?: { enabled: boolean; degree: number; rewire_p: number; weight_min: number; weight_max: number } };
  exposure: { frequency_cap_per_tick: number /* 2 */; frequency_cap_72h: number /* 6 */; schedule: ScheduleRow[]; allocation?: AllocationConfig };
  goals: { config: string; overrides?: ArmSpec["goal_overrides"] };
  fulfillment: { lag_ticks: number /* 2 */; sat_noise_sd: number /* 0.08 */ };
  promos?: { schedule: string; enabled: boolean };
  /** The ONLY tunables. evidence.py constants are frozen by hash. */
  calibration?: { stage_bases?: Partial<Record<Stage, number>>; appraisal?: Partial<typeof APPRAISAL_PARAMS>; choice?: Record<string, unknown>; retrieval?: Partial<typeof RETRIEVAL_PARAMS> };
  arms: ArmSpec[];
}

export interface RunManifest {
  seed: number;
  run_index: number;
  config_hash: string; // sha256(canonical run_config + arm name)
  perception_cache_hash: string;
  appraisal_cache_hash: string;
  evidence_hash: string;
  goal_config_hash: string;
  latent_quality_hash: string;
  social_config_hash?: string;
  view_hash: string;
}

/** Event-type → count. Keys are a subset of the funnel event types. */
export type FunnelCounts = Partial<Record<"SAW" | "CLICKED" | "VISITED" | "BROWSED" | "BOUNCED" | "CARTED" | "ABANDONED" | "BOUGHT" | "EXPERIENCED", number>>;

export interface RunSummary {
  run_manifest: RunManifest;
  /** arm → segment id → event counts. This is THE per-segment roll-up. */
  funnel: Record<string, Record<string, FunnelCounts>>;
  ctr_by_day: Array<{ tick: number; exposures: number; clicks: number; ctr: number | null }>;
  funnel_by_creative: Record<string, FunnelCounts>;
  /** bounce_rate = BOUNCED / (VISITED + BOUNCED). */
  funnel_by_page: Record<string, FunnelCounts & { bounce_rate: number | null }>;
  ctr_by_creative_by_day: Array<{ creative: Id; tick: number; exposures: number; clicks: number; ctr: number | null }>;
  revenue: { total: number; by_creative: Record<string, number> };
  /** Mean live PREFERS w per (claimed concept, segment) per tick. null = no holders yet. */
  preference_drift: Array<{ concept: ConceptId; segment: Id; series: Array<number | null> }>;
  belief_drift: Array<{ aspect: "trust"; about: Id; segment: Id | "all"; series: Array<number | null>; confidence_series: Array<number | null> }>;
  belief_confidence_dist: Array<{ aspect: string; bin_lo: number; bin_hi: number; count: number }>;
  reference_price_trajectory: Array<{ tick: number; current_price: number | null; mean_reference_price: number | null; n_holders: number }>;
  /** Measured at PAGE decisions, split by whether active_need was present. */
  goal_stats: { p_buy_need_on: number | null; p_buy_need_off: number | null; decisions_need_on: number; decisions_need_off: number; time_to_satisfaction: number[]; decisions_from_tick: number };
  /** Three channels measured on creative decisions; "high" means level ≥ 0.5. */
  fatigue_split: Record<"asset" | "brand_msg" | "concept", Array<{ tick: number; n: number; mean: number; high_n: number; high_ctr: number | null; low_n: number; low_ctr: number | null }>>;
  violations: { count: number; bounce_delta: number | null };
  motif_stats: Record<string, { prevalence_by_outcome: Partial<Record<Action, number>>; mean_strength: number | null }>;
  /**
   * 95% percentile bootstrap, 2000 reps, resampling SHOPPERS.
   * Keys: "<metric>" or "<metric>:<segment>".
   * Metrics: ctr, browse_rate, cart_rate, buy_rate, buy_per_exposure, p_buy_need_on, p_buy_need_off.
   */
  ci: Record<string, [number, number]>;
  repeat_ltv_by_arm: Array<{ arm: string; buyers: number; buys: number; repeat_buyers: number; repeat_rate: number | null; buys_per_buyer: number | null; revenue_total: number; revenue_per_buyer: number | null }>;
  /** Observational: "causal" only means w_social > 0, NOT that confounding was removed. */
  social_lift: { p_buy_social_on: number | null; p_buy_social_off: number | null; lift: number | null; decisions_on: number; decisions_off: number; w_social: number; causal: boolean; note: string } | null;
  provenance_coverage: { coverage: number | null; prefers: { versions: number; learned_versions: number; with_cause: number; coverage: number | null; cause_kinds: Record<string, number> }; beliefs: { versions: number; with_provenance: number; coverage: number | null }; belief_scope: string } | null;
}

// ---------------------------------------------------------------------------
// Constants: data, copied verbatim. No logic lives here.
// ---------------------------------------------------------------------------

/**
 * Appendix F, evidence.py (frozen).
 * blend: w' = (E·w + wt·target)/(E + wt), E' = min(E + wt, 8).
 * Pref target is always 1.0 except EXPERIENCED. belief_target null = feeds EXPECTS (α-smoothing).
 */
export const EVIDENCE = {
  E_CAP: 8, PRIOR_E0: 2, CONFIDENCE_K: 0.7, EPSILON: 0.01,
  MAX_SUBJECTIVE_WRITES_PER_TICK: 6, REF_PRICE_ALPHA: 0.3,
  /** Write priority when the per-tick cap bites (lowest truncated first). */
  WRITE_PRIORITY: ["need_satisfy", "belief", "edge", "ref_price", "expects", "habit"],
  table: {
    SAW: { pref_weight: 0.0, belief_weight: 0.2, belief_target: null },
    CLICKED: { pref_weight: 0.1, belief_weight: 0.2, belief_target: null },
    VISITED: { pref_weight: 0.25, belief_weight: 0.75, belief_target: 0.6 },
    BROWSED: { pref_weight: 0.25, belief_weight: 0.75, belief_target: 0.6 },
    CARTED: { pref_weight: 0.5, belief_weight: null, belief_target: null },
    BOUGHT: { pref_weight: 1.0, belief_weight: 1.5, belief_target: 0.65 },
  },
  /** EXPERIENCED: pref weight 0.75·|2·sat − 1| toward (sat ≥ 0.5 ? 1 : 0), on HAS_ATTR concepts only. Trust weight 2.0 toward sat. */
  EXPERIENCED_PREF_MAGNITUDE: 0.75, EXPERIENCED_BELIEF_WEIGHT: 2.0,
  /** Applier cold start for an unheld concept (Phase 7). Beliefs start from (0, 0). */
  COLD_START_PREFERS: { w: 0.5, E: 1.0 },
} as const;

/** U_s weights W[stage][dim]. Relevance weighs most at CART/BUY, which is how goal-gating emerges. */
export const STAGE_WEIGHTS: Record<Stage, Record<"relevance" | "credibility" | "brand_message_fatigue" | "offer_attractiveness" | "expectation_alignment", number>> = {
  CLICK: { relevance: 1.2, credibility: 0.6, brand_message_fatigue: -1.0, offer_attractiveness: 0.8, expectation_alignment: 0.3 },
  BROWSE: { relevance: 1.0, credibility: 0.8, brand_message_fatigue: -0.6, offer_attractiveness: 0.6, expectation_alignment: 1.5 },
  CART: { relevance: 1.6, credibility: 1.0, brand_message_fatigue: -0.3, offer_attractiveness: 1.0, expectation_alignment: 0.8 },
  BUY: { relevance: 2.2, credibility: 1.4, brand_message_fatigue: -0.2, offer_attractiveness: 1.0, expectation_alignment: 0.6 },
};

export const CHOICE_PARAMS = {
  gamma_adstock: 0.5, adstock_cap: 2.0, delta_wearout: 0.8,
  wearout_free_exposures: 2, wearout_scale: 4.0, loss_aversion: 2.0, budget_cap_damp: 0.25,
} as const;

/**
 * Calibrated θ_s at τ = 1 (Phase 7 fit; only BUY moved, 3.2 → 2.85).
 * The demo profile uses CLICK 4.07 (5% CTR, ×5.7). The retired CLICK 2.0 is ×31.
 */
export const DEFAULT_STAGE_BASES: Record<Stage, number> = { CLICK: 6.0, BROWSE: 2.3, CART: 3.7, BUY: 2.85 };

export const APPRAISAL_PARAMS = {
  w_pref: 0.6, w_goal: 0.8, no_belief_credibility: 0.2, trust_orientation_span: 0.4,
  offer_norm: 0.3, cold_credibility_factor: 0.5, cold_offer_factor: 0.25, w_social: 0.0,
} as const;

export const RETRIEVAL_PARAMS = {
  tick_seconds: 86_400, saw_window_ticks: 14, freq_window_seconds: 259_200,
  adstock_half_life_s: 2 * 86_400, recency_half_life_s: 3 * 86_400,
  pref_recency_half_life_s: 30 * 86_400, fatigue_norm: 3.0, saturation_norm: 4.0,
  urgency_horizon_s: 7 * 86_400, pref_min_w: 0.05, violation_min_strength: 0.5,
  claim_min_strength: 0.05, max_path_len: 4, budget_default: 200.0, social_default_experience: 1.0,
} as const;

/** Researched base-rate bands (eval/market-research.md). Calibrate to these; never "accelerate" to them. */
export const FUNNEL_BANDS = {
  p_click: [0.005, 0.02],
  bounce_rate: [0.45, 0.55],
  p_cart_given_browse: [0.1, 0.2],
  p_buy_given_cart: [0.24, 0.28],
  visit_to_purchase: [0.01, 0.03],
} as const;
