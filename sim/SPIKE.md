# B1 Jev spike: question shapes

Run 2026-10-24 against `jev-1.13.0`. Every answer is cached in `.cache/jev-cache.sqlite`, so
`npm run sim:spike` reprints the tables below identically at no cost. Raw results are in
`spike/results/` (`tests.json`, `mechanics*.json`, `determinism.json`).

## Decision

**The feed call is one Noul per ad, with the three posts listed in the state.** The decision
rule fired: the plan's single Choice failed the order test (9 of 21 judged ads moved more than
20%). The Noul shape is also better on the measures the reward depends on:

| | Choice over A/B/C + none (plan) | One Noul per ad (chosen) |
| --- | --- | --- |
| Order test (rule: every ad < 20%) | FAIL, 9/21 ads over; 8 of the 9 have mean P < 0.10, where one 0.01 step is 10–50% | FAIL, 4/36 ads over, all competitor ads (worst 37%) |
| Our ad's order movement (what the reward uses) | max 19.5% | max 19.7% |
| Repeat-call noise on P(tap ours), sd | 0.008–0.035 | 0.011–0.018 |
| Saturation: P(tap ours) ≥ 0.95 | 3 of 12 states; reaches exactly 1.0 | 0 of 12; max 0.74 |
| Exact 0 or 1 probabilities | 2,156 of 14,036 values (15%) | 0 of 10,680 (all values 0.06–0.73) |
| Sensitivity, fitting ad ÷ other ad (≥ 1.5×) | PASS, 1.74–7.81× | FAIL in 1 of 4 states, 1.43–2.78× |
| Memory effect (must fall) | PASS, −0% to −12% | PASS, −2% to −12% |
| Mean input tokens per feed call | 750 | 688 |

**Why it matters.** The reward multiplies P(tap ours) by the page probabilities. Calibration
moves it in log-odds, so saturation near 1 and exact 0s and 1s destroy the differences between
arms. That happens for in-market, well-matched shoppers, which is exactly where purchases come
from. The Noul shape keeps P(tap ours) between 0.28 and 0.74, where a 0.01 step is a small
change in log-odds.

**What it costs.** Sensitivity is weaker (see test 1), and a competitor ad's tap chance depends
on its position (up to 37%). Competitor taps only feed the "lost to a competitor" count, so
they never enter the reward.

## Chosen question shapes

Feed call. The state is the template's SHOPPER and MEMORY, then:

```
RIGHT NOW
Scrolling Instagram on their phone. Three sponsored posts appear one after another:
- {brand}: {headline} {primary text} [Button: {cta}] [Image: {visual description}]
- … (3 posts, in the seeded feed order)
```

| Name | Type | Wording |
| --- | --- | --- |
| `tap_A`, `tap_B`, `tap_C` | Noul | `Does this shopper tap the {brand} post that says "{headline}" to learn more?` |
| `believes` | Noul | `Does this shopper believe the main promise of the {brand} post that says "{headline}"?` (plan wording; the post is now in the state) |

Page call: unchanged from the plan (`stays` Noul, `buys` Noul, `objection` Choice over price,
taste_doubt, trust, not_now, other_brand, nothing). Code: `src/feed.ts`, `src/render.ts`
`renderFeedState`; the spike's page state is in `spike/states.ts` `renderPageState`.

**Concurrency limit: 32.** Latency stays flat up to 32 in flight (p50 78 ms, p95 150 ms) at
311 requests/s. A round of about 1,440 calls (720 feed + 720 page) takes about 5 s. No 429s
appeared even at 256 in flight. Set in `src/config.ts`.

## Setup

- **States:** 12 base states, one per fixture segment × {not shopping, shopping now}, plus 3
  memory variants. Preferences are the segment's priors exactly, with no draw noise
  (`spike/states.ts`), rendered by the production renderer.
