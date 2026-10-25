# Sim decisions log (Person B)

Every place where B's code had to choose because docs/PLAN.md is silent, ambiguous, or couldn't
be followed as written. Each entry gives the decision, why, where it lives, and who must agree.
When a decision changes, edit its entry and status here in the same commit as the code.

**Status:** `OPEN` needs an answer · `NEEDS A` needs Person A's agreement because it touches the
contract or A's data · `DECIDED` taken by B and reversible · `FORCED` the plan couldn't be followed.

Last updated: 2026-10-24, B4 (SpacetimeDB, task board, worker). B0 entries: commits `c82e80e`, `2a4f72a`; B1: `2dd85d2`; B2: `e7ca652`, `d5da10d`; B3: `9cf9666`, `241045b`.

---

## Open questions

### D1. The `believes` question wording — `DECIDED` (resolved by B1, D29)
- **Was:** the plan's sentence followed by ` The full post: …`, because the ads lived only in the
  tap Choice's options, which other questions can't see.
- **Now:** the plan's wording exactly. Since B1 the posts are listed in the state, so
  `Does this shopper believe the main promise of the {brand} post that says "{headline}"?` points
  at text Jev can read. Outer quotes on testimonial headlines are still stripped.
- **Where:** `src/feed.ts` `feedQuestions`, `postRef`.

### D2. Magic Spoon's live ads sit in the control arm — `NEEDS A`
- **Code:** `brand_live` creatives carry `arm_id: "arm_control"`. `fixtures:check` errors otherwise.
- **Why:** the contract says "Exactly one control arm: Magic Spoon's own live ads", and the bandit
  picks a creative *within* an arm, so the live ads must belong to it.
- **Conflict:** A4's "Live ads to creative rows" mapping never sets `arm_id` for live ads, so A may
  leave it empty.
- **Where:** `src/fixtures.ts` `checkWorld` (`brand_live` case), `fixtures/magicspoon/creatives.json`.
- **To agree with A:** A4 writes `arm_id = <control arm id>` on brand_live rows. Otherwise B infers
  the arm from origin, which is a small code change.

### D3. Both competitor neighbours may come from the same brand — `OPEN`
- **Plan:** "2 competitor ads, sampled with weight proportional to days_running". It doesn't say
  whether they must be different brands.
- **Code:** 2 distinct ads, without replacement, from any brands. Measured: same-brand pairs in
  about 18% of feeds with the fixtures.
- **Where:** `src/feed.ts` `assembleFeed`.
- **Alternative:** pick 2 different brands first, then one ad each. This changes neighbour
  frequencies and the realism of the "lost to a competitor" share.

