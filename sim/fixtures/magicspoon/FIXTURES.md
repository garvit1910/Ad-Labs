# Magic Spoon fixtures

Fixture rows with exactly the contract's shapes (docs/PLAN.md "The contract"), so B can run
without A. `npm run fixtures:check` validates every row and the cross-table rules. Columns the
contract marks json are stored parsed here; `""` and `null` both mean "empty".

| File | Table | Rows | Status |
| --- | --- | --- | --- |
| brands.json | brand | 4 | Final |
| concepts.json | concept | 19 | Draft vocabulary from "Simulation design"; agree with A |
| segments.json | segment | 6 | Draft; A's personas replace them at the 2:30 PM integration |
| products.json | product | 4 | **Placeholder**: prices, rating, review count, highlights and shipping notes are 0 or empty until filled from the brand sites |
| arms.json | arm | 11 recipes + control | Placeholder recipes; evidence is empty |
| creatives.json | creative | 20 | See below |

## Placeholders still to replace

- **products.json**: every `price_usd`, `subscription_price_usd`, `rating`, `review_count`,
  `page_highlights` and `shipping_note`, and possibly the product names. `fixtures:check`
  warns while a price is 0.
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
