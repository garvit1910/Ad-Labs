# Sim decisions log (Person B)

Every place where B's code had to choose because docs/PLAN.md is silent, ambiguous, or couldn't
be followed as written. Each entry gives the decision, why, where it lives, and who must agree.
When a decision changes, edit its entry and status here in the same commit as the code.

**Status:** `OPEN` needs an answer · `NEEDS A` needs Person A's agreement because it touches the
contract or A's data · `DECIDED` taken by B and reversible · `FORCED` the plan couldn't be followed.

Last updated: 2026-10-24, after B3 (bandit and learnings). B0 entries: commits `c82e80e`, `2a4f72a`; B1: `2dd85d2`; B2: `e7ca652`, `d5da10d`.

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

### D43. Arms are picked uniformly until the bandit exists — `DECIDED`
- `uniformPolicy` draws one live arm per impression from `(seed, "arm", shopper, tick)`. That is
  also the warm-up's rule. B3 passes the bandit as the engine's `policy`.
- An arm is live when it has a ranked Magic Spoon creative. Within an arm, the creative is drawn
  from those written for the shopper's segment, else from all of the arm's (the control's live
  ads have no segment).

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
- The plan's round summary also lists the cache hit rate; B4's round row can add it next to the
  deterministic part.
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

### D48. Two state texts per shopper-day; the shopper row has one `state_text` — `OPEN` (for B4)
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
- **Fitted on the fixtures (728 impressions):** tap −3.932, stay −0.318, buy −1.820. That gives
  P(tap) 1.00%, bounce 50.0%, P(buy | stay) 4.00% and visit→purchase 2.00%, all inside
  FUNNEL_BANDS.
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
- **Where:** `src/run.ts`.

### D51. Floors are met in expectation, exactly; a round's realised share varies — `DECIDED`
- **Plan:** "the control arm gets at least 10% of impressions and every other live arm at least 3%".
- **Code:**
  - Each impression draws θ ~ N(μ, σ²) for every arm, with seeded draws, and takes the highest.
  - The floored shares are p_best raised to the floors, with the rest scaled down in proportion.
  - A pick from an arm above its share is kept with probability share ÷ p_best. Otherwise the
    impression goes to an arm below its floor, in proportion to how far below it is.
  - Each impression's arm then follows the floored shares exactly (unit test: 20,000 picks within
    1 point).
- **What a run shows:** realised per-round shares scatter around that. In the fixture run the
  control got 9.6% over rounds 1–5 (3,614 impressions); by segment it ranged from 7.9% (531
  impressions) to 11.3%, which is sampling noise.
- **With 11 recipes plus the control, the floors cap any one arm at 60%.**
- **Where:** `src/bandit.ts` `applyFloors`, `Bandit.policy`.

### D52. arm_stat covers the run so far; the leaderboard range is μ ± 2σ — `DECIDED`
- `impressions` and `mean_reward` count the whole run so far, like the posterior they sit next to.
  Per-round counts are in the round summary.
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
  one key each: `(seed, "arm", shopper, tick, arm)`, plus `"keep"` and `"floor"` for the floors.
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
  percents; directives go through `numberFree`, which throws if a digit survives.
- **Versioning:** a key is (segment, kind, arm or concept). A new version opens whenever the
  statement text changes, so a statement whose numbers move opens a new version each round;
  valid_from_round is the round whose data produced it. A key that stops firing is closed at that
  round. Nothing is deleted.
- **wear_out is not built** (cut line 1; SPIKE.md test 3 found Jev's wear-out response weak).
- **`OPEN` (yours):** with the stand-in ads, "not needing cereal yet" is every segment's top
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
  stay inside the arm builder's limits. Adding a 12th recipe would have lowered the floor cap to
  57%.
- **The creative:** `cr_gen_11` is written for the taste skeptic segment: their own "gravel" quote,
  their roommates, taste, crunch, and the product page's real "4.6 stars, over 25,000" reviews.
  `fixtures/magicspoon/planted.json` names it, and the CLI reports its share each round.
- **Real Jev:** share in its segment 15% (warm-up), 44%, 63%, then **57% in round 3** (> 50%), then
  65% and 65%; p_best 99.7% at round 3.
- **Stub Jev:** `test/b3.test.ts` checks the same rule with a stub that only likes the planted ad
  for that segment.
- **Where:** `fixtures/magicspoon/arms.json`, `creatives.json`, `planted.json`.