### D4. Memory lines the template doesn't have — `OPEN`
- The template covers "never seen" and "seen N times this week". The code adds:
  - `Hasn't seen a Magic Spoon ad this week.` — seen before, but not in the last 7 ticks.
  - `Tapped a Magic Spoon ad … , left the page right away.` — a tap with no stay ("Left the page
    within seconds" in the evidence table).
  - `… , looked at the page and bought.` — tap, stay and buy.
  - `earlier today` / `yesterday` / `N days ago` for the engagement age.
- **Why:** abstention lines must be literal (rule 5), so each case needs its own sentence rather
  than a blank.
- **Where:** `src/render.ts` `memoryLines`, `lastEngagementLine`.
- **To decide:** accept the wording, or supply your own. B1 is the place to test that Jev reacts
  sensibly to each line.

### D5. Placeholders that must be replaced before B1 results mean anything — `OPEN`
- **Product prices, ratings, review counts, highlights, shipping notes:** filled from the brand
  sites in B2 for Magic Spoon, Catalina Crunch and Three Wishes (D44). Wonderworks is still 0.
  Only Magic Spoon's page is ever shown (the page call is for our ad), so this no longer blocks.
- **The 9 live ads** (`cr_ms_live_1-3`, `cr_cc/tw/ww_live_1-2`): invented stand-ins, and their
  `days_running` drive the neighbour weighting. B1's Sensitivity and Order tests compare ads, so
  their results only mean something with the real Meta Ad Library ads.
- **Segment quotes:** invented, 3–4 per segment. Real ones (8–20) come from A in A4.
- **`cr_gen_03` "13g protein":** unverified; real numbers come from A's brand facts.
- **Owner:** you, for prices and ads (paste them in); A, for quotes.

---

## Deviations from the plan

### D6. Node 22, not Node 20 — `FORCED`
- `better-sqlite3@13.0.3` (the cache) needs Node ≥ 22, and so does `@typesafe-ai/sdk@0.7.0`.
  This machine runs Node 22.23.1.
- **Where:** `package.json` `engines`.
- **If Node 20 is required:** pin `better-sqlite3@12`. Nothing else depends on Node 22.

### D7. `sim/`, not `packages/sim` — `DECIDED`
- B0's checklist says `packages/sim`, but the plan's repo layout and Person B's layout paragraph
  both say `sim/`, and so did your B0 prompt.
- `sim/` has its own `package.json`, so commands run as `cd sim && npm run …`. When A creates the
  root app, a root script can forward: `"sim:smoke": "npm --prefix sim run sim:smoke"`.

### D8. Direct HTTP calls, not the TypeSafe JS SDK — `DECIDED`
- **Why:** zod validates the raw response (B0 asks for zod on every Jev response), the cache key is
  the exact request body, and no dependency is added beyond the plan's list.
- **Cost:** retries with backoff are ours (429/529/5xx, `retry-after` capped at 30 s, 5 attempts).
- **Where:** `src/jev.ts`. Field names: `JEV_API.md`.

### D9. Stay on `jev-1.13.0` although `jev-1.14.0` exists — `DECIDED`
- 1.14.0 shipped 2026-10-14 and `jev-latest` now points to it. The plan pins 1.13.0, and changing
  the model means re-running calibration.
- The wrapper rejects any answer, fresh or cached, from a model other than the pinned version.
- **Where:** `src/config.ts` `jev.model`, `src/jev.ts` `validate`.

### D10. TypeScript 5.9.3, not 7.x — `DECIDED`
- `typescript@latest` is 7.0.2, the new Go-based compiler. 5.9.3 is the safer pick for a
  hackathon. Align with A's `deps.json` once it exists.

---

## Contract interpretations (shapes A must match)

### D11. Id prefixes beyond the plan's four — `NEEDS A`
- The plan defines `seg_`, `arm_`, `cr_`, `shp_`. The code also uses `br_` (brand), `cpt_`
  (concept) and `prd_` (product), and the schemas enforce all seven.
- **Where:** `src/contract.ts` `prefixedId`.

### D12. "Empty" means `""` or `null` — `DECIDED`
- The contract says "arm_id (empty for competitors)" and "segment_id (empty for live ads)". The
  schemas accept either and normalise to `null`, so A can write whichever SpacetimeDB makes easy.
- **Where:** `src/contract.ts` `empty`.

### D13. json columns load as strings or parsed values — `DECIDED`
- `prior_weights`, `quotes`, `evidence`, `learning_ids` and `page_highlights` are JSON strings
  from SpacetimeDB and parsed objects in the fixtures. Both load.
- `evidence` isn't marked json in the contract, but it is a list of ids, so it is treated the
  same way. **Confirm with A** (`NEEDS A`).
- **Where:** `src/contract.ts` `json`.

### D14. The control arm's `angle` and `hook` are null — `NEEDS A`
- The control is "Magic Spoon's own live ads", not a recipe, so it has no single angle × hook.
  Every recipe must have both. The schema rejects anything else.
- **Where:** `src/contract.ts` `armSchema` refine.

### D15. `subscription_price_usd` may be null — `DECIDED`
- Null = the brand has no subscription; 0 would mean a free subscription. The page call (B2) must
  handle null.

### D16. A missing prior weight means an unheld concept — `DECIDED`
- The contract doesn't require every concept key in `prior_weights`. A missing key loads with a
  warning, and that concept starts at w 0.5, E 1.0 (the plan's "unheld concept" rule) with no noise.
- **Where:** `src/population.ts` `makeShopper`, `src/fixtures.ts` `checkWorld`.

### D17. Segments need at least 2 quotes — `NEEDS A`
- Each shopper draws 2 quotes from the segment's pool, so the schema requires ≥ 2. A's real rows
  have 8–20, so this only bites on bad data.

---

## Simulation semantics

### D18. A tick is a run-wide sim day — `DECIDED`
- Round 0 = ticks 0–2, round 1 = ticks 3–5, and so on. A tick never repeats in a run.
- **Why:** draw keys are `hash(seed, stream, shopper, tick, …)`. If tick restarted each round,
  every shopper would see the same neighbours in the same order every round. The `decision`
  table still stores `round` and `tick` separately.
- **Where:** `src/config.ts` `run`, `src/rng.ts` header. **B2 must follow this.**

### D19. The starting shopping flag has its own draw key — `DECIDED`
- Key: `("population", shopper, "in_market")`. The `need` stream is reserved for per-tick
  arrivals (sim-day step 1), so the tick-0 arrival is independent of the starting flag.
- **Where:** `src/population.ts`.

### D20. The preference line reserves 3 slots for the strongest concepts — `DECIDED`
- **Plan:** "Show at most 6 concepts: the strongest ones, plus any concept today's ads claim."
- **Code:** the top 3 by weight first, then claimed concepts in the order given, then more of the
  strongest, up to 6 in total. `other` is never shown.
- **Why:** without a reservation, ads claiming many concepts erased who the shopper is (found in
  the audit).
- **Where:** `src/render.ts` `preferenceLine`, constant `STRONGEST_RESERVED`.

### D21. Opinions record page-visit and purchase counts — `DECIDED`
- `Opinion = { value, E, page_visits, purchases }`, rendered as "from one page visit", "from two
  page visits", "from a purchase". A purchase outranks visits as the stated source.
- **Where:** `src/population.ts` `Opinion`, `src/render.ts` `memoryLines`. B2's memory updates
  must increment the counts.

### D22. Neighbour weight is `max(1, days_running)` — `DECIDED`
- The floor keeps an ad that launched today (0 days) eligible. With real ads it rarely matters.
- **Where:** `src/feed.ts`.

### D23. The expected-price line uses the product's full name — `DECIDED`
- Rendered as "Thinks the Magic Spoon Variety 4-Pack costs about $40.", rounded to whole dollars.
  The template's "a Magic Spoon 4-pack" would need a short name the contract doesn't have.
- **Where:** `src/render.ts` `memoryLines`.

### D24. The 450-word limit is enforced in the renderer — `DECIDED`
- `renderFeedState` and `renderPageState` throw at 450 words or more (rule 1 says *under* 450),
  so no caller can send an oversized state.
- Since B1 put the three posts in the feed state, real states run 158–297 words (all 1,456 states
  of round 0, measured in the B2 review).

---

## Fixture choices

### D25. Concept labels are short, plain phrases — `NEEDS A`
- Labels are what Jev reads in "Cares a lot about: …". They avoid "and" and commas so joined lists
  stay unambiguous ("crunch", not "crunch and texture"). They avoid assuming life facts
  ("kid-friendly", not "food their kids will eat").
- **Where:** `fixtures/magicspoon/concepts.json`. A's analysts map brand facts onto these keys, so
  the 15-minute vocabulary sync should confirm keys *and* labels.

### D26. Segment descriptions never restate a prior — `NEEDS A`
- Descriptions are life context only. No gym routine (it would double-count fitness) and no
  childhood cartoons (it would double-count nostalgia). Rendering rule 2 and the contract both
  require this.
- **For A4:** the segment builder's "life context only" rewrite should strip these too, not just
  explicit preferences.

### D27. Fixture arm evidence cites fixture ad ids — `DECIDED`
- Steal recipes cite competitor stand-in ads, double_down cites Magic Spoon live ads, and control
  cites all three. Gap recipes cite nothing until A's voc facts exist. `fixtures:check` errors if
  an evidence id that starts with `cr_` doesn't exist.

### D28. Generated fixture ads have no image or pack — `DECIDED`
- `days_running: 0`, `image_url: null`, `pack_fingerprint: null`, `round_created: 0`. Each
  generated ad is written for one segment chosen to fit its recipe.

---

## B1: Jev spike (details and every number in `SPIKE.md`)

### D29. The feed call is one Noul per ad, with the posts listed in the state — `DECIDED`
- **Plan:** one Choice `tap` over A, B, C (each described by its full ad text) and `none`. Its
  decision rule: "if test 2 fails, switch the feed call to one Noul per ad … with the other two
  ads described in the state."
- **Result:** the Choice shape failed test 2 (9 of 21 judged ads over 20%), so the rule fired. The
  Noul shape also has no saturation (P(tap ours) max 0.74 against 1.0), no exact 0s or 1s (0 of
  10,680 values against 15%), 2–4× lower repeat-call noise, and 8% fewer tokens.
- **Cost:** weaker sensitivity (1.43× in one of four states, against ≥ 1.5×) and order effects up
  to 37% on competitor ads, which don't enter the reward. Re-check sensitivity at the 2:30 PM
  integration with A's real personas and ads.
- **Where:** `src/feed.ts` (`feedQuestions`, `tapProbabilities`, `postRef`), `src/render.ts`
  (`renderFeedState` now takes the ads), `src/smoke.ts`.

### D30. Jev concurrency is 32 — `DECIDED`
- Latency is flat up to 32 in flight (p50 78 ms, p95 150 ms, 311 req/s). No 429s at any level up to
  256; over 256 the server queues. 32 leaves wide headroom and runs a round of about 1,440 calls
  in about 5 s.
- **Where:** `src/config.ts` `jev.concurrency` (the plan assumed 24).

### D31. How the order test was judged — `DECIDED`
- All 6 orders of the 3 ads were tested, not 10 random shuffles; repeats would come back identical
  from the cache.
- Metric: max |p − mean| ÷ mean. Ads with mean P(tap) < 0.02 weren't judged, because Jev's 0.01
  resolution makes one step there 50% or more. Both shapes still failed the plan's rule as
  written; SPIKE.md separates the failures that are resolution artifacts from real ones.

### D32. The cache is the only source of identical replays — `DECIDED` (for B6)
- Jev is not deterministic. Identical requests vary by sd 0.011–0.018 on a Noul and 0.008–0.035 on
  a Choice, and the variation is the same whether requests are sent one after another or together.
  A re-run with the same seed only reproduces numbers when the cache is warm. The demo must replay
  from `.cache/jev-cache.sqlite`; never clear it before the demo.

### D33. Guidance for B2 and B3 from the spike — `DECIDED` (B2: D39; B3: D49)
- **B2 dice (done, D39):** tap Nouls are independent and don't sum to 1. Draw our tap from
  P_cal(tap ours) alone; a competitor tap only counts as "lost to a competitor".
- **B3 calibration:** fit one log-odds offset on P(tap ours) to a 1% mean. This replaces the plan's
  "P(tap any) = 1 − P(none), then split". Clamp probabilities to [0.005, 0.995] before logit,
  because Choice answers (the page `objection`) hit exact 0 and 1.
- **B3 memory:** Jev's wear-out response is weak (−2% to −4% for protein athletes after 4 protein
  ads), so the wear_out learning, already cut line 1, may never fire.

### D34. Spike-only page values — `DECIDED` (spike only)
- Test 4 needed a page but products.json has no prices yet. `spike/states.ts` `SPIKE_PAGE` uses
  $47 one-time, $40 with subscription, rated 4.5 from 5,000 reviews. These values were invented for
  a directional test and must never be used outside the spike.

---

## B2: engine core

### D35. Perception is pluggable; a keyword reader stands in — `OPEN` (yours to settle)
- **Plan:** each creative's claims are extracted once by Claude (image-capable for live ads) and
  frozen.
- **Code:** a `Perceiver` interface (`id` + `perceive(creative)` → claims and offer_pct). The
  default, `keyword-v1`, reads concept keywords from the headline (strength 0.9), primary text
  (0.7) and visual description (0.5), after removing brand names, so "Catalina Crunch" never
  claims crunch. `offer_pct` comes only from an explicit "N% off".
- **Frozen:** results go to a `creative_perception` table in `.cache/jev-cache.sqlite`, keyed by
  sha256(provider id + ad text + concept vocabulary). Switching providers re-perceives every
  creative instead of mixing answers. Unknown concepts map to `other`; strengths clamp to 0–1,
  offers to 0–0.95 (ShopSim's rules).
- **Claimed:** a concept counts as claimed at strength ≥ 0.5 (`CLAIM_MIN`). Claimed concepts drive
  the exposure memory ("mostly about …"), the preference line and the evidence updates.
- **To decide:** which provider replaces `keyword-v1` (Claude or another model) once real ads with
  images arrive. Bump the id when it lands; the cache then refills on its own.
- **Known keyword limits:** "variety pack" counts as a flavor-variety claim (`cr_gen_09`,
  `cr_ms_live_1`). Keyword matching can't tell a claim from a mention. That is acceptable for a
  stand-in, and it is one more reason to settle the provider.
- **Where:** `src/perceive.ts`.

### D36. `--rounds N` runs the warm-up plus N bandit rounds — `DECIDED` (in B3)
- The plan's run is "a warm-up round plus 5 rounds", `rounds_planned` counts rounds after the
  warm-up (A's worker queues `run_round` "until rounds_planned"), and B3's done-when is "a
  5-round fixture run". So `--rounds 5` runs round 0 (warm-up) and rounds 1–5. In B2 the flag
  meant rounds 0..N−1; `--rounds 1` now also runs round 1 (still well under 60 s).
- **Where:** `src/cli.ts`.

### D37. Page call details — `DECIDED`
- Both calls are rendered from the shopper's state before today's events, in parallel.
- The page is our ad's `landing_product_id`. The template's line becomes "{product} — $39
  one-time, $31.20 with subscription." The subscription half is dropped when the price is null,
  and "No reviews shown." replaces the rating line when the review count is 0.
- **The guard uses the one-time price.** It is the conservative choice; a first-time buyer may
  not subscribe. `purchase` subtracts the same price.
- Objection: the summary uses the Choice's most likely option (ties go to the earlier option).
- **The page keeps the feed's SHOPPER and MEMORY blocks exactly** ("The page call keeps SHOPPER
  and MEMORY"). That includes the preference line, which shows concepts claimed by any of today's
  three ads, not just ours. Fixed in the B2 review; a test checks the blocks are identical.
- **Where:** `src/render.ts` `renderPageState`, `src/feed.ts` `PAGE_QUESTIONS`, `src/engine.ts`.

### D38. Evidence is cumulative, and a price is "seen" only on STAY — `DECIDED`
- **Plan:** the evidence table has rows for TAP (0.10), STAY (0.25; opinion 0.75 → 0.6), BUY
  (1.00; opinion 1.5 → 0.65) and "left the page within seconds" (0 / 0). It doesn't say whether one
  impression applies every row it reaches or only the highest one.
- **Code:** cumulative, as in ShopSim (its golden chain runs CLICK → BROWSE → … one row per step):
  - a tap that bounces applies TAP only (+0.10); the bounce itself adds nothing;
  - a stay applies TAP then STAY;
  - a purchase applies TAP, STAY and BUY.
  "One STAY event, one evidence row" (ShopSim bug (b)) still holds: a page visit is one STAY row,
  not VISITED plus BROWSED.
- **Why not the highest event only:** every tap ends in a stay or a bounce, so the TAP row would
  never apply.
- **Price:** the expected price (first sighting sets it, then 0.7 old + 0.3 seen) updates only
  when the shopper looks through the page. A bounce sees no price.
- B2 tests pin all three paths with hand-computed values: tap+bounce 0.4762, tap+stay 0.5319,
  tap+stay+buy 0.6716, from a 0.45 prior with E 2.
- **Where:** `src/engine.ts` `remember`, `src/memory.ts` `applyEvidence`, `seePrice`.

### D39. Dice — `DECIDED`
- Our tap: `uniform(seed, "tap", shopper, tick, creative) < P_cal(tap ours)`. If tapped, stay
  `(seed, "stay", shopper, tick)`, then buy `(seed, "buy", shopper, tick)`.
- If ours isn't tapped, each competitor gets its own tap draw keyed by its creative id; any hit is
  "lost to a competitor" and nothing else happens.

### D40. Decision rows carry the state hash in `options` — `DECIDED`
- The plan says every decision stores "the raw probabilities and the state hash", but the
  contract's `decision` row has no hash column. Rather than change the contract, `options` is
  `{ state_hash, order }` (feed) or `{ state_hash, objections }` (page). `state_hash` is the Jev
  cache key, so it also locates the exact answer.
- `draw` holds every uniform the call's dice used: `{ tap }` or `{ stay, buy }` (null if not
  reached). Actions: feed `tap` / `lost_to_competitor` / `scroll`; page `not_tapped` / `bounce` /
  `stay` / `buy`. `p_cal.guard` records the budget guard.
- Only B writes or reads `decision`, so A is unaffected. B4 stringifies the json columns.
- **Where:** `src/engine.ts` `DecisionRow`.

### D41. Price gap in words — `DECIDED`
- Within ±10% of the expected price: "about what they expected". At least 10% above: "about N%
  more than expected", rounded to the nearest 10%. At least 10% below: "cheaper than expected".
- **Where:** `src/render.ts` `priceComparison`.

### D42. Calibration offsets were 0 in B2 — `DECIDED` (superseded by D49 in B3)
- `src/calibrate.ts` applies σ(logit(p) + b) after clamping to [0.005, 0.995]. With b = 0 it
  returns the clamped value exactly. Raw and calibrated values are both stored.
- The guard is applied after calibration (P_cal(buy) = 0), so the clamp can never lift a guarded
  0 to 0.005.
- Until B3, B2's taps run at raw rates (mean P(tap ours) 0.28), far above the 1% target. Only the
  dice and memory are affected, not the probabilities.

### D43. Arm picks: an even deal in the warm-up, the bandit after — `DECIDED` (revised in the B3 review)
- **Warm-up (round 0, probe and real pass):** `balancedPolicy` deals arms round-robin. Per segment,
  each day's scrolling shoppers (the engine's own keyed reach draw) are put in a keyed order, and
  the deal continues across the round's days from a keyed starting arm. Within a segment, arm
  counts for the round differ by at most one ("every arm gets equal impressions").
  - B2 had used a uniform random pick, which gave 51–74 impressions per arm. `uniformPolicy` is
    still the engine's default, for runs without a bandit.
- **Rounds 1+:** the bandit (D51). An arm is live when it has a ranked Magic Spoon creative.
  Within an arm, the creative is drawn from those written for the shopper's segment, else from
  all of the arm's (the control's live ads have no segment). A test covers both cases.
