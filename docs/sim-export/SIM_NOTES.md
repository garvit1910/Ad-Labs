# ShopSim → Jev: simulation notes

**Commit:** `b208e33e04812ebd5f4286cdde1d3b55707a5108` on branch `phase-7-calibration-evals`. This branch is 32 commits ahead of `main`; Phases 5–7 and the 05 Mind exhibit exist only here.
**Tree:** the working tree has uncommitted edits to `demo-script.md` and `web/app/globals.css`. §6 quotes the working copy of `demo-script.md`.
**Written:** 2026-10-23, read-only pass. The only output is this file and `contracts.ts`, which renders every contract below as types.

**How to read this:** every claim cites a `path:line` in the repo. "Documented" means ShopSim's own docs say it. "Found while reading" means I derived it from the code and, where noted, checked it against committed run data. It was never confirmed by a fresh run.

---

## 0. The rules that survived (read this if nothing else)

These are the hard-won rules, roughly in order of how much pain they prevented. Each is restated in its own section below.

1. **The evidence hierarchy is law.** Seeing an ad never teaches taste. Only engagement teaches taste, at strictly increasing weights: CLICK < BROWSE < CART < BUY. Living with a product teaches the truth, and only about attributes the product really has. (`engine/shopsim/contracts/evidence.py:8-11`)
2. **Single entry (Law 12).** Every behavioral variable enters the pipeline at exactly one point. Persona priors exist only as seeded preference edges and are never multiplied again. Traits feed appraisal only. Coefficients feed choice only. A 23-row registry plus a test enforces this. (`CONTRACT.md:174-210`)
3. **Abstention is structural.** No belief means `null`. No path means no motif. Nothing is ever fabricated to fill a field, and an unknown brand floors credibility instead of inventing familiarity. (`CONTRACT.md:105-109`)
4. **Hidden truth stays hidden (Law 15).** `latent_quality` reaches a shopper only through a generated EXPERIENCED satisfaction draw. Every payload a mind sees is scanned for forbidden keys. (`engine/shopsim/contracts/types.py:39-40, 237-245`)
5. **The model gives a probability; the engine draws the action.** Draws come from a seeded substream keyed by `(seed, "decide", offset, tick, stimulus)`, with one uniform per gate reached, so twins stay rng-aligned. ShopSim's version of this rule was "the LLM never picks CLICK/BUY" (`PLAN.md:139`). With Jev, the model supplies the calibrated P and the engine still rolls the dice.
6. **Determinism by freezing.** Perception runs once and is cached. The manifest carries hashes of every input. The JSONL event log is the replay source of truth, and worldview state is recomputed from it, never replayed from stored deltas. (`CONTRACT.md:389-418`)
7. **Different quantities need different constants.** One half-life once served both ad recency and taste recency, which made seeded preferences decay at ad speed and starved the whole funnel. Splitting it into 3 days for ads and 30 days for taste fixed most of what looked like a broken choice model. (`engine/shopsim/hydramem/schema.py:140-150`, `eval/calibration.md`)
8. **Calibrate to researched bands; never accelerate the displayed number.** A demo profile that loosened the CLICK gate (θ 2.0) produced 28% CTR and ~46× ROAS in `r039`, and a 300×60 Nisolo run realised 35% CTR. The UI then had to divide those numbers back down. (`eval/calibration.md:13`, `eval/results/calibration.json` → `demo_profile.click_gate_acceleration.note`)
9. **Record decision INPUTS, not outputs.** A trace of raw appraisal inputs lets any candidate calibration replay offline in milliseconds, instead of costing a 20–110 minute run. (`engine/shopsim/eval/trace.py:1-29`)
10. **Absolute-dollar gates need brand-scaled budgets.** A premium catalog with value-tier budgets reads as a broken funnel. (`fixtures/nisolo/personas.json` comment; `eval/market-research.md` §6)

---

## 1. Shopper state: the six families

The normative table is in `PLAN.md:58-67`. The edge catalog is in `engine/shopsim/hydramem/schema.py:35-104`. Every subjective, preference and need edge is **bitemporal**: a live version carries `valid_to = 9_007_199_254_740_991`, and superseding means `SET old.valid_to = now` followed by `CREATE new`. History is never erased (`schema.py:8-9, 119-121`).

| # | Family | Records (fields: types) | Initialised from persona? |
|---|---|---|---|
| 1 | **Objective world**: what is true | product `{name, list_price}`. `SOLD_BY→brand`, `IN_CATEGORY→category`, `HAS_ATTR→concept` (catalog truth, never LLM output). `PRICED_AT{price: float, t, valid_to}`. Creative `CLAIMS→concept{strength: 0..1}`, `PROMOTES→brand`, `OFFERS→product{claimed_pct: 0..0.95}`. Page `SHOWS→concept`, `PAGE_FOR→product`. Hidden: `latent_quality` (Law 15). | No. Comes from `catalog.csv`, `page_variants.json` and the perception cache. |
| 2 | **Episodic**: what happened | `SAW CLICKED VISITED BROWSED BOUNCED CARTED ABANDONED`, all `{t, run}`. `BOUGHT{t,run,price}`, `PRICE_SEEN{t,run,price}`, `EXPERIENCED{t,run,sat: 0..1}`. JSONL-only records: `NEED_ACTIVATED/EXPIRED/SATISFIED` and `TICK_COMPLETE`. IGNORE is derived and never stored. | No. Starts empty. |
| 3 | **Subjective worldview**: what they believe | A reified **Belief** node `{value: 0..1, evidence: E≤8, about_id: brand, that_id: 7101 trust / 7102 quality, t, valid_to}` with edges `HOLDS{t,valid_to}`, `ABOUT`, `THAT`, `DERIVED_FROM{kind, count, first_t, last_t, weight}`. `EXPECTS→concept{about: brand, strength: 0..1, t, valid_to, cause_id: creative}`. `REFERENCE_PRICE→product{price, t, valid_to}`. Confidence = `E/(E+0.7)` is computed, not stored. | No. Starts empty, which is abstention by design. |
| 4 | **Preferences & habits**: what they like | `PREFERS→concept{w: 0..1, evidence: E, source: prior\|learned, cause_kind, cause_id, t, valid_to}`. The supersession chain **is** the provenance timeline. `HABIT→brand{evidence, t, valid_to}` (P1; strength `E/(E+2)`). | **Yes. This is the only persona-seeded state.** `w ~ N(segment mean, 0.08)` clipped to [0.05, 0.95], `E0 = 2`, `source: prior`, `cause_kind: SEED`, written at `t0 − 1 tick` (`population/factory.py:163-167, 273-291`; `runner/loop.py:196`). |
| 5 | **Goal state**: what they need now | `NEEDS→category{strength: 0..1, budget_cap: $, deadline_t, t, valid_to, source: seeded\|scripted, closed_cause_kind, closed_cause_id}` | Indirectly: the **segment** keys the arrival rates. The runner's goal step creates needs (see below). |
| 6 | **Social** (P1, opt-in) | `TRUSTS_PERSON→shopper{w}`, written in both directions | A seeded Watts-Strogatz small world over offsets: degree 4, rewire 0.1, `w ~ U[0.4, 0.9]` (`population/factory.py:211-270`). Drawn once per population, not per shopper. |

