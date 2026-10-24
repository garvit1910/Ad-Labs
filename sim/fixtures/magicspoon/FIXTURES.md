# Magic Spoon fixtures

Fixture rows with exactly the contract's shapes (docs/PLAN.md "The contract"), so B can run
without A. `npm run fixtures:check` validates every row and the cross-table rules. Columns the
contract marks json are stored parsed here; `""` and `null` both mean "empty".

| File | Table | Rows | Status |
| --- | --- | --- | --- |
| brands.json | brand | 4 | Final |
| concepts.json | concept | 19 | Draft vocabulary from "Simulation design"; agree with A |
| segments.json | segment | 6 | Draft; A's personas replace them at the 2:30 PM integration |
| products.json | product | 4 | Magic Spoon, Catalina Crunch and Three Wishes filled from the brand sites on 2026-10-24 (DECISIONS D44); Wonderworks still 0 |
| arms.json | arm | 11 recipes + control | Placeholder recipes; steal, double_down and control cite fixture ad ids; gap arms cite nothing until A's voc facts exist |
| creatives.json | creative | 20 | See below |

## Placeholders still to replace

- **products.json**: Wonderworks only (no direct store found). The others came from the brand
  sites on 2026-10-24; re-check prices before the demo. `fixtures:check` warns while a price is 0.
- **creatives.json, competitor_live**: `cr_cc_live_1/2`, `cr_tw_live_1/2` and `cr_ww_live_1/2`
  are invented stand-ins. Replace their headline, primary text, CTA, visual description and
  days running with real ads copied from the Meta Ad Library.
- **creatives.json, brand_live**: `cr_ms_live_1/2/3` (the control arm) are stand-ins too.
- **segments.json quotes**: invented placeholder quotes, 3 or 4 per segment. Real ones
  (8 to 20, exact substrings of real mentions) come from A.
- **cr_gen_03**: the "13g protein" figure is unverified; real numbers come from A's brand facts.

## Choices made here (not contract changes)

- Id prefixes beyond the plan's `seg_`, `arm_`, `cr_`, `shp_`: brands `br_`, concepts `cpt_`, products `prd_`.
- The control arm has `angle` and `hook` set to null; every other arm must have both.
- `brand_live` creatives carry `arm_id: "arm_control"`; competitor ads have no arm.
- Generated fixture creatives have `days_running: 0`, `image_url: null`, `pack_fingerprint: null`.
- `subscription_price_usd` may be null for a brand without a subscription.
- `arm_11` and `cr_gen_11` are the B3 planted winner: written to fit the taste skeptic segment
  (`planted.json`; DECISIONS D56). Its "4.6 stars across over 25,000 reviews" is the product
  page's rating and review count (D44, grouped across products on the site). The roommate
  testimonial is invented, like every fixture ad.
- json columns (`prior_weights`, `quotes`, `evidence`, `learning_ids`, `page_highlights`) may arrive as
  JSON strings from SpacetimeDB or parsed here; both load.
- A segment missing a concept in `prior_weights` loads with a warning; that concept starts unheld (w 0.5, E 1.0).
- Segment descriptions avoid restating a prior (no gym routine, no childhood cartoons): rendering rule 2.