- **Where:** `src/engine.ts` `balancedPolicy`, `pickCreative`; `src/run.ts`.

### D44. Product fixtures from the brand sites — `DECIDED` (check before the demo)
- Fetched 2026-10-24 from each brand's own product page and Shopify product JSON, never from
  memory or retailers:
  - **Magic Spoon:** "Variety 4" (4 boxes), $39 one-time, $31.20 with subscription (subscribe and
    save 20%), rated 4.6 from 25,926 reviews. Highlights: "4-5g net carbs", "0g total sugars",
    "12-14g complete protein". Source: magicspoon.com/products/variety-pack-cereal-case.
    - The review count is grouped across products on the site.
    - No shipping note: the threshold only appears in the cart drawer.
    - The product name stays "Magic Spoon Variety 4-Pack".
  - **Catalina Crunch:** "Cereal Best Seller Bundle" (4 × 8 oz pouches), $31, no subscription on
    the bundle. No rating is shown without scripts. "Free shipping on orders over $45."
  - **Three Wishes:** no variety pack exists; every flavor is a $39.99 6-pack. The fixture uses
    "Cocoa Cereal 6-Pack", with no subscription and no rating shown.
  - **Wonderworks:** no direct store found (a General Mills line, possibly discontinued). Still 0.
- The product ids keep their B0 names (`prd_*_variety`), though two products aren't variety packs.
  Only Magic Spoon's page is shown today; competitor products matter only if a later phase
  models competitor pages.
