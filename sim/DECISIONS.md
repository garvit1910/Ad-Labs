# Sim decisions log (Person B)

Every place where B's code had to choose because docs/PLAN.md is silent, ambiguous, or couldn't
be followed as written. Each entry gives the decision, why, where it lives, and who must agree.
When a decision changes, edit its entry and status here in the same commit as the code.

**Status:** `OPEN` needs an answer · `NEEDS A` needs Person A's agreement because it touches the
contract or A's data · `DECIDED` taken by B and reversible · `FORCED` the plan couldn't be followed.

Last updated: 2026-10-24, after B1 (the Jev spike, `SPIKE.md`). B0 entries: commits `c82e80e`, `2a4f72a`.

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
- **Product prices, ratings, review counts, highlights, shipping notes:** all 0 or empty
  (`fixtures/magicspoon/products.json`). They don't affect the feed call, only the page call (B2).
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
- `renderFeedState` throws over 450 words, so no caller can send an oversized state. Fixture
  states run about 100–125 words.

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

### D33. Guidance for B2 and B3 from the spike — `OPEN` (to settle in those phases)
- **B2 dice:** tap Nouls are independent and don't sum to 1. Draw our tap from P_cal(tap ours)
  alone; a competitor tap only counts as "lost to a competitor".
- **B3 calibration:** fit one log-odds offset on P(tap ours) to a 1% mean. This replaces the plan's
  "P(tap any) = 1 − P(none), then split". Clamp probabilities to [0.005, 0.995] before logit,
  because Choice answers (the page `objection`) hit exact 0 and 1.
- **B3 memory:** Jev's wear-out response is weak (−2% to −4% for protein athletes after 4 protein
  ads), so the wear_out learning, already cut line 1, may never fire.

### D34. Spike-only page values — `DECIDED` (spike only)
- Test 4 needed a page but products.json has no prices yet. `spike/states.ts` `SPIKE_PAGE` uses
  $47 one-time, $40 with subscription, rated 4.5 from 5,000 reviews. These values were invented for
  a directional test and must never be used outside the spike.