The `shopper` node also carries `{segment_id, budget}`. Budget is the run-total spend; it is never replenished.

### How needs arrive (tick step 0, `engine/shopsim/runner/steps.py:141-226`)

1. **Expiry first:** a need whose `deadline_t ≤ now` closes with `closed_cause_kind = NEED_EXPIRED`.
2. **Seeded Bernoulli arrivals.** For each shopper offset and each category in `arrival_rates_per_tick[segment]`, draw `u` from `(seed, "goal", offset, tick)`. The draw happens even when a need for that category is already live, so the stream shape is state-independent. The rate is multiplied by any active wave; e.g. "marathon season" runs ×4 on 5504 over ticks 6–9 (`fixtures/demo-brand/goal_config.json`). A new need gets strength `U[0.5, 0.9]`, a deadline `U{4..8}` ticks out, and `budget_cap` from a per-category table.
3. **Scripted overrides** (Maya's need is one) close any live seeded need in the same category, then activate.
4. **Satisfaction** happens in consolidation: a BUY in an active-need category supersedes the NEEDS edge with `closed_cause = BOUGHT product`.

Rates are small: 0.01–0.06 per tick per category (`fixtures/demo-brand/goal_config.json`). Goals are **exogenous**: "this sim demonstrates demand capture, not demand creation" (`PLAN.md:394`).

### The decision-time view of state (`engine/shopsim/hydramem/reads.py:172-396`)

A mind never sees the six families directly. It sees a `DecisionContext`: 13 scalars plus typed motif paths (§3). Each scalar is derived as follows:

| Scalar | Derivation |
|---|---|
| `aware_of_brand` | any SAW of a same-brand creative within the 14-tick window (`reads.py:203-206`) |
| `adstock` | Σ `exp(−ln2·age/2d)` over same-brand SAWs in the window (`:207`) |
| `exposures_72h`, `last_seen_t` | SAWs of *this* creative, or VISITs of *this* page (`:209-214`) |
| `reference_price`, `current_price_gap` | live REFERENCE_PRICE for the stimulus product(s). Gap is `(price_now − ref)/ref` on the primary product, else 0 (`:216-221`) |
| `budget_left` | `budget − Σ BOUGHT.price` (default budget $200 when unset) (`:223-225`) |
| `cart` | carted products with no later BOUGHT/ABANDONED. A cart resolved earlier can be re-carted (v3.4 fix) (`:227-234`) |
| `trust_belief`, `quality_belief` | the live HOLDS belief whose `about_id` is the stimulus brand, else **null** (`:236-245`) |
| `active_need` | the best-matching live NEEDS for a stimulus product's category; present **iff** a goal_fit motif is (`:273-290`) |
| `habit` | P1 (`:247-251`) |

---

## 2. Personas

### Inputs and schema

A persona file is `fixtures/<brand>/personas.json`: `{prior_sd, trait_sd_default, theta_jitter_sd, segments[]}`. Each segment has this shape (see `SegmentSpec` in `contracts.ts`):

```json
{ "segment_id": 1005, "name": "style_conscious", "archetype": "fashion leader", "share": 0.09,
  "prior_means": {"5017": 0.7, "5022": 0.5, "5010": 0.45},
  "traits": {"trust_orientation": 0.5, "deal_proneness": 0.45, "novelty_seeking": 0.7},
  "coeffs": {"impulsivity": 1.05, "price_sensitivity": 0.55, "budget": [286, 57]},
  "theta_adjust": {} }
```

There are 13 authored segments, the same in both brands. Each segment's numbers are grounded in `eval/market-research.md` §4:

eco_enthusiast, performance_athlete, bargain_hunter, comfort_seeker, style_conscious, casual_browser, trail_adventurer, marathon_trainer, ortho_comfort, fashion_forward, brand_skeptic, deal_stacker, quality_investor.

Some segments shift stage thresholds:
- casual_browser: `CLICK +0.5`
- brand_skeptic: `CLICK +0.4`
- quality_investor: `CLICK +0.3`, `BUY −0.1`
- marathon_trainer: `BUY −0.2`

Nisolo's file is the demo-brand file with budgets ×2.2. The ordering and spread are kept, so the deal segments still sit below the $250 boot. That constraint is what makes the discount ladder informative (`fixtures/nisolo/personas.json` comment).

### The split: appraisal traits vs choice coefficients (Law 12)

| Family | Fields | Enters | Never enters |
|---|---|---|---|
| **Preference priors** | `prior_means` → PREFERS edges (E0 = 2) | retrieval → `preference_fit` motif → relevance | appraisal as a multiplier ("would count it twice", `types.py:348-350`) |
| **AppraisalTraits** | `trust_orientation`, `deal_proneness`, `novelty_seeking` | `appraise()` only | `decide()` (the signature has no traits param; source-scanned in a test) |
| **ChoiceCoeffs** | `impulsivity` (= temperature τ), `price_sensitivity`, `budget`, `stage_bases θ_s`, P1 `switching_inertia`, `risk_aversion` | `decide()` only | `appraise()` |

**Draws** (`population/factory.py:149-204`). Each shopper gets its own substream, `SeedSequence((seed, "pop", offset))`, and draws in a fixed order: segment (by cumulative share), then priors (sorted by concept), then traits, then coeffs, then θ jitter.

| Field | Distribution | Clip |
|---|---|---|
| prior w | N(mean, 0.08) | [0.05, 0.95] |
| traits | N(mean, 0.08) | [0, 1] |
| impulsivity | N(mean, 0.15) | [0.4, 2.0] |
| price_sensitivity | N(mean, 0.10) | [0.05, 1.5] |
| budget | N(mean, sd) | floor $30 |
| θ_s | calibration base + segment `theta_adjust` + N(0, 0.15) | — |

Growing the population never changes existing shoppers.

**Note:** `novelty_seeking` is drawn but has **no consumer at P0**. Registry row 19 (concept_saturation × novelty_seeking → novelty) was never pulled (`minds/appraisal.py:20-22`).

### The ENTRY_POINTS registry, condensed (`CONTRACT.md:178-202`)

| Rows | Inputs | Where they enter |
|---|---|---|
| 1 | priors | seeded PREFERS |
| 2–3 | preference_fit, goal_fit (strength × urgency) | relevance |
| 4 | need `budget_cap` | BUY damp ×0.25 |
| 5–6 | trust_belief, trust_orientation | credibility |
| 7 | aware_of_brand | cold gate |
| 8 | brand_semantic_fatigue | fatigue dim |
| 9 | claimed_pct × deal_proneness | offer dim (the *perceived* deal) |
| 10 | expectation_violation | 1 − alignment |
| 11–12 | adstock, wearout | utility (the single asset-repetition entry) |
| 13 | price_gap × price_sensitivity | utility (the *realised* deal; losses ×2) |
| 14 | reference_price | engine-side input to the gap |
| 15 | impulsivity | τ |
| 16 | budget_left | hard BUY block |
| 17 | θ_s | gate thresholds |
| 18 | cart | funnel state |
| 19–23 | P1 inputs | — |

Tests enforce the registry (`CONTRACT.md:204-210`):
- every trait and coefficient appears in exactly one row of the right stage;
- every scalar appears in at least one row;
- every behavioral motif appears in exactly one row.

---

## 3. Decision pipeline

```
perception (once per creative, frozen)          → objective CLAIMS/OFFERS
retrieval  (per shopper × stimulus)             → DecisionContext {scalars, motifs}
appraise   (ctx, traits, stimulus claimed_pct)  → 5 dims, 0..1
decide     (appraisal, scalars, coeffs, rng)    → Action (deepest gate reached)
expand     (action)                             → episodic events
```

### Perception (`engine/shopsim/perception/schema.py`, `perceive.py`)

- One vision-LLM call per creative (gpt-4o-mini). It returns strict JSON: `{claims: [{concept: <enum name>, strength}], claimed_discounts: [{product_id, claimed_pct}]}`.
- Concepts are constrained to the 30-name enum; unknown names map to `OTHER`. Strength is clamped to 0..1, claimed_pct to 0..0.95.
- Offers are only accepted for products the ad actually carries (`schema.py:78-106`).
- The result is cached on disk per stimulus hash and frozen. Never hand-edit a cache entry.
- The Nisolo "Up to 40% Off" creative's 0.40 is *read off the image* (the authored value is 0.0). A test fails if that ever stops being true.
- **Copy has zero runtime effect.** Only the perceived claims and offers do.
- **For Jev:** Jev takes no images, so perception stays an external, frozen pre-step exactly as in ShopSim.

### Retrieval: the motif library (`reads.py:253-363`, constants in `schema.py:127-167`)

Retrieval is "Route B": per-shopper single-hop reads, joined in Python against a per-tick cache of the objective layer. Every motif carries its typed **path** (alternating node ids and edge types, odd length ≥ 3, ≤ 4 hops). The path is the explanation the UI lights up.

| Motif | Construction | Fields |
|---|---|---|
| `preference_fit` | live PREFERS ∩ stimulus CLAIMS. Floors: `w ≥ 0.05`, `claim ≥ 0.05`. Keep the single best hit, ranked by `w × claim_strength`. | strength = w, evidence = E, recency = decay(age, **30 d**) |
| `goal_fit` | live NEEDS whose category matches a stimulus product's category. Path: `NEEDS→cat←IN_CATEGORY product←OFFERS\|PAGE_FOR stim`. | strength, urgency = clamp01(1 − (deadline − now)/7 d) |
| `brand_semantic_fatigue` | past SAWs (14-tick window) of **other same-brand** creatives sharing ≥ 1 claimed concept with this one. | strength = min(1, Σ decay(age, **3 d**)/3), recency of the newest contributor, brand |
| `concept_saturation` (P1) | the same construction for **other brands**, normaliser 4 | strength. Retrieved but unread. |
| `expectation_violation` | **pages only.** EXPECTS(about = page brand) with strength ≥ **0.5** whose concept is not in SHOWS. Keep the strongest. | strength |
| `social_proof` (P1) | a trusted peer BOUGHT a stimulus product **before this tick**. Keep the highest-trust peer. | valence = clamp01((w·(2·exp−1)+1)/2), peer_trust, experience (peer's sat, default 1.0) |
| `experience_path`, `habit_path` | explanatory, trace only | — |

Signals that are deliberately scalars, not motifs (Law 16): reference price, gap, budget, need cap, belief values, habit strengths, and adstock/wearout. The rule is "paths where relationships genuinely matter; scalars where a value is just a value" (`PLAN.md:56`).

### DecisionContext

Fields are listed in §1 and typed in `contracts.ts`. Its validation rules are (`types.py:248-338`):
- all 13 scalar keys present;
- `confidence` agrees with `E/(E+0.7)` to within 0.005;
- motif types are behavioral only, with each type's required numeric fields present;
- paths are well-formed;
- **`goal_fit` is present iff `active_need` is present**;
- no forbidden latent keys anywhere.

An empty motif list is valid.

### Appraisal: five dims (`engine/shopsim/minds/appraisal.py:59-123`, params in `minds/calibration.py:32-55`)

```
relevance   = clamp01(0.6 · pref.strength · pref.recency  +  0.8 · goal.strength · goal.urgency)
tilt        = 0.4 · (trust_orientation − 0.5)
credibility = no belief:  clamp01(0.2 + tilt)
              belief:     clamp01(0.5 + (value − 0.5)·conf  +  tilt·(1 − conf))     # orientation fills only the uncertain remainder
              + if w_social > 0:  w_social · (2·social_valence − 1)                 # default w_social = 0
brand_message_fatigue = clamp01(fatigue.strength)   or 0
offer_attractiveness  = clamp01(max_claimed_pct / 0.30) · deal_proneness            # the PERCEIVED deal; 30% saturates
expectation_alignment = 1 − violation.strength      or 1.0
cold gate: unaware ∧ no belief ∧ no motifs → relevance = 0, credibility ×0.5, offer ×0.25
```

### Choice: the staged gate model (`engine/shopsim/minds/choice.py:75-151`)

Each gate's utility and probability:

```
U_s = Σ_d W[s,d]·A_d  +  0.5·min(adstock, 2)  −  0.8·wearout(exposures_72h)
      − price_sensitivity · (2·gap if gap > 0 else gap)        # post-click gates only
wearout = clamp01((exposures_72h − 2) / 4)
P(advance at s) = σ((U_s − θ_s) / τ),     τ = impulsivity
```

The weight table `W[s,d]`:

| stage | relevance | credibility | fatigue | offer | alignment | θ_s default |
|---|---|---|---|---|---|---|
| CLICK | 1.2 | 0.6 | −1.0 | 0.8 | 0.3 | **6.0** |
| BROWSE | 1.0 | 0.8 | −0.6 | 0.6 | 1.5 | **2.3** |
| CART | 1.6 | 1.0 | −0.3 | 1.0 | 0.8 | **3.7** |
| BUY | 2.2 | 1.4 | −0.2 | 1.0 | 0.6 | **2.85** |

Relevance weighs ~2× more at BUY than at CLICK. That is how goal-gating *emerges* from one entry point: a shopper with no need can click out of curiosity but rarely buys (`PLAN.md:146`). The θ values are the Phase-7 fit; only BUY moved (3.2 → 2.85) (`calibration.py:98-117`).

**BUY guards** (`choice.py:88-98`). The price is derived as `min(reference_price) × (1 + gap)`.
- If `price > budget_left`, P(BUY) = 0. The draw is still consumed, which keeps rng aligned across twins.
- If `price > active_need.budget_cap`, P(BUY) ×0.25.
- With no reference price, **neither guard can fire**. See §8 bug (a).

**Funnel walk** (`choice.py:124-151`):
- **Creative:** one CLICK draw, giving CLICK or IGNORE.
- **Page:**
  - If the stimulus product is already in the cart (a *resumed cart*), skip straight to the BUY draw: BUY or ABANDON.
  - Otherwise draw BROWSE; on failure, BOUNCE.
  - Then draw CART; on failure, BROWSE.
  - Then draw BUY: success is BUY; failure is CART (the cart persists and resumes on a later tick).

**Randomness.** Every stochastic step has its own substream: `SeedSequence((seed, stream_tag, *key))` with `stream_tag = int.from_bytes(b"decide")` etc. (`runner/steps.py:31-41`). Keys always use **block offsets**, never shopper ids, so the same seed reproduces in any run block.

| Stream | Key |
|---|---|
| population | `(seed,"pop",offset)` |
| goals | `(seed,"goal",offset,tick)` |
| exposure | `(seed,"expose",offset,tick)` |
| decisions | `(seed,"decide",offset,tick,stimulus_id)` |
| landing-page A/B | `(seed,"page",offset,creative)`, tick-free so a shopper's variant is stable |
| fulfilment | `(seed,"fulfil",offset,product,purchase_t)` |
| social | `(seed,"social")` |
| CI bootstrap | `(seed,"ci",segment,metric_i)` |

**Action → events** (`engine/shopsim/runner/expansion.py`). Page events carry `cause_creative` in the JSONL.

| Action | Events emitted |
|---|---|
| IGNORE | `SAW` |
| CLICK | `SAW, CLICKED` |
| BOUNCE | `BOUNCED` only. A bounce teaches nothing and sees no price. |
| BROWSE | `VISITED, PRICE_SEEN, BROWSED` |
| CART | `… + CARTED` |
| BUY | `… + CARTED, BOUGHT{price}` |
| resumed BUY | `VISITED, PRICE_SEEN, BOUGHT` |
| resumed ABANDON | `VISITED, PRICE_SEEN, ABANDONED` |

### Jev mapping (my recommendation)

| ShopSim piece | Jev rebuild |
|---|---|
| Perception | **Stays outside Jev** (it needs images). Freeze its output exactly as before. |
| Retrieval / motifs | **Stays engine code.** This is the IP. Render the DecisionContext as the text state: scalars as plain facts, and each motif as one sentence with its path. Keep abstention literal ("no belief about this brand"), not a fake zero. |
| Appraisal dims | Optional `Score` questions (0..1) if you want the five-dim explanation panel. If Jev answers the gates directly, appraisal becomes an explanation layer. Don't feed Jev's own scores back into its gate questions, or you double-count. |
| Gates | **One yes/no question per gate, asked conditionally**: "clicks?"; then on the page "keeps browsing (no bounce)?", "adds to cart?", "buys?". Jev's calibrated P replaces `σ((U−θ)/τ)`. The engine draws with the seeded substream. This preserves cart-resume, rng-aligned twins, and per-gate calibration checks. A single `Choice` over {BOUNCE, BROWSE, CART, BUY} is simpler but loses the conditional structure the bands are stated in. |
| BUY guards, cart state, need lifecycle | **Stay deterministic code**, applied after Jev's P. They are testable and must never be "learned". |
| Learning (consolidate + applier) | **Stays engine code.** Jev generates no text and must not write state. evidence.py is a pure table. |
| Law 12 single entry | Harder with a model that reads the whole state. "Each variable appears once in the state text" becomes the rule. **Don't include segment names or archetypes** next to the learned PREFERS: that re-introduces the prior a second time. |
| Determinism | Cache Jev answers keyed by `hash(state text, question, model version)`, like the P1 appraisal "bucket key" idea (`CONTRACT.md:212-214`). Put the cache hash in the manifest. Replays then refuse on a hash change. |
| Calibration | Check Jev's per-gate P against `FUNNEL_BANDS`. If it is off, fit a per-gate logit shift offline from the decision trace (ShopSim's `shopsim.eval.calibrate` approach). Don't accelerate. |

The call budget is set by decisions, not shoppers. ShopSim's 300×20 reference run made **7,878 creative decisions and 89 page decisions** (`eval/README.md:48`). That is about one Jev question per creative decision, plus up to three per page decision.

---

## 4. State updates

### The evidence table (`engine/shopsim/contracts/evidence.py:60-70`, frozen by hash)

The update formula:

```
blend:  w' = (E·w + wt·target) / (E + wt),   E' = min(E + wt, 8)
confidence = E / (E + 0.7)      priors E0 = 2
```

| Event | Preference weight (target 1.0) on… | Trust-belief weight → target | EXPECTS |
|---|---|---|---|
| SAW | **0**. Never taste. | — | α = 0.2 toward the claim strength |
| (IGNORE) | 0. Derived; carries no evidence at P0. | — | — |
| CLICK | 0.10 on stimulus-claimed concepts | — | α = 0.2 |
| VISITED | 0.25 | 0.75 → 0.6 | — |
| BROWSED | 0.25 | 0.75 → 0.6 | — |
| CARTED | 0.50 | — | — |
| BOUGHT | 1.00 | 1.5 → 0.65. Also satisfies a matching need. | — |
| EXPERIENCED | `0.75·\|2·sat−1\|` toward (sat ≥ 0.5 ? 1 : 0), **only on HAS_ATTR concepts** | 2.0 → sat | — |
| PRICE_SEEN | — | — | ref price: `0.7·old + 0.3·seen` (the first sighting sets it outright) |

Concept attribution for engagement events works like this (`minds/consolidation.py:46-63`):
- the perceived claims of the creative itself;
- else the claims of the `cause_creative` that led to the page;
- else catalog truth (HAS_ATTR ∩ SHOWS).

In one line: ads teach expectations; experience teaches truth.

### Applier rules (`engine/shopsim/hydramem/writes.py:426-614`)

- **Fold per tick:** same-key deltas within a tick fold into ONE supersession. The blend still applies per delta in canonical `(t, event_rank)` order. The receipt carries the last cause; a belief's DERIVED_FROM accumulates every cause.
- **ε = 0.01:** a change smaller than that writes nothing.
- **Cap: ≤ 6 subjective writes per shopper per tick**, priority need_satisfy > belief > PREFERS > ref_price > expects > habit. Lower priority is truncated first.
- **Cold start (Phase 7):** an unheld concept starts at `(w 0.5, E 1.0)`, not `(0, 0)`. Under (0, 0), one CLICK set w to 1.0 outright, and every drift chart was a flat 1.0 (`minds/calibration.py:119-145`). Beliefs still start at `(0, 0)`, so the first belief equals its event's target, with low E.
- EXPECTS is keyed by (concept, brand), resolved through the causing creative's PROMOTES.

### The golden chain (contract-tested to the digit, `CONTRACT.md:384-387`)

The eco prior goes 0.45 (E 2) → CLICK 0.476 → BROWSE 0.532 → CART 0.614 → BUY 0.714 → positive experience 0.761 (E 4.6, confidence 0.87). I re-derived these with the blend formula and they match.

The trust example is "2 visits + 1 purchase → E 3.0 → confidence 0.81". That also matches, but the *value* comes out at **0.625**. The prose and the Appendix-B context say 0.70. See §8.

### brand_semantic_fatigue

This is the *message* channel, distinct from the other two:
- **asset wearout** is the repetition of *this* creative, as a scalar entering utility at −0.8 (`choice.py:51-53`);
- **concept saturation** is the same message from *rivals*, P1.

Fatigue fires when the shopper has recently seen **other creatives from the same brand that make an overlapping claim**. Its strength is `min(1, Σ recency/3)`, with a 3-day half-life over a 14-day window. It enters appraisal as `brand_message_fatigue`, at −1.0 utility at CLICK and fading down-funnel (−0.6, −0.3, −0.2).

Two laws measure it:
- **F12** (repetition decays CTR faster than rotation) passes: decay −0.108 vs −0.664 (`eval/README.md:20`).
- **F1** (frequency response rises, then wears out) passes: peak ×1.37 at exposure 2, −44% from the peak.

### Expectation violation

EXPECTS accumulates from **any** of a brand's creatives. Before Phase 7, 85% of page visits "violated" something at a mean strength of 0.42, which cost −0.64 utility at BROWSE on pages doing nothing wrong. That alone held bounce at 60–67%. The fix was a 0.5 strength floor (`schema.py:155-163`). The deliberate A/B variant (a page hiding a concept its own ad claims at 0.8) still fires. **F5** passes: bounce 0.421 → 0.563.

### The post-purchase experience loop

```
BUY at tick k ──(lag 2 ticks; 1 in demos)──▶ EXPERIENCED{sat}
    sat = clamp01(latent_quality[product] + N(0, 0.08))     # substream (seed,"fulfil",offset,product,purchase_t)
    → trust belief: weight 2.0 toward sat
    → PREFERS on the product's actual HAS_ATTR concepts: ±0.75·|2sat−1|
    → the same NEEDS was already closed at BUY (NEED_SATISFIED{cause BOUGHT product})
    → peers who TRUST this shopper see BOUGHT + EXPERIENCED from the next tick on (social_proof)
```

- The fulfilment queue is derived from BOUGHT events + lag. It is never persisted; it is rebuilt from the log on resume (`runner/steps.py:420-456`).
- `latent_quality.csv` is read in exactly one place.
- An overpromise multiplier (P1) on trust weight was never pulled: `×(1 + 0.5·max(0, expectation − sat))` (`evidence.py:98-106`).

---

## 5. Experiment loop

### Setup: shoppers × creatives × ticks

A run is `population.size` shoppers × `ticks` sim-days × a creative **schedule**. Each schedule row is `{creative_id, start_tick, end_tick, reach_prob, audience_segments?, page_ids?}` (`runner/config.py:35-47`).

| Run | Shape |
|---|---|
| reference (calibration) | 300 × 20 |
| demo market | 100 × 28, 5 creatives at reach 0.35 |
| F9 twin | 300 × 14 |

Experiments are a JSON spec of one of four types (`engine/shopsim/experiments/specs.py:1-27`). The spec is expanded into an ordinary run config, so `config_hash` pins the whole definition.

| Type | Arms |
|---|---|
| `ad_test` | one arm per creative on a shared seed (paired populations). Or `market.shared`: all creatives in one market arm with adaptive allocation. |
| `pricing` | discount-ladder arms plus a **pinned 0% control that always runs**. The discounted products are derived from the picked ads. The verdict is per depth vs control, per ad. |
| `page_ab` | within-run seeded 50/50 page split |
| `scenario` | goal-wave / quality / social overlay packs |

Arms can **branch** from a parent's log at `divergence_tick`: the prefix is replayed and the worldview recomputed. Resume refuses if any manifest hash changed; branch allows only `config_hash` to differ.

### The tick (`engine/shopsim/runner/loop.py:286-487`)

```
0  goal step      expire → seeded arrivals → scripted overrides   (JSONL first, then NEEDS writes)
1  promo hook     PRICED_AT supersessions to the scheduled discount (self-healing, idempotent)
2  exposure       per offset × active row: one uniform from (seed,"expose",offset,tick); u < reach_prob;
                  audience filter AFTER the draw; caps 2/tick and 6/72h
   (allocation)   if on: reach rescaled first by trailing smoothed CTR^2, prior 6 clicks / 120 exposures, floor 5%
3  creative phase batched retrieval per creative → appraise → decide (CLICK|IGNORE) → expand
                  clickers get a landing page (seeded A/B or a static map)
4  page phase     clickers ∪ held carts, batched per page → appraise → decide → expand; update cart state
5  fulfilment     purchases from tick − lag → EXPERIENCED
6  episodic write all events in canonical order (offset asc, emission order); JSONL write-ahead
7  consolidation  snapshot worldviews → consolidate() per active shopper → applier (fold, ε, cap)
8  NEED_SATISFIED log records from the kept need supersessions
9  results sweep  drift / belief / ref-price snapshots; results_state_<tick>.json
10 TICK_COMPLETE  fsync'd marker; resume truncates the log to the last marker
```

Every event of tick k carries `t = t0 + k·86400`. A run is byte-deterministic: same seed ⇒ identical `results.json`.

### Metrics (`engine/shopsim/runner/results.py`, `engine/shopsim/analytics/metrics.py`)

There are two observation channels:
- **event-derived:** funnel, CTR, exposures. Available live and on replay.
- **decision-derived:** motif prevalence, the need-on/off split, fatigue channels, violation sightings. Live decisions only, so a branch arm counts these from its divergence tick.

| Metric | Definition |
|---|---|
| `funnel[arm][segment]` | event counts per type (SAW…EXPERIENCED). **The per-segment roll-up.** |
| `ctr_by_day`, `ctr_by_creative_by_day` | CLICKED/SAW per tick |
| `funnel_by_creative`, `funnel_by_page` | page/product events attributed via `cause_creative`. `bounce_rate = BOUNCED/(VISITED+BOUNCED)` |
| `revenue{total, by_creative}` | Σ BOUGHT.price |
| `preference_drift` | mean live PREFERS w per (claimed concept, segment) per tick |
| `belief_drift`, `belief_confidence_dist` | mean trust value + confidence per (brand, segment \| "all") per tick; 10-bin histogram |
| `reference_price_trajectory` | hero product's current price vs mean reference price per tick (promo addiction, F4) |
| `goal_stats` | P(BUY) at page decisions with vs without `active_need`; time to satisfaction |
| `fatigue_split` | 3 channels (asset, brand_msg, concept) per tick: mean level, plus CTR for high (≥ 0.5) vs low decisions |
| `violations{count, bounce_delta}` | within-run pooled bounce(B) − bounce(A) |
| `motif_stats` | per motif type: outcome counts and mean strength |
| `ci` | 95% percentile bootstrap, **2,000 reps, resampling shoppers** (one shopper's exposures and buys are one correlated story). Keys `metric` and `metric:segment` for ctr, browse_rate (BROWSED/CLICKED), cart_rate (CARTED/BROWSED), buy_rate (BOUGHT/CARTED), buy_per_exposure, p_buy_need_on/off (`metrics.py:42-57, 106-160`) |
| `repeat_ltv_by_arm` | buyers, repeat rate, revenue per buyer |
| `social_lift` | P(buy) at decisions carrying social_proof vs not |
| `provenance_coverage` | share of learned versions carrying a cause |

**Money** lives in the UI, not the engine:
- spend = impressions × **$13.88 CPM** / 1000 (`web/lib/economics.ts:19`);
- ROAS = revenue / spend.

**Cross-arm** deltas (vs-control, ladder winner, revenue lift) live in `comparison.json` (`experiments/compare.py`), never in per-run results.

**Estimator choice** (documented in `eval/calibration.md` and `eval/README.md`): at demo scale the *model-implied* mean gate probability over the decisions that happened is the primary estimator. With ~89 page decisions, realised rates carry ±5pp standard errors. The two do **not** agree; see §8.

---

## 6. The "Maya" demo

### The design: ten beats (`PLAN.md:370-382`)

1. Prior eco 0.45, no needs.
2. Ignores the ad (preference_fit only, no goal, no belief).
3. Engagement climbs eco 0.45 → 0.61, every step cause-stamped.
4. "ReplaceRunningShoes" activates (scripted: shopper 1000042, category 5504, strength 0.8, cap $90, ticks 8 → 13; `fixtures/demo-brand/goal_config.json`).
5. The same ad now retrieves goal_fit + preference_fit + reference price + low fatigue, and P jumps.
6. Buys (eco 0.714).
7. A positive experience forms a trust belief (eco 0.761).
8. The next ad lands differently.
9. **Twin control:** same seed, no goal, still ignoring.
10. Paths and receipts behind every beat.

### What actually existed

- **Maya as data.** In `fixtures/scripted-run-1` (ScriptedMind decides, real consolidate learns), offset 42 runs the whole chain: browses, scripted need t8, BUY t10, NEED_SATISFIED with cause, EXPERIENCED t12; eco 0.699 → 0.898; trust 0.70 @ 0.90 "from 2 visits, 2 browses, 1 purchase and 1 delivery". The need_off twin browses and never buys (`fixtures/scripted-run-1/README.md:33-40`). With the formula mind on the demo brand, a decision replay gave P(buy) **0.345 vs 0.152** with the need removed (`PLAN.md:215`).
- **The ten beats were never shipped live.** The Phase 8 checkbox is open (`PLAN.md:388`).
- **What the video shows instead is "Ruth"** in 05 Mind. She is a frozen capture of run `r072` (Nisolo's 5 real image ads, 100 × 28, social on, `w_social` 0.5): offset 76, style_conscious, as of day 27 (`fixtures/shopper-mind/README.md`). For the eco ad (2000101 → page 4000104, the $160 Diego sneaker), her state was:
  - **preference_fit** eco w 0.938 (E 8, recency 0.74). It was learned; her prior segment is style.
  - **goal_fit** casual shoes (5500), strength 0.77, urgency 0.57, cap $175.
  - **brand_semantic_fatigue** 1.0 (saturated, via the sale ad 2000103 sharing eco).
  - **social_proof**: peer 8200078, trust 0.876, bought this product, sat 0.792, valence 0.756.
  - **trust** 0.659 @ E 8 (confidence 0.92).
  - **budget_left $95.94**; reference price $160.

  The funnel reads **45% click → 26% browse → 8% cart → 0% buy**, because $160 > $95.94. The need-removed counterfactual drops relevance from 0.77 to 0.42 and P(click) from 0.454 to 0.369. I recomputed all of these from `fixtures/shopper-mind/mind.json` (the panel multiplies gates into reach, `web/components/MindPanels.tsx:116-133`).

### What made it land

The video script and its rules: one shopper, plain language, vision-first, cut on RUN THE MARKET.

- **One pinned, named shopper who always exists**, frozen so it can't blank or silently swap when the store resets.
- **Every number has a lit path behind it.** The decision's own motifs are drawn as primary (animated, labelled); the wider trace is drawn soft. Lighting the full trace (21 hops) made the head unreadable; lighting only the 9 motifs `appraise()` consumed read instantly.
- **A punchline the audience can check:** "zero buys — it costs $160 and she has $96". A deterministic guard, not a vibe.
- **A counterfactual on the same screen** (need removed), plus the twin idea.
- **Provenance sentences:** "believes X with 81% confidence, from two visits and one purchase".
- **A real ad whose claim was read off the image** ("40% off" was never typed in).
- **Social:** "a friend she trusts bought this exact product".

### Honest caveats for the rebuild

- Ruth's **45% click sits on `stage_bases.CLICK = 2.0`**, which is about **31× the calibrated click gate** (`eval/results/calibration.json` → `demo_profile.click_gate_acceleration`). At the calibrated θ = 6.0 she would click a few percent of the time.
- Her **0% buy depends on bug (a)** (§8). She is blocked on the $160 sneaker only because she had already seen its price. In the same capture, the $178 Chukka page (4000105) she had never priced shows **BUY gate 0.606**, and the $150 sandal (4000102) shows 0.447, with the same $95.94 budget.
- **F9, "the Maya law"** (a goal moves BUY more than CTR, both above floors), is the demo claim written as a test. It is **RED**:
  - cross-arm CTR ×1.032, BUY ×1.095, against floors of 1.05 / 1.5;
  - the ordering holds, and the within-run need-on/off contrast is 1.79×;
  - the diagnosis is the scenario design: the twin branches at tick 4 of 14 (29% shared history, with pre-split needs persisting), and it rests on 21 vs 23 purchases (`eval/INDEX.md:103-133`, `eval/README.md:18`).

### Minimum state to reproduce the moment

Objective world:
- one brand; two creatives of that brand that share a claimed concept (eco); one product + landing page per creative;
- one product priced **above** the shopper's remaining budget and one below;
- `latent_quality` for each product (hidden).

The shopper:
1. a PREFERS edge on the claimed concept (prior 0.45 / E 2 for the Maya arc, or a learned ~0.9 for Ruth);
2. one live NEEDS in the advertised product's category, with deadline 3–5 ticks out (urgency > 0), strength ~0.8, and a cap;
3. a trust belief on the brand with some evidence (or deliberately null, to show abstention);
4. ≥ 1 recent SAW of the *other* same-brand creative (fatigue);
5. a REFERENCE_PRICE on the expensive product (so the budget guard fires);
6. a budget such that `budget_left` sits between the two prices.

Optionally, one TRUSTS_PERSON peer with BOUGHT + EXPERIENCED on the product before this tick. Then add a twin shopper with identical state minus item 2, and the same seed.

Ask the four gate questions for both shoppers, plus the need-removed counterfactual. That covers every Ruth panel and beats 5, 6 and 9.

---

## 7. Frontend

**Stack** (`web/package.json`):
- Next 15, React 19, zustand 5, d3-force / d3-selection / d3-drag 3.
- **No chart library:** every chart is hand-written SVG (`web/components/charts.tsx`: `Spark`, `LineChart`).
- The browser calls `/api/sim/*`, proxied to the engine's FastAPI at `:8000` (`web/next.config.mjs`).

**Live transport: polling only, no SSE.**
- The market store polls every 2 s, and every 1 s while the run is preparing (`web/lib/market.ts:200-240`).
- It tails `GET /runs/{id}/events?after=<byte cursor>` until eof and splits days on `TICK_COMPLETE` markers.
- It fetches `/results-live` when a new tick lands, then `/progress`.
- "LIVE" is a **chase-replay:** a clock plays one sim-day per 1,400 ms and stops at the head tick (`market.ts:20`).

**Worth copying, ranked:**
1. **The market store + `derive()`** (`web/lib/market.ts`, `web/lib/selectors.ts`). This is the byte-cursor event tail, per-tick bucketing and replay clock, with no view logic in the store. Swap the polling for SSE.
2. **AllocationRiver** (`web/components/AllocationRiver.tsx`): a stacked stream of impressions per ad per day. It is the clearest single live picture and needs only `perDay[]` per creative.
3. **FlightKpis + MasterTimeline** (`web/components/market.tsx:33`, `web/components/MasterTimeline.tsx`): play, speed and scrub controls; spend/revenue/ROAS/CTR tiles; a day axis with promo/wave spans and detected-event markers.
4. **Inspector + decision preview** (`web/components/Inspector.tsx`). For one shopper it shows the diary, worldview, preference chain, and the `DecisionPreview` (appraisal dims, gate probabilities, need-off counterfactual). This is the "why".
5. **CtrSmallMultiples / FunnelByCreativePanel**: per-ad comparison on a shared y-scale.

Skip the landing particle field, the static GateFunnel, and the frozen MindGraph and MemoryGraph exhibits. They are beautiful but not live.

**Data shapes** (`web/lib/types.ts`):
- `Progress {run_id, arm, label, status: "preparing"|"running"|"complete", phase?, tick, ticks, phase_s, total_wall_s, updated_at}`
- `EventsPage {records: EventRecord[], next: <byte offset>, eof}`, where `EventRecord` is the JSONL record (≈ `EpisodicEvent` in `contracts.ts`, plus `TICK_COMPLETE{tick, n_events}`)
- `ResultsLive {tick, status, results: C3Results, live_extras: {belief_avg}}`
- `C3Results` ≈ `RunSummary` in `contracts.ts`
- `DecisionPreview {tick, stimulus{id, kind, page_id}, scalars, motifs, appraisal, probabilities, counterfactual_need_off}` (`engine/shopsim/runner/preview.py:73-110`)

The engine endpoints that matter are `/runs`, `/runs/{id}/{progress,manifest,results,results-live,events,config,population,creatives}` and `/runs/{id}/shoppers/{offset}/{worldview,preference-history/{c},belief-history,trace/{s},decision-preview/{s}}` (`engine/shopsim/runner/api.py`).

---

## 8. What I'd change, and known bugs

### Documented, still open

- **F9 (the Maya law) is RED.** F7b (never-drop), F4 and F11 have **never produced a number**. `make eval` exits non-zero on purpose (`eval/README.md:5-9`).
- **Model-implied vs realised rates disagree.** 4 of 5 realised rates are out of band, all high: bounce 0.618, cart|browse 0.294, buy|cart 0.400, visit→purchase 0.045, on 89 page decisions (`eval/README.md:40-48`). Offline replay is first-order: it cannot model "more clicks teach more preferences, which raise relevance".
- **The analytic tier's synthetic population misses `p_buy_given_cart` on every seed** (0.294–0.303 vs the 0.24–0.28 band). Never chased (`eval/results/analytic.json`).
- **CTR "acceleration."** Demo profiles move only θ_CLICK. The UI divides CTR and ROAS by a factor taken from a table mirrored in TypeScript (`web/lib/calibration.ts`, pinned by a Python test). Dividing ROAS by the CTR factor is admitted to be first-order (`web/lib/economics.ts:65`, `ctrAdjust` at `:76`).
- **`/results-live` drops `preference_drift` and `reference_price_trajectory` mid-run.** It rebuilds the accumulator with an empty segment map, no drift concepts and no hero product (`engine/shopsim/runner/api.py:247-249`), so live drift and promo detectors can't fire.
- **Frontend:**
  - a module-level event cursor is shared across `openRun` calls (`web/lib/market.ts:99`);
  - `derive()` recomputes everything on every poll;
  - `/events` reads to end of file before applying `limit`;
  - the timeline regex-parses its own label text.
- **Store-side (HydraDB, irrelevant to Jev):** per-tick cost grows about 6× with store size and within a run, and loaded stores fail resume.

### Found while reading (not run-verified unless noted)

- **(a) First-visit purchases ignore price and budget.**
  - The page decision happens in the same tick as the click. `PRICE_SEEN → REFERENCE_PRICE` is only applied in consolidation, *after* the decision (`runner/loop.py:372-449`).
  - On a first visit, `scalars.reference_price` is therefore empty. `_price()` returns None (`minds/choice.py:65-72`), so **neither BUY guard fires**, and `current_price_gap` is 0, so **the realised-price term is off too**.
  - First-visit buyers react only to the *perceived* claimed discount.
  - **Checked against committed data:** in the Ruth capture, never-priced pages show BUY gates 0.606 ($178) and 0.447 ($150) with $95.94 left.
  - This likely contaminates every pricing-ladder result.
  - *Fix:* put the current price (and a first-sight reference) into state at the page decision.
- **(b) Page engagement is double-counted.**
  - A browse emits both VISITED and BROWSED, and they carry identical evidence rows (0.25 pref, 0.75 trust → 0.6) (`expansion.py:49-63`, `evidence.py:65-66`).
  - One purchase walk therefore adds CLICK 0.10 + 0.25 + 0.25 + 0.50 + 1.00. From an eco prior of 0.45 that runs 0.476 → 0.532 → 0.577 → 0.645 → 0.732 → 0.773 after experience, so **the runner's chain is not the contract's golden chain** (0.714 / 0.761).
  - Trust gains E 3.0 from a single buy walk.
  - *Fix:* give VISITED no evidence, or don't emit it alongside BROWSED.
- **(c) The per-tick cap drops evidence; it doesn't defer it.** Writes truncated by the 6-write cap are lost; the in-memory fold isn't carried to the next tick (`writes.py:453-457`). Busy shoppers silently learn less. It also evicts REFERENCE_PRICE, which caused the documented resumed-cart desync crash. That crash was fixed by deriving the flag from the context (`CONTRACT.md:724-738`), but the evidence loss stays.
- **(d) EXPECTS uses α-smoothing**, `(1−α)·s + α·target` with α = the delta weight (`writes.py:540-542`), not the "one formula everywhere". SAW and CLICK on the same tick apply two α steps.
- **(e) EXPECTS is keyed by (concept, brand), not (creative → its page).** A claim from *any* brand ad is checked against *every* brand page. The 0.5 floor treats the symptom. *Fix:* key the expectation to the creative that promised it and check only that creative's landing page.
- **(f) Awareness lapses after 14 ticks without exposure, even for a past buyer.** `aware_of_brand` reads only the SAW window (`reads.py:203-206`); a shopper with a trust belief can be "unaware".
- **(g) Budget is a run total that never replenishes** (`reads.py:223-225`), so long runs drain shoppers permanently. Because of (a), `budget_left` can also go negative: a first-visit BUY is never checked against it.
- **(h) `novelty_seeking` is a dead trait.** It is drawn but read nowhere at P0.
- **(i) The prose and code disagree on the trust example.** "2 visits + 1 purchase → value 0.70" computes to **0.625** from (0, 0) (E 3.0 and confidence 0.81 match) (`PLAN.md:130, 622`, `CONTRACT.md:64`).
- **(j) `social_lift.causal` only means `w_social > 0`.** It is observational: shoppers next to buyers are also next to the schedule's reach (`analytics/metrics.py:285-296`). The headline "1.26–1.32×" is a correlation with the channel switched on. A proper test is a paired social-off arm.
- **(k) F9's design** (documented diagnosis, my emphasis): a twin that branches at tick 4 inherits live needs. Run two independent seeded arms, or expire pre-split needs, and size for more purchases.

### What I'd change in the rebuild

1. **Price in state from the first exposure:** fixes (a).
2. **One evidence row per real engagement step:** fixes (b). Then re-derive the golden chain *from the runner*, not from isolated events.
3. **Defer, don't drop, capped evidence;** or raise the cap and keep ε.
4. **Expectations keyed to the promising creative:** fixes (e) and removes the need for the 0.5 floor.
5. **Keep the deterministic spine** (retrieval, guards, cart/need lifecycle, learning, seeded draws) **in code. Jev answers only the gate questions** (and optional Score dims). Cache answers by state hash so replays stay exact.
6. **Calibrate Jev against `FUNNEL_BANDS` with a per-gate logit offset fitted on a decision trace.** Never ship an accelerated profile; size runs (or report model-implied rates with SEs) instead.
7. **Decision record = inputs + P + draw + action** (`DecisionRecord` in `contracts.ts`). It is both the eval set and the explanation surface.
8. **Fix F9 before demoing it:** independent twins, enough purchases, and a pre-registered threshold.
9. **Make the evidence table and all retrieval constants one hashed config.** That keeps ShopSim's discipline that evidence constants are frozen and only calibration moves.