- **Where:** `fixtures/magicspoon/products.json`, `FIXTURES.md`.

### D45. Output: summary on stdout, stats on stderr — `DECIDED`
- **Since B3:** stdout is a readable report (calibration, leaderboard, learnings, generation,
  final arm stats); `--json` prints the per-round JSON instead. Both are deterministic.
- In B2, `sim:run` printed one JSON summary per round on stdout, built only from Jev's answers and the
  seeded dice (calls and input tokens count the same cached or fresh). Cache hits, latency and
  wall time go to stderr. A cold run and a warm run therefore print identical stdout.
- The plan's round summary also lists the cache hit rate; since B4 the worker adds
  `jev.cache_hit_rate` to the summary it writes to the round row (the CLI still keeps it off stdout).
- **Where:** `src/cli.ts`, `src/summary.ts`.

### D46. "Changes smaller than 0.01 are ignored" also freezes E — `DECIDED`
- When an update would move w by less than 0.01, nothing is written: neither w nor E (ShopSim's
  applier: "a change smaller than that writes nothing").
- **Effect:** a tap (wt 0.10) no longer registers once w is above about 0.79 at E 2. STAY and BUY
  still do.
- **The same rule applies to brand opinions.** The first event always sets the opinion, and page
  visits and purchases are counted either way.