- **Neighbours:** always `cr_cc_live_2` ("Snack smarter") and `cr_tw_live_1` ("Cereal with
  nothing to hide"), so only our ad and the state change. Each shopper's own ad is the fixture
  ad written for its segment.
- **Orders:** all 6 orders of the 3 ads are tested, not 10 random shuffles. Shuffles would repeat
  orders, and the cache would return identical answers for the repeats.
- **Ads are placeholders:** the fixture live ads are invented stand-ins (DECISIONS D5).
  Re-run `npm run sim:spike` once the real ads are in (B4 integration).

## Test 1: sensitivity (rule: fitting ad ≥ 1.5× the other)

Keto shoppers: low-carb ad `cr_gen_02` vs childhood-taste ad `cr_gen_04`; nostalgic shoppers the
reverse. "Alone" is the sim's shape: one of our ads plus the two neighbours, as the bandit
compares arms. "Head to head" puts both our ads in one feed. All values are means over 6 orders.

| State | Choice alone | Choice head to head | Noul alone | Noul head to head |
| --- | --- | --- | --- | --- |
| keto, not shopping | 0.872 vs 0.490 = **1.78×** | 0.905 vs 0.015 = 60× | 0.685 vs 0.410 = **1.67×** | 0.677 vs 0.327 = 2.07× |
| keto, shopping now | 0.985 vs 0.567 = **1.74×** | 0.990 vs 0.007 = 149× | 0.715 vs 0.498 = **1.43×** ✗ | 0.717 vs 0.357 = 2.01× |
| nostalgic, not shopping | 0.938 vs 0.145 = **6.47×** | 0.950 vs 0.002 = 570× | 0.583 vs 0.210 = **2.78×** | 0.545 vs 0.210 = 2.60× |
| nostalgic, shopping now | 0.977 vs 0.125 = **7.81×** | 0.990 vs 0.000 | 0.685 vs 0.257 = **2.67×** | 0.668 vs 0.235 = 2.84× |

Result: Choice PASS. Noul FAIL on keto + shopping now (1.43×).

- The keto shortfall is partly the fixture. The "other" ad promises "minus the sugar crash", and
  keto shoppers care a lot about low sugar (prior 0.80), so it isn't irrelevant to them.
- The plan's fallback applies if real personas and ads still fall short at the 2:30 PM integration:
  sharper quotes and plainer preference lines first, then a Score "how appealing" question
  folded into the tap estimate.

## Test 2: option order (rule: every ad moves < 20% relative over the orders)

Metric: max |p − mean| ÷ mean over the 6 orders. Ads with mean P(tap) < 0.02 are listed but not
judged, because a 0.01 step there is 50% or more.

| State | Choice: ours / cc_live_2 / tw_live_1 | Noul: ours / cc_live_2 / tw_live_1 |
| --- | --- | --- |
| keto, not shopping | 0.872 ±3% / 0.020 ±50% / 0.002 (skip) | 0.685 ±5% / 0.258 ±16% / 0.133 ±18% |
| keto, shopping now | 0.985 ±2% / 0.008 (skip) / 0.000 (skip) | 0.715 ±4% / 0.277 ±6% / 0.152 ±14% |
| protein, not shopping | 0.857 ±20% / 0.003 (skip) / 0.000 (skip) | 0.523 ±20% / 0.175 ±9% / 0.115 ±13% |
| protein, shopping now | 0.987 ±2% / 0.002 (skip) / 0.000 (skip) | 0.577 ±13% / 0.183 ±14% / 0.132 ±9% |
| nostalgic, not shopping | 0.938 ±2% / 0.008 (skip) / 0.000 (skip) | 0.583 ±2% / 0.220 ±14% / 0.163 ±4% |
| nostalgic, shopping now | 0.977 ±3% / 0.015 (skip) / 0.000 (skip) | 0.685 ±4% / 0.255 ±10% / 0.180 ±11% |
| family, not shopping | 0.732 ±14% / 0.005 (skip) / 0.043 ±77% | 0.535 ±8% / 0.157 ±21% / 0.302 ±23% |
| family, shopping now | 0.948 ±4% / 0.003 (skip) / 0.027 ±88% | 0.650 ±3% / 0.175 ±37% / 0.328 ±19% |
| skeptic, not shopping | 0.355 ±10% / 0.080 ±38% / 0.025 ±20% | 0.312 ±13% / 0.212 ±18% / 0.203 ±8% |
| skeptic, shopping now | 0.503 ±15% / 0.112 ±37% / 0.028 ±41% | 0.412 ±13% / 0.233 ±16% / 0.215 ±7% |
| deal, not shopping | 0.667 ±19% / 0.020 ±50% / 0.008 (skip) | 0.428 ±7% / 0.238 ±22% / 0.192 ±6% |
| deal, shopping now | 0.902 ±4% / 0.027 ±88% / 0.008 (skip) | 0.603 ±6% / 0.270 ±11% / 0.228 ±5% |

| | Choice | Noul |
| --- | --- | --- |
| Judged ads over 20% | 9 / 21 (FAIL) | 4 / 36 (FAIL) |
| Worst | cr_tw_live_1 0.027 ±88% | cr_cc_live_2 0.175 ±37% |
| Over 20% with mean ≥ 0.10 | 1 (cr_cc_live_2 0.112 ±37%) | 4, all competitor ads |
| Our ad, worst | 19.5% (protein, not shopping) | 19.7% (protein, not shopping) |
| Mean P(tap) by position 1 / 2 / 3 | 0.287 / 0.276 / 0.284 | 0.316 / 0.333 / 0.327 |

- **No first-position bias** in either shape, despite the jev-1.13 docs' warning.
- **Part of the movement is noise.** Some of what this test sees is repeat-call noise, not order
  (see test 5): an identical Choice request ranged 0.32–0.45 on one state.

## Test 3: memory (rule: "seen 4 protein ads this week" lowers the protein ad's tap chance)

The memory line rendered is `Has seen Magic Spoon ads 4 times this week, mostly about high
protein.` The ad is `cr_gen_03` ("13g of protein in every serving"); values are means over
6 orders.

| State | Choice: without → with | Noul: without → with |
| --- | --- | --- |
| protein, not shopping | 0.857 → 0.852 (−1%) | 0.523 → 0.503 (−4%) |
| protein, shopping now | 0.987 → 0.985 (−0%) | 0.577 → 0.565 (−2%) |
| keto, not shopping | 0.735 → 0.647 (−12%) | 0.502 → 0.440 (−12%) |

Result: PASS in both shapes, with the right direction in every pair.

- **The effect is weak for the protein athlete** (−2% to −4% with Noul), about the size of the
  repeat noise. Jev reads repeated protein ads as only a mild turn-off for someone who cares a lot
  about protein.
- **wear_out may rarely fire.** The planned wear_out learning ("tap chance falls ≥ 30% after 3
  same-concept showings") is cut line 1 anyway.

## Test 4: need (rule: "shopping for cereal right now" raises P(buy))

Page call, the same tapped ad and page for both halves of each pair. The page values are
spike-only placeholders: $47 one-time, $40 with subscription, rated 4.5 from 5,000 reviews.

| Segment | P(buy \| stay): not shopping → shopping | P(stay) | Main objection |
| --- | --- | --- | --- |
| keto | 0.35 → 0.46 | 0.66 → 0.71 | not_now → nothing |
| protein | 0.28 → 0.31 | 0.56 → 0.55 | not_now → price |
| nostalgic | 0.23 → 0.42 | 0.56 → 0.67 | not_now → price |
| family | 0.24 → 0.37 | 0.59 → 0.62 | not_now → price |
| skeptic | 0.21 → 0.38 | 0.48 → 0.61 | not_now → trust |
| deal seeker | 0.25 → 0.43 | 0.37 → 0.48 | not_now → price |

Result: PASS, P(buy) rises in 6 of 6.

- **The feed responds too:** P(tap ours) rises in 6 of 6 with Noul (keto 0.685 → 0.715 … deal
  seeker 0.428 → 0.603) and with Choice.
- **Objections look sensible:** without a need the objection is `not_now`, and with one it moves
  to price, trust or nothing.

## Test 5: mechanics

### Latency and rate limit

Production feed shape, 512 fresh requests per level (`mechanics.json`):

| In flight | Requests/s | p50 | p95 | max | 429s |
| --- | --- | --- | --- | --- | --- |
| 16 | 187 | 68 ms | 113 ms | 501 ms | 0 |
| **32** | **311** | **78 ms** | **150 ms** | 355 ms | 0 |
| 64 | 498 | 82 ms | 172 ms | 401 ms | 0 |
| 128 | 698 | 114 ms | 272 ms | 454 ms | 0 |
| 256 | 260 | 137 ms | 328 ms | 1,896 ms | 0 |

- **Earlier runs:** the old Choice shape, 1,024 requests per level (`mechanics-choice-sustained.json`),
  gave 356 req/s at 128 in flight (p50 276 ms) and 480 req/s at 256 (p50 315 ms), with no 429s.
- **Rate limit:** not reached at about 700 req/s or about 480k input tokens/s. The org's real
  limit is shown only in the TypeSafe console. Over 256 in flight the server queues (throughput
  falls, max latency 1.9 s), so 32 leaves wide headroom.
- **Spike calls:** p50 75–80 ms and p95 145–152 ms over 444 fresh spike calls. That is within
  TypeSafe's listed 70–500 ms and well under the plan's 0.3 s estimate.

### Error types (raw requests)

| Request | Status | Body |
| --- | --- | --- |
| Bad API key | 401 | `{"detail":{"error_type":"authentication_error", …}}` |
| Unknown model `jev-9.9.9` | **400** | `{"detail":{"error_type":"api_usage_error","message":"Unknown model: jev-9.9.9"}}` |
| Missing `state` | 422 | `{"detail":[{"type":"missing","loc":["body","state"], …}]}` |
| Empty `questions` | 422 | `type: "too_short"` |
| Choice without criteria | 422 | `type: "missing"`, `loc: [… "choice","criteria"]` |
| Choice with 256 options | 422 | `type: "too_long"` (max 255) |
| Score with 11 levels | 422 | `type: "too_long"` (max 10) |
| Malformed JSON | **422** | `type: "json_invalid"` (the docs say 400) |
| State over 64k tokens | 400 | `{"detail":{"error_type":"max_tokens_exceeded"}}` |

The wrapper treats all of these as non-retryable and throws `JevError` with the status and body.

### Retry behaviour

- **Live:** no 429, 529 or 5xx ever occurred in about 5,700 calls, so the retry path (exponential
  backoff, `retry-after` capped at 30 s, 5 attempts) has only run against the stubbed API in
  `npm test`.
- **`retry-after`:** never seen live.

### Determinism: Jev is not deterministic

The same request sent 10× in a row and 10× at once (separate clients):

| Shape | State | Mean | sd | Range | Distinct answers |
| --- | --- | --- | --- | --- | --- |
| Choice | keto | 0.861–0.875 | 0.023–0.026 | 0.81–0.91 | 5–6 / 10 |
| Choice | nostalgic | 0.954–0.960 | 0.008–0.012 | 0.94–0.97 | 3–4 / 10 |
| Choice | skeptic | 0.358–0.375 | 0.034–0.035 | 0.31–0.44 | 6–7 / 10 |
| Noul | keto | 0.667–0.671 | 0.011 | 0.65–0.68 | 4 / 10 |
| Noul | nostalgic | 0.596–0.597 | 0.017–0.018 | 0.57–0.63 | 5–6 / 10 |
| Noul | skeptic | 0.278–0.285 | 0.013–0.015 | 0.26–0.31 | 4–5 / 10 |

- **Model noise, not batching:** sequential and concurrent repeats are alike, so the variation is
  in the model itself.
- **The cache matters more than planned.** It's the only source of identical replays: the same
  seed without the cache gives different numbers. The B6 demo must replay from the cache.

### Probability resolution

- **0.01 grid:** every probability Jev returned (5,698 responses) is on a 0.01 grid, give or take
  float rounding such as 0.8099999999999999.
- **Exact 0s and 1s:** Choice answers include exact 0s and 1s, and so does the page's `objection`
  Choice (29 of 96 values were 0). Feed Nouls never did (0 of 10,680).

## What this means for later phases

- **B2, dice:** tap Nouls are independent, so the three P(tap) values don't sum to 1. Draw our tap
  from P_cal(tap ours) alone. A competitor tap, drawn separately, only counts as "lost to a
  competitor" and isn't modelled further.
- **B3, calibration:**
  - The plan's "calibrate P(tap any) = 1 − P(none), then split" no longer applies. Fit one offset
    on P(tap ours) to a 1% mean.
  - Raw means are about 0.3–0.7, so expect b_tap around −4.5 to −5.
  - P(buy | stay) is 0.21–0.46 raw against a 4% target, and P(stay) is 0.37–0.71 against 50%.
  - Clamp every probability to [0.005, 0.995] before logit; Choice and objection answers do hit
    exact 0 and 1.
- **B3, bandit noise:** per-call noise (sd about 0.01–0.02 on P(tap ours)) is small next to arm
  differences (0.28–0.74 across states). Averaging over impressions removes it, and the reward
  uses probabilities, so noise doesn't compound.
- **Cost:** about 690 input tokens per feed call and 714 per page call, against the plan's 900.
  The whole spike, including all ramps, used about 4.1M input tokens, roughly $0.17.

## Reproduce

```sh
cd sim
npm run sim:spike              # tests 1-4, both shapes; free and identical from cache
npm run sim:spike:mechanics    # test 5: fresh ramp, determinism probe, error types (costs about $0.01)
npx tsx spike/determinism.ts   # repeat-call noise; bypasses the cache on purpose
```