- **Where:** `src/memory.ts` `updatePreference`, `updateOpinion`.

### D47. Questions keep the plan's wording even after a "?" headline — `DECIDED`
- `…the Magic Spoon post that says "Gave up cereal for keto?"?` doubles the punctuation (185
  questions in round 0). This is the plan's template filled in literally.
- Changing it would change every feed question's cache key and break comparison with the B1
  spike, for a cosmetic gain.
- **Where:** `src/feed.ts` `postRef`.

### D48. Two state texts per shopper-day; the shopper row has one `state_text` — `DECIDED` (B4: the page state, D65)
- The engine keeps `{ feed, page }` per shopper (`Engine.lastState`). The contract's `shopper` row
  has a single `state_text`, "the exact text Jev last read".
- **Since D37, both states share their SHOPPER and MEMORY blocks.** B4 can store the page state
  (the last one Jev reads) or the feed state, or add a column with A's agreement.
- **Where:** `src/engine.ts`.

---

## B3: calibration, reward, bandit and learnings

### D49. Each gate is fitted as a conditional rate, with the guard counted — `DECIDED`
- **Plan:** "bisection finds each offset b so the average calibrated probability hits its target":
  tap 1% per ad, stay 50%, buy given stay 4% ("about 2% from visit to purchase").
- **Code** fits in funnel order on the warm-up's impressions:
  - **tap:** the plain mean of P_cal(tap ours) = 1%;
  - **stay:** the mean weighted by P_cal(tap) = 50%, which makes it the rate among visitors;
  - **buy:** the mean weighted by P_cal(tap) × P_cal(stay), with guarded impressions counted as 0
    = 4%, which makes it the realised rate among shoppers who stayed.
- **Why the guard counts:** the bands are what happens to real visitors, including those who can't
  afford it. Without it, visit→purchase would come out near 1.1% (43% of impressions are
  guarded), at the bottom of its band.
- **Competitor taps** use the same tap offset ("1% per ad"). The plan's "1 − P(none), then split"
  died with the Choice shape (D29).
- **Fitted on the fixtures (728 warm-up impressions):** tap −3.965, stay −0.328, buy −1.852.
  That gives P(tap) 1.00%, bounce 50.0%, P(buy | stay) 4.00% and visit→purchase 2.00%, all inside
  FUNNEL_BANDS.
- **An unreachable target throws**, rather than returning a bisection bound (B3 review). Example:
  every impression guarded, so no buy offset can reach 4%.
- **Stored:** offsets are kept at full precision and frozen (`Object.freeze`). The report's
  `calibration.offsets` is unrounded, so p_cal replays exactly from the stored values.
- **Where:** `src/calibrate.ts` `fitOffsets`, `FUNNEL_BANDS`, `TARGETS`.

### D50. The warm-up is asked twice: a probe, then the real round 0 — `DECIDED`
- The offsets need the whole warm-up round's raw answers, but day 1's state depends on day 0's dice.
  Rolling those dice at raw rates (taps about 28%) would fill memory and drain budgets with taps
  that calibration then says shouldn't happen.
- **So `SimRun.calibrate`:**
  1. runs round 0 with zero offsets on throwaway shoppers;
  2. fits the offsets;
  3. builds the real engine with fresh shoppers and the frozen offsets;
  4. runs round 0 again, rolling the dice with calibrated values.
- **Cost:** day 0 of the real pass reads exactly the probe's states, so it comes from the cache.
  Days 1–2 are mostly fresh: about 1,000 extra calls, $0.03.
- **Counted:** no round's `jev` block includes the probe's 1,456 calls. Every report carries them
  as `calibration.probe_jev` (calls, input tokens, cost).
- **Where:** `src/run.ts`.

### D51. Floors are a mixture, so they hold exactly — `DECIDED` (revised in the B3 review)
- **Plan:** "the control arm gets at least 10% of impressions and every other live arm at least 3%".
- **Code:**
  - With probability F = Σ floors (0.40 for 10 recipes plus the control), an impression goes to an
    arm drawn in proportion to its floor.
  - Otherwise every arm draws θ ~ N(μ, σ²) with its own key, and the highest θ wins.
  - So P(arm a) = floor_a + (1 − F) · P(Thompson picks a) ≥ floor_a, whatever the posterior says.
  - Expected shares (`sharesFor`) use p_best as P(Thompson picks a).
- **Why it changed:** B3 first used water-filling, then a keep/redirect step driven by the
  2,000-draw p_best. The review showed Monte Carlo error leaking into the shares, with some arms
  getting 2.1% against a 3% floor. The mixture doesn't depend on p_best at all.
- **Cap:** a recipe that always wins Thompson gets 3% + 60% = 63%; the control can reach 70%.
- **Realised per-round shares still scatter around the expected shares** (sampling).
- **Tests:** 60,000 picks land within 4 sd of every expected share, including arms Thompson never
  picks. A spy shows every pick in a day sees the same bandit state: no same-day leakage.
- **Where:** `src/bandit.ts` `policy`, `sharesFor`.

### D52. arm_stat covers the run so far; the leaderboard range is μ ± 2σ — `DECIDED`
- `impressions` and `mean_reward` count the whole run so far, like the posterior they sit next to.
  Per-round counts are in the round summary.
- **A full set of rows is produced at the end of every sim day** (`RoundReport.dailyArmStats`); the
  last day's is the round's. B4 writes each day's set. Fixed in the B3 review: rows used to be
  produced once per round.
- `est_cost_per_order_usd` = $13.88 CPM ÷ 1000 ÷ μ (null when μ ≤ 0). The leaderboard's range is
  the cost per order at μ + 2σ and μ − 2σ ("n/a" when μ − 2σ ≤ 0).
- **p_best** comes from 2,000 joint draws per segment at the end of each day. It drives the
  floored shares for the next day, the winner learning and the generation pick.
- **Where:** `src/run.ts` `armStats`, `report`.

### D53. p_best's Monte Carlo uses one keyed stream per (segment, day) — `DECIDED`
- **Plan:** "every draw uses its own key". 2,000 draws × 12 arms × 6 segments per day as separate
  sha256 keys would take seconds per day.
- **Code:** one sfc32 stream seeded from the key `(seed, "arm", "p_best", segment, tick)`. It is
  just as reproducible and independent of every other key. The per-impression θ draws still use
  one key each: `(seed, "arm", shopper, tick, arm)`, plus `"floor"` and `"floor_arm"` for the floor mixture (D51).
- **Where:** `src/rng.ts` `keyedStream`, `src/bandit.ts`.

### D54. Learning details the templates leave open — `DECIDED`, one `OPEN` point
- **winner:** p_best ≥ 0.8 and n ≥ 100 in that segment. The control never "wins" (it has no angle
  or hook to keep), but it is the "vs" in every winner statement.
- **objection:** fires at ≥ 50 page calls. It names the most common hesitation other than
  "nothing", as a share of all the segment's page calls. Page calls are asked on every
  impression, so this is hypothetical visits, not only realised ones.
- **claim_doubt:** fires when mean `believes` is under 0.40 over ≥ 50 feed calls, grouped by the
  concept of each ad's strongest claimed concept (its "main promise").
- **Wording:** segments read "{name} shoppers"; numbers are rounded to whole dollars and
  percents; directives go through `numberFree`, which strips digits (so a segment named with digits
  loses them in its directive, by design).
- **Edges (fixed in the B3 review):**
  - the winner's chance is shown as at most 99%, since 2,000 draws can't support "100%";
  - claim_doubt's percent is rounded down, so a mean of 0.398 reads "only 39% do", never 40%.
- **"mostly hesitate"** is the template's wording for the *most common* hesitation, even when it is
  under half of page calls.
- **Main promise:** an ad's strongest claimed concept. Ties break alphabetically, so with the
  keyword stand-in, `cr_ms_live_1`'s main promise is flavor variety, not protein. This goes away
  with a real perceiver (D35).
- **learning_id** includes the run (`lrn_{run}_{segment}_{kind}_{subject}_v{n}`), so two runs can
  share the learning table.
- **Versioning:** a key is (run, segment, kind, arm or concept). A new version opens whenever the
  statement text changes, so a statement whose numbers move opens a new version each round;
  valid_from_round is the round whose data produced it. A key that stops firing is closed at that
  round. Nothing is deleted.
- **wear_out is not built** (cut line 1; SPIKE.md test 3 found Jev's wear-out response weak).
- **`DECIDED` (your call before B4: keep it as is):** with the stand-in ads, "not needing cereal yet" is every segment's top
  hesitation (53–64%), so every objection directive reads "Address not needing cereal yet early
  for …". Either keep it (urgency is copy's job too) or skip `not_now` like `nothing`.
  - claim_doubt also fires widely, because Jev's mean `believes` is about 0.32 across the board.
- **Where:** `src/learnings.ts`.

### D55. Generation request — `DECIDED`
- After every round except the last, the top recipe per segment by p_best (never the control) is
  taken. Recipes are deduped and keep their segments, at most 3 are kept by their best p_best,
  `n_per_arm` is 1, and `learning_ids` are the live learnings for those segments. B4 queues it as a
  `generate_creatives` task.
- **Where:** `src/run.ts` `generation`.

### D56. The planted winner replaces arm_11 — `DECIDED` (fixtures only)
- **Change:** `arm_11` (gap) was convenience × question for deal seekers. It is now taste_indulgence
  × testimonial, still a gap recipe ("answers the taste-doubt objection"), so the strategy counts
  stay inside the arm builder's limits. Adding a 12th recipe would have lowered the cap.
- **The creative:** `cr_gen_11` is written for the taste skeptic segment: their own "gravel" quote,
  their roommates, taste, crunch, and "Rated 4.6 stars across over 25,000 reviews", which is the
  product page's rating and review count (D44).
  - The testimonial itself is invented, like every fixture ad.
  - `fixtures/magicspoon/planted.json` names it, and the CLI reports its share each round.
- **Real Jev (after the B3 review fixes):** share in its segment 8.8% (warm-up, an even 1/12), 47%,
  59%, then **57.3% in round 3** (> 50%), then 69% and 64%; p_best 99.0% at round 3.
- **Stub Jev:** `test/b3.test.ts` checks the same rule with a stub that only likes the planted ad
  for that segment. That proves the mechanism; the real run proves the result.
- **Where:** `fixtures/magicspoon/arms.json`, `creatives.json`, `planted.json`.

### D57. Calibrated rates leave their bands once the bandit picks — `DECIDED`
- The offsets are fitted on the warm-up, where every arm is shown equally, and then frozen. Once
  the bandit shows better ads, the calibrated funnel rises. Fixture run, rounds 1–5:
  - P(tap) 1.5–1.7% (band 0.5–2%);
  - bounce 43.6–44.2% (band 45–55%, slightly below);
  - visit→purchase 2.7–3.1% (band 1–3%, at the top).
- That is the lift being measured, not a calibration error. Refitting each round would erase it,
  and the plan says the offsets are frozen per run and never loosened.
- Every round's report shows this as `funnel_cal`; the CLI prints it as "calibrated funnel".
- **Where:** `src/summary.ts` `funnelCal`.

---

## ShopSim export in the repo (after A0 merged `docs/`)

### D58. B2 and B3 are checked against `docs/sim-export/` — `DECIDED`
- B2 and B3 were built from the same export pasted into the session: same ShopSim commit
  (`b208e33`), same 597-line SIM_NOTES.md. Now that `docs/sim-export/` is in the repo,
  `test/sim-export.test.ts` imports ShopSim's `contracts.ts` and SIM_NOTES.md, so a copied
  constant can't drift.
- **Carried over and checked:**
  - evidence weights: TAP = CLICKED 0.10; STAY = VISITED = BROWSED 0.25 with opinion 0.75 → 0.6;
    BUY = BOUGHT 1.00 with opinion 1.5 → 0.65; SEEN = SAW 0;
  - E cap 8, ε 0.01, prior E0 2, cold start (0.5, 1.0), reference-price α 0.3;
  - prior draw N(prior, 0.08) clipped to [0.05, 0.95];
  - FUNNEL_BANDS (p_click, bounce_rate, visit_to_purchase), with every target inside its band;
  - the $13.88 CPM;
  - the golden chain's shared steps (0.45 → 0.476 → 0.532).
- **Departures, each asserted in the test:**
  - **No cart.** CARTED (0.50) has no event, so BUY lands at 0.672 where ShopSim's chain
    reaches 0.714 through CART.
  - **One STAY row for a page visit:** VISITED and BROWSED are identical rows in ShopSim (bug (b)).
  - **No EXPECTS.** SAW and CLICK teach no expectation; the page call shows the exact tapped ad
    instead (bug (e)).
  - **No per-tick write cap.** ShopSim dropped writes past 6 (bug (c)); here a shopper writes at
    most tap, stay and buy on one ad per day, and all are applied.
- **Plan wins where they differ:** the budget floor is $15 (ShopSim $30), and `CLAIM_MIN` 0.5 is
  "claimed" for memory and evidence, a different role from ShopSim's 0.05 retrieval floor.
- **Where:** `test/sim-export.test.ts`; `src/memory.ts` exports `PRICE_KEEP` for it.

### D59. Budgets vs a $39 price: 43% of impressions are guarded — `OPEN` (your call before B4: keep, revisit with A's personas)
- SIM_NOTES rule 10: "Absolute-dollar gates need brand-scaled budgets. A premium catalog with
  value-tier budgets reads as a broken funnel."
- With the plan's $45 ± $15 a month against Magic Spoon's $39 one-time price, about 34% of shoppers
  can't afford a box (41% in the seed-13 population). 43% of impressions are guarded in every
  fixture round.
- The guard is correct; the question is the budget. The plan says A hand-sets "near $45 ± $15; B
  tunes". **Options:**
  1. keep it, which means about two in five shoppers never buy;
  2. scale budgets to the brand, e.g. $60 ± $15, which guards about 16%;
  3. let A set budgets per persona from what customers say about price.
  ShopSim deliberately kept deal segments below the price, so the price objection stays
  informative.
- Budgets never enter the state text (rendering rule 4), so a change re-uses most of the cache:
  only dice, memory and later states move.

### D60. The run manifest hashes every constant — `DECIDED`
- **`config_hash`** = sha256 over:
  - the Jev model; the run settings except the seed; population and rounds planned;
  - shopper, render and reward config; the evidence table and its constants;
  - the perception provider and `CLAIM_MIN`; calibration targets and clamp;
  - bandit constants and floors; learning thresholds.
- **Not in it:** the seed and calibration offsets, which the run row stores in their own columns,
  and A's rows.
- Every round report carries `jev_model` and `config_hash`, and the CLI prints the first 12
  characters. B4 writes them to the run row.
- ShopSim refused to resume a run when any manifest hash changed (SIM_NOTES rule 6, §8 rec. 9).
- **Where:** `src/run.ts` `configHash`.

---

## B4: SpacetimeDB, task board, worker

Sources: the SpacetimeDB TypeScript module docs (cheat sheet, reducer context, submodules, unit
testing), the HTTP API (`/v1/database`) and SATS-JSON pages, and the installed `spacetimedb@2.13.0`
package (types and `dist/server`), and A's `spacetime/src/tables_a.ts`, `reducers_a.ts` and
`schema.ts` from `feat/spacetime-tables-a` (merged). The live database has no tables yet: its schema
lists only `ping` until the merged module is published.

### D61. B's reducers are re-exported from `index.ts`, built on A's `schema.ts` — `DECIDED` (revised after merging A's tables)
- **Why an export at all:** in 2.13, a reducer is registered only through the module entry file's
  exports (`Schema.buildRawModuleDefV10(exports)`; each export's `registerExport` hook).
- **A's layout** (`feat/spacetime-tables-a`, merged):
  - `schema.ts` creates the schema from `tablesA` and `tablesB`;
  - `reducers_a.ts` and `reducers_b.ts` import it, with no import cycle;
  - `index.ts` re-exports both. A left `export * from './reducers_b'` commented out for B.
- **B's one edit to `index.ts`** is un-commenting that line. B's earlier `reducersB(spacetimedb)`
  wrapper and its export block were dropped in the merge.
- **Only reducers are exported:** helpers in `reducers_b.ts` stay local (the cheat sheet: "only
  export the schema, reducers, lifecycle handlers, and views"). `test:module` checks the merged
  module exports exactly the schema, `ping`, A's 6 reducers and B's 13.
- **Wire names** are the snake_case of the export names (`upsertProducts` → `upsert_products`).

### D62. The worker talks HTTP; batch writers take one JSON string — `DECIDED`
- **Endpoints:** `POST /v1/identity`, `POST /v1/database/<db>/call/<reducer>` (positional JSON array)
  and `POST /v1/database/<db>/sql`. No SDK dependency in `sim/`, matching A's `check:connections`.
- **Rows** are decoded from SATS-JSON:
  - products as arrays or objects;
  - sums by index or name;
  - options to null;
  - timestamps to ISO strings.
- **Batch writers** take the rows as one JSON-string argument (`rows_json`). The reducer parses and
  validates every row and rejects the whole batch with a `SenderError` on a bad one. That keeps
  SATS encoding off the wire for options and timestamps, which the HTTP docs don't spell out.
- **Calls per sim day:** `insert_decisions`, `upsert_shoppers`, `replace_arm_stats` (one each).
- **Calls per round:** `start_round`, `upsert_learnings`, `finish_round`.
- **The worker's identity token** is cached in `sim/.cache/spacetime-identity.json` (git-ignored).

### D63. The worker: claim, run, write, hand back; replay after a restart — `DECIDED`
- **Claiming:**
  1. read queued `run_round` tasks by SQL, oldest first;
  2. `claim_task` each until one succeeds; a task another worker took rejects;
  3. run the round, then `complete_task` with a short result, or `fail_task` with the error.
- **After the round:**
  - the summary goes to the round row (`finish_round`);
  - a `generate_creatives` task is queued for every round but the last (task id
    `tsk_gen_<run>_r<round>`);
  - the run row is set to `done` after the last round.
- **A run stays in memory between rounds.** A worker without it rebuilds it by replaying rounds
  0..r−1 from the Jev cache, each on the creatives that existed in that round.
- **The replay refuses (and the task fails)** if the run row's `config_hash` or the replayed
  calibration offsets differ, rather than writing numbers that don't match what's stored.
- **Stand-ins until A's pieces exist:**
  - `--enqueue <run_id>` queues `run_round` (task id `tsk_run_<run>_r<round>`), standing in for A6's
    start-rounds;
  - `--auto-next` queues the next round itself, standing in for A5.

### D64. The worker creates the run row on round 0 — `DECIDED` (your default)
- If `run_round` round 0 arrives for a run with no row, the worker uses the defaults (seed 13,
  300 shoppers, 5 rounds). If a row exists (A or a test wrote one), its settings win.
- The row then gets `status`, `calibration` (offsets, warm-up fit, probe usage), `jev_model` and
  `config_hash` (D60).
- **A new run is a new warm-up:** switching from fixtures to A's rows starts a fresh calibration,
  which is the plan's "re-run the warm-up round" at integration.

### D65. `shopper.state_text` is the page state — `DECIDED` (your default)
- It is the last text Jev read that day. A shopper who hasn't scrolled yet has `""`.

### D66. Column types for the contract's fields — `DECIDED` (no field added or changed)
- **json columns** are `string` holding JSON text.
- **Empty values are `option`:** subscription price, mean reward, cost per order, a learning's
  arm and valid_to_round, believes and objection, task claimed_by and result.
- **Round timestamps:** `started_at` and `finished_at` are options; `created_at` and `updated_at`
  are set from `ctx.timestamp`.
- **Keys:**
  - product, creative_perception, run, learning and task have their id as primary key;
  - round, shopper, decision and arm_stat have no single-column key in the contract, so they are
    indexed on `run_id` and their reducers filter within a run, rather than adding a column.
- `draw` is JSON (every uniform the call's dice used; D40). Every table is `public`.

### D67. Task board rules — `DECIDED` (your default; A's agents use the same reducers)
- **`enqueue_task(task_id, kind, payload_json)`:**
  - `kind` is `run_round` or `generate_creatives`;
  - the payload is checked against the contract's shape;
  - a duplicate task id is rejected.
- **`claim_task(task_id, claimed_by)`:** queued → claimed in one transaction, so two workers can
  never both take a task.
- **`complete_task(task_id, result_json)`** needs a claimed task; **`fail_task(task_id, error)`**
  records `{ error }` as the result.
- **`run_id`** comes from the payload.

### D68. Reading A's rows: A's field names match the contract — `DECIDED` (after merging A's tables)
- A's `tables_a.ts` has the contract's field names and order. Its conventions are the ones B's
  reader already accepts:
  - `""` for empty, never an option (D12);
  - json columns as JSON strings (D13);
  - integers as u32, so they arrive as numbers.
- **`loadWorldFromDb` is unchanged.** It reads `brand`, `concept`, `segment`, `arm` and `creative`
  (A's) plus `product` (B's) with `SELECT *`, and parses them through the same contract schemas and
  cross-table checks as the fixtures.
  - Rows are sorted by id.
  - Creatives with `round_created` after the round are left out.
- **Checked end to end in `test:module`:** the fixture world is written through A's own reducers
  (`upsertBrands` … `upsertCreatives`, in A's conventions), and the worker runs a round from those
  rows in database mode.
- **Products** are B's table. With A's rows, the worker reads them from `product`, so they must be
  written before a run (`writer.products`).

### D69. The module is tested in the official harness without Vitest — `DECIDED`
- **`npm run test:module`:**
  1. bundles `spacetime/src/index.ts` with esbuild (already installed with tsx);
  2. runs it in `createModuleTestHarness` (spacetimedb/server/test-utils);
  3. drives it with the real worker.
- **How it loads:** a Node resolve hook (`test/module/sys-hooks.mjs`) serves `spacetime:sys@2.*` from
  the same stub the official Vitest plugin uses, so nothing is added to `spacetime/package.json`.
- **What it covers:**
  - the module definition builds;
  - two rounds land in every B table, the summary in the round row, and tasks move queued → claimed
    → done, with `generate_creatives` queued;
  - claim races and bad input are rejected;
  - perceptions stay frozen.
- **The wire contract,** read from the module definition SpacetimeDB publishes
  (`buildRawModuleDefV10`):
  - the case policy is snake_case;
  - every table has exactly the fields of `docs/PLAN.md` "The contract", in order, parsed from the
    plan itself;
  - A's tables match the contract schemas the loader reads them with;
  - every reducer the sim calls exists, with the parameters it sends, in order;
  - every row the worker writes has exactly its table's columns, and the task payloads have the
    plan's shapes.

  A deliberate column rename fails four of these tests.
- **What it can't cover:** row-level security, network behaviour and the real HTTP encoding (the
  live database has no tables yet). The real `spacetime build` and publish need the CLI and A's
  owner login.

### D70. Live status at the end of B4 coding — `OPEN`
- **Connection:** the database answers reducer calls (`ping`) and SQL, but has no tables. A's
  aren't published, and B's go up with the next publish.
- **The CLI install was blocked** by the session's permission check, so `spacetime build` hasn't
  run here; the module typechecks and bundles.
- **The done-when** ("A starts a round from ASI:One, the worker runs it, and the summary lands in
  the round row") waits on A publishing the module with A4's rows. Until A6 exists,
  `npm run sim:worker -- --enqueue <run>` stands in for start-rounds.
- **Sample round summary for A6:** `sim/SAMPLE_ROUND_SUMMARY.json`, round 1 of a fixture run on
  real Jev answers (from cache), written by the real worker.

### D71. The competitor set is locked at seven brands; fixtures keep the stand-ins — `OPEN` (products)
- The plan now locks Magic Spoon against seven competitors that run Meta ads: Catalina Crunch,
  Seven Sundays, Surreal, GHOST, Premier Protein, Legendary Foods and Quest Nutrition. This
  replaces Three Wishes and Wonderworks.
- **Per your call before B4, the fixtures keep the old stand-ins** until real data is in. The sim
  reads whatever brands A writes, so this only matters for B's `product` table.
- **Needed:** one landing product per competitor A actually uses as a `landing_product_id`, with
  price, rating and highlights from each brand's site (D44's method). Only Magic Spoon's page is
  ever shown today, so the competitors' rows matter only for completeness.
