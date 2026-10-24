# Adcero → Cal Hacks reuse manifest

**Source commit:** `f9bb088c93f40f1c2ae41886ba4a21b7556e102f` (branch `main`, clean tree). Generated 2026-10-23.

This export is read-only. Nothing outside `reuse-export/` was modified. No `.env*` file was opened; environment variables appear here by name only.

| File | What it is |
|---|---|
| `REUSE_MANIFEST.md` | This document: per-area tables, couplings, stubs, env vars, defects, copy order. |
| `files.txt` | 319 repo-relative paths (every *copy as-is* + *copy + edit* file). Feed to `rsync --files-from`. |
| `deps.json` | npm dependencies those 319 files import, with Adcero's range and the lockfile-resolved version. |
| `contracts.ts` | Standalone types (no imports): normalized signal row, brand context (facts/chunks/slice), competitor ad + labels + cluster + winner, both pages' payloads and top-level props. |
| `fixtures/brand-identity.json` | One Brand Identity page payload, keyed by endpoint. Invented brand. |
| `fixtures/competitor-analysis.json` | One Competitor Analysis page payload, keyed by endpoint. Invented competitors; dashboard computed by Adcero's own pipeline. |

Each fixture also carries a top-level `_meta` key (description, provenance, contract name). It is documentation, not part of the payload: strip it before serving, since the `*PagePayload` types in `contracts.ts` exclude it.

---

## 0. Read this first

### 0.1 What the brief assumed vs what the code has (verified in source)

| Brief said | Reality at this commit |
|---|---|
| `brand_signals` table | **Does not exist.** The normalized customer-voice row is **`brand_mentions`** (one row per review/post/comment, upsert key `(brand_profile_id, platform, external_id)`). Derived layers: `brand_presence_phrases` (atomic pain/desire/objection/praise/quote phrases + 1536-d embedding) → `brand_presence_themes` (clustered angles). Each normalizer returns its own union type; the canonical persisted shape is `BrandMention` (`lib/brand-presence/types.ts:823`) — `contracts.ts` `NormalizedSignalRow`. |
| `brand_identity` table | **Does not exist.** Own brand = **`brand_presence_profiles`**. Competitors = **`tracked_competitors`** (one row per platform per competitor). |
| domain → Google advertiser ID | **No automatic resolver exists.** The Google AR id is always pasted (`parseGoogleAdvertiserInput`). Domain → Meta Page ID is *homepage Facebook-link mining* (`extractFacebookLinks`) plus a *zero-ad keyword-scrape fallback* (`sync/page-id-resolution.ts`). facebook.com and the Ad Library typeahead bot-wall server-side fetches, so there is no direct lookup. |
| "four" distillation workers | **Six job types**: `brand_object_crawl → identity → promote → market → personas → chunks`. Only **identity** and **personas** call an LLM; **promote** and **market** are zero-LLM. |
| enums `angle_universal`, `persona_universal` | Those are **column names** on `ad_labels`. The enums are `ANGLES` and `PERSONAS` in `services/ad-library/label-taxonomy.ts`. The `angle`/`persona` columns hold **industry-specific** tokens (`lib/brand-identity/industry-vocabulary.ts`). |
| "leaky taxonomy", "failing Offer extractor" | **Neither exists under that name** (searched `tasks/`, `docs/`, every `CLAUDE.md`, tests, last 2,000 commits). Closest real issues and their status are in §5.6. |
| an `LLMProvider` interface | Exists (`lib/ai/provider.ts`, 111 LOC) but **areas 1–7 never use it**. They call `openAIChatCompletion` / `openAIEmbeddings` (`lib/llm/clients.ts`) and `geminiGenerateContent` (`lib/llm/clients/gemini.ts`) directly. The stubs target those. |
| Sentry/PostHog, Drizzle client, `emitEvent`/`auditLog`/engine_actions | **None of them appear in areas 1–6.** All logging is `console.*`. They live in the API route wrappers (`withAfRoute`), which are not exported. The DB is reached through an injected **supabase-js** client (`SupabaseClient` constructor/param), not Drizzle; `drizzle/schema.ts` is only the DDL source. |

### 0.2 How this export is meant to be used

1. `rsync -a --files-from=reuse-export/files.txt /path/to/admigo-1/ /path/to/new-project/` (319 files).
2. Write the **18 same-path stubs** in §8.2. Each replaces a cut-point file at the *same path* with the *same exported names*, so every importer compiles unchanged.
3. Apply the **11 copy + edit** changes in §8.3 (mostly deletions).
4. Create the tables from §13 (Appendix) and a minimal `job_queue` (§8.4), then run the job types listed in §8.4 with a ~60-line local worker instead of Vercel crons.

**Design choice behind the verdicts.** The processors stay **unchanged** wherever a same-path stub can absorb the coupling. That includes keeping `organization_id` as a constant and keeping the three queue modules, which write `job_queue`. The phase, checkpoint and resume logic is where the value is, and rewriting it would cost more than a stub (user decision: processors are copy + edit).

### 0.3 What was verified (evidence)

- **Closure.** A read-only import walker followed every `@/` and relative import (type-only included) from 116 seeds. The resolver was written in plain Node, because this checkout has no `node_modules`. Result: 319 files, 0 unresolved except the declared cut points. Every path is git-tracked (`git ls-files --error-unmatch` exit 0) and none is an `.env*` file.
- **rsync round-trip.** `rsync --files-from=files.txt` into a scratch dir copied 319 files. Re-running the walker on the copy with no cut list gives 92 unresolved imports, pointing at exactly **28 distinct targets: the 18 stubs + 10 skips listed below. 0 undeclared.**
- **`contracts.ts`** passes `tsc 5.9.3 --strict --noUnusedLocals --noUnusedParameters` standalone.
- **Fixtures, structure.** Both pass as object literals typed against `contracts.ts` (0 errors).
- **Fixtures vs Adcero's real lib types.** Checked against `TrackedCompetitor`, `InsightFact`, `BrandSynthesis`, `CompetitiveLandscapeResponse`, `BrandPresenceStatus`, `BrandPresenceProfile`, `BrandPresenceSource`: 0 errors. Against `BrandIdentityDashboard` the only errors (135) are the `EnrichedAd.angle` type defect in §11.
- **Fixtures, rendering.** Run through Adcero's real pure selectors, every report chapter gets data:
  - identity: positioning + 6 pillars
  - VOC: 4 kinds, every row with a verbatim
  - market formula: 4 steps
  - alignment: non-null
  - personas: 4
  - landscape: 2 competitors
- **Competitor dashboard.** It is the literal output of `computeReplication → buildDashboard → buildWinnerEvaluator` over 64 invented ads: 18 proven winners, 12 angle clusters, and all 7 over-index dimensions with ≥3 tactics clearing `MIN_SAMPLE`. `competitors/list` winner counts sum to the dashboard KPI (5 + 5 + 2 + 6 = 18).
- **PII sweep of the fixtures.** No emails, no `@` handles, no real brand/client names (checked against every client name in the CLAUDE.md docs and every industry-catalog seed keyword and AR id), no real org ids. All domains use the reserved `.example` TLD; media are `placehold.co` placeholders.

**Not verified:** no live run of any Apify actor, LLM call or database. No `next build` or browser render of the copied pages. Everything about runtime behaviour beyond the pure functions above comes from reading the source.

---

## 1. Brand identity resolution

**Flow.** Brand website → `discover-processor` fetches the homepage (plain SSRF-safe fetch, Apify `website-content-crawler` fallback when blocked or under 200 chars). `extractBrandProfile` (LLM) then writes a draft `brand_presence_profiles` row with `brand_name`, `name_variants`, `category` and competitor candidates.

**Competitors.** Each becomes a `tracked_competitors` row:
- **Meta:** a keyword + country, a Page handle, or a numeric Page ID mined from the competitor's homepage by `extractFacebookLinks`, then confirmed by the user.
- **Google:** a pasted AR id.

After the first sync, `meta_page_id` / `google_advertiser_name` are backfilled from the scraped ads (`sync/enrichment.ts`). A handle that returns 0 ads triggers the keyword-scrape Page-ID fallback.

| path | LOC | purpose (entry fns · reads/writes) | verdict | reason | depends on |
|---|---|---|---|---|---|
| `services/ad-library/website-facebook-resolver.ts` | 212 | `extractFacebookLinks(html)` → ranked `{rawUrl, handle, numericId}[]`; `assertPublicHttpUrl(raw)` SSRF pre-check. Pure. | copy as-is | pure | `page-input` |
| `services/ad-library/page-input.ts` | 79 | `parsePageInput(raw)` — FB URL / `@handle` / `profile.php?id=` / numeric → `{handle, numericId}`. Pure. | copy as-is | pure | — |
| `services/ad-library/google-advertiser-input.ts` | 50 | `parseGoogleAdvertiserInput(raw)` — Transparency URL or `AR\d{6,}` → `{advertiserId}`. Manual input only. | copy as-is | pure | — |
| `services/job-processor/ad-library/sync/page-id-resolution.ts` | 205 | `attemptPageIdResolution({db, provider, competitor, signal, timeoutTracker})`. On 0 ads, runs one keyword scrape (limit 30) and exact-matches `pageName`. Writes `tracked_competitors.meta_page_id/meta_page_name/scores.pageIdResolve` (7-day retry window). | copy as-is | runs behind stubs | `SupabaseClient`, Apify provider, `function-timeout` |
| `lib/brand-summary/fetch-website.ts` | 242 | `fetchWebsiteHtml/Content/HtmlAndText`. DNS-validated + pinned on every redirect hop (≤5), 10 s timeout, 500 KB cap, 15k-char text. | copy as-is | self-contained | `video-fetch-utils`, `errors`, `undici` |
| `lib/brand-summary/errors.ts` | 62 | `BrandSummaryError` (code/status/retryable). | copy as-is | pure | — |
| `lib/video-fetch-utils.ts` | 518 | `fetchPinnedRemoteResponse`, `safeFetchRemoteMedia`, `validateSafeRemoteUrl`. Undici `Agent` pinned to the resolved IP. | copy as-is | SSRF safety | `undici`, `lib/security/blocked-address` |
| `lib/security/blocked-address.ts` | 124 | Private / loopback / IPv4-mapped-IPv6 blocklist. | copy as-is | pure | — |
| `services/brand-presence/website-apify-provider.ts` | 331 | `WebsiteApifyProvider.fetchHomepageText` (1 page, playwright:firefox, residential proxy, 90 s) and `startCrawl/getCrawlStatus/collectCrawlPages/abortCrawl` (the brand-object crawl; http tier then browser tier). | copy as-is | — | `apify-config`, `apify-timeout`, `lib/brand-object/config` |
| `services/job-processor/brand-presence/discover-processor.ts` | 355 | `brand_presence_discover`: website → draft profile + seeded `brand_presence_sources` rows (upsert `(brand_profile_id, source_type, uri)`). Writes a degraded draft with `meta.discovery.homepageBlocked` if both fetches fail. | copy as-is | runs behind `Job` + LLM stubs | `SupabaseClient`, `discover-profile`, `website-apify-provider` |
| `lib/brand-presence/discover-profile.ts` | 148 | `extractBrandProfile(text, url)`. Strict json_schema + zod; role `brand_presence` (`gpt-5.4-mini`), temperature 0.2, flex tier. | copy as-is | behind `lib/llm/clients` stub | `lib/llm/*`, `./llm` |
| `lib/brand-presence/llm.ts` | 43 | `getBrandPresenceModel`, `strictResponseFormat`, `decodeChatJson`, `clamp01`. | copy as-is | pure | `lib/llm/model-roles` |
| `lib/brand-identity/countries.ts` | 53 | `DEFAULT_AD_LIBRARY_COUNTRY='US'`, `isSupportedCountry`. | copy as-is | pure | — |
| `app/api/brand-identity/competitors/resolve-website/route.ts` | 88 | POST: website → ≤5 FB page candidates (`fetchWebsiteHtml` + `extractFacebookLinks`). | rewrite (~20 LOC) | `withAfRoute` + org auth | — |
| `app/api/brand-identity/competitors/create/route.ts` | 309 | Creates a `tracked_competitors` row (keyword/page/AR id validation, 23505 adoption). | rewrite (~40 LOC insert) | org/brand-scope + auth plumbing | — |
| `lib/brand-identity/cross-platform.ts` | 290 | Pairs a competitor's Meta and Google rows by dominant landing domain (`scores.landingDomain`). | skip (optional) | only used by the competitor detail page | — |

**Schemas.** `tracked_competitors` (`drizzle/schema.ts:6692`) and `brand_presence_profiles` (`:9081`) are reproduced verbatim in §13.

`tracked_competitors` unique indexes: `(organization_id, meta_page_id)`, `(organization_id, keyword, country)`, `(organization_id, google_advertiser_id)`.

`scores` keys written:
- `adlibCadence`
- `pageIdResolve`
- `brandTypeSuggestion`
- `landingDomain`

---

## 2. Apify ingest

### 2.1 Mechanics common to every actor

- **Start + poll, no webhooks.** Every run is `client.actor(id).start(input)` followed by status-keyed polling of `client.run(id).get()`:
  - `SUCCEEDED` → done
  - `READY`/`RUNNING` → keep waiting
  - anything else → failed (retryable unless `ABORTED`)
  - There is also a blocking `.call()` inside `fetchAds()`, used only by paged/dev paths and the 30-ad Page-ID scrape.
- **Run checkpoint, persisted immediately after start.**
  - Ad library: `tracked_competitors.sync_run_id` / `sync_run_started_at`.
  - Brand presence: `brand_presence_sources.meta.sync = { scopeKey, phase, runId, datasetId, runStartedAt, datasetOffset, … }` (`SourceSyncCheckpoint`).
  - A resume polls the persisted run. Staleness is decided by run state, not by wall clock.
- **Wall-clock ceilings.** Ad-library runs are capped at `MAX_RUN_WALL_MS` = 60 min; brand presence (`run-lifecycle.ts`) at 15 min. Every abandon path calls `abortRun()` first, then fails retryable.
- **Function budget.** `FunctionTimeoutError` (`lib/sync/function-timeout-error.ts`) pauses a job when the serverless budget runs out, and the queue resumes it. Standalone, pass no `timeoutTracker` and runs poll to completion.
- **Control-plane timeouts.** `createApifyClient()` sets `timeoutSecs` = 120 and `maxRetries` = 3. Every SDK call is wrapped in `withApifyTimeout` (120 s; 15 min for the blocking `.call()`).
- **Dataset reads.** `listDatasetItems(datasetId, offset, limit)` uses `clean=true` paging (`datasetPageSize` 250), so ingest resumes mid-dataset.
- **Raw results.** Each page is archived as JSON to R2 bucket `adcero-ad-creatives`. The key is stored as `raw_ref` on the row.
  - Ad library: `ad-library/<org>/<competitor>/<syncIso>-page<N>.json`, or `ad-library/shared/<cacheKey>/…` when the scrape is cache-eligible.
  - Brand presence: `brand-presence/<org>/<profile>/<source>/[<platform>-<phase>-]<startedAt>-page<N>.json`.
  - Best-effort for ingest. Mandatory for the brand-object crawl, where the archive *is* the handoff to identity.
- **Idempotency.**
  - `library_ads` upsert key `(organization_id, platform, external_ad_id)`. The upsert never sends `first_seen_at`.
  - `brand_mentions` merge-upsert on `(brand_profile_id, platform, external_id)`. The higher scope wins (brand > competitor > category); a decided `relevant`/`irrelevant` is never reset; mentions are never deleted.
  - `brand_presence_phrases` on `(mention_id, kind, content_hash)`.
  - Registry tables on `(brand_profile_id, video_id|post_id)`.
  - Jobs: a partial unique index on `job_queue(type, dedupe_key)` while pending/processing, and `enqueue()` resolves a 23505 to the winning row.

### 2.2 Actors (ids verbatim from source)

| # | actor id (constant) | provider · input builder | input set by Adcero (caps) | notes |
|---|---|---|---|---|
| A1 | `XtaWFhbtfxyzqrFmd` = curious_coder/facebook-ads-library-scraper (`APIFY_AD_LIBRARY_ACTOR_ID`) | `services/ad-library/apify-provider.ts` · `apify-config.ts buildApifyActorInput` + `apify-url.ts` | `{urls:[{url}], count, scrapeAdDetails:true, 'scrapePageAds.activeStatus', 'scrapePageAds.countryCode':'ALL', 'scrapePageAds.sortBy':'impressions_desc', 'scrapePageAds.period':''}`. `count` = `APIFY_AD_LIBRARY_MAX_ADS` (default **250**, min **10** — actor floor). URL priority keyword → pageId → handle. | 1st sync `activeStatus:'all'`, then `'active'` (billed per result). |
| A2 | `N8vqwV9wL9wpIsLDz` = silva95gustavo/google-ads-scraper (`APIFY_GOOGLE_ADS_ACTOR_ID`) | `google-apify-provider.ts` · `buildGoogleActorInput` | `{startUrls:[{url:'https://adstransparency.google.com/advertiser/<AR>?region=anywhere'}], resultsLimit: 250, skipDetails:false, ocr:true}` | **Rental actor** — must be rented on the token's account. ~30 min for 250 ads. |
| A3 | `trudax~reddit-scraper-lite` (`REDDIT_SCRAPER_ACTOR_ID`) | `services/brand-presence/reddit-apify-provider.ts` · `reddit-actor-input.ts` | Base `{includeMediaLinks:false, skipUserPosts:true, debugMode:false}`. **Run A** brand search: name variants, posts+comments, `maxItems` 300, then a full-thread pass on stored brand posts (`maxItems` 100). **Run B** per-subreddit: brand+competitor names only, `maxItems` 80. **Run C**: competitor names, `maxItems` 100. Refresh sets `sort:'new'` + date limit, `maxItems` 50. Run memory `BRAND_PRESENCE_REDDIT_RUN_MEMORY_MB` (1024). | Term-containment gate drops items whose raw text doesn't word-boundary-contain a required term before storage; homonym terms pruned (`reddit-term-stats.ts`). |
| A4 | `compass~google-maps-reviews-scraper` | `google-maps-apify-provider.ts` · `google-maps-actor-input.ts` | Always `language:'en'`, **`personalData:false`** (actor defaults true), explicit `maxReviews` (actor defaults 10M). Probe `maxReviews:1`; backfill 100 `lowestRanking`; top-up 50 `highestRanking` only if >100 reviews; refresh 100 `newest` + `reviewsStartDate`. | Wrong-business gate `placeMatchesBrand` at confirm. |
| A5 | `apidojo~twitter-scraper-lite` (`X_SCRAPER_ACTOR_ID`) | `x-apify-provider.ts` · `x-actor-input.ts` | `{searchTerms, sort:'Latest', maxItems, includeSearchTerms:true}`. Two runs: `@handle -from:handle -filter:retweets` (100, refresh 50), then ≤2 quoted name variants (100/50); `since:` injected into the query on refresh. | **Unset `maxItems` = unlimited** on this actor. Every X mention is LLM relevance-gated. |
| A6 | `memo23~trustpilot-scraper-ppe` | `trustpilot-apify-provider.ts` · `trustpilot-actor-input.ts` | Probe `{startUrls:[domain], maxItems:5, includeCompanyDetails/Stats/Transparency:true, expandRegionalDomains:false}` → `www.` retry → search `{searchTerms, maxItems:20}`. Reviews: `backfill_negative` `filterStars:['1','2']` 100 (skipped when ≤100 reviews) → `backfill_full` 100 → refresh 50 + `startDate`. | Slug may include `www.` — exact slug matters. `companyMatchesDomain` gate. |
| A7 | `clockworks~tiktok-profile-scraper` (Hop 1) | `tiktok-apify-provider.ts` `startProfileRun` · `tiktok-actor-input.ts` | Probe `{profiles:[u], resultsPerPage:5, profileSorting:'latest', excludePinnedPosts:false}`; enumeration `resultsPerPage:50`. | Private/not-found → terminal card, job succeeds. |
| A8 | `clockworks~tiktok-comments-scraper` (Hop 2) | same file `startCommentsRun` | `{postURLs (≤10), commentsPerPost: max(1,n), maxRepliesPerComment:3}` (`commentsPerPost` includes replies). | **Output field names unpinned** (normalizer probes candidates). |
| A9 | `apify~instagram-scraper` (one actor, 4 modes) | `instagram-apify-provider.ts` · `instagram-actor-input.ts` | `details` probe (`resultsLimit:1`); `posts`+`reels` enumeration (`resultsLimit:30`, `onlyPostsNewerThan` on refresh); `recheck` (direct post URLs, limit 1); `comments` (`resultsLimit` clamp 1–50; Adcero uses 20). | Output fields pinned live 2026-07-10. |
| A10 | `aYG0l9s7dbB7j3gbS` = apify/website-content-crawler (`WEBSITE_CONTENT_CRAWLER_ACTOR_ID`, overridable by `BRAND_PRESENCE_WEBSITE_ACTOR_ID`) | `website-apify-provider.ts` | Homepage fallback: 1 page, `playwright:firefox`, `RESIDENTIAL` proxy, `saveMarkdown`. Brand-object crawl: `http` tier (cheerio, datacenter, depth 1) then `browser` tier. | Feeds identity distillation. |
| A11 | `axesso_data~amazon-reviews-scraper` | `amazon-apify-provider.ts` | — | **Skipped** (Amazon is not in your source list); needs one-time console approval. |

### 2.3 Two-hop pattern (TikTok, Instagram)

**Hop 1** enumerates the brand's own posts into a registry table: `brand_presence_tiktok_videos` / `brand_presence_instagram_posts`, unique `(brand_profile_id, video_id|post_id)`, holding `comment_count` + `baseline_comment_count`.

**Pure planner** (`tiktok-video-plan.ts`, reused by Instagram) picks which posts to harvest:
- **Backfill:** top-N by comment count ∪ M most recent by `posted_at`, minus posts under the comment floor (TikTok 7 + 3, floor 3, 25 comments; IG 8 + 4, 20 comments).
- **Refresh:** diff-driven. A post is picked when `delta = comment_count − baseline ≥ 5`, with cap `clamp(ceil(delta × 1.5), 10, backfillCap)`.
- **Batches:** ≤10 URLs each.

**Hop 2** harvests comments one batch at a time. A post's baseline advances only after its batch's dataset is fully ingested **and** the post yielded ≥1 item; only then does the batch index advance. The delta-baseline contract is documented in `services/CLAUDE.md`.

**Storage.** Comments land as `relevance='not_required'` (own-profile = ownership gate), with `parent_external_id` = post id and `parent_title` = caption. Owner comments are dropped.

### 2.4 Files

| path | LOC | purpose | verdict | reason | depends on |
|---|---|---|---|---|---|
| `services/ad-library/apify-config.ts` | 141 | Actor ids, `getApifyToken`, `createApifyClient`, `getApifyMaxAds`, input builders. | copy as-is | pure + env | `apify-client` |
| `services/ad-library/apify-timeout.ts` | 46 | `withApifyTimeout(op, promise, ms)` (clears its timer on both paths). | copy as-is | pure | `types` |
| `services/ad-library/apify-url.ts` | 51 | Ad Library search URL builder (keyword/pageId/handle). | copy as-is | pure | `countries` |
| `services/ad-library/apify-provider.ts` | 187 | `ApifyAdLibraryProvider` `fetchAds/startRun/pollRun/abortRun` (Meta). | copy as-is | — | `apify-config`, `apify-normalizer` |
| `services/ad-library/google-apify-provider.ts` | 162 | `GoogleApifyAdLibraryProvider` (same four methods). | copy as-is | — | `google-normalizer` |
| `services/ad-library/index.ts` | 48 | `getAdLibraryProvider('meta'\|'google')` from `AD_LIBRARY_PROVIDER` / `GOOGLE_AD_LIBRARY_PROVIDER`. | **copy + edit** | drop `meta`/`mock` branches (imports skipped files) | — |
| `services/ad-library/scrape-cache.ts` | 455 | Cross-org scrape cache + run claim/adoption. | skip | multi-tenant cost sharing only | — |
| `services/ad-library/ingestion-budget.ts` | 104 | Per-org daily sync cap counted from `job_queue`. | skip | multi-tenant cost control | — |
| `services/ad-library/{meta-provider,mock-provider,google-mock-provider,mock-data}.ts` | 263/80/114/478 | Meta Graph `ads_archive` provider; synthetic providers. | skip | needs Meta token; mocks not needed | — |
| `services/job-processor/ad-library/sync-processor.ts` | 419 | `AdLibrarySyncProcessor.process(job)`. Picks `activeStatus`, runs the lifecycle or paging path, `finalizeSync` (cadence, landing-domain, enqueue label/embed/rehost, market hook). Reads/writes `tracked_competitors`, `library_ads`. | **copy + edit** | remove scrape-cache branches (`isScrapeCacheFresh`) | `sync/*`, queues, providers |
| `services/job-processor/ad-library/sync/fetch-paths.ts` | 403 | `syncViaRunLifecycle` / `syncViaPaging` / `ingestFromScrapeCache`. | **copy + edit** | delete cache claim/adopt/write-through calls and `ingestFromScrapeCache` | `scrape-cache` (skip) |
| `services/job-processor/ad-library/sync/types.ts` | 50 | `CompetitorRow`, `ScrapeCacheContext`, constants. | **copy + edit** | drop the `ScrapeCacheEntry/Ref` type imports | — |
| `services/job-processor/ad-library/sync/persistence.ts` | 401 | `upsertAds` (`NormalizedAd` → `library_ads` row), `storeRawPayload` (R2), run checkpoints, `findUnlabeledAdIds/findUnembeddedAdIds`. | copy as-is | behind `r2-service` stub | `signal-capture`, `embeddings` |
| `services/job-processor/ad-library/sync/enrichment.ts` | 373 | Page/Google identity backfill, brand-type suggestion, industry classification (LLM). | copy as-is | — | `industry-classifier`, `brand-type-classifier` |
| `services/job-processor/ad-library/sync/signal-capture.ts` | 163 | Relaunch + EU-reach history deltas into `library_ads.scores`. | copy as-is | pure + db | — |
| `services/job-processor/ad-library/sync/index.ts` | 6 | Barrel. | copy as-is | — | — |
| `services/job-processor/ad-library/cadence.ts` | 143 | `computeAdlibCadence` (30-day due date). | copy as-is | harmless; you can ignore cadence | — |
| `services/job-processor/ad-library/queue.ts` | 222 | `enqueueAdlibSyncJob`, `enqueueLabelBatches/EmbedBatches/RehostBatches` (sha256 dedupe keys). | **copy + edit** | remove the `assertOrgSyncBudget` call/import | `job_queue` |
| `services/job-processor/ad-library/types.ts` | 42 | Ad-library job payload schemas. | copy as-is | zod | — |
| `services/brand-presence/{reddit,google-maps,x,trustpilot,tiktok,instagram}-apify-provider.ts` | 133/113/115/112/148/119 | Per-actor `startRun`, `getRun`, `abortRun`, `listDatasetItems`. | copy as-is | — | `apify-config`, `apify-timeout` |
| `services/brand-presence/{reddit,google-maps,x,trustpilot,tiktok,instagram}-actor-input.ts` | 283/99/142/131/130/189 | Input builders typed from each actor's live OpenAPI (caps in §2.2). | copy as-is | pure | `config` |
| `services/brand-presence/reddit-term-stats.ts` | 135 | Per-term kill rates → homonym pruning. | copy as-is | pure | — |
| `services/job-processor/brand-presence/reddit-scrape-processor.ts` | 906 | Runs A/B/C, phases, containment gate, mention merge-upsert, R2 archive, then enqueues relevance/extract. | copy as-is | behind stubs | `mention-ingest`, `queue`, `r2-service` |
| `services/job-processor/brand-presence/subreddit-discovery-processor.ts` | 325 | LLM-proposed subreddits verified via actor community search. | copy as-is | — | `subreddit-discovery` |
| `services/job-processor/brand-presence/google-place-processor.ts` | 281 | Maps URL resolve probe + `placeMatchesBrand` + auto-confirm. | copy as-is | — | `confirm-source` |
| `services/job-processor/brand-presence/google-reviews-processor.ts` | 522 | Phases `backfill_low → topup_high → refresh`. | copy as-is | — | — |
| `services/job-processor/brand-presence/trustpilot-resolve-processor.ts` | 412 | Probe ladder `probe → probe_www → search\|degraded`. | copy as-is | — | — |
| `services/job-processor/brand-presence/trustpilot-reviews-processor.ts` | 572 | `backfill_negative → backfill_full → refresh`. | copy as-is | — | — |
| `services/job-processor/brand-presence/x-scrape-processor.ts` | 663 | Handle run, then variants run; gate-everything relevance. | copy as-is | — | — |
| `services/job-processor/brand-presence/tiktok-profile-processor.ts` | 270 | Hop-1 probe → profile card → auto-confirm. | copy as-is | — | — |
| `services/job-processor/brand-presence/tiktok-comments-processor.ts` | 908 | Enumerate → plan → harvest batches → per-video baselines. | copy as-is | — | `tiktok-video-plan` |
| `services/job-processor/brand-presence/instagram-profile-processor.ts` | 274 | Details probe → card → auto-confirm. | copy as-is | — | — |
| `services/job-processor/brand-presence/instagram-comments-processor.ts` | 1083 | `recheck → enumerate_posts → enumerate_reels → harvest`. | copy as-is | over 1,000 LOC — refactor if you modify it | — |
| `services/job-processor/brand-presence/tiktok-video-plan.ts` | 169 | `planTikTokHarvest` (pure planner, shared with IG). | copy as-is | pure | `config` |
| `services/job-processor/brand-presence/run-lifecycle.ts` | 96 | `awaitRunCompletion` (poll every 15 s, 15-min ceiling, abort-before-abandon). | copy as-is | — | `function-timeout` |
| `services/job-processor/brand-presence/confirm-source.ts` | 368 | `confirm{GoogleMaps,Trustpilot,TikTok,Instagram}Source` stamps `confirmedAt`, flips status, enqueues the scrape. | copy as-is | behind `record` stub | `af-error`, `queue` |
| `services/job-processor/brand-presence/queue.ts` | 1030 | All brand-presence enqueues plus extraction eligibility/budgets (`gatherExtractEligibleIds`, `enqueueExtractOrDrainCluster`, `enqueueClusterIfAnalysisDrained`). | copy as-is | keep `job_queue`; over 1,000 LOC | `job_queue` |
| `services/job-processor/brand-presence/types.ts` | 287 | Job type constants + zod payloads. | copy as-is | behind `record` stub | — |
| `services/job-processor/brand-presence/relevance-processor.ts` | 439 | Two-stage relevance cascade over `pending` mentions; writes relevance, thread propagation, generic-name flags. | copy as-is | — | `lib/brand-presence/relevance` |
| `services/job-processor/brand-presence/relevance-finalize.ts` | 276 | Drain-finalize: subreddit auto-promote, straggler sweep, enqueue extract. | copy as-is | — | `queue` |
| `services/job-processor/brand-presence/{sync-source,amazon-*}.ts`, `kickoff-brand-processing.ts` | 525/200/621/50 | Manual-sync dispatch, Amazon, Next `after()` kickoff. | skip | HTTP/cron glue; Amazon out of scope | — |
| `lib/brand-presence/relevance.ts` | 266 | `classifyMentionRelevanceCascaded`: cheap model (`gpt-5.4-mini`) first, then re-judge verdicts in [0.45, 0.9] (or dropped) on `gpt-5.4`; kept only if relevant at ≥ 0.7. | copy as-is | behind LLM stub | `lib/llm/*` |
| `lib/brand-presence/subreddit-discovery.ts` | 259 | LLM subreddit proposal (`gpt-5.4-mini`). | copy as-is | — | — |
| `lib/brand-presence/config.ts` | 395 | `BRAND_PRESENCE_CONFIG`: every cap/threshold in §2.2 plus extract/cluster budgets. | copy as-is | pure | — |
| `lib/brand-presence/{google-maps,trustpilot}.ts` | 129/136 | URL / domain helpers. | copy as-is | pure | — |
| `services/job-processor/function-timeout.ts` | 63 | `createFunctionTimeoutTracker`. | copy as-is | pure | `function-timeout-error` |
| `lib/sync/function-timeout-error.ts` | 16 | `FunctionTimeoutError`. | copy as-is | pure | — |

**Caps and costs** (from source comments):
- Meta: 250 ads per sync; per-result pricing.
- Google: rental.
- Reddit, Maps, Trustpilot (~$0.75/1k), X: per result.
- TikTok: ~$5/1k profile items, ~$1/1k comments.
- Instagram: $2.30/1k results.
- Extraction: ceiling of 1,500 mentions per onboarding, split into per-platform budgets (Reddit 300, each other platform 200).

---

## 3. Normalization

Every normalizer is a **pure** function mapping one raw actor item to a discriminated union: `{kind:'mention'|'review'|'video'|'post', …} | {kind:'skipped', reason}`. The processor then maps the payload onto a `brand_mentions` row. All exact types are in `contracts.ts` §2; the canonical row is `NormalizedSignalRow`.

**Field conventions** (`brand_mentions`):
- `author_ref` is a sha256 of the username; raw identities are never stored.
- `relevance`:
  - `pending` for gated sources (Reddit standalone items, all X)
  - `not_required` for founder-confirmed own-profile sources (Maps, Trustpilot, TikTok, Instagram)
- `extraction_status='skipped'` for short or empty text.

| path | LOC | purpose | verdict | reason | depends on |
|---|---|---|---|---|---|
| `services/ad-library/types.ts` | 164 | `NormalizedAd`, `AdLibraryProvider`, `FetchAdsOptions`, `AdLibraryProviderError`. | copy as-is | pure | — |
| `services/ad-library/apify-normalizer.ts` | 275 | `normalizeApifyAd(raw) → NormalizedAd \| null`:<br>• id = `ad_archive_id`<br>• dates are unix seconds<br>• `snapshot.body.text`, `snapshot.cards[]`<br>• DCO variant sets collapse to the lead card<br>• empty `currency` → null | copy as-is | pure | `landing-domain` |
| `services/ad-library/google-normalizer.ts` | 164 | `normalizeGoogleAd(item, {now})`:<br>• ISO `firstShown`/`lastShown`<br>• active if last shown within 5 days<br>• body from `variations[]`<br>• no reach or spend | copy as-is | pure | `landing-domain` |
| `services/ad-library/landing-domain.ts` | 146 | `extractLandingDomain` (unwraps redirect wrappers, rejects tracker hosts). | copy as-is | pure | — |
| `services/brand-presence/reddit-normalizer.ts` | 210 | `normalizeRedditItem`, `containsNameVariant`. | copy as-is | pure | `oauth-state` (sha256), `html-entities` |
| `services/brand-presence/google-maps-normalizer.ts` | 173 | `normalizeGoogleReviewItem`, `extractPlaceMetaFromItem`, `placeMatchesBrand`. | copy as-is | pure | — |
| `services/brand-presence/x-normalizer.ts` | 189 | `normalizeXItem` (drops retweets and brand-authored; non-safe-integer ids rejected). | copy as-is | pure | `config` |
| `services/brand-presence/trustpilot-normalizer.ts` | 290 | `normalizeTrustpilotReviewItem`, `extractCompanyFromItem`, `companyMatchesDomain`. | copy as-is | pure | `trustpilot` |
| `services/brand-presence/tiktok-normalizer.ts` | 374 | Videos (Hop 1) + comments (Hop 2, probes candidate fields), `classifyProbeOutcome`. | copy as-is | pure | `config` |
| `services/brand-presence/instagram-normalizer.ts` | 364 | Posts/reels + comments (`postUrl` attribution), probe outcome. | copy as-is | pure | `instagram-actor-input` |
| `lib/brand-presence/types.ts` | 964 | All brand-presence enums and row types (`BrandMention`, `MentionTags`, `MentionExtraction`, checkpoints, source meta). | copy as-is | pure | — |
| `lib/brand-presence/html-entities.ts` | 59 | Entity decoding. | copy as-is | pure | — |
| `lib/crypto/oauth-state.ts` | 16 | `hashValue` (sha256 of `author_ref`) and the OAuth-state hash; only `hashValue` is used here. | copy as-is | pure (`node:crypto`) | — |
| `services/job-processor/brand-presence/mention-ingest.ts` | 145 | Pure ingest state machine: `contentScope`, `requiredTermsForPhase`, `decideMention`, `mergeScope`, `mergeRelevance`. | copy as-is | pure | — |
| `lib/brand-presence/extract.ts` | 361 | `extractMentionSignals(card, mentions)` → per mention: sentiment, pains, desires, objections, praise, `quotes[]` (exact-substring validated), insight. Role `brand_presence_extract` (`gpt-5.4-mini`), batches of 20, flex tier. | copy as-is | behind LLM stub | — |
| `services/job-processor/brand-presence/extract-processor.ts` | 406 | Writes `brand_mentions.tags.insight`, `.extraction`, `brand_presence_phrases` (+ `text-embedding-3-small` vectors), then drains to cluster. | copy as-is | — | `embeddings`, `queue` |
| `lib/brand-presence/themes.ts` | 227 | Theme partitions, adaptive UPGMA over phrase embeddings. | copy as-is | pure | `lib/brand-identity/clustering` |
| `lib/brand-presence/theme-grouping.ts` | 143 | Small-partition (≤28 phrases) LLM grouping (`gpt-5.4-mini`). | copy as-is | — | — |
| `lib/brand-presence/theme-labels.ts` | 110 | Batched theme labelling (`gpt-5.4-mini`). | copy as-is | — | — |
| `lib/brand-presence/theme-merge.ts` | 183 | Synonym-merge refinement (`gpt-5.4-mini`). | copy as-is | — | — |
| `services/job-processor/brand-presence/cluster-processor.ts` | 393 | Rebuilds `brand_presence_themes` per brand (insert new run → repoint phrases → delete old run), then hooks the brand-object promote. | **copy + edit** | remove the `translateClusteredThemes` call (skipped i18n file) | `themes*`, `brand-object/queue` |
| `lib/brand-presence/theme-translation.server.ts` | 387 | Translates theme labels for other locales. | skip | i18n, ~2.1k LOC transitive | — |

---

## 4. Distillation (Layer 3, the "Brand Object")

**Pipeline.** Opt-in per brand: no `brand_object_state` row means no hook fires. Each stage enqueues the next when `chain:true`, and every stage re-chunks.
- **crawl** — website-content-crawler, http tier then browser tier; pages archived to R2 (`brand-object/<org>/<profile>/crawl/…`) as the handoff.
- **identity** — one LLM call. Each claim survives only if its source sentence is an **exact substring of a crawled page**.
- **promote** — zero-LLM. VOC themes → `voc_*` facts.
- **market** — zero-LLM. Winner-gated competitor ad labels → `market_prior` facts. One vote per UPGMA message family.
- **personas** — one LLM call. 2–4 personas grounded in fact ids, plus an "unaware" projection.
- **chunks** — one chunk per live fact, embedded.

**Append-only versioning (`brand_facts`).**
- A row is live while `valid_to IS NULL`, enforced by the partial unique index `(brand_profile_id, section, fact_key) WHERE valid_to IS NULL`.
- Supersede stamps `valid_to` on the old row **first**, then inserts the new row with `previous_version_id`. Rows are never deleted.
- Point-in-time read: `loadBrandFactsAsOf(T)` = `valid_from <= T AND (valid_to IS NULL OR valid_to > T)`.
- PostgREST `.upsert()` can't target a partial index, so writes select first and then branch.

**Reconciler rules** (`reconciler.ts`; candidate keyed `section:factKey`):
1. Key was rejected → no-op.
2. No live fact → insert.
3. Same statement (case- and whitespace-insensitive) → refresh metrics/evidence in place.
4. Live fact is **confirmed** → write a `brand_fact_suggestions` row *and* refresh metrics. A founder-confirmed fact is never auto-superseded.
5. Candidate confidence ≥ live → supersede.
6. Otherwise → refresh metrics (`kept_live`).

Machine confidence is always <1.0; 1.0 = founder-stated.

**Fact identity** (`fact-key.ts`): match by centroid cosine ≥0.75 (greedy, each key claimed once). Slug match is a fallback only when a vector is missing. Otherwise mint a new slug.

**Embedding:** `text-embedding-3-small`, **1536 dims** (`services/ad-library/embeddings.ts`), stored as a pgvector text literal. There is **no ANN index and no SQL cosine**: `retrieveBrandSlice` loads the brand's chunks and ranks in JS.

**The retrieval door** — `retrieveBrandSlice(db: SupabaseClient, req: BrandSliceRequest): Promise<BrandSlice>`. Full types are in `contracts.ts` §3.
- **Request:** `{organizationId, brandProfileId, sections?, personaKey?, awarenessStage?, query (required), k? (default 8, max 24)}`.
- **Score:** `cosine × (0.6 + 0.4 × confidence)`, one chunk per fact.
- **Filters:** persona/stage pass when NULL or matching.
- **Compliance:** every live compliance fact is always appended, never counted against `k`.
- **Returns:** `{facts: RetrievedFact[], complianceFacts, provenanceFactIds, meta:{retrievedAt}}`.

Bulk read: `loadLiveBrandFacts(db, {organizationId, brandProfileId}) → InsightFact[]`.

**Prompts and models:**

| step | prompt file(s) | model (role → env → default) |
|---|---|---|
| identity | system prompt inline in `lib/brand-object/identity/pack.ts` (≈L49–59); strict schema `identity/prompt.ts`; verify `identity/verify.ts` | `brand_object_identity` → `BRAND_OBJECT_IDENTITY_MODEL` → **gpt-5.4**, temperature 0.2, flex |
| personas | system prompt inline in `lib/brand-object/personas/pack.ts` (≈L58–87); schema + gates `personas/prompt.ts`; user suffix in `personas-processor.ts` | `brand_object_personas` → `BRAND_OBJECT_PERSONA_MODEL` → **gpt-5.4**, temperature 0.3, flex |
| promote, market | — | none (zero-LLM) |
| chunks / persona keys / retrieval query | — | `text-embedding-3-small` (constant `EMBEDDING_MODEL`) |
| AI narrative (Chapter 02) | `lib/brand-object/synthesis/prompt.ts` | `brand_object_synthesis` agent profile → `openai/gpt-5.4` — **skipped** (see below) |

**Budget.** `assertBrandObjectBudget` caps LLM calls per brand per month (`BRAND_OBJECT_MONTHLY_LLM_CALL_CAP`, default 60) and throws non-retryable when exceeded. Identity has a fingerprint + 7-day cooldown, personas a fingerprint + 24 h cooldown.

| path | LOC | purpose | verdict | reason | depends on |
|---|---|---|---|---|---|
| `services/job-processor/brand-object/crawl-processor.ts` | 344 | `brand_object_crawl`: tiered crawl, run checkpoint in `cursors.crawl`, R2 page archive, content hash. | copy as-is | behind `r2-service` stub (needs a real download for identity — see §8.2) | `website-apify-provider`, `state`, `queue` |
| `services/job-processor/brand-object/identity-processor.ts` | 351 | `brand_object_identity`: reads crawl pages + own-ad copy, one LLM call, verify, reconcile, retire stale candidates. | copy as-is | behind `connected-scope` stub (→ no own-ad copy) | `identity/*`, `reconciler`, `fact-writer` |
| `services/job-processor/brand-object/promote-processor.ts` | 461 | `brand_object_promote`: themes + phrases + mentions → `voc_*` facts; race guard on `cluster_run_id`. | copy as-is | zero-LLM | `promotion`, `fact-key` |
| `services/job-processor/brand-object/market-processor.ts` | 334 | `brand_object_market`: `library_ads_enriched` + `ad_embeddings` → `market_prior` facts (needs ≥5 winners). | **copy + edit** | fix the 1000-row truncation at L249 (see §11.1) | `market`, `fact-writer` |
| `services/job-processor/brand-object/personas-processor.ts` | 244 | `brand_object_personas`: one LLM call, validate, persona keys, reconcile. | copy as-is | — | `personas/*`, `persona-keys` |
| `services/job-processor/brand-object/chunks-processor.ts` | 140 | `brand_object_chunks`: delete stale chunks, insert missing, embed in waves of 500. | copy as-is | — | `chunks`, `embeddings` |
| `services/job-processor/brand-object/fact-writer.ts` | 268 | `loadLiveFacts`, `executeReconcilePlan` (stamp-then-insert), `retireFacts`, suggestion dedupe. | copy as-is | — | `brand_facts`, `brand_fact_suggestions` |
| `services/job-processor/brand-object/state.ts` | 209 | `brand_object_state` cursors, budget meter. | copy as-is | — | — |
| `services/job-processor/brand-object/queue.ts` | 341 | Six enqueues + `maybeEnqueuePromoteAfterCluster` / `maybeEnqueueMarketAfterAdlibSync` hooks. | copy as-is | keep `job_queue` | `state` |
| `services/job-processor/brand-object/persona-keys.ts` | 65 | Embedding-keyed persona identity. | copy as-is | — | `embeddings` |
| `services/job-processor/brand-object/types.ts` | 85 | `BRAND_OBJECT_JOB_TYPES` + zod payloads. | copy as-is | pure | — |
| `lib/brand-object/{types,config,reconciler,fact-key,promotion,market,chunks,completeness,voc-rank,voc-verbatim,quote-language,execution-notes,freshness}.ts` | 216/138/122/125/255/368/80/84/24/187/144/68/119 | Pure distillation logic (rules above). `config.ts` reads one env var. | copy as-is | pure | `lib/brand-identity/{clustering,win-score,win-profile}` |
| `lib/brand-object/identity/{pack,prompt,verify}.ts` | 100/89/126 | Identity prompt pack, strict schema, substring verification. | copy as-is | pure | `lib/brand-presence/llm` |
| `lib/brand-object/personas/{pack,prompt,identity,verbatim-rank}.ts` | 115/270/125/182 | Persona prompt pack, schema + grounding gates, identity texts, verbatim scoring. | copy as-is | pure | — |
| `lib/brand-object/retrieval/{service,rank}.ts` | 183/81 | `retrieveBrandSlice` + `rankChunks`. | copy as-is | — | `embeddings` |
| `lib/brand-object/live-facts.ts` | 82 | `loadLiveBrandFacts`, `loadBrandFactsAsOf`. | copy as-is | — | `insights` (type) |
| `services/ad-library/embeddings.ts` | 107 | `EMBEDDING_MODEL`, `embedTexts` (batches of 96), `primaryBody`, `contentHashFor`, pgvector literal helpers. | copy as-is | behind `lib/llm/clients` stub | — |
| `lib/llm/{model-roles,flex,errors}.ts` | 155/73/44 | `modelForRole`, `flexServiceTier`, `LlmProviderError`. | copy as-is | no repo imports | — |
| `lib/llm/task-runner/{json,types}.ts`, `lib/llm/task-types.ts` | 47/61/185 | `parseJsonObject` (used by suggest-competitors) + types. | copy as-is | type import from `clients` stub | — |
| `lib/af/af-error.ts` | 88 | `AfError` `{code, reason, remediation}` (thrown by confirm-source). | copy as-is | pure | — |
| `lib/brand-object/synthesis/{service,synthesize,prompt,pack,translation,flags,index}.ts` | 424/70/139/162/44/36/12 | AI Brand Narrative (Chapter 02): agent model profile, usage meter, i18n. | skip | heavy agent/i18n coupling; replace with one `openAIChatCompletion` call over `synthesis/pack.ts` if you want it. Fixture ships a static narrative. | — |
| `lib/brand-object/synthesis/types.ts` | 172 | `BrandSynthesis` types (UI needs them). | copy as-is | types only | `i18n/config` |
| `lib/creative-engine/brand-context/{service,ingest,compile}.ts` | 456/640/445 | `brand_context_rows` / `brand_context_packs`: a one-way copy of live facts into the Creative Engine's versioned store, compiled to fingerprinted packs. | skip | consumer layer, not distillation; schemas in §13 | — |

**`brand_context_rows` / `brand_context_packs`.**
- Rows are versioned by `row_id`. The latest has `superseded_at IS NULL`, enforced by a partial unique index.
- `content_hash` is sha256 over `{content, priority, tagFilters}`, so an unchanged re-promotion writes nothing.
- `row_type ∈ fact|voice|rule|asset|persona`.
- Packs are keyed by a 64-hex sha256 of the compiled pack (`compiler_version` + `pack` jsonb).
- If your new agent crew wants a frozen, versioned context bundle, this is the model to copy later. `retrieveBrandSlice` already serves the query-shaped read.

---

## 5. Competitor intelligence

### 5.1 Discovery
`suggestCompetitors(homepageText, url, {count=12, exclude})` returns `{industry, description, competitors:{name, website}[]}`.
- **Model:** role `suggest_competitors` → `BRAND_IDENTITY_SUGGEST_MODEL` → `gpt-5.4-mini`; `json_object` (not strict), temperature 0.5.
- **Prompts:** in the same file.

The industry classifier `suggestIndustry` runs at sync-finalize:
- **Model:** `industry_classifier` → `ADLIB_INDUSTRY_MODEL` → `gpt-4o-mini`.
- **Gate:** if confidence <0.6, `industry` stays null, and that competitor gets the universal angle list.

### 5.2 Labelling (`ad_labels`, taxonomy v3)
`AdLibraryLabelBatchProcessor` (`adlib_label_batch`). Per ad it writes:
- the labels: hook_archetype, angle (+ `angle_universal`), persona (+ `persona_universal`), funnel_stage, format, offer_type
- creative fields: style, `aspect_ratio` (deterministic, from poster dimensions via sharp), `fingerprint` jsonb, `hook_text` (verbatim), summary, confidence
- provenance: model, plus `tags.taxonomyVersion = 3`

**Vision + text.**
- Every ad with a poster gets its **own** single-ad OpenAI call: data-URL image at `detail:'low'`, ≤4 MB, 10 s fetch.
- Posterless ads share one batched text call.
- Strict `json_schema` (every key required); enums come from the competitor's industry vocabulary.
- Model: `ad_label` → `ADLIB_LABEL_MODEL` → **`gpt-6-luna`** (reasoning effort none).
- **Video ads** (and all-video carousels) go through Gemini first: `ad_video_label` → `ADLIB_VIDEO_LABEL_MODEL` → `gemini-2.5-flash`. Inline mp4 ≤18 MB or a YouTube URI, 150 s deadline, worker pool of 3 (`ADLIB_VIDEO_LABEL_CONCURRENCY`).

**Deterministic guards** (`label/parse.ts`, `label/rows.ts`):
- an angle or persona outside the vocabulary drops the item
- `carousel_*` formats require ≥2 static image cards, else `other`
- `offer_type:'none'` is stored as NULL
- style/fingerprint are nulled without visual context

### 5.3 Embeddings and clustering
**Embedding** (`adlib_embed_batch`): one `text-embedding-3-small` 1536-d vector per ad, from `primaryBody`, into `ad_embeddings`. Skipped when model + `content_hash` are unchanged; copyless ads get none.

**Clustering is computed at read time and never stored** (`lib/brand-identity/clustering.ts`). `clusterByCosine` works per competitor:
1. Drop vectors from a different embedding model.
2. **UPGMA** average-linkage merge into message families while mean cosine ≥ **0.75** (`VARIATION_COSINE`).
3. **Union-find** near-duplicate buckets at ≥ **0.95** (`DUPLICATE_COSINE`) inside each family.

Results:
- `clusterId` = the smallest ad id in the family.
- `replicationScore` = the number of distinct duplicate buckets.
- **Replication** (used in the win score and the UI) = family size (`buildClusterSizeIndex`).
- `clusterFamiliesAdaptive` is the same UPGMA with an adaptive stop, used for VOC themes.

### 5.4 Winner gating

**Score.** `computeWinScore(ad, clusterSize, profile)` uses absolute curves (`win-score-constants.ts`):
- longevity: `min(days, cap)/cap`
- replication: `log2(size)/log2(128)`
- EU reach: `log10(reach/100)/log10(1e6/100)`
- weights: 0.4/0.4/0.2 for EU-reach ads, 0.5/0.5 otherwise
- stopped ads are divided by 1.15

**Winner** (`buildWinnerEvaluator`, `win-profile.ts`): the ad clears the profile floor **and** sits at or above the **P75** (`relativeQuantile 0.75`) of its **cohort = platform × surface × competitor**. Below 10 ads in the cohort, the floor alone decides.

| profile (key) | mode | floor | must be active | longevity basis |
|---|---|---|---|---|
| `meta` | relative | `META_RELATIVE_FLOOR_DAYS` = 30 | yes | `longevity_days` |
| `google:visual` / `google:text` | relative | 14 d | no (Google `is_active` is inferred) | `num_served_days ?? longevity_days` |
| `neutral` (TikTok/other) | absolute | 60 d (`WINNER_MIN_DAYS`) | yes | `longevity_days` |

`longevity_days` and `is_active` come from the **`library_ads_enriched` view** (SQL verbatim in §13): `is_active = delivery_stop IS NULL AND last_seen_at > now() − 32 days`. If you skip Postgres, port it to a TS `enrich(row)`; the expression is 3 lines.

### 5.5 Files

| path | LOC | purpose | verdict | reason | depends on |
|---|---|---|---|---|---|
| `lib/brand-identity/suggest-competitors.ts` | 199 | `suggestCompetitors`. | copy as-is | behind LLM stub | `lib/llm/*` |
| `lib/brand-identity/industry-classifier.ts` | 153 | `suggestIndustry`. | copy as-is | behind LLM stub | — |
| `lib/brand-identity/brand-type-classifier.ts` | 107 | `suggestBrandType` (advisory, never auto-committed). | copy as-is | pure | — |
| `services/job-processor/ad-library/label-processor.ts` | 562 | `AdLibraryLabelBatchProcessor` (sibling copy → groups → calls → parse → upsert per group). | **copy + edit** | remove `translateAdLabelSummaries` (skipped i18n) | `label/*`, `video-label` |
| `services/job-processor/ad-library/label/{prompt,parse,rows,media,types,sibling-copy,index}.ts` | 228/125/79/207/54/219/6 | System prompt + strict schema + planner; zod gate + guards; row builder; poster fetch + aspect ratio; types; cross-org label reuse (inert single-tenant). | copy as-is | — | `sharp`, `label-taxonomy`, `industry-taxonomy` |
| `services/job-processor/ad-library/video-label.ts` | 182 | `labelVideoAd` (Gemini, prompt-enforced JSON → same parse gate). | copy as-is | behind `gemini` stub | `@google/genai` (types) |
| `services/job-processor/ad-library/video-context.ts` | 141 | `fetchVideoPart` (inline mp4 / YouTube URI), mp4 duration. | copy as-is | — | `video-fetch-utils` |
| `services/job-processor/ad-library/embed-processor.ts` | 213 | `adlib_embed_batch` (+ sibling vector copy). | copy as-is | — | `embeddings` |
| `services/job-processor/ad-library/rehost-processor.ts` | 288 | Copies expiring CDN media to R2. | skip | R2-only; use raw `media_urls` (they expire) or write your own copier | — |
| `services/ad-library/label-taxonomy.ts` | 193 | All closed enums (§6). | copy as-is | pure | — |
| `services/ad-library/near-duplicates.ts` | 58 | Exact-text near-duplicate grouping. | copy as-is | pure | — |
| `lib/brand-identity/{industry-taxonomy,industry-vocabulary,industries}.ts` | 172/677/105 | Industry angle/persona vocabularies, universal mapping, 16 industry keys. `industries.ts` also hard-codes the industry-catalog seeds (`INDUSTRY_CATALOG_ORG_ID`). | copy as-is | pure | — |
| `lib/brand-identity/clustering.ts` | 318 | UPGMA + union-find; cosine. | copy as-is | pure | — |
| `lib/brand-identity/signals.ts` | 516 | `computeReplication`, scaling signals, longevity distribution. | copy as-is | pure | — |
| `lib/brand-identity/dashboard.ts` | 498 | `buildDashboard`, `buildWinnerEvaluator`, `computeScopedStats`, over-index, breakdowns, angle clusters. | copy as-is | pure | — |
| `lib/brand-identity/{media-quadrants,win-profile,win-score,win-score-constants,longevity,landing-pages,math,labeling,relative-time,creative-text,desk}.ts` | 254/217/214/52/30/312/17/30/20/85/294 | Over-index core, winner profiles and score, landing-page ranking, helpers; `desk.ts` is a type import of `types.ts`. | copy as-is | pure | — |
| `lib/brand-identity/types.ts` | 592 | `EnrichedAd(Row)`, `TrackedCompetitor`, dashboard types, `serializeEnrichedAd`. | copy as-is | pure; **`EnrichedAd.angle` is mistyped — §11.2** | `label-taxonomy` |
| `app/api/brand-identity/dashboard/route.ts` + `shared/helpers.ts` | 165 + 229 | `fetchAllEnrichedAdRows` (1000-row paging) → `loadAdVectors` → `computeReplication` → `buildDashboard` → serialize. | rewrite (~25 LOC) | auth, org, cache | — |
| `app/api/brand-identity/competitors/list/route.ts` | 164 | Per-competitor `adCount/labeledCount/activeCount/winnerCount` with ONE evaluator over all rows. | rewrite (~25 LOC) | auth, job status | — |

**The rewrite**, mirrored exactly by the fixture generator:

```ts
const rows = await fetchAllEnrichedAdRows(db, { organizationId, competitorId, platform }); // page by 1000, order by id
const vectors = await loadAdVectors(db, organizationId, rows.map(r => r.id));         // Map<id,{vector, embeddingModel}>
const replication = computeReplication(rows, vectors, EMBEDDING_MODEL);
const d = buildDashboard(rows, replication, competitorNames, { gridLimit: 24, clusterLimit: 12 });
return { scope: { competitorId, totalAds: rows.length, labeledAds: rows.filter(r => r.hook_archetype).length,
                  activeAds: rows.filter(r => r.is_active).length, provenWinners: d.provenWinners, embeddedAds: vectors.size },
         winners: d.winners.map(w => ({ ...w, ad: serializeEnrichedAd(w.ad) })), overIndex: d.overIndex,
         breakdowns: d.breakdowns, mediaQuadrants: d.mediaQuadrants,
         angleClusters: d.angleClusters.map(c => ({ ...c, members: c.members.map(m => ({ ...m, ad: serializeEnrichedAd(m.ad) })) })),
         exampleAds: d.exampleAds.map(serializeEnrichedAd) };
```

### 5.6 The two "known issues"

Neither name exists in the repo. These are the closest real behaviours, with their status at this commit:

- **Taxonomy leakage — partly mitigated, not fixed.**
  - (a) `lib/brand-object/market.ts:77` extracts `ad.angle ?? ad.angleUniversal`. Market priors therefore mix an industry token with a universal one under one `angle` key, and a pool of competitors from different industries mixes vocabularies.
    - Mitigations: brand-scoped competitor tags (migration 0134); the sibling-label copy requires an equal industry (`label/sibling-copy.ts`); the parse gate drops out-of-vocabulary angles (`label/parse.ts`).
  - (b) **New finding from this export:** Adcero's `EnrichedAd.angle` is typed as the 8 universal values while the API returns industry tokens, and `angle_universal` is missing from the type (§11.2).
- **Offer — no extractor exists. Labeller accuracy improved; downstream gaps remain.**
  - Offers come only from the labeller's `offer_type` (`'none'` → NULL, so market priors count only ads that carry an offer).
  - Labeller `offer_type` accuracy moved from 69.2% (gpt-4o-mini) to **80.8%** (gpt-6-luna) on n=52 (`tasks/benchmarks/ad-label-2026-10/report.md:26`, commit `b2f033374`).
  - The creative engine's offer experiment (E26) is pre-registered but unrun.
  - The Creative Studio "has an offer fact" gate is a regex over fact statements (`app/api/creative-studio/briefs/brief-helpers.ts:97`), so brands without that wording read as offer-less.

---

## 6. Closed enums

All values are pasted verbatim into `contracts.ts` §1–§3, with the source file noted in each comment. Primary sources:

| enum | file | values |
|---|---|---|
| `HOOK_ARCHETYPES` | `services/ad-library/label-taxonomy.ts` | problem_callout, bold_claim, question, social_proof, curiosity, offer_led, demo, testimonial, comparison, story_narrative, statistic, pov_relatable, other |
| `ANGLES` (= `angle_universal` values) | same | pain_relief, convenience, price_value, status, health, time_saving, trust_safety, other |
| `FORMATS` | same | ugc, studio, text_overlay_static, meme, founder_talking, product_demo, before_after, carousel_listicle, testimonial_review, social_screenshot, us_vs_them, press_advertorial, tutorial_howto, unboxing, lifestyle_static, product_only_static, carousel_product_set, other |
| `OFFER_TYPES` | same | discount, free_shipping, bundle, trial, guarantee, bogo_gwp, urgency_limited, financing, giveaway, subscribe_save, none (`none` stored as NULL) |
| `PERSONAS` (= `persona_universal` values) | same | parents_family, young_adults, professionals, midlife_adults, seniors, general_broad, other |
| `FUNNEL_STAGES` | same | tof_problem, mof_solution, bof_offer, other |
| `VISUAL_STYLES` ("styles") | same | lo_fi_ugc, polished_studio, designed_graphic, screen_capture, cinematic, meme_style, other |
| `TONES` / `SETTINGS` / `PACINGS` / `DURATION_BUCKETS` / `ASPECT_RATIOS` | same | humorous, aspirational, educational, fear_urgency, heartfelt, plain_promotional, other / home, studio, outdoor, digital, other / static, slow, fast / lt15, 15_30, 30_60, gt60 / 9:16, 4:5, 1:1, 16:9, other |
| `LABEL_TAXONOMY_VERSION` | same | `3` |
| `INDUSTRY_ANGLES`, `INDUSTRY_PERSONAS` (per-industry `angle`/`persona` tokens) | `lib/brand-identity/industry-vocabulary.ts` L20–L397 | 16 industries. Each angle list gets `price_value`, `trust_safety`, `other` appended; each persona list gets `general_broad`, `other`. Example — food: taste_indulgence, health_nutrition, convenience, natural_clean, craving, dietary_fit / busy_parents, health_conscious_eaters, snackers_cravers, diet_specific_shoppers, foodies, meal_preppers. Industry → universal via `universalAngleFor` / `universalPersonaFor` (`industry-taxonomy.ts`). |
| industries | `lib/brand-identity/industries.ts` | accessories, automotive, beauty, jewelry, shoes, clothing, electronics, sport, food, gaming, health, home, pets, software, books, services |
| `AWARENESS_STAGES` | `lib/brand-object/types.ts` | unaware, problem_aware, solution_aware, product_aware, most_aware |
| `BRAND_SECTIONS` | same | positioning, value_prop, usp, proof_point, voice, compliance, voc_pain, voc_desire, voc_objection, voc_praise, competitor_intel (no writer), market_prior, performance_prior, persona |
| mention enums | `lib/brand-presence/types.ts` | platforms reddit, amazon, google_maps, x, trustpilot, tiktok, instagram · data types post, comment, review · scopes brand, competitor, category · relevance pending, relevant, irrelevant, not_required · theme kinds pain, desire, objection, praise |

**Area 6 files**

| path | LOC | purpose | verdict | reason | depends on |
|---|---|---|---|---|---|
| `services/ad-library/label-taxonomy.ts` | 193 | HOOK_ARCHETYPES, ANGLES, FORMATS, OFFER_TYPES, PERSONAS, FUNNEL_STAGES, TONES, DURATION_BUCKETS, VISUAL_STYLES, ASPECT_RATIOS, SETTINGS, PACINGS, AdFingerprint, LABEL_TAXONOMY_VERSION. | copy as-is | pure; single source of truth | — |
| `lib/brand-identity/industry-vocabulary.ts` | 677 | INDUSTRY_ANGLES / INDUSTRY_PERSONAS per industry (+ labels). | copy as-is | pure; single source of truth | — |
| `lib/brand-identity/industry-taxonomy.ts` | 172 | getAngleVocabulary / getPersonaVocabulary, universalAngleFor / universalPersonaFor, isKnownAngle. | copy as-is | pure; single source of truth | — |
| `lib/brand-identity/industries.ts` | 105 | 16 industry keys + catalog seeds. | copy as-is | pure; single source of truth | — |
| `lib/brand-object/types.ts` | 216 | BRAND_SECTIONS, AWARENESS_STAGES, FACT_SOURCES, statuses, EvidenceRef, FactMetrics. | copy as-is | pure; single source of truth | — |
| `lib/brand-presence/types.ts` | 964 | MENTION_* enums, THEME_KINDS, PHRASE_KINDS, source types/statuses. | copy as-is | pure; single source of truth | — |

---

## 7. Frontend: the two pages

### 7.1 Routes

| page | route | file | notes |
|---|---|---|---|
| Brand Identity report | `/brand-identity` | `app/brand-identity/page.tsx` (130) | `'use client'`. Old `/brand-identity/brand` is a 308 redirect stub. |
| Competitor Analysis | `/brand-identity/competitor-analysis` | `app/brand-identity/competitor-analysis/page.tsx` (192) | `'use client'`. Default overview = **Signal** (`components/brand-identity/signal/`); the classic overview is a rollback path and is removed in §8.3. |

**Parent chain**, and what the new app needs from it:
- **`app/layout.tsx`** sets `<html class="dark" data-theme="dark">`, the font variables, `globals.css` and `NextIntlClientProvider`. **Needed** (rewrite as the shell in §7.6).
- **`app/route-shell-boundary.tsx`** → **`authenticated-app-shell.tsx`** → **`app/providers.tsx`** carry the auth wall, `QueryClientProvider`, `OrganizationProvider` and toasters. **Drop** all of it. Keep only a `QueryClientProvider`, the org stub provider and one sonner `<Toaster/>`.
- **`components/app-layout-content.tsx`** is the sidebar / mobile nav / billing banners. **Drop**. Its main-column classes are `flex-1 min-w-0 bg-background text-foreground`; the `md:pl-44` sidebar offset no longer applies.
- **`app/brand-identity/layout.tsx`** (16) adds the namespaces `BrandIdentity`, `BrandPresence`, `BrandReport`, `Dashboard.change`, and **`brand-identity-layout-client.tsx`** (265) adds the header, tabs, Export/Build actions and the competitor filter slot. **Rewrite** as the minimal shell (user decision). The competitor page renders its filters inline when no slot provider exists, and `competitor-filter-slot.tsx` is copied so you can keep the slot.
- **`app/brand-identity/navigation.ts`** (268) holds the tab tables and header copy keys. **Copied**.

### 7.2 Component tree, Brand Identity page

```
app/brand-identity/page.tsx  (hooks: useOrganization*, useBrandIdentityScope, useCreativeStudioEnabled*, useBrandObjectStatus({poll}), useBrandFacts, useBrandBuildSettleRefresh; gate isDistilledReportEnabledForOrg* → treatment)
├─ ui/skeleton · ui/frost-panel (.panel-frost) · ui/button (cva + Slot)
├─ brand-object/insights/BrandBuildProgressCard   { status: BrandObjectStatusView | null }  → ui/progress
├─ brand-object/insights/GenerateCreativesCta     { brandReady; studioEnabled; brandProfileId? } → ui/eyebrow-chip, ui/status-pill
└─ brand-object/insights/BrandInsightsDashboard   BrandInsightsDashboardProps (contracts.ts)
     hooks: useCompetitors, useBrandPresenceSources, useBrandSynthesis, useRunBrandSynthesis, useOwnAdAngles, useOwnPerformance,
            useBrandIdentityScope, useCompetitiveLandscape, useLocaleFormatters, useLocalizeError
     selectors: lib/brand-object/insights.ts (identityClaims, topVocBySection, priorsByDimension, marketFormula, personaCards, tailChapterNumbers),
                alignment.ts brandAlignment, dashboard.ts computeScopedStats, own-performance.ts, demo-own-*.ts
     ├─ IdentityRail { brandName, websiteUrl, positioning, voice, mentionsKept, l1, personaCount, hasAlignment?, hasPerformance?, hasLandscape? } (brand-logo.ts favicon)
     ├─ ChapterHeader { number; title; action?; className? }
     ├─ 01 IdentityHeroPanel { pillars; treatment? } → EvidenceDisclosure { claim }
     ├─ 02 BrandNarrativePanel { synthesis; staleness; translated?; isLoading; generating; onGenerate; treatment? } → narrative-figures, narrative-evidence, i18n/AiTranslatedBadge
     ├─ 03 VocReportPanel { rowsBySection; listening?; building?; treatment? } → report-copy
     ├─ 04 MarketFormulaHeadline { steps } + MarketPlaybookPanel { dimensions; identity; building; competitors?; treatment? } → freshness
     ├─ 05 AlignmentHeadline + AlignmentMapPanel { alignment; treatment? } → alignment-copy          (renders when brandAlignment ≠ null)
     ├─ 06 PersonaLadderHeadline + PersonaStrip { personas; treatment? } → AwarenessFrameworkDialog (ui/dialog), PersonaSignalChip, persona-signal
     ├─ 07 OwnPerformanceHeadline + OwnPerformancePanel { model; treatment? } → own-performance-format    (hidden when own-performance 404s)
     └─ 07/08 LandscapeHeadline + CompetitiveLandscapePanel { landscape; treatment? } → section-tone, brand-presence/{channel-style,presence-role,presence-copy,SourceCard(type),SourceLogoTile(type)}
```

`*` = served by a same-path stub (§8.2).

### 7.3 Component tree, Competitor Analysis page

```
app/brand-identity/competitor-analysis/page.tsx  (useCompetitors, useCompetitorFilterSlot, OrganizationContext*, computeScopedStats; gate isSignalOverviewEnabledForOrg*)
└─ AdSelectionProvider (ad-selection-context)  { onSelect: (ad, list?) => void }
   ├─ filters (inline or portaled via createPortal): DashboardPlatformSelector { value; onChange } · DashboardCompetitorSelector { competitors; value; onChange } → ui/select
   ├─ signal/SignalOverview  SignalOverviewProps (contracts.ts)
   │    ├─ CompetitorSyncHint { competitors } (.glass-pill)
   │    ├─ signal/SignalStatBand { stats; labeledPct; isLoading }
   │    ├─ BrandIdentityEmptyState → Chroma* (stub = lucide fallback)
   │    └─ signal/SignalDashboard { competitorId; platform }  → useBrandIdentityDashboard
   │         ├─ dashboard-shared: SectionHeader, RefreshingPill/Overlay, QueryErrorState, StatBar, useBrandIdentityNumbers, labelText
   │         ├─ signal/SignalTopCreatives { winners; onSelectAd } → FullLeaderboardDialog { winners; onSelectAd } → AdCard { ad; onClick? }, ad-grid, ui/dialog, ui/tooltip
   │         ├─ signal/SignalAngles { clusters; showCompetitor; onSelectAd }
   │         ├─ TacticExampleProvider (tactic-example-context) → WinnersVsRestPanel { overIndex; labeledAds; totalAds; mediaQuadrants; colorScheme? }
   │         │     → MediaBucketTabs → MatrixDimensionView → PerformanceMatrix (hand-drawn SVG; winners-matrix, winners-matrix-visuals, matrix-layout, i18n/matrix-copy) → ui/tabs
   │         └─ DynamicPanels (next/dynamic ssr:false) → DimensionPerformancePanel { breakdowns; mediaQuadrants; surface? } (recharts; dimension-headline)
   └─ AdDetailSheet { ad; ads?; open; onOpenChange } → ui/sheet, ui/badge, ui/separator, LongevityBadge, SaveAdButton → SaveToCollectionPopover (ui/popover, ui/input; useCollections), i18n/taxonomy-labels, useLocalizedAdSummary
```

### 7.4 Data fetching

Every hook is a client-side React Query call. No page uses server components for data. The helpers POST JSON with `getAuthHeaders()` and unwrap `{ data }`:
- `lib/services/brand-identity.ts` `brandIdentityRequest(path, body)` → `/api/brand-identity/<path>`
- `lib/services/brand-presence.ts` `brandPresenceRequest(path, body, zod?)` → `/api/brand-presence/<path>`
- inline `postJson/getJson` in `hooks/brand-object/useBrandObject.ts`, `useBrandPortfolio.ts`, `useOwnPerformance.ts`

**Endpoints to serve** (the fixtures are keyed by these exact paths):

| hook | endpoint | query key | response (contracts.ts) |
|---|---|---|---|
| `useBrandProfiles` | POST `/api/brand-presence/profiles/list` | `['brand-presence','profiles',org]` | `{profiles, keptCounts}` |
| `useBrandPortfolio` | POST `/api/brand-object/portfolio` | `['brand-object','portfolio',org]` | `{orgCompetitorCount, profiles}` |
| `useBrandObjectStatus` | POST `/api/brand-object/status` (polls 5 s) | `['brand-object','status',org,profile]` | `BrandObjectStatusView` |
| `useBrandFacts` | POST `/api/brand-object/facts` | `['brand-object','facts',org,profile]` | `{facts: BrandFact[], pendingSuggestionsByFactId}` |
| `useBrandSynthesis` / `useRunBrandSynthesis` | GET / POST `/api/organizations/{org}/brand-identity/synthesis?brandProfileId=` | `['brand-object','synthesis',org,profile,locale]` | `BrandSynthesisView` |
| `useOwnAdAngles` | POST `/api/brand-object/own-ad-angles` | `['brand-object','own-ad-angles',org]` | `{mix}` |
| `useOwnPerformance` | POST `/api/brand-object/own-performance` | — | 404 → chapter hidden |
| `useBrandPresenceSources` | POST `/api/brand-presence/sources/list` and `/status` (`include:'activity'\|'full'`) | `['brand-presence','sources'\|'status',org,profile,…]` | `{sources, mentionCounts}`, `BrandPresenceStatus` (only `counts.kept` is rendered) |
| `useCompetitiveLandscape` | POST `/api/brand-presence/insights/competitive-landscape` (zod-validated; 404 → null) | `['brand-presence','competitive-landscape',org,profile,locale]` | `CompetitiveLandscapeResponse` |
| `useCompetitors` (both pages) | POST `/api/brand-identity/competitors/list` (polls 3 s while syncing) | `['brand-identity','competitors',org]` | `TrackedCompetitor[]` |
| `useBrandIdentityDashboard` | POST `/api/brand-identity/dashboard` `{organizationId, competitorId?, platform}` | `['brand-identity','dashboard',org,competitorId??'all',platform]` | `BrandIdentityDashboard` |
| `useLocalizedAdSummary` | POST `/api/brand-identity/labels/summaries` | — | `{locale, summaries}` |
| `useCollections*` | POST `/api/brand-identity/collections/{list,membership,…}` | — | `[]` / `{}` (or hide `SaveAdButton`) |

**Gates the stubs neutralise:**
- `useBrandReportEnabled` = `isBrandReportEnabledForOrg` ∨ `usePlanFeatureUnlocked('brand_identity')`. **Both stubs return true**; if either is wired to false, every report read is disabled.
- `useBrandIdentityScope` picks the selected profile from `stores/brandProfileStore.ts` (Zustand, `localStorage` key `brand-profile-storage`), falling back to the newest profile.

### 7.5 Look: styling, tokens, fonts, icons, charts, UI kit

- **Tailwind v4, CSS-first.**
  - `postcss.config.mjs` = `plugins: ["@tailwindcss/postcss"]`.
  - `app/globals.css` (1,395 LOC): `@import 'tailwindcss'; @import 'tw-animate-css'; @custom-variant dark (&:is(.dark *)); @theme inline {…}`.
  - **`tailwind.config.ts` (109) is ignored by v4** (there is no `@config` line), so it is *skip*.
- **Tokens: the Magenta & Charcoal palette.**
  - `globals.css` L1–80 holds the `@theme inline` map, which provides `bg-brand`, `text-brand-text`, `bg-brand-soft`, `text-brand-ink`, `status-*`, `platform-*`, `chart-1..5`, the radius scale and `--font-sans`.
  - L82–161 `:root` (light); L243–322 `.dark` (background `#141414`, card `#1E1D1F`, brand `#F0559F`, brand-text `#F57AB3`, brand-soft `#3A1A2C`).
  - L335–506 dark re-tones of the Tailwind hues; L521–606 the recipe classes used here: `.panel-frost`, `.frost-card(-subtle)`, `.section-frost(-closed)`, `.glass-surface`, `.glass-pill`, `.eyebrow-chip`, `.btn-frost-primary`.
  - Reference docs: `design.md` and `.claude/brand-book.md`. Not copied; read them in Adcero if needed.
- **Fonts.** Use **`lib/fonts-online.ts`** (copied): `next/font/google` Geist (`--font-geist-sans`), Geist Mono, Poppins.
  - Adcero's `lib/fonts.ts` is an empty offline stub that a webpack alias swaps out. Not copied; import `fonts-online.ts` directly.
- **Icons:** `lucide-react` only.
- **Charts:** `recharts` 2.15 (three panels, loaded through `DynamicPanels` with `ssr:false`). The Winners-vs-rest matrix is hand-drawn SVG.
- **UI kit.** shadcn "new-york" over Radix (`components.json`: rsc, `cssVariables`, base `stone`, `iconLibrary: lucide`). Primitives copied:
  - `components/ui/{badge, button, card, dialog, eyebrow-chip, frost-panel, input, page-header, popover, progress, select, separator, sheet, skeleton, status-pill, tabs, tooltip}`
  - `toast-interaction.ts`
- **Typography.** `components/brand-identity/typography.ts` `BI_TYPE`: eyebrow `text-[11px]`, panelTitle `text-lg`, heroClaim `text-base`, card/body `text-sm`, meta `text-xs`.
- **`cn`** = `twMerge(clsx(…))` (`lib/utils.ts`). **Path alias** `@/* → ./*` (`tsconfig.json`).
- **i18n.** next-intl 4.14.8; every string comes from `messages/en.json` namespaces `BrandIdentity`, `BrandReport`, `BrandPresence`, `Common`, `Dashboard.change`, `Shell.statusPill`, `Billing.errors`. `global.d.ts` types the keys against `en.json`, which `navigation.ts` needs.
- **Assets.** None are needed: ad media are remote URLs rendered with plain `<img>`, and brand logos use Google's favicon service. The Chroma mascot SVGs (`public/assets/chroma/*`) are only reached through the stubbed `components/chroma`.

### 7.6 Shell to write (replaces the auth/sidebar/section layout, ~40 LOC)

```tsx
// app/layout.tsx (server)
import './globals.css';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/messages/en.json';
import { formats } from '@/i18n/formats';
import { geistSans, geistMono, poppins } from '@/lib/fonts-online';
import { Providers } from './providers';
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" data-theme="dark">
      <body className={`${geistSans.variable} ${geistMono.variable} ${poppins.variable} bg-background text-foreground antialiased`}>
        <NextIntlClientProvider locale="en" messages={messages} formats={formats} timeZone="UTC">
          <Providers>
            <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background p-6 sm:p-8">
              <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-6">{children}</div>
            </div>
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
// app/providers.tsx ('use client'): <QueryClientProvider client={qc}><OrganizationContext.Provider value={ORG_STUB}>{children}<Toaster /></OrganizationContext.Provider></QueryClientProvider>
// Header: <PageHeader title=… description=…/> from components/ui/page-header + a <Tabs> row built from navigation.ts BRAND_IDENTITY_SECTIONS.
```

`geistSans`, `geistMono` and `poppins` are the actual exports of `lib/fonts-online.ts` (checked).

### 7.7 Files (Area 7 table)

Verdicts are derived mechanically: a file that imports only same-path stubs is *copy as-is*. "depends on" lists stubbed/skipped imports and npm packages (react omitted).

| path | LOC | purpose | verdict | reason | depends on |
|---|---|---|---|---|---|
| `app/brand-identity/competitor-analysis/page.tsx` | 192 | Competitor Analysis page (client). Scoped stats + platform/competitor filters + Signal overview + lifted AdDetailSheet. | **copy + edit** | drop classic overview branch | skip: `components/dashboard/MetricCard`, skip: `components/brand-identity/BrandIdentityDashboard`, stub: `contexts/OrganizationContext`, stub: `lib/brand-identity/competitor-signal-overview-access`, `lucide-react`, `next-intl`, `react-dom` |
| `app/brand-identity/navigation.ts` | 268 | Section tab tables, header copy keys, path resolvers (lucide icons). | copy as-is | no app coupling | `lucide-react`, `next-intl` |
| `app/brand-identity/page.tsx` | 130 | Brand Identity report page (client). Picks treatment, renders build progress / empty / report. | copy as-is | runs behind same-path stubs | stub: `contexts/OrganizationContext`, stub: `lib/brand-object/distilled-report-access`, stub: `hooks/creative-studio/useCreativeStudioEnabled`, `lucide-react`, `next`, `next-intl` |
| `app/globals.css` | 1395 | Tailwind v4 entry: @theme tokens, light/dark palette, recipe classes (.panel-frost, .glass-pill, …). | copy as-is | no app coupling | `tailwindcss`, `tw-animate-css` |
| `components.json` | 21 | shadcn config (new-york, stone, css variables, lucide). | copy as-is | no app coupling | — |
| `components/brand-identity/AdCard.tsx` | 167 | Ad tile (media, longevity, labels) used by the leaderboard. | copy as-is | no app coupling | `lucide-react`, `next-intl` |
| `components/brand-identity/AdDetailSheet.tsx` | 497 | Right-side ad detail sheet: creative cards, labels, fingerprint, summary, save. | copy as-is | no app coupling | `lucide-react`, `next-intl` |
| `components/brand-identity/BrandIdentityEmptyState.tsx` | 28 | Empty state (Chroma mascot or lucide fallback). | copy as-is | runs behind same-path stubs | stub: `components/chroma/index`, `lucide-react`, `next`, `next-intl` |
| `components/brand-identity/CompetitorSyncHint.tsx` | 35 | Pill showing competitors still syncing/labelling. | copy as-is | no app coupling | `lucide-react`, `next-intl` |
| `components/brand-identity/DashboardCompetitorSelector.tsx` | 68 | Competitor dropdown (ui/select). | copy as-is | no app coupling | `lucide-react`, `next`, `next-intl` |
| `components/brand-identity/DashboardPlatformSelector.tsx` | 39 | Meta / Google / All dropdown. | copy as-is | no app coupling | `next-intl` |
| `components/brand-identity/DimensionPerformancePanel.tsx` | 407 | "What's working by dimension" bar charts (recharts). | copy as-is | no app coupling | `lucide-react`, `next-intl`, `recharts` |
| `components/brand-identity/DynamicPanels.tsx` | 42 | next/dynamic (ssr:false) wrappers for the recharts panels. | copy as-is | no app coupling | `next` |
| `components/brand-identity/FullLeaderboardDialog.tsx` | 109 | All-winners dialog grid. | copy as-is | no app coupling | `lucide-react`, `next-intl` |
| `components/brand-identity/LongevityBadge.tsx` | 41 | Days-running badge. | copy as-is | no app coupling | `next-intl` |
| `components/brand-identity/LongevityDistributionChart.tsx` | 65 | Longevity histogram (recharts; exported by DynamicPanels, not rendered by Signal). | copy as-is | no app coupling | `next-intl`, `recharts` |
| `components/brand-identity/MatrixDimensionView.tsx` | 305 | One facet of the Winners-vs-rest matrix. | copy as-is | no app coupling | `lucide-react`, `next-intl` |
| `components/brand-identity/MediaBucketTabs.tsx` | 123 | Images / Videos sub-tabs over visual dimensions. | copy as-is | no app coupling | `lucide-react`, `next-intl` |
| `components/brand-identity/PerformanceMatrix.tsx` | 388 | Hand-drawn SVG quadrant matrix (over-index × median win score). | copy as-is | no app coupling | `lucide-react`, `next-intl` |
| `components/brand-identity/SaveAdButton.tsx` | 100 | Save-to-collection trigger. | copy as-is | no app coupling | `lucide-react`, `next-intl` |
| `components/brand-identity/SaveToCollectionPopover.tsx` | 148 | Collections popover (needs collections/* endpoints). | copy as-is | no app coupling | `lucide-react`, `next-intl` |
| `components/brand-identity/WinnersVsRestPanel.tsx` | 118 | Tabbed matrix panel (Format/Hook/Offer/Angle/Images/Videos). | copy as-is | no app coupling | `lucide-react`, `next-intl` |
| `components/brand-identity/ad-grid.ts` | 25 | adGridClass() densities. | copy as-is | no app coupling | — |
| `components/brand-identity/ad-selection-context.tsx` | 43 | AdSelectionProvider / useAdSelection. | copy as-is | no app coupling | — |
| `components/brand-identity/competitor-filter-slot.tsx` | 57 | Portal slot for the page filters (optional). | copy as-is | no app coupling | — |
| `components/brand-identity/dashboard-shared.tsx` | 230 | SectionHeader, RefreshingPill/Overlay, QueryErrorState, StatBar, number/label helpers. | copy as-is | no app coupling | `lucide-react`, `next-intl` |
| `components/brand-identity/desk/SurvivalCurveChart.tsx` | 114 | Survival curve (recharts; exported by DynamicPanels, unused here). | copy as-is | no app coupling | `lucide-react`, `next-intl`, `recharts` |
| `components/brand-identity/dimension-headline.ts` | 399 | Honest-by-construction panel headlines (MIN_SAMPLE floor). | copy as-is | no app coupling | `next-intl` |
| `components/brand-identity/i18n/matrix-copy.ts` | 157 | Matrix copy helpers. | copy as-is | no app coupling | `next-intl` |
| `components/brand-identity/i18n/taxonomy-labels.ts` | 74 | useTaxonomyLabels (enum → catalog label). | copy as-is | no app coupling | `next-intl` |
| `components/brand-identity/matrix-layout.ts` | 419 | Matrix geometry / label collision layout. | copy as-is | no app coupling | — |
| `components/brand-identity/signal/SignalAngles.tsx` | 202 | Momentum-bar angle clusters. | copy as-is | no app coupling | `lucide-react`, `next-intl` |
| `components/brand-identity/signal/SignalDashboard.tsx` | 150 | Signal overview body (fetches the dashboard). | copy as-is | no app coupling | `lucide-react`, `next-intl` |
| `components/brand-identity/signal/SignalOverview.tsx` | 47 | Signal overview composition root. | copy as-is | no app coupling | — |
| `components/brand-identity/signal/SignalStatBand.tsx` | 63 | Monochrome stat band. | copy as-is | no app coupling | `next-intl` |
| `components/brand-identity/signal/SignalTopCreatives.tsx` | 256 | Hero + supporting winners. | copy as-is | no app coupling | `lucide-react`, `next-intl` |
| `components/brand-identity/tactic-example-context.tsx` | 56 | Matrix label → example ads sink. | copy as-is | no app coupling | — |
| `components/brand-identity/typography.ts` | 25 | BI_TYPE font-size scale. | copy as-is | no app coupling | — |
| `components/brand-identity/winners-matrix-visuals.ts` | 288 | Matrix colours / visuals. | copy as-is | no app coupling | `lucide-react` |
| `components/brand-identity/winners-matrix.ts` | 527 | buildMatrixModel (winners vs provisional mode, takeaways). | copy as-is | no app coupling | `lucide-react` |
| `components/brand-object/insights/AlignmentMapPanel.tsx` | 296 | Chapter 05 claims ↔ voice ↔ market map. | copy as-is | no app coupling | `next`, `next-intl` |
| `components/brand-object/insights/AwarenessFrameworkDialog.tsx` | 116 | Schwartz awareness explainer dialog. | copy as-is | no app coupling | `lucide-react`, `next-intl` |
| `components/brand-object/insights/BrandBuildProgressCard.tsx` | 186 | Build progress (listening + competitors + stages). | copy as-is | no app coupling | `lucide-react`, `next-intl` |
| `components/brand-object/insights/BrandInsightsDashboard.tsx` | 446 | Report composition root (chapters 01–08) + all report hooks. | **copy + edit** | import useBrandPresenceSources from use-brand-presence/sources | skip: `hooks/brand-presence/useBrandPresence`, stub: `lib/demo/example-ai-overview`, stub: `lib/brand-object/brand-identity-brand-pin`, `lucide-react`, `next`, `next-intl`, `sonner` |
| `components/brand-object/insights/BrandNarrativePanel.tsx` | 400 | Chapter 02 AI narrative. | copy as-is | no app coupling | `lucide-react`, `next-intl` |
| `components/brand-object/insights/ChapterHeader.tsx` | 37 | Numbered chapter header. | copy as-is | no app coupling | `next-intl` |
| `components/brand-object/insights/CompetitiveLandscapePanel.tsx` | 425 | Chapter 07/08 voice-vs-competitors landscape. | copy as-is | no app coupling | `lucide-react`, `next-intl` |
| `components/brand-object/insights/EvidenceDisclosure.tsx` | 59 | Source-sentence disclosure for a claim. | copy as-is | no app coupling | `lucide-react`, `next-intl` |
| `components/brand-object/insights/GenerateCreativesCta.tsx` | 74 | "Generate creatives" CTA. | copy as-is | no app coupling | `lucide-react`, `next`, `next-intl` |
| `components/brand-object/insights/IdentityHeroPanel.tsx` | 106 | Chapter 01 pillars. | copy as-is | no app coupling | `next-intl` |
| `components/brand-object/insights/IdentityRail.tsx` | 238 | Left identity rail (logo, positioning, voice, counts). | copy as-is | no app coupling | `next-intl` |
| `components/brand-object/insights/MarketPlaybookPanel.tsx` | 486 | Chapter 04 market formula / priors. | copy as-is | no app coupling | `lucide-react`, `next`, `next-intl` |
| `components/brand-object/insights/OwnPerformancePanel.tsx` | 414 | Chapter 07 own-ad performance (hidden without data). | copy as-is | no app coupling | `next-intl` |
| `components/brand-object/insights/PersonaSignalChip.tsx` | 192 | Persona pain/desire chip. | copy as-is | no app coupling | `next-intl` |
| `components/brand-object/insights/PersonaStrip.tsx` | 312 | Chapter 06 persona ladder. | copy as-is | no app coupling | `next-intl` |
| `components/brand-object/insights/VocReportPanel.tsx` | 345 | Chapter 03 voice of customer. | copy as-is | no app coupling | `lucide-react`, `next-intl` |
| `components/brand-object/insights/alignment-copy.ts` | 119 | Alignment copy helpers. | copy as-is | no app coupling | `next-intl` |
| `components/brand-object/insights/narrative-evidence.ts` | 144 | Narrative evidence formatting. | copy as-is | no app coupling | — |
| `components/brand-object/insights/narrative-figures.ts` | 197 | Narrative figure extraction. | copy as-is | no app coupling | — |
| `components/brand-object/insights/persona-signal.ts` | 319 | Persona signal helpers. | copy as-is | no app coupling | — |
| `components/brand-object/insights/report-copy.ts` | 123 | Report copy hooks (section / kind titles). | copy as-is | no app coupling | `next-intl` |
| `components/brand-object/insights/section-tone.ts` | 112 | Section colour tones. | copy as-is | no app coupling | — |
| `components/brand-presence/SourceCard.tsx` | 144 | Source card (type import only from presence-copy). | copy as-is | no app coupling | `next-intl` |
| `components/brand-presence/SourceLogoTile.tsx` | 61 | Source logo tile (type import only). | copy as-is | no app coupling | `next` |
| `components/brand-presence/channel-style.tsx` | 119 | Per-platform channel styles. | copy as-is | no app coupling | `lucide-react` |
| `components/brand-presence/presence-copy.ts` | 252 | Presence copy helpers. | copy as-is | no app coupling | `next-intl` |
| `components/brand-presence/presence-role.tsx` | 166 | Self / competitor role header. | copy as-is | no app coupling | `lucide-react`, `next-intl` |
| `components/dashboard/charts/constants.ts` | 88 | CHART_COLORS → var(--chart-N). | copy as-is | no app coupling | — |
| `components/i18n/AiTranslatedBadge.tsx` | 25 | "AI translated" badge. | copy as-is | no app coupling | `lucide-react`, `next-intl` |
| `global.d.ts` | 13 | next-intl AppConfig typing against messages/en.json. | **copy + edit** | follows the trimmed en.json | — |
| `hooks/brand-identity/useBrandIdentityDashboard.ts` | 49 | POST brand-identity/dashboard; DashboardPlatform type. | copy as-is | runs behind same-path stubs | stub: `contexts/OrganizationContext`, `@tanstack/react-query` |
| `hooks/brand-identity/useCollections.ts` | 319 | Collections queries + mutations. | copy as-is | runs behind same-path stubs | stub: `contexts/OrganizationContext`, `@tanstack/react-query`, `next-intl`, `sonner` |
| `hooks/brand-identity/useCompetitors.ts` | 323 | POST brand-identity/competitors/list (+ create/sync mutations). | copy as-is | runs behind same-path stubs | stub: `contexts/OrganizationContext`, stub: `hooks/use-organization-queries/auth-headers`, stub: `components/billing/PlanLimitDialog`, stub: `hooks/billing/use-org-billing`, `@tanstack/react-query`, `next-intl`, `sonner` |
| `hooks/brand-identity/useLocalizedAdSummary.ts` | 70 | POST brand-identity/labels/summaries. | copy as-is | runs behind same-path stubs | stub: `contexts/OrganizationContext`, `@tanstack/react-query`, `next-intl` |
| `hooks/brand-object/useBrandIdentityScope.ts` | 86 | Selected brand profile scope. | copy as-is | runs behind same-path stubs | stub: `lib/brand-object/brand-identity-brand-pin` |
| `hooks/brand-object/useBrandObject.ts` | 300 | status / facts / synthesis / own-ad-angles / build hooks + view types. | copy as-is | runs behind same-path stubs | stub: `hooks/use-organization-queries/auth-headers`, stub: `components/billing/PlanLimitDialog`, `@tanstack/react-query`, `next-intl` |
| `hooks/brand-object/useBrandPortfolio.ts` | 81 | POST brand-object/portfolio. | copy as-is | runs behind same-path stubs | stub: `contexts/OrganizationContext`, stub: `hooks/use-organization-queries/auth-headers`, `@tanstack/react-query` |
| `hooks/brand-object/useBrandReportEnabled.ts` | 25 | Report gate (both stubs → true). | copy as-is | runs behind same-path stubs | stub: `contexts/OrganizationContext`, stub: `hooks/billing/use-plan-feature`, stub: `lib/brand-object/brand-report-access` |
| `hooks/brand-object/useOwnPerformance.ts` | 86 | POST brand-object/own-performance (404 → empty). | copy as-is | runs behind same-path stubs | stub: `hooks/use-organization-queries/auth-headers`, `@tanstack/react-query` |
| `hooks/brand-presence/use-brand-presence/query-keys.ts` | 134 | Brand-presence query keys. | copy as-is | no app coupling | — |
| `hooks/brand-presence/use-brand-presence/shared.ts` | 88 | Invalidation + mutation error toast. | copy as-is | no app coupling | `@tanstack/react-query`, `sonner` |
| `hooks/brand-presence/use-brand-presence/sources.ts` | 224 | useBrandPresenceSources (sources/list + status). | copy as-is | no app coupling | `@tanstack/react-query`, `next-intl`, `sonner` |
| `hooks/brand-presence/useBrandProfileScope.ts` | 71 | Profile selection from the Zustand store. | copy as-is | runs behind same-path stubs | stub: `contexts/OrganizationContext` |
| `hooks/brand-presence/useBrandProfiles.ts` | 42 | POST brand-presence/profiles/list. | copy as-is | runs behind same-path stubs | stub: `contexts/OrganizationContext`, `@tanstack/react-query` |
| `hooks/brand-presence/useCompetitiveLandscape.ts` | 88 | POST brand-presence/insights/competitive-landscape (zod). | copy as-is | no app coupling | `@tanstack/react-query`, `next-intl` |
| `hooks/useFormatLocale.ts` | 16 | Intl locale tag. | copy as-is | no app coupling | `next-intl` |
| `hooks/useLocaleFormatters.ts` | 59 | Number/currency/date formatters (currency store). | copy as-is | no app coupling | `next-intl` |
| `i18n/config.ts` | 45 | SUPPORTED_LOCALES, DEFAULT_LOCALE, toIntlTag. | copy as-is | no app coupling | — |
| `i18n/formats.ts` | 18 | next-intl dateTime/number formats. | copy as-is | no app coupling | `next-intl` |
| `i18n/request.ts` | 62 | next-intl request config (cookie → Accept-Language → en). | **copy + edit** | pin locale "en" (dynamic import of messages/${locale}.json) | `next`, `next-intl` |
| `lib/billing/plans.ts` | 216 | BillingErrorCode type (error-code map only). | copy as-is | no app coupling | — |
| `lib/brand-object/alignment.ts` | 681 | brandAlignment (claims ↔ voice ↔ market). | copy as-is | no app coupling | — |
| `lib/brand-object/brand-logo.ts` | 42 | Google favicon URL for the brand. | copy as-is | no app coupling | — |
| `lib/brand-object/demo-own-angles.ts` | 80 | Demo own-angle mix (pinned demo orgs only). | copy as-is | no app coupling | — |
| `lib/brand-object/demo-own-performance.ts` | 167 | Demo own-performance model (pinned demo orgs only). | copy as-is | no app coupling | — |
| `lib/brand-object/insights.ts` | 604 | Report selectors (identityClaims, topVocBySection, priorsByDimension, marketFormula, personaCards). | copy as-is | no app coupling | — |
| `lib/brand-object/own-angles.ts` | 113 | OwnAdAngleMix type + helpers. | copy as-is | no app coupling | — |
| `lib/brand-object/own-performance-format.ts` | 134 | Own-performance formatting. | copy as-is | no app coupling | — |
| `lib/brand-object/own-performance.ts` | 494 | OwnPerformanceModel + emptiness check. | copy as-is | no app coupling | — |
| `lib/brand-presence/awaiting-confirm.ts` | 74 | Meta-derived "awaiting confirm" state. | copy as-is | no app coupling | — |
| `lib/brand-presence/client-schemas.ts` | 300 | zod response schemas (status, landscape, …). | copy as-is | no app coupling | `zod` |
| `lib/brand-presence/competitive-landscape.ts` | 301 | Landscape constants/types (zero-LLM builder). | copy as-is | no app coupling | — |
| `lib/brand-presence/highlights.ts` | 134 | VOC highlight helpers. | copy as-is | no app coupling | — |
| `lib/brand-presence/hook-quotes.ts` | 113 | Hook-quote picking. | copy as-is | no app coupling | — |
| `lib/brand-presence/localized-themes.ts` | 173 | Localized theme labels. | copy as-is | no app coupling | — |
| `lib/brand-presence/platform-labels.ts` | 21 | Platform display labels. | copy as-is | no app coupling | — |
| `lib/brand-presence/pulse-metrics.ts` | 63 | Presence pulse metrics. | copy as-is | no app coupling | — |
| `lib/brand-presence/source-registry.ts` | 116 | Source type registry (labels, logos). | copy as-is | no app coupling | `lucide-react` |
| `lib/currency/currencies.ts` | 74 | Currency table. | copy as-is | no app coupling | — |
| `lib/currency/exchange-rates.ts` | 191 | Static FX conversion. | copy as-is | no app coupling | — |
| `lib/fonts-online.ts` | 22 | next/font/google Geist, Geist Mono, Poppins (CSS variables). | copy as-is | no app coupling | `next` |
| `lib/i18n/deep-merge.ts` | 54 | Catalog deep merge (request.ts). | copy as-is | no app coupling | — |
| `lib/i18n/error-code-keys.ts` | 9 | ErrorCodeKeys type. | copy as-is | no app coupling | — |
| `lib/i18n/format.ts` | 239 | Locale formatters. | copy as-is | no app coupling | — |
| `lib/i18n/locale-cookie.ts` | 53 | Locale cookie name (request.ts). | copy as-is | no app coupling | — |
| `lib/i18n/localize-error.ts` | 377 | useLocalizeError (server code → catalog key). | copy as-is | no app coupling | `next-intl` |
| `lib/i18n/localized-synthesis.ts` | 32 | Merge localized synthesis prose. | copy as-is | no app coupling | — |
| `lib/i18n/resolve-locale.ts` | 61 | Cookie/Accept-Language resolution (request.ts). | copy as-is | no app coupling | — |
| `lib/services/brand-identity.ts` | 46 | brandIdentityRequest (POST, unwrap {data}). | copy as-is | runs behind same-path stubs | stub: `hooks/use-organization-queries/auth-headers` |
| `lib/services/brand-presence.ts` | 73 | brandPresenceRequest (POST, zod, unwrap {data}). | copy as-is | runs behind same-path stubs | stub: `hooks/use-organization-queries/auth-headers` |
| `lib/utils.ts` | 31 | cn() = twMerge(clsx()). | copy as-is | no app coupling | `clsx`, `tailwind-merge` |
| `messages/en.json` | 25171 | English catalog (all namespaces; pages read 7). | **copy + edit** | optional trim to the 7 namespaces | — |
| `postcss.config.mjs` | 5 | @tailwindcss/postcss plugin. | copy as-is | no app coupling | — |
| `stores/brandProfileStore.ts` | 44 | Zustand: selected profile per org (localStorage). | copy as-is | no app coupling | `zustand` |
| `stores/currencyStore.ts` | 110 | Zustand: display currency. | copy as-is | no app coupling | `zustand` |
| `tsconfig.json` | 50 | TS config with @/* path alias. | **copy + edit** | merge the @/* alias into your config | — |
| `components/ui/{badge,button,card,dialog,eyebrow-chip,frost-panel,input,page-header,popover,progress,select,separator,sheet,skeleton,status-pill,tabs,toast-interaction,tooltip}` (18 files) | 46/68/108/147/25/52/24/63/48/28/227/28/159/13/79/71/18/61 | shadcn new-york primitives over Radix (+ dialog toast-interaction helper). | copy as-is | no app coupling | Radix packages, `class-variance-authority`, `lucide-react` |
| `lib/i18n/error-code-key-maps/*.ts` (10 files) | 731 total | Server error code → catalog key maps used by useLocalizeError. | copy as-is | pure | — |
| `app/brand-identity/layout.tsx`, `brand-identity-layout-client.tsx`, `error.tsx` | 16/265/61 | Section intl namespaces, header/tabs/Export/Build/filter slot, error boundary (lazy Sentry). | rewrite | minimal shell (user decision); §7.6 | auth/org/billing/export |
| `app/layout.tsx`, `app/providers.tsx`, `components/app-layout-content.tsx` | — | Root html/fonts/intl; auth wall + providers; sidebar/nav. | rewrite | §7.6 shell | Supabase auth, org context, billing |
| `tailwind.config.ts` | 109 | v3-style config. | skip | ignored by Tailwind v4 (no `@config` in globals.css) | — |
| `components/brand-identity/BrandIdentityDashboard.tsx`, `components/dashboard/MetricCard.tsx` (+ DashboardPanels, TopCreativesChart, AngleClustersPanel, CountUp, format-locale) | 107/190 | Classic overview (rollback path). | skip | Signal is the default overview | framer-motion, date-fns |
| `hooks/brand-presence/useBrandPresence.ts` | 76 | Barrel over 15 brand-presence hooks. | skip | only `useBrandPresenceSources` is needed (import it directly) | — |

---

## 8. Coupling to cut

### 8.1 Every coupling, and how it is cut

| coupling | where (areas 1–7) | smallest stub |
|---|---|---|
| `organization_id` + RLS | every table, every processor query (`.eq('organization_id', …)`), every job payload, R2 key prefixes | **Keep the column, pin one constant uuid** (e.g. `00000000-0000-4000-8000-000000000001`). Create the tables without the `organizations` FK and without RLS policies (single tenant, service role). Zero code edits. |
| Supabase client | constructor param of all processors, `fact-writer`, `state`, the three queues, `retrieveBrandSlice`, `live-facts` (PostgREST builder: `.eq/.in/.is/.or/.gte/.order/.range/.upsert(onConflict, ignoreDuplicates)/.maybeSingle/count:'exact'`) | **Use supabase-js against a Supabase project or local `supabase start`** (PostgREST semantics are relied on: 23505 handling, partial-index workaround, `.or` NULL-inclusive filters). A hand-written Postgres adapter would need ~15 query shapes; not recommended for a hackathon. Vectors can be a `text` column if you lack pgvector (all cosine math runs in JS). |
| `job_queue` + crons + self-continuation | three queue modules write `job_queue` rows with dedupe keys and read active jobs; processors chain by enqueueing | **Keep a minimal `job_queue` table (§8.4) + a local worker loop** dispatching `type → new Processor(db).process(job, signal)` (registry = `services/job-processor/job-executor.ts` L121–L165). Drop Vercel crons, `/api/jobs/process`, `kickoff-*`, `wake-job-processor`. |
| `Job` type | `services/job-processor/types.ts` (255 LOC, imports bulk-launch/Meta types) | stub (§8.2) |
| `FunctionTimeoutError` / tracker | sync, crawl, chunks, label, brand-presence processors | **Copied as-is** (79 LOC). Pass no tracker, or `{ shouldStop: () => false }`; if a processor throws `FunctionTimeoutError`, your worker resets the row to `pending` and refunds `attempts` (Adcero's executor does exactly that). |
| auth (`withAfRoute`, `getActor`, `assertCanAccessOrganization`, OAuth) | API routes only (not exported) | none: write plain route handlers / an HTTP entry for the Python uAgents layer |
| Sentry / PostHog | none in areas 1–6; `app/brand-identity/error.tsx` only (not copied) | none |
| R2 (`services/r2-service.ts`, env-reading singleton) | raw-page archive (9 processors), brand-object crawl upload + identity download, `getPublicUrl`, `fileExists` | stub writing to local disk (§8.2) — **must actually return the bytes on `downloadFile`**, because identity reads the crawl pages from it |
| LLM clients | `openAIChatCompletion` (12 files), `openAIEmbeddings` (embeddings.ts), `geminiGenerateContent` (video-label.ts), `flexServiceTier`, `modelForRole` | stub `lib/llm/clients.ts` + `lib/llm/clients/gemini.ts` (§8.2); `flex.ts`, `model-roles.ts`, `errors.ts` are copied as-is (no imports). `lib/ai/provider.ts` `LLMProvider` is unused here. |
| Drizzle client (`lib/db`) | **none** in areas 1–7 | none; `drizzle/schema.ts` is reference DDL only |
| `engine_actions` / `auditLog` / `emitEvent` | **none** in areas 1–7 (route wrappers only) | none |
| user-activity log | `confirm-source.ts` (`recordListeningStarted`), `brand-presence/types.ts` + `queue.ts` (actor schema/type) | stub `lib/user-activity/record.ts` (§8.2) |
| connected ad-account scope | `identity-processor.ts` own-ad copy | stub `lib/accounts/connected-scope.ts` → no accounts |
| feature flags / allowlists | UI only: `brand-report-access`, `distilled-report-access`, `competitor-signal-overview-access`, `brand-identity-brand-pin`, `use-plan-feature`, `useCreativeStudioEnabled`, `chroma` | constant stubs (§8.2) |
| org/billing UI context | `contexts/OrganizationContext.tsx`, `auth-headers`, `PlanLimitDialog`, `use-org-billing` | stubs (§8.2) |
| i18n translation jobs | `label-processor` (`translateAdLabelSummaries`), `cluster-processor` (`translateClusteredThemes`) | delete the call (copy + edit, §8.3) |

### 8.2 The 18 same-path stubs (write these; importers then compile unchanged)

The exported names are exactly the ones importers use, extracted mechanically.

| stub path | must export (signature) | behaviour |
|---|---|---|
| `lib/llm/clients.ts` | `openAIChatCompletion(params: {body: Record<string,unknown>; apiKey?: string; signal?: AbortSignal; retryProfile?: LlmRetryProfile; attempts?: number; timeoutMs?: number; baseUrl?: string}): Promise<Record<string,unknown>>`; `openAIEmbeddings(params: {body; apiKey?; signal?; retryProfile?; attempts?; timeoutMs?}): Promise<Record<string,unknown>>`; `type LlmRetryProfile = 'background' \| 'interactive'` | `fetch('https://api.openai.com/v1/chat/completions' \| '/v1/embeddings')` with `OPENAI_API_KEY`, return the parsed JSON; on non-2xx throw `new LlmProviderError({provider:'openai', code, reason, remediation, retryable: status===429\|\|status>=500, status})` from the copied `lib/llm/errors.ts`; one retry on retryable. If you keep `flexServiceTier()` (sends `service_tier:'flex'`), retry a 429 once without it. |
| `lib/llm/clients/gemini.ts` | `geminiGenerateContent(params: {model: string; contents: ContentListUnion; config?: GenerateContentConfig; apiKey?; retryProfile?; attempts?}): Promise<{text?: string; candidates?: Candidate[]}>` | `new GoogleGenAI({apiKey: GEMINI_API_KEY}).models.generateContent({model, contents, config})`. Or throw to make every video fall back to the poster path. |
| `services/r2-service.ts` | `export const r2Service = { uploadFile(bucket, key, body, contentType?, metadata?): Promise<unknown>, downloadFile(bucket, key): Promise<{transformToString(): Promise<string>}>, fileExists(bucket, key): Promise<boolean>, getPublicUrl(bucket, key): string }` | write/read `./data/r2/<bucket>/<key>` on disk |
| `services/job-processor/types.ts` | `interface Job { id: string; type: string; status: string; attempts: number; max_attempts: number; payload: { organizationId: string; [k: string]: unknown }; claim_token?: string; created_at?: string; completed_at?: string; error_message?: string }` | type only |
| `lib/user-activity/record.ts` | `userActivityActorSchema = z.object({type: z.enum(['human','agent','system']), userId: z.string().uuid().nullable(), impersonatedBy: z.string().nullable()})`; `type UserActivityActor = z.infer<…>`; `SYSTEM_ACTIVITY_ACTOR = {type:'system', userId:null, impersonatedBy:null}`; `type ListeningPlatform = string`; `recordListeningStarted(_db, _params): Promise<void>` (no-op) | |
| `lib/accounts/connected-scope.ts` | `resolveConnectedAdAccountScope({supabase, organizationId, platform?}): Promise<{accounts: unknown[]; accountIds: string[]}>` | return `{accounts: [], accountIds: []}` |
| `contexts/OrganizationContext.tsx` | `OrganizationContext` (React context), `useOrganization()` | value `{ currentOrganization: { id: LOCAL_ORG, name: 'My Brand', feature_grants: ['brand_presence'] }, selectedPlatform: 'meta' }`; render a `<OrganizationContext.Provider>` in your providers |
| `hooks/use-organization-queries/auth-headers.ts` | `getAuthHeaders(): Promise<Record<string,string>>` | `{ 'Content-Type': 'application/json' }` |
| `components/billing/PlanLimitDialog.tsx` | `usePlanLimitPrompt(defaults?)` → `{ handleBillingError: (e: unknown) => boolean; dialog: ReactNode }` | `{ handleBillingError: () => false, dialog: null }` |
| `hooks/billing/use-org-billing.ts` | `orgBillingKeys = { all: ['billing'] as const, org: (id: string) => ['billing','org',id] as const }` | |
| `hooks/billing/use-plan-feature.ts` | `usePlanFeatureUnlocked(feature: string): boolean` | `true` |
| `hooks/creative-studio/useCreativeStudioEnabled.ts` | `useCreativeStudioEnabled(): boolean` | `false` (true shows the "Generate creatives" CTA as enabled) |
| `lib/brand-object/brand-report-access.ts` | `isBrandReportEnabledForOrg(org): boolean` | `true` |
| `lib/brand-object/distilled-report-access.ts` | `isDistilledReportEnabledForOrg(org): boolean` | `false` → 'classic' report treatment (`true` → 'distilled') |
| `lib/brand-object/brand-identity-brand-pin.ts` | `isBrandIdentityPinnedToBuiltBrand(orgId?: string \| null): boolean` | `false` |
| `lib/brand-identity/competitor-signal-overview-access.ts` | `isSignalOverviewEnabledForOrg(org): boolean` | `true` (or delete the classic branch, §8.3) |
| `lib/demo/example-ai-overview.ts` | `EXAMPLE_BRAND_SYNTHESIS`, `shouldShowExampleAiOverview(orgId?)` | `null` / `() => false`. Or return your fixture synthesis + `true` for a static Chapter 02 with no API. |
| `components/chroma/index.ts` | `Chroma` (component) | render the lucide fallback icon (`<Sparkles/>`) |

### 8.3 The 11 copy + edit files

| file | edit | size |
|---|---|---|
| `app/brand-identity/competitor-analysis/page.tsx` | delete the classic branch (`MetricCard` ×5 + `BrandIdentityDashboard`) and its two imports; keep `SignalOverview` | ~40 lines removed |
| `components/brand-object/insights/BrandInsightsDashboard.tsx` | `import { useBrandPresenceSources } from '@/hooks/brand-presence/use-brand-presence/sources'` (instead of the `useBrandPresence` barrel, which drags 12 unrelated hooks) | 1 line |
| `services/ad-library/index.ts` | keep only the `apify` branches | ~15 lines |
| `services/job-processor/ad-library/sync-processor.ts`, `sync/fetch-paths.ts`, `sync/types.ts` | remove the scrape-cache read/claim/adopt/publish/write-through calls, `ingestFromScrapeCache`, and the cache type imports; the lifecycle path (start → checkpoint → poll → `upsertAds`) stays | ~120 lines removed |
| `services/job-processor/ad-library/queue.ts` | remove `assertOrgSyncBudget` | 3 lines |
| `services/job-processor/ad-library/label-processor.ts` | remove the `translateAdLabelSummaries` call/import | ~6 lines |
| `services/job-processor/brand-presence/cluster-processor.ts` | remove the `translateClusteredThemes` call/import | ~6 lines |
| `services/job-processor/brand-object/market-processor.ts` | page the `library_ads_enriched` read (`.order('id').range()` until a short page) instead of `.limit(2000)` | ~15 lines (bug fix, §11.1) |
| `i18n/request.ts`, `messages/en.json`, `tsconfig.json`, `global.d.ts` | `request.ts`: return `locale:'en'` (it dynamically imports `messages/${locale}.json`, and only `en.json` is copied). `en.json` (25,171 lines): optionally trim to the namespaces in §7.5 (`global.d.ts` follows it). `tsconfig.json`: merge the `@/*` alias into your config. | small |

`lib/brand-identity/industries.ts` and `sync-processor.ts` still reference `INDUSTRY_CATALOG_ORG_ID` (the global catalog). Single-tenant, those branches are dead but harmless.

### 8.4 Minimal `job_queue` + worker

DDL subset of `drizzle/schema.ts:824`:

```sql
create table job_queue (
  id uuid primary key default gen_random_uuid(), type text not null, dedupe_key text, status text not null default 'pending',
  priority int default 0, payload jsonb not null default '{}', result jsonb, attempts int default 0, max_attempts int default 3,
  error_message text, organization_id uuid, created_at timestamptz default now(), scheduled_for timestamptz default now(),
  started_at timestamptz, completed_at timestamptz, claim_token uuid);
-- the two dedupe indexes the queues rely on (23505 → reuse the winning row):
create unique index idx_job_queue_brand_presence_active_dedupe on job_queue (type, dedupe_key) where type like 'brand_presence%' and dedupe_key is not null and status in ('pending','processing');
create unique index idx_job_queue_brand_object_active_dedupe  on job_queue (type, dedupe_key) where type like 'brand_object%'  and dedupe_key is not null and status in ('pending','processing');
```

These match the `WHERE` clauses of migrations `drizzle/0115_brand_presence_active_dedupe.sql` and `drizzle/0132_brand_object_active_dedupe.sql` exactly (checked).

**Worker loop.**
1. Select the oldest `pending` row where `scheduled_for <= now()` and `attempts < max_attempts`.
2. Set `status='processing'`, `attempts += 1`, `started_at`.
3. `await registry[row.type](db).process(row, abortSignal, tracker)`.
4. On success: `completed`, `result`. On `FunctionTimeoutError`: back to `pending`, `attempts -= 1`. On any other error: `pending` again until `max_attempts`, else `failed` + `error_message`.

Loop until no pending rows. **Job types:** `adlib_sync_competitor`, `adlib_label_batch`, `adlib_embed_batch`, the 16 `brand_presence_*` types (excluding Amazon) and the 6 `brand_object_*` types.

**SpacetimeDB.** Mirror `job_queue` status and `brand_presence_sources.status` into it if you want live progress. Nothing in the copied code depends on it.

**Python uAgents.** Expose one HTTP endpoint that enqueues `brand_presence_discover` / `adlib_sync_competitor` / `brand_object_crawl {chain:true}`, one that drains the worker, and one wrapping `retrieveBrandSlice`.

---

## 9. Environment variables and external services (names only)

| needed standalone | used by |
|---|---|
| `APIFY_TOKEN` | every actor |
| `OPENAI_API_KEY` | your `lib/llm/clients.ts` stub (all chat + embeddings) |
| `GEMINI_API_KEY` | your `gemini.ts` stub (video labels; optional) |
| `SUPABASE_URL`-style + service key | your own client construction (Adcero's are `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`; nothing in the copied files reads them) |

**Optional tuning** (defaults in parentheses):

- **Apify**
  - `APIFY_AD_LIBRARY_MAX_ADS` (250)
  - `APIFY_CONTROL_TIMEOUT_MS` (120000)
  - `APIFY_CALL_TIMEOUT_MS` (900000)
  - `BRAND_PRESENCE_REDDIT_RUN_MEMORY_MB` (1024)
  - `BRAND_PRESENCE_WEBSITE_ACTOR_ID`
- **Ad-library provider selection:** `AD_LIBRARY_PROVIDER` / `GOOGLE_AD_LIBRARY_PROVIDER` (`apify`)
- **Model overrides**
  - `ADLIB_LABEL_MODEL` (gpt-6-luna)
  - `ADLIB_VIDEO_LABEL_MODEL` (gemini-2.5-flash)
  - `ADLIB_VIDEO_LABEL_CONCURRENCY` (3)
  - `ADLIB_INDUSTRY_MODEL` (gpt-4o-mini)
  - `BRAND_IDENTITY_SUGGEST_MODEL` (gpt-5.4-mini)
  - `BRAND_PRESENCE_LLM_MODEL` (gpt-5.4-mini)
  - `BRAND_PRESENCE_RELEVANCE_MODEL` (gpt-5.4)
  - `BRAND_PRESENCE_EXTRACT_MODEL` (gpt-5.4-mini)
  - `BRAND_OBJECT_IDENTITY_MODEL` (gpt-5.4)
  - `BRAND_OBJECT_PERSONA_MODEL` (gpt-5.4)
- **Brand object**
  - `BRAND_OBJECT_CRAWL_TIER`
  - `BRAND_OBJECT_MONTHLY_LLM_CALL_CAP` (60)
- **LLM transport:** `LLM_FLEX_TIER` (on; `0` disables; flex works only on gpt-5.x models)
- **Read by `NODE_ENV`:** dev-only branches

`lib/llm/model-roles.ts` also lists ~25 unrelated role env vars (creative, policy, chat, …), which none of these areas read.

**Adcero-only, drop:** `R2_*` / `NEXT_PUBLIC_R2_*` (replaced by the disk stub), `CRON_SECRET`, `META_AD_LIBRARY_TOKEN`, `ADLIB_SCRAPE_CACHE_TTL_HOURS`, `ADLIB_ORG_DAILY_SYNC_CAP`, `BRAND_PRESENCE_ORG_IDS` and `NEXT_PUBLIC_*` mirrors, `DISTILLED_BRAND_REPORT_ORG_IDS`, `COMPETITOR_SIGNAL_OVERVIEW*`, `CHROMA_ORG_IDS`, `CREATIVE_STUDIO_ORG_IDS`, `AI_TRANSLATE_MODEL`.

**External services:**
- Apify: actors A1–A10 (the Google actor is a rental)
- OpenAI: chat completions with strict `json_schema`, flex tier optional; embeddings `text-embedding-3-small`
- Google Gemini (optional)
- Postgres via Supabase/PostgREST, with pgvector optional
- the brand and competitor websites, fetched SSRF-safe
- Google favicon service (UI)

---

## 10. Half-built or ambiguous (not guessed around)

1. **TikTok Hop-2 output field names are unpinned** (`tiktok-normalizer.ts` header). The normalizer probes candidate keys. Run one small live comments job and pin them before relying on TikTok.
2. **The Google Ads actor is a rental.** Rent it on the Apify account behind `APIFY_TOKEN`, or every Google sync fails at start.
3. **Meta keyword search sets active status twice.** The search URL hard-codes `active_status=all` while the input sets `scrapePageAds.activeStatus`. Which one wins for keyword searches was not verified statically.
4. **Instagram `perPostCommentCap = 20`** is commented as "the actor's hard max", but the actor's max is 50 (stale comment after a cost cut). In Adcero, the TikTok/IG comments-processor tests still assert the pre-cut caps and are known-red on `main` (`services/CLAUDE.md`).
5. **Reddit Run B** intent terms and the subreddit feed are switched off (`includeIntentTerms:false`, `subredditFeed.enabled:false`). Category-scope VOC therefore gets little Reddit input.
6. **Cluster thresholds** (`lib/brand-presence/config.ts`) are labelled placeholders calibrated on one dev corpus.
7. **`competitor_intel`** is a brand section with no writer. **`in_review`** is a legacy status, still allowed by the CHECK but never derived.
8. **Merchant language is hardcoded to English** (`quote-language.ts`), so non-English quotes are filtered out of verbatims.
9. **Every chunk refresh re-embeds.** Chunk content includes a metrics line, so any frequency change re-embeds the chunk.
10. **`brand_object_state.cost`** is read-merge-written, not an atomic increment, so concurrent writers can lose counts.
11. **There is no end-to-end in-repo harness for the Layer-3 chain.** The closest are `scripts/brand-object-{build,promote,distill}.ts` (in-process, not copied).
12. **The page shell, route handlers and worker are rewrites.** Nothing in `files.txt` serves HTTP or claims jobs by itself.

---

## 11. Adcero defects found during this export (not fixed — the task is read-only)

1. **Market distillation silently truncates its input — persisted-data bug.**
   - `services/job-processor/brand-object/market-processor.ts:249` reads `library_ads_enriched` with `.limit(AD_ROW_CAP=2000)`, with no `.order()` and no paging.
   - PostgREST caps a response at 1,000 rows (`app/api/CLAUDE.md`), so any brand whose competitor pool exceeds 1,000 ads distils `market_prior` facts from an arbitrary, non-deterministic subset. Those facts are written to `brand_facts`.
   - The copy + edit in §8.3 fixes it in your copy.
2. **`EnrichedAd.angle` is mistyped — type only, no runtime effect.**
   - `lib/brand-identity/types.ts` types it `Angle | null` (the 8 universal values), but the labeller writes industry tokens (e.g. `health_nutrition`), and the API spreads the view row (`serializeEnrichedAd`), which also carries `angle_universal`, a key absent from `EnrichedAd`.
   - Proven by typechecking the generated dashboard against Adcero's own type: 135 errors, all of this one kind.
   - `contracts.ts` types the runtime truth.
3. **Stale docs.**
   - `services/CLAUDE.md` still says the ad labeller is gpt-4o-mini; the code default is `gpt-6-luna` (`lib/llm/model-roles.ts:88`, commit `b2f033374`).
   - `lib/brand-object/market.ts:8-12` and `lib/brand-object/CLAUDE.md:85` describe market concept de-dup as ≥0.95 near-duplicates, but the code votes per 0.75 UPGMA family (`clusterId`).
4. **Stale config comment** — the Instagram `perPostCommentCap` (§10.4).

**Proposed follow-up session (Adcero repo), complete brief:**

> On `main` in admigo-1:
> 1. Page the read at `services/job-processor/brand-object/market-processor.ts:249`. Use `.order('id')` plus `.range()` until a short page; keep `AD_ROW_CAP` as a total ceiling. Tier-1 regression test: red without the fix, using the capped fake `tests/unit/attribution/pagination/capped-supabase.ts` pattern with more than 1,000 rows.
> 2. Widen `EnrichedAd.angle` to `string | null` and add `angle_universal: Angle | null` in `lib/brand-identity/types.ts`. Run `npm run typecheck` and fix consumers.
> 3. Correct the gpt-4o-mini mentions in `services/CLAUDE.md`, the 0.95 de-dup wording in `market.ts` and `lib/brand-object/CLAUDE.md`, and the Instagram cap comment in `lib/brand-presence/config.ts`.
>
> Commit with explicit pathspecs.

---

## 12. Recommended copy order and edit estimate

| step | what | effort |
|---|---|---|
| 1 | `rsync --files-from=files.txt`; `npm install` the `deps.json` set (`--prefer-dedupe`) | 15 min |
| 2 | Write the 18 stubs (§8.2); real work is only `lib/llm/clients.ts` (~80 LOC) and `r2-service` (~30 LOC) | 1.5–2 h |
| 3 | Apply the 11 copy + edits (§8.3) | 1–1.5 h |
| 4 | Create the tables (§13; drop org FKs/RLS) + `library_ads_enriched` view + `job_queue` + worker (~80 LOC) | 2–3 h |
| 5 | Smoke the pure core: run normalizers on `tests/fixtures/ad-library/apify-sample.json` (Adcero test fixture, not copied); run `buildDashboard` over `fixtures/competitor-analysis.json` rows | 30 min |
| 6 | Ingest: one Meta competitor sync (`adlib_sync_competitor` → label → embed), one Trustpilot + one Reddit source | 1–2 h (mostly actor wall time) |
| 7 | Distillation: `brand_object_crawl {chain:true}` after listening drains; verify `retrieveBrandSlice` | 1 h |
| 8 | Frontend: shell (§7.6) + route handlers that first return the fixtures, then real data | 2–3 h |
| 9 | Competitor Analysis page on fixtures → live; then Brand Identity page | 1–2 h |

**Total: roughly 1–1.5 focused dev-days.** About 300 LOC of new code (stubs + worker + shell), ~200 lines of deletions in copied files, and ~350 LOC of route handlers. No changes to the pure distillation, clustering or winner logic.

---

## 13. Appendix — schemas verbatim from source

Generated mechanically from `drizzle/schema.ts` and `drizzle/*.sql` at the source commit; nothing below is hand-edited.

### 13.1 `library_ads_enriched` view (`drizzle/0139_awesome_ironclad.sql`, latest definition)

```sql
CREATE VIEW "public"."library_ads_enriched" WITH (security_invoker = true) AS (SELECT la.id, la.organization_id, la.competitor_id, la.external_ad_id, la.platform, la.ad_snapshot_url, la.creative_bodies, la.creative_link_titles, la.page_name, la.publisher_platforms, la.delivery_start, la.delivery_stop, la.eu_total_reach, la.currency, la.spend_range, la.media_type, la.media_urls, la.video_urls, la.hosted_media_urls, la.hosted_video_urls, la.num_served_days, la.landing_url, la.landing_domain, la.raw_ref, la.first_seen_at, la.last_seen_at, al.hook_archetype, al.angle, al.angle_universal, al.persona, al.persona_universal, al.funnel_stage, al.format, al.style, al.aspect_ratio, al.fingerprint, al.offer_type, al.hook_text, al.summary, al.confidence, al.model AS label_model, al.labeled_at, GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(la.delivery_stop, CASE WHEN COALESCE(la.last_seen_at, now()) > now() - interval '32 days' THEN now() ELSE la.last_seen_at END) - la.delivery_start)) / 86400)::int AS longevity_days, (la.delivery_stop IS NULL AND la.last_seen_at > now() - interval '32 days') AS is_active FROM library_ads la LEFT JOIN ad_labels al ON al.library_ad_id = la.id);
```

### 13.2 `vector1536` column type (`drizzle/schema.ts:5397`)

```ts
const vector1536 = customType<{ data: number[]; driverValue: string }>({
  dataType() {
    return "vector(1536)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: unknown): number[] {
    return JSON.parse(value as string);
  },
});
```

### 13.3 `tracked_competitors` (`drizzle/schema.ts:6692-6860`)

```ts
export const trackedCompetitors = pgTable(
  "tracked_competitors",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    organizationId: uuid("organization_id").notNull(),
    // Which brand this competitor informs (agency multi-brand orgs). NULL =
    // org-shared: pre-feature rows and deliberate untagged competitors. The
    // Layer-3 market distillation prefers a brand's tagged set and falls back
    // to the org-wide pool only when a brand has zero tags.
    brandProfileId: uuid("brand_profile_id"),
    name: text().notNull(),
    // Which ad library this competitor is tracked on. Drives provider selection
    // and the dashboard platform filter. One row per platform (Meta "Nike" and
    // Google "Nike" are separate competitors).
    platform: text().default("meta").notNull(),
    // Keyword + country is the primary tracking model (Apify keyword search).
    // meta_page_id is retained, nullable, for the legacy page-based provider.
    keyword: text("keyword"),
    country: text("country").default("US").notNull(),
    // Page tracking: the user-entered vanity handle (e.g. "uprootclean").
    // meta_page_id is resolved/backfilled from the scraped ads after sync.
    pageRef: text("page_ref"),
    metaPageId: text("meta_page_id"),
    metaPageName: text("meta_page_name"),
    // Google Ads Transparency Center identity. advertiser_id is the public
    // AR… id parsed from the pasted Transparency URL at create; advertiser_name
    // is backfilled from the scraped ads after the first sync (mirrors the
    // meta_page_id/meta_page_name backfill).
    googleAdvertiserId: text("google_advertiser_id"),
    googleAdvertiserName: text("google_advertiser_name"),
    // Advertiser vertical (e.g. 'beauty'). Set on the global Industry Explorer
    // catalog pseudo-competitors owned by INDUSTRY_CATALOG_ORG_ID (see
    // lib/brand-identity/industries.ts) AND auto-classified on real user
    // competitors at sync, where it picks the label angle vocabulary. Never use
    // it to tell the two apart: a catalog seed is identified by its owning org
    // (the daily sync excludes seeds with `.neq('organization_id',
    // INDUSTRY_CATALOG_ORG_ID)`; the biweekly industry-ads-refresh cron drives them).
    industry: text("industry"),
    // Advertiser archetype driving win-profile selection. User-settable;
    // defaults to neutral 'unknown'. An advisory classifier may suggest a value
    // (into scores.brandTypeSuggestion) but never auto-commits this column.
    brandType: text("brand_type").default("unknown").notNull(),
    // First-party marker: TRUE when this row is the BRAND'S OWN public Facebook
    // Page (scraped through the same Apify ad-library pipeline as a competitor,
    // but routed to identity, not market). Set only alongside a brand_profile_id.
    // The market distillation EXCLUDES these rows (self-ads must never count as
    // competitive-market signal); identity INCLUDES their ad copy; the
    // competitor list HIDES them. Default false keeps every existing row a
    // competitor. See app/brand-identity + services/job-processor/brand-object.
    isBrandSelf: boolean("is_brand_self").default(false).notNull(),
    status: text().default("active").notNull(),
    lastSyncedAt: timestamp("last_synced_at", {
      withTimezone: true,
      mode: "string",
    }),
    // In-flight Apify run checkpoint so a cron-resumed sync polls the existing
    // run instead of starting a new (billable) one.
    syncRunId: text("sync_run_id"),
    syncRunStartedAt: timestamp("sync_run_started_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    tags: jsonb("tags").default({}).notNull(),
    scores: jsonb("scores").default({}).notNull(),
    entityConstraints: jsonb("entity_constraints").default({}).notNull(),
    editHistory: jsonb("edit_history").default([]).notNull(),
  },
  (table) => [
    uniqueIndex("tracked_competitors_org_page_unique").using(
      "btree",
      table.organizationId.asc().nullsLast().op("uuid_ops"),
      table.metaPageId.asc().nullsLast().op("text_ops"),
    ),
    // One saved search per (org, keyword, country). NULL keyword rows (legacy
    // page-based competitors) are distinct under Postgres NULL semantics.
    uniqueIndex("tracked_competitors_org_keyword_country_unique").using(
      "btree",
      table.organizationId.asc().nullsLast().op("uuid_ops"),
      table.keyword.asc().nullsLast().op("text_ops"),
      table.country.asc().nullsLast().op("text_ops"),
    ),
    // One Google advertiser per org. NULL google_advertiser_id rows (every Meta
    // competitor, plus a Google row before its AR id is parsed) are distinct
    // under Postgres NULL semantics, so this does not collide with Meta rows.
    uniqueIndex("tracked_competitors_org_google_unique").using(
      "btree",
      table.organizationId.asc().nullsLast().op("uuid_ops"),
      table.googleAdvertiserId.asc().nullsLast().op("text_ops"),
    ),
    index("idx_tracked_competitors_org_status").using(
      "btree",
      table.organizationId.asc().nullsLast().op("uuid_ops"),
      table.status.asc().nullsLast().op("text_ops"),
    ),
    index("idx_tracked_competitors_brand_profile").using(
      "btree",
      table.brandProfileId.asc().nullsLast().op("uuid_ops"),
    ),
    // Industry Explorer catalog lookups: "all active seeds for industry X on
    // platform Y".
    index("idx_tracked_competitors_industry_platform").using(
      "btree",
      table.industry.asc().nullsLast().op("text_ops"),
      table.platform.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
      name: "tracked_competitors_organization_id_fkey",
    }).onDelete("cascade"),
    // SET NULL: removing a brand must never delete tracking data — the row
    // falls back to the org-shared pool (saved_ads no-FK precedent, softened).
    foreignKey({
      columns: [table.brandProfileId],
      foreignColumns: [brandPresenceProfiles.id],
      name: "tracked_competitors_brand_profile_id_fkey",
    }).onDelete("set null"),
    check(
      "tracked_competitors_status_check",
      sql`status = ANY (ARRAY['active'::text, 'paused'::text])`,
    ),
    check(
      "tracked_competitors_platform_check",
      sql`platform = ANY (ARRAY['meta'::text, 'google'::text, 'twitter'::text])`,
    ),
    check(
      "tracked_competitors_brand_type_check",
      sql`brand_type = ANY (ARRAY['dtc_performance'::text, 'brand_cpg'::text, 'unknown'::text])`,
    ),
    pgPolicy("Service role full access for tracked_competitors", {
      as: "permissive",
      for: "all",
      to: ["service_role"],
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy("Org members can view tracked_competitors", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`check_organization_membership(organization_id, (select auth.uid()))`,
    }),
    pgPolicy("Org members can insert tracked_competitors", {
      as: "permissive",
      for: "insert",
      to: ["authenticated"],
      withCheck: sql`check_organization_membership(organization_id, (select auth.uid()))`,
    }),
    pgPolicy("Org members can update tracked_competitors", {
      as: "permissive",
      for: "update",
      to: ["authenticated"],
      using: sql`check_organization_membership(organization_id, (select auth.uid()))`,
      withCheck: sql`check_organization_membership(organization_id, (select auth.uid()))`,
    }),
    pgPolicy("Org members can delete tracked_competitors", {
      as: "permissive",
      for: "delete",
      to: ["authenticated"],
      using: sql`check_organization_membership(organization_id, (select auth.uid()))`,
    }),
  ],
);
```

### 13.4 `library_ads` (`drizzle/schema.ts:6862-6979`)

```ts
export const libraryAds = pgTable(
  "library_ads",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    organizationId: uuid("organization_id").notNull(),
    competitorId: uuid("competitor_id").notNull(),
    externalAdId: text("external_ad_id").notNull(),
    platform: text().default("meta").notNull(),
    adSnapshotUrl: text("ad_snapshot_url"),
    creativeBodies: jsonb("creative_bodies").default([]).notNull(),
    creativeLinkTitles: jsonb("creative_link_titles").default([]).notNull(),
    pageName: text("page_name"),
    publisherPlatforms: jsonb("publisher_platforms").default([]).notNull(),
    deliveryStart: timestamp("delivery_start", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    deliveryStop: timestamp("delivery_stop", {
      withTimezone: true,
      mode: "string",
    }),
    euTotalReach: integer("eu_total_reach"),
    currency: text(),
    spendRange: jsonb("spend_range"),
    mediaType: text("media_type").default("unknown").notNull(),
    mediaUrls: jsonb("media_urls"),
    // Playable video URLs (mp4) for video/carousel ads; media_urls holds the
    // still-image posters used for thumbnails.
    videoUrls: jsonb("video_urls"),
    // Permanent R2 copies of media_urls; raw fbcdn URLs expire within days.
    hostedMediaUrls: jsonb("hosted_media_urls"),
    // Permanent R2 copies of video_urls; raw fbcdn URLs expire within days.
    hostedVideoUrls: jsonb("hosted_video_urls"),
    // Google only: the Transparency Center actor's own served-day count. Used as
    // the longevity basis for Google win scoring (immune to the lastShown-lag
    // that distorts the firstSeen→lastSeen span). Null for Meta/TikTok.
    numServedDays: integer("num_served_days"),
    // Destination URL (Meta snapshot.link_url / Google variations[].clickUrl)
    // and its normalized domain — the cross-platform brand-pairing key.
    landingUrl: text("landing_url"),
    landingDomain: text("landing_domain"),
    rawRef: text("raw_ref"),
    firstSeenAt: timestamp("first_seen_at", {
      withTimezone: true,
      mode: "string",
    })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    lastSeenAt: timestamp("last_seen_at", {
      withTimezone: true,
      mode: "string",
    })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    tags: jsonb("tags").default({}).notNull(),
    scores: jsonb("scores").default({}).notNull(),
    entityConstraints: jsonb("entity_constraints").default({}).notNull(),
    editHistory: jsonb("edit_history").default([]).notNull(),
  },
  (table) => [
    // Idempotency key for upserts. Includes platform so a Google creative id
    // can never collide with a Meta ad id within the same org.
    uniqueIndex("library_ads_org_platform_external_ad_unique").using(
      "btree",
      table.organizationId.asc().nullsLast().op("uuid_ops"),
      table.platform.asc().nullsLast().op("text_ops"),
      table.externalAdId.asc().nullsLast().op("text_ops"),
    ),
    index("idx_library_ads_org_competitor_delivery").using(
      "btree",
      table.organizationId.asc().nullsLast().op("uuid_ops"),
      table.competitorId.asc().nullsLast().op("uuid_ops"),
      table.deliveryStart.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("idx_library_ads_competitor_first_seen").using(
      "btree",
      table.competitorId.asc().nullsLast().op("uuid_ops"),
      table.firstSeenAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
      name: "library_ads_organization_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.competitorId],
      foreignColumns: [trackedCompetitors.id],
      name: "library_ads_competitor_id_fkey",
    }).onDelete("cascade"),
    check(
      "library_ads_platform_check",
      sql`platform = ANY (ARRAY['meta'::text, 'tiktok'::text, 'google'::text, 'twitter'::text])`,
    ),
    check(
      "library_ads_media_type_check",
      sql`media_type = ANY (ARRAY['image'::text, 'video'::text, 'carousel'::text, 'text'::text, 'unknown'::text])`,
    ),
    pgPolicy("Service role full access for library_ads", {
      as: "permissive",
      for: "all",
      to: ["service_role"],
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy("Org members can view library_ads", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`check_organization_membership(organization_id, (select auth.uid()))`,
    }),
  ],
);
```

### 13.5 `ad_labels` (`drizzle/schema.ts:6981-7079`)

```ts
export const adLabels = pgTable(
  "ad_labels",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    organizationId: uuid("organization_id").notNull(),
    libraryAdId: uuid("library_ad_id").notNull(),
    hookArchetype: text("hook_archetype").notNull(),
    angle: text().notNull(),
    // Industry-specific high-resolution motivation lives in `angle`; this holds
    // the stable global angle (label-taxonomy ANGLES) for cross-industry
    // comparison. Nullable: legacy rows and unrelabelled ads have no value yet.
    angleUniversal: text("angle_universal"),
    // Persona: the specific customer group the ad speaks to. `persona` holds the
    // industry-specific high-resolution value (getPersonaVocabulary(industry));
    // `persona_universal` holds the stable universal persona (label-taxonomy
    // PERSONAS) for cross-industry comparison. `funnel_stage` is the funnel
    // position (FUNNEL_STAGES). All nullable: legacy rows and pre-v2 ads have no
    // value yet (Label Taxonomy v2, migration 0092).
    persona: text(),
    personaUniversal: text("persona_universal"),
    funnelStage: text("funnel_stage"),
    format: text().notNull(),
    // Creative fingerprint (visual judgments; nullable — legacy rows and
    // text-only labelling have no visual context). `style` is the visual
    // aesthetic (label-taxonomy VISUAL_STYLES) under the same `style` dimension
    // name the creative-engine genome/performance_memory rollup keys on;
    // `aspect_ratio` is derived deterministically from the poster dimensions;
    // `fingerprint` holds the AdFingerprint attribute object.
    style: text(),
    aspectRatio: text("aspect_ratio"),
    fingerprint: jsonb(),
    offerType: text("offer_type"),
    hookText: text("hook_text"),
    summary: text(),
    confidence: numeric(),
    model: text().notNull(),
    labeledAt: timestamp("labeled_at", { withTimezone: true, mode: "string" })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    tags: jsonb("tags").default({}).notNull(),
    scores: jsonb("scores").default({}).notNull(),
    entityConstraints: jsonb("entity_constraints").default({}).notNull(),
    editHistory: jsonb("edit_history").default([]).notNull(),
  },
  (table) => [
    uniqueIndex("ad_labels_library_ad_unique").using(
      "btree",
      table.libraryAdId.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_ad_labels_org_id").using(
      "btree",
      table.organizationId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
      name: "ad_labels_organization_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.libraryAdId],
      foreignColumns: [libraryAds.id],
      name: "ad_labels_library_ad_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("Service role full access for ad_labels", {
      as: "permissive",
      for: "all",
      to: ["service_role"],
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy("Org members can view ad_labels", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`check_organization_membership(organization_id, (select auth.uid()))`,
    }),
  ],
);

/**
 * One label row per OWN synced ad (the org's own `ads`, not competitor
 * `library_ads`). Runs the org's ads through the SAME LLM label pipeline the
 * competitor path uses (label-processor pure pieces), so the creative-fingerprint
 * taxonomy becomes a learnable signal against the org's own spend (a later PR
 * joins it to performance_memory). Mirrors the `ad_labels` v2 column set.
 *
 * Identity is the composite `(organization_id, ad_id)` — `ad_id` is a TEXT
 * platform id (the same shape as `ads`), NOT a uuid. The unique
 * `(organization_id, ad_id)` is the upsert key; the composite FK
 * `(ad_id, organization_id) → ads(ad_id, organization_id)` (cascade) mirrors the
 * `ads → ad_sets/campaigns` composite-FK precedent. Written by the
 * `own_ad_label_batch` job, driven by the daily `/api/jobs/own-ad-label-sync`
 * cron. A row whose `tags.taxonomyVersion` is behind the current version is
 * refreshed on the next pass (the upsert relabels it) — a taxonomy bump re-labels
 * own ads with no delete pass.
 */
```

### 13.6 `ad_embeddings` (`drizzle/schema.ts:7232-7304`)

```ts
export const adEmbeddings = pgTable(
  "ad_embeddings",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    organizationId: uuid("organization_id").notNull(),
    libraryAdId: uuid("library_ad_id").notNull(),
    embedding: vector1536("embedding").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    embeddingDims: integer("embedding_dims").notNull(),
    contentHash: text("content_hash").notNull(),
    embeddedAt: timestamp("embedded_at", { withTimezone: true, mode: "string" })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    tags: jsonb("tags").default({}).notNull(),
    scores: jsonb("scores").default({}).notNull(),
    entityConstraints: jsonb("entity_constraints").default({}).notNull(),
    editHistory: jsonb("edit_history").default([]).notNull(),
  },
  (table) => [
    uniqueIndex("ad_embeddings_library_ad_unique").using(
      "btree",
      table.libraryAdId.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_ad_embeddings_org_library_ad").using(
      "btree",
      table.organizationId.asc().nullsLast().op("uuid_ops"),
      table.libraryAdId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
      name: "ad_embeddings_organization_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.libraryAdId],
      foreignColumns: [libraryAds.id],
      name: "ad_embeddings_library_ad_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("Service role full access for ad_embeddings", {
      as: "permissive",
      for: "all",
      to: ["service_role"],
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy("Org members can view ad_embeddings", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`check_organization_membership(organization_id, (select auth.uid()))`,
    }),
  ],
);

/**
 * Cross-organization scrape cache for ad-library provider results.
 *
 * DELIBERATELY NOT ORG-SCOPED: rows hold normalized public ad-transparency
 * data (Meta Ad Library / Google Transparency Center) keyed by the canonical
 * scrape identity, so N orgs tracking the same advertiser pay for ONE Apify
 * run instead of N. `fetched_by_organization_id` is provenance only (SET NULL
 * on org delete — the cached public data outlives the org that paid for it).
 * `run_id`/`run_started_at` checkpoint an in-flight provider run so a second
 * org syncing the same identity adopts (polls) the already-billed run instead
 * of starting another. Service-role-only RLS: this is backend job
 * infrastructure, never read by browser clients.
 */
```

### 13.7 `brand_presence_profiles` (`drizzle/schema.ts:9081-9178`)

```ts
export const brandPresenceProfiles = pgTable(
  "brand_presence_profiles",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    organizationId: uuid("organization_id").notNull(),
    websiteUrl: text("website_url").notNull(),
    brandName: text("brand_name").notNull(),
    // string[] — the exact search variants Run A uses (name, spaced name,
    // domain-without-TLD, @handle) and the relevance gate disambiguates with.
    nameVariants: jsonb("name_variants").default([]).notNull(),
    productDescription: text("product_description"),
    category: text("category"),
    // string[] — competitor names (seeded from Layer 1 tracked_competitors
    // when present, merged with LLM candidates; founder-editable).
    competitors: jsonb("competitors").default([]).notNull(),
    // draft = extracted, awaiting founder confirmation; confirmed = scraping
    // pipeline may run. Re-discovery never stomps a confirmed profile.
    status: text().default("draft").notNull(),
    // Brand Presence's 2-brand model: `self` = the org's own brand,
    // `competitor` = the single competitor brand tracked for comparison. NULL =
    // a legacy/agency profile predating the model (kept, never auto-labeled).
    // At most one `self` + one `competitor` per org — enforced in the
    // start-discovery route (Brand Presence is separate from Competitor
    // Analysis's tracked_competitors ad-library tracking).
    presenceRole: text("presence_role"),
    // Amazon Reviews source config: marketplace domain code ('com', 'co.uk',
    // …), the founder-pasted storefront URL, and pasted product URLs
    // (string[]). The founder supplying these IS the ownership gate — every
    // ASIN extracted from them is theirs by construction.
    amazonMarketplace: text("amazon_marketplace").default("com").notNull(),
    amazonStorefrontUrl: text("amazon_storefront_url"),
    amazonProductUrls: jsonb("amazon_product_urls").default([]).notNull(),
    // Job checkpoints + candidate caches (subredditDiscovery phase state).
    meta: jsonb("meta").default({}).notNull(),
    // Per-brand creative brand kit (logo/colors/fonts/productImages —
    // OrganizationBrandAssets shape). NULL = not configured for this brand.
    // Migration 0138 moved the kit here from organizations.settings.brandAssets
    // so a multi-brand org's profiles never share reference product images.
    brandKit: jsonb("brand_kit"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    tags: jsonb("tags").default({}).notNull(),
    scores: jsonb("scores").default({}).notNull(),
    entityConstraints: jsonb("entity_constraints").default({}).notNull(),
    editHistory: jsonb("edit_history").default([]).notNull(),
  },
  (table) => [
    // Multi-brand: an org (agency) can track several brand profiles. Children
    // already key on brand_profile_id; routes resolve a specific profile by id
    // (validated to belong to the org). Plain org index serves the
    // profiles-list read.
    index("idx_brand_presence_profiles_org").using(
      "btree",
      table.organizationId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
      name: "brand_presence_profiles_organization_id_fkey",
    }).onDelete("cascade"),
    check(
      "brand_presence_profiles_status_check",
      sql`status = ANY (ARRAY['draft'::text, 'confirmed'::text])`,
    ),
    check(
      "brand_presence_profiles_presence_role_check",
      sql`presence_role IS NULL OR presence_role = ANY (ARRAY['self'::text, 'competitor'::text])`,
    ),
    pgPolicy("Service role full access for brand_presence_profiles", {
      as: "permissive",
      for: "all",
      to: ["service_role"],
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy("Org members can view brand_presence_profiles", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`check_organization_membership(organization_id, (select auth.uid()))`,
    }),
  ],
);

/**
 * Brand Presence source registry: one row per listening source. Drives the
 * dashboard card grid AND the scrape jobs. Future source types (Amazon,
 * Trustpilot, …) are seeded now as coming_soon rows so adding one later is a
 * new adapter + a registry flip, zero page rework. meta carries the refresh
 * cursor (lastPostedAt), the in-flight scrape checkpoint (sync: runId /
 * datasetId / phase / datasetOffset), core|adjacent classification for
 * subreddits, per-source cap overrides, and advisory flags
 * (genericBrandName).
 */
```

### 13.8 `brand_presence_sources` (`drizzle/schema.ts:9179-9260`)

```ts
export const brandPresenceSources = pgTable(
  "brand_presence_sources",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    organizationId: uuid("organization_id").notNull(),
    brandProfileId: uuid("brand_profile_id").notNull(),
    sourceType: text("source_type").notNull(),
    // e.g. subreddit url/name for reddit_subreddit; '' for search-based
    // sources (NOT NULL so the (profile, type, uri) unique key dedupes seeds).
    uri: text().default("").notNull(),
    label: text(),
    status: text().default("available").notNull(),
    meta: jsonb("meta").default({}).notNull(),
    lastSyncedAt: timestamp("last_synced_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    tags: jsonb("tags").default({}).notNull(),
    scores: jsonb("scores").default({}).notNull(),
    entityConstraints: jsonb("entity_constraints").default({}).notNull(),
    editHistory: jsonb("edit_history").default([]).notNull(),
  },
  (table) => [
    uniqueIndex("brand_presence_sources_profile_type_uri_unique").using(
      "btree",
      table.brandProfileId.asc().nullsLast().op("uuid_ops"),
      table.sourceType.asc().nullsLast().op("text_ops"),
      table.uri.asc().nullsLast().op("text_ops"),
    ),
    index("idx_brand_presence_sources_org").using(
      "btree",
      table.organizationId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
      name: "brand_presence_sources_organization_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.brandProfileId],
      foreignColumns: [brandPresenceProfiles.id],
      name: "brand_presence_sources_brand_profile_id_fkey",
    }).onDelete("cascade"),
    check(
      "brand_presence_sources_source_type_check",
      sql`source_type = ANY (ARRAY['reddit_search'::text, 'reddit_subreddit'::text, 'reddit_category'::text, 'amazon_reviews'::text, 'google_maps_reviews'::text, 'instagram_comments'::text, 'tiktok_comments'::text, 'trustpilot'::text, 'onsite_reviews'::text, 'youtube'::text, 'x'::text])`,
    ),
    check(
      "brand_presence_sources_status_check",
      sql`status = ANY (ARRAY['available'::text, 'coming_soon'::text, 'pending'::text, 'running'::text, 'synced'::text, 'error'::text])`,
    ),
    pgPolicy("Service role full access for brand_presence_sources", {
      as: "permissive",
      for: "all",
      to: ["service_role"],
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy("Org members can view brand_presence_sources", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`check_organization_membership(organization_id, (select auth.uid()))`,
    }),
  ],
);

/**
 * Normalized brand/category mentions — the heart of Layer 2. Every scrape
 * mode upserts on (brand_profile_id, platform, external_id): that key is the
 * at-least-once idempotency contract (kill the worker mid-run, restart, no
 * duplicates). Rows are never deleted — status transitions only. source_id
 * is informational (first writer) and survives source removal via SET NULL.
 * author_ref is a sha256 hash of the platform username; raw identities are
 * never stored and no per-user profiles are built.
 */
```

### 13.9 `brand_mentions` (`drizzle/schema.ts:9261-9396`)

```ts
export const brandMentions = pgTable(
  "brand_mentions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    organizationId: uuid("organization_id").notNull(),
    brandProfileId: uuid("brand_profile_id").notNull(),
    sourceId: uuid("source_id"),
    platform: text().default("reddit").notNull(),
    externalId: text("external_id").notNull(),
    dataType: text("data_type").notNull(),
    // brand = names the user's brand; competitor = names a tracked competitor;
    // category = ambient category discussion (Run B communities + thread
    // children). All gated by the relevance job except category/not_required.
    scope: text().notNull(),
    url: text(),
    subreddit: text(),
    authorRef: text("author_ref"),
    title: text(),
    body: text(),
    // For comments: external_id of the parent post (Reddit-style threading);
    // NULL for posts. parentTitle is the parent post title parsed from the
    // actor's synthetic "/u/X on <title>" comment title (display context).
    parentExternalId: text("parent_external_id"),
    parentTitle: text("parent_title"),
    postedAt: timestamp("posted_at", { withTimezone: true, mode: "string" }),
    // pending = awaiting the LLM gate; not_required = category-scope items
    // that skip the gate. A decided relevant/irrelevant is never reset.
    relevance: text().default("pending").notNull(),
    relevanceConfidence: numeric("relevance_confidence"),
    // Star rating for review-platform mentions (Amazon: 1.0–5.0); NULL for
    // platforms without ratings (Reddit).
    rating: numeric(),
    // Phrase-extraction lifecycle: pending = awaiting the extract job; done =
    // extracted (possibly zero phrases); skipped = judged irrelevant, never
    // extracted; error = extraction failed permanently.
    extractionStatus: text("extraction_status").default("pending").notNull(),
    // Raw structured output of the extract job (audit/debug), null until done.
    extraction: jsonb("extraction"),
    // R2 key of the raw dataset page this item arrived in.
    rawRef: text("raw_ref"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    tags: jsonb("tags").default({}).notNull(),
    scores: jsonb("scores").default({}).notNull(),
    entityConstraints: jsonb("entity_constraints").default({}).notNull(),
    editHistory: jsonb("edit_history").default([]).notNull(),
  },
  (table) => [
    uniqueIndex("brand_mentions_profile_platform_external_unique").using(
      "btree",
      table.brandProfileId.asc().nullsLast().op("uuid_ops"),
      table.platform.asc().nullsLast().op("text_ops"),
      table.externalId.asc().nullsLast().op("text_ops"),
    ),
    // Mentions feed hot path: newest-first within a brand.
    index("idx_brand_mentions_profile_posted_at").using(
      "btree",
      table.brandProfileId.asc().nullsLast().op("uuid_ops"),
      table.postedAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("idx_brand_mentions_source").using(
      "btree",
      table.sourceId.asc().nullsLast().op("uuid_ops"),
    ),
    // Thread assembly + verdict propagation: children of a post by parent id.
    index("idx_brand_mentions_profile_parent").using(
      "btree",
      table.brandProfileId.asc().nullsLast().op("uuid_ops"),
      table.parentExternalId.asc().nullsLast().op("text_ops"),
    ),
    index("idx_brand_mentions_org").using(
      "btree",
      table.organizationId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
      name: "brand_mentions_organization_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.brandProfileId],
      foreignColumns: [brandPresenceProfiles.id],
      name: "brand_mentions_brand_profile_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.sourceId],
      foreignColumns: [brandPresenceSources.id],
      name: "brand_mentions_source_id_fkey",
    }).onDelete("set null"),
    // Extract gather hot path: pending mentions within a brand.
    index("idx_brand_mentions_profile_extraction").using(
      "btree",
      table.brandProfileId.asc().nullsLast().op("uuid_ops"),
      table.extractionStatus.asc().nullsLast().op("text_ops"),
    ),
    check(
      "brand_mentions_data_type_check",
      sql`data_type = ANY (ARRAY['post'::text, 'comment'::text, 'review'::text])`,
    ),
    check(
      "brand_mentions_extraction_status_check",
      sql`extraction_status = ANY (ARRAY['pending'::text, 'done'::text, 'skipped'::text, 'error'::text])`,
    ),
    check(
      "brand_mentions_scope_check",
      sql`scope = ANY (ARRAY['brand'::text, 'competitor'::text, 'category'::text])`,
    ),
    check(
      "brand_mentions_relevance_check",
      sql`relevance = ANY (ARRAY['pending'::text, 'relevant'::text, 'irrelevant'::text, 'not_required'::text])`,
    ),
    pgPolicy("Service role full access for brand_mentions", {
      as: "permissive",
      for: "all",
      to: ["service_role"],
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy("Org members can view brand_mentions", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`check_organization_membership(organization_id, (select auth.uid()))`,
    }),
  ],
);

/**
 * Amazon product (ASIN) registry driving the per-product review-scrape
 * fan-out. Rows come from the founder's storefront/product URLs; `selected`
 * is the founder's include/exclude toggle (deselected products are never
 * scraped). meta holds the in-flight scrape checkpoint (sync: runId /
 * datasetId / phase / datasetOffset) and lastError — crash-resume state, same
 * contract as brand_presence_sources.meta.
 */
```

### 13.10 `brand_presence_tiktok_videos` (`drizzle/schema.ts:9503-9601`)

```ts
export const brandPresenceTiktokVideos = pgTable(
  "brand_presence_tiktok_videos",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    organizationId: uuid("organization_id").notNull(),
    brandProfileId: uuid("brand_profile_id").notNull(),
    sourceId: uuid("source_id"),
    videoId: text("video_id").notNull(),
    url: text().notNull(),
    // Hop-1 caption ('text') — the normalize-time parent_title source
    // (Hop-2 comment items carry no caption).
    caption: text(),
    postedAt: timestamp("posted_at", { withTimezone: true, mode: "string" }),
    commentCount: integer("comment_count").default(0).notNull(),
    baselineCommentCount: integer("baseline_comment_count")
      .default(0)
      .notNull(),
    commentsIngested: integer("comments_ingested").default(0).notNull(),
    lastEnumeratedAt: timestamp("last_enumerated_at", {
      withTimezone: true,
      mode: "string",
    }),
    lastScrapedAt: timestamp("last_scraped_at", {
      withTimezone: true,
      mode: "string",
    }),
    meta: jsonb("meta").default({}).notNull(),
    firstSeenAt: timestamp("first_seen_at", {
      withTimezone: true,
      mode: "string",
    })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    tags: jsonb("tags").default({}).notNull(),
    scores: jsonb("scores").default({}).notNull(),
    entityConstraints: jsonb("entity_constraints").default({}).notNull(),
    editHistory: jsonb("edit_history").default([]).notNull(),
  },
  (table) => [
    // Keyed on the profile, not source_id (nullable SET NULL — NULLs are
    // distinct under Postgres and cannot anchor uniqueness); there is
    // exactly one tiktok_comments source per brand (uri='').
    uniqueIndex("brand_presence_tiktok_videos_profile_video_unique").using(
      "btree",
      table.brandProfileId.asc().nullsLast().op("uuid_ops"),
      table.videoId.asc().nullsLast().op("text_ops"),
    ),
    index("idx_brand_presence_tiktok_videos_org").using(
      "btree",
      table.organizationId.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_brand_presence_tiktok_videos_source").using(
      "btree",
      table.sourceId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
      name: "brand_presence_tiktok_videos_organization_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.brandProfileId],
      foreignColumns: [brandPresenceProfiles.id],
      name: "brand_presence_tiktok_videos_brand_profile_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.sourceId],
      foreignColumns: [brandPresenceSources.id],
      name: "brand_presence_tiktok_videos_source_id_fkey",
    }).onDelete("set null"),
    pgPolicy("Service role full access for brand_presence_tiktok_videos", {
      as: "permissive",
      for: "all",
      to: ["service_role"],
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy("Org members can view brand_presence_tiktok_videos", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`check_organization_membership(organization_id, (select auth.uid()))`,
    }),
  ],
);

/**
 * Instagram per-post registry — the brand_presence_tiktok_videos twin for
 * the instagram_comments source (same two-hop delta contract: comment_count
 * is the latest enumerated value, baseline_comment_count advances ONLY when
 * the post's comments were actually scraped; a partial Hop-2 failure never
 * advances the baseline for the failed posts). post_id is the Instagram
 * SHORTCODE (the URL key every actor mode round-trips). kind keeps posts
 * and reels uniformly handled — reels are a separate actor resultsType but
 * one registry, one selection policy.
 */
```

### 13.11 `brand_presence_instagram_posts` (`drizzle/schema.ts:9602-9699`)

```ts
export const brandPresenceInstagramPosts = pgTable(
  "brand_presence_instagram_posts",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    organizationId: uuid("organization_id").notNull(),
    brandProfileId: uuid("brand_profile_id").notNull(),
    sourceId: uuid("source_id"),
    postId: text("post_id").notNull(),
    kind: text().default("post").notNull(),
    url: text().notNull(),
    // Hop-1 caption — the normalize-time parent_title source (comments-mode
    // items carry no caption).
    caption: text(),
    postedAt: timestamp("posted_at", { withTimezone: true, mode: "string" }),
    commentCount: integer("comment_count").default(0).notNull(),
    baselineCommentCount: integer("baseline_comment_count")
      .default(0)
      .notNull(),
    commentsIngested: integer("comments_ingested").default(0).notNull(),
    lastEnumeratedAt: timestamp("last_enumerated_at", {
      withTimezone: true,
      mode: "string",
    }),
    lastScrapedAt: timestamp("last_scraped_at", {
      withTimezone: true,
      mode: "string",
    }),
    meta: jsonb("meta").default({}).notNull(),
    firstSeenAt: timestamp("first_seen_at", {
      withTimezone: true,
      mode: "string",
    })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    tags: jsonb("tags").default({}).notNull(),
    scores: jsonb("scores").default({}).notNull(),
    entityConstraints: jsonb("entity_constraints").default({}).notNull(),
    editHistory: jsonb("edit_history").default([]).notNull(),
  },
  (table) => [
    // Keyed on the profile, not source_id (nullable SET NULL — NULLs are
    // distinct under Postgres and cannot anchor uniqueness); there is
    // exactly one instagram_comments source per brand (uri='').
    uniqueIndex("brand_presence_instagram_posts_profile_post_unique").using(
      "btree",
      table.brandProfileId.asc().nullsLast().op("uuid_ops"),
      table.postId.asc().nullsLast().op("text_ops"),
    ),
    index("idx_brand_presence_instagram_posts_org").using(
      "btree",
      table.organizationId.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_brand_presence_instagram_posts_source").using(
      "btree",
      table.sourceId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
      name: "brand_presence_instagram_posts_organization_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.brandProfileId],
      foreignColumns: [brandPresenceProfiles.id],
      name: "brand_presence_instagram_posts_brand_profile_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.sourceId],
      foreignColumns: [brandPresenceSources.id],
      name: "brand_presence_instagram_posts_source_id_fkey",
    }).onDelete("set null"),
    pgPolicy("Service role full access for brand_presence_instagram_posts", {
      as: "permissive",
      for: "all",
      to: ["service_role"],
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy("Org members can view brand_presence_instagram_posts", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`check_organization_membership(organization_id, (select auth.uid()))`,
    }),
  ],
);

/**
 * Voice-of-customer THEMES — DERIVED data. Each clustering run deletes and
 * rebuilds a brand's themes wholesale (insert new cluster_run_id → repoint
 * phrases.theme_id → delete stale run rows). This is the ONE sanctioned
 * delete in Layer 2; mentions and phrases are source data and are never
 * deleted. representative_phrase_ids are the 3 nearest-to-centroid member
 * phrase ids, rendered verbatim in the UI.
 */
```

### 13.12 `brand_presence_themes` (`drizzle/schema.ts:9700-9786`)

```ts
export const brandPresenceThemes = pgTable(
  "brand_presence_themes",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    organizationId: uuid("organization_id").notNull(),
    brandProfileId: uuid("brand_profile_id").notNull(),
    kind: text().notNull(),
    scope: text().notNull(),
    label: text().notNull(),
    summary: text(),
    // Per-(kind × scope) bucket for low-signal singleton phrases that don't
    // merit their own theme (non-severe singles).
    isCatchall: boolean("is_catchall").default(false).notNull(),
    // Member phrase count.
    frequency: integer().default(0).notNull(),
    // Distinct underlying mentions.
    mentionCount: integer("mention_count").default(0).notNull(),
    avgSentiment: numeric("avg_sentiment"),
    representativePhraseIds: jsonb("representative_phrase_ids")
      .default([])
      .notNull(),
    clusterRunId: uuid("cluster_run_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    tags: jsonb("tags").default({}).notNull(),
    scores: jsonb("scores").default({}).notNull(),
    entityConstraints: jsonb("entity_constraints").default({}).notNull(),
    editHistory: jsonb("edit_history").default([]).notNull(),
  },
  (table) => [
    index("idx_brand_presence_themes_profile_kind_scope").using(
      "btree",
      table.brandProfileId.asc().nullsLast().op("uuid_ops"),
      table.kind.asc().nullsLast().op("text_ops"),
      table.scope.asc().nullsLast().op("text_ops"),
    ),
    index("idx_brand_presence_themes_org").using(
      "btree",
      table.organizationId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
      name: "brand_presence_themes_organization_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.brandProfileId],
      foreignColumns: [brandPresenceProfiles.id],
      name: "brand_presence_themes_brand_profile_id_fkey",
    }).onDelete("cascade"),
    check(
      "brand_presence_themes_kind_check",
      sql`kind = ANY (ARRAY['pain'::text, 'desire'::text, 'objection'::text, 'praise'::text])`,
    ),
    check(
      "brand_presence_themes_scope_check",
      sql`scope = ANY (ARRAY['brand'::text, 'category'::text])`,
    ),
    pgPolicy("Service role full access for brand_presence_themes", {
      as: "permissive",
      for: "all",
      to: ["service_role"],
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy("Org members can view brand_presence_themes", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`check_organization_membership(organization_id, (select auth.uid()))`,
    }),
  ],
);

/**
 * Atomic voice-of-customer phrases extracted from mentions — SOURCE data,
 * never deleted. kind=quote rows are word-for-word verbatims (validated as
 * exact substrings of the mention text at write time) and are never
 * clustered; the other kinds embed their paraphrase and cluster into themes.
 * (mention_id, kind, content_hash) is the idempotency key: re-extracting a
 * mention upserts with ignoreDuplicates, so a crash between phrase insert
 * and extraction_status update never duplicates rows. theme_id is set by the
 * latest clustering run (SET NULL on theme delete is the crash-safety net —
 * the next full rebuild repoints it). Brand-scoped exact cosine scans in TS
 * are fine at this scale; no ANN index by design (ad_embeddings precedent).
 */
```

### 13.13 `brand_presence_phrases` (`drizzle/schema.ts:9787-9898`)

```ts
export const brandPresencePhrases = pgTable(
  "brand_presence_phrases",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    organizationId: uuid("organization_id").notNull(),
    brandProfileId: uuid("brand_profile_id").notNull(),
    mentionId: uuid("mention_id").notNull(),
    kind: text().notNull(),
    phrase: text().notNull(),
    // Short normalized restatement — the embedded text. NULL for quotes.
    paraphrase: text(),
    // Mention-level sentiment (-1..1) inherited from extraction.
    sentiment: numeric(),
    scope: text().notNull(),
    embedding: vector1536("embedding"),
    // Model that produced `embedding` (ad_embeddings precedent) — a model
    // swap must be detectable so same-model-only comparisons hold. Nullable:
    // stamped going forward + backfilled in 0120; NULL embedding ⇒ NULL model.
    embeddingModel: text("embedding_model"),
    themeId: uuid("theme_id"),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    tags: jsonb("tags").default({}).notNull(),
    scores: jsonb("scores").default({}).notNull(),
    entityConstraints: jsonb("entity_constraints").default({}).notNull(),
    editHistory: jsonb("edit_history").default([]).notNull(),
  },
  (table) => [
    uniqueIndex("brand_presence_phrases_mention_kind_hash_unique").using(
      "btree",
      table.mentionId.asc().nullsLast().op("uuid_ops"),
      table.kind.asc().nullsLast().op("text_ops"),
      table.contentHash.asc().nullsLast().op("text_ops"),
    ),
    index("idx_brand_presence_phrases_profile_scope_kind").using(
      "btree",
      table.brandProfileId.asc().nullsLast().op("uuid_ops"),
      table.scope.asc().nullsLast().op("text_ops"),
      table.kind.asc().nullsLast().op("text_ops"),
    ),
    index("idx_brand_presence_phrases_theme").using(
      "btree",
      table.themeId.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_brand_presence_phrases_mention").using(
      "btree",
      table.mentionId.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_brand_presence_phrases_org").using(
      "btree",
      table.organizationId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
      name: "brand_presence_phrases_organization_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.brandProfileId],
      foreignColumns: [brandPresenceProfiles.id],
      name: "brand_presence_phrases_brand_profile_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.mentionId],
      foreignColumns: [brandMentions.id],
      name: "brand_presence_phrases_mention_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.themeId],
      foreignColumns: [brandPresenceThemes.id],
      name: "brand_presence_phrases_theme_id_fkey",
    }).onDelete("set null"),
    check(
      "brand_presence_phrases_kind_check",
      sql`kind = ANY (ARRAY['pain'::text, 'desire'::text, 'objection'::text, 'praise'::text, 'quote'::text])`,
    ),
    check(
      "brand_presence_phrases_scope_check",
      sql`scope = ANY (ARRAY['brand'::text, 'category'::text])`,
    ),
    pgPolicy("Service role full access for brand_presence_phrases", {
      as: "permissive",
      for: "all",
      to: ["service_role"],
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy("Org members can view brand_presence_phrases", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`check_organization_membership(organization_id, (select auth.uid()))`,
    }),
  ],
);

/**
 * Layer 3 (Brand Object) — versioned, evidence-backed fact store. The stable
 * distillation of Layer-1/Layer-2 output + first-party data. Bi-temporal
 * (agent_org_memory_facts precedent): valid_to IS NULL = live; supersession
 * stamps valid_to + links previous_version_id — rows are NEVER deleted
 * (rejected facts are retained as eval examples). `section` and `source` are
 * OPEN strings validated in code (recommendations.type posture — new sections
 * ship with no migration). `fact_key` is the stable identity within
 * (brand_profile_id, section) that survives theme-cluster rebuilds; the
 * partial unique index enforces exactly ONE live version per identity.
 * confidence 1.0 is reserved for human confirm/edit (source 'user_stated' or
 * status 'confirmed') — the reconciler never auto-supersedes a confirmed
 * fact; contradictions go to brand_fact_suggestions instead.
 */
```

### 13.14 `brand_facts` (`drizzle/schema.ts:9899-10015`)

```ts
export const brandFacts = pgTable(
  "brand_facts",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    organizationId: uuid("organization_id").notNull(),
    brandProfileId: uuid("brand_profile_id").notNull(),
    // positioning | value_prop | usp | proof_point | voice | compliance |
    // voc_pain | voc_desire | voc_objection | voc_praise | competitor_intel |
    // market_prior | persona — validated in code, no CHECK.
    section: text().notNull(),
    factKey: text("fact_key").notNull(),
    statement: text().notNull(),
    // Section-shaped structured payload (persona card, voice card, prior
    // aggregate). Statement stays the readable claim; details carries shape.
    details: jsonb("details").default({}).notNull(),
    confidence: real().notNull(),
    // identity_extraction | voc_promotion | market_distillation |
    // persona_synthesis | user_stated — validated in code.
    source: text().notNull(),
    status: text().default("candidate").notNull(),
    // Typed provenance refs: [{type: 'phrase'|'mention'|'crawl_page'|
    // 'ad_label_agg'|'own_ad'|'theme_snapshot', id?, url?, quote?,
    // sourceSentence?, platform?, count?}]. Quotes here were mechanically
    // substring-verified against source text at write time.
    evidence: jsonb("evidence").default([]).notNull(),
    // Deterministic numbers recomputed each promotion: {frequency,
    // decayedFrequency, perPlatform, avgSentiment, lastSeenAt, winnerCount?,
    // replicationWeight?}. The LLM never sources these.
    metrics: jsonb("metrics").default({}).notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true, mode: "string" })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    // NULL = live; set on supersession/rejection. Never deleted.
    validTo: timestamp("valid_to", { withTimezone: true, mode: "string" }),
    previousVersionId: uuid("previous_version_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    tags: jsonb("tags").default({}).notNull(),
    scores: jsonb("scores").default({}).notNull(),
    entityConstraints: jsonb("entity_constraints").default({}).notNull(),
    editHistory: jsonb("edit_history").default([]).notNull(),
  },
  (table) => [
    // Exactly one live version per fact identity. Conflicting candidates
    // against a live confirmed fact become suggestions, never second rows.
    uniqueIndex("brand_facts_live_identity_unique")
      .using(
        "btree",
        table.brandProfileId.asc().nullsLast().op("uuid_ops"),
        table.section.asc().nullsLast().op("text_ops"),
        table.factKey.asc().nullsLast().op("text_ops"),
      )
      .where(sql`(valid_to IS NULL)`),
    index("idx_brand_facts_profile_section_valid").using(
      "btree",
      table.brandProfileId.asc().nullsLast().op("uuid_ops"),
      table.section.asc().nullsLast().op("text_ops"),
      table.validTo.asc().nullsLast(),
    ),
    index("idx_brand_facts_org").using(
      "btree",
      table.organizationId.asc().nullsLast().op("uuid_ops"),
    ),
    // FK covering index (Supabase advisor: leading column must match FK).
    index("idx_brand_facts_previous_version").using(
      "btree",
      table.previousVersionId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
      name: "brand_facts_organization_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.brandProfileId],
      foreignColumns: [brandPresenceProfiles.id],
      name: "brand_facts_brand_profile_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.previousVersionId],
      foreignColumns: [table.id],
      name: "brand_facts_previous_version_id_fkey",
    }).onDelete("set null"),
    check(
      "brand_facts_status_check",
      sql`status = ANY (ARRAY['candidate'::text, 'confirmed'::text, 'rejected'::text])`,
    ),
    pgPolicy("Service role full access for brand_facts", {
      as: "permissive",
      for: "all",
      to: ["service_role"],
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy("Org members can view brand_facts", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`check_organization_membership(organization_id, (select auth.uid()))`,
    }),
  ],
);

/**
 * Layer 3 — DERIVED retrieval representation of live brand facts. One or more
 * readable chunks per fact (fact statement + best verbatim + metrics line),
 * embedded for the retrieveBrandSlice door. DERIVED lifecycle: chunks of
 * superseded/rejected facts are deleted (the one sanctioned Layer-3 delete —
 * brand_presence_themes precedent); (fact_id, content_hash) makes re-embedding
 * idempotent. Brand-scoped exact cosine scans in TS — NO ANN index by design
 * (ad_embeddings precedent; revisit only past ~5k chunks per brand).
 * embedding_model stored alongside the vector so a model swap is detectable.
 */
```

### 13.15 `brand_chunks` (`drizzle/schema.ts:10016-10101`)

```ts
export const brandChunks = pgTable(
  "brand_chunks",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    organizationId: uuid("organization_id").notNull(),
    brandProfileId: uuid("brand_profile_id").notNull(),
    factId: uuid("fact_id").notNull(),
    content: text().notNull(),
    // Denormalized SQL filters for the retrieval door.
    section: text().notNull(),
    // The persona fact's fact_key slug; NULL = not persona-scoped.
    personaKey: text("persona_key"),
    // Schwartz stage; NULL = not stage-scoped.
    awarenessStage: text("awareness_stage"),
    // Denormalized fact.source.
    sourceType: text("source_type").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    embedding: vector1536("embedding"),
    embeddingModel: text("embedding_model"),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    tags: jsonb("tags").default({}).notNull(),
    scores: jsonb("scores").default({}).notNull(),
    entityConstraints: jsonb("entity_constraints").default({}).notNull(),
    editHistory: jsonb("edit_history").default([]).notNull(),
  },
  (table) => [
    // Leads with fact_id — doubles as the FK covering index.
    uniqueIndex("brand_chunks_fact_hash_unique").using(
      "btree",
      table.factId.asc().nullsLast().op("uuid_ops"),
      table.contentHash.asc().nullsLast().op("text_ops"),
    ),
    index("idx_brand_chunks_profile_section").using(
      "btree",
      table.brandProfileId.asc().nullsLast().op("uuid_ops"),
      table.section.asc().nullsLast().op("text_ops"),
    ),
    index("idx_brand_chunks_org").using(
      "btree",
      table.organizationId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
      name: "brand_chunks_organization_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.brandProfileId],
      foreignColumns: [brandPresenceProfiles.id],
      name: "brand_chunks_brand_profile_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.factId],
      foreignColumns: [brandFacts.id],
      name: "brand_chunks_fact_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("Service role full access for brand_chunks", {
      as: "permissive",
      for: "all",
      to: ["service_role"],
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy("Org members can view brand_chunks", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`check_organization_membership(organization_id, (select auth.uid()))`,
    }),
  ],
);

/**
 * Layer 3 — one row per brand profile: build status, per-section
 * completeness, incremental job cursors, and the monthly cost meter.
 * Dedicated table rather than brand_presence_profiles.meta so Layer-3 state
 * never couples to Layer-2 discovery checkpoints (agent_org_brand_block
 * one-row-per-scope precedent). cursors = {promotion: {clusterRunId,
 * phraseWatermark}, crawl: {pageHashes, lastCrawledAt}, identity/market/
 * personas: {packFingerprint, lastRunAt}}. cost = {'YYYY-MM': {llmCalls,
 * inputTokens, outputTokens, embedTokens, apifyRuns}} — the hard-stop budget
 * meter (BRAND_OBJECT_MONTHLY_LLM_CALL_CAP).
 */
```

### 13.16 `brand_object_state` (`drizzle/schema.ts:10102-10166`)

```ts
export const brandObjectState = pgTable(
  "brand_object_state",
  {
    brandProfileId: uuid("brand_profile_id").primaryKey().notNull(),
    organizationId: uuid("organization_id").notNull(),
    status: text().default("empty").notNull(),
    completeness: jsonb("completeness").default({}).notNull(),
    cursors: jsonb("cursors").default({}).notNull(),
    cost: jsonb("cost").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    tags: jsonb("tags").default({}).notNull(),
    scores: jsonb("scores").default({}).notNull(),
    entityConstraints: jsonb("entity_constraints").default({}).notNull(),
    editHistory: jsonb("edit_history").default([]).notNull(),
  },
  (table) => [
    index("idx_brand_object_state_org").using(
      "btree",
      table.organizationId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.brandProfileId],
      foreignColumns: [brandPresenceProfiles.id],
      name: "brand_object_state_brand_profile_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
      name: "brand_object_state_organization_id_fkey",
    }).onDelete("cascade"),
    check(
      "brand_object_state_status_check",
      sql`status = ANY (ARRAY['empty'::text, 'building'::text, 'in_review'::text, 'ready'::text])`,
    ),
    pgPolicy("Service role full access for brand_object_state", {
      as: "permissive",
      for: "all",
      to: ["service_role"],
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy("Org members can view brand_object_state", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`check_organization_membership(organization_id, (select auth.uid()))`,
    }),
  ],
);

/**
 * Layer 3 — reconciler conflicts against HUMAN-CONFIRMED facts. When a fresh
 * candidate contradicts a live confirmed fact (confidence 1.0), the
 * reconciler NEVER auto-supersedes; it raises a suggestion here for the
 * founder to accept (supersede with source 'user_stated') or dismiss.
 * Decide is a conditional atomic update guarded on status='proposed'
 * (recommendations decide-machine clone → ALREADY_DECIDED 409 on races).
 * dedupe_key = sha256(fact_id + normalized proposed statement) so re-running
 * promotion doesn't stack duplicate suggestions.
 */
```

### 13.17 `brand_fact_suggestions` (`drizzle/schema.ts:10167-10252`)

```ts
export const brandFactSuggestions = pgTable(
  "brand_fact_suggestions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    organizationId: uuid("organization_id").notNull(),
    brandProfileId: uuid("brand_profile_id").notNull(),
    factId: uuid("fact_id").notNull(),
    proposedStatement: text("proposed_statement").notNull(),
    proposedDetails: jsonb("proposed_details").default({}).notNull(),
    evidence: jsonb("evidence").default([]).notNull(),
    // Human-readable contradiction summary rendered on the suggestion card.
    reason: text().notNull(),
    confidence: real().notNull(),
    status: text().default("proposed").notNull(),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "string" }),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    tags: jsonb("tags").default({}).notNull(),
    scores: jsonb("scores").default({}).notNull(),
    entityConstraints: jsonb("entity_constraints").default({}).notNull(),
    editHistory: jsonb("edit_history").default([]).notNull(),
  },
  (table) => [
    uniqueIndex("brand_fact_suggestions_org_dedupe_unique").using(
      "btree",
      table.organizationId.asc().nullsLast().op("uuid_ops"),
      table.dedupeKey.asc().nullsLast().op("text_ops"),
    ),
    index("idx_brand_fact_suggestions_profile_status").using(
      "btree",
      table.brandProfileId.asc().nullsLast().op("uuid_ops"),
      table.status.asc().nullsLast().op("text_ops"),
    ),
    // FK covering index.
    index("idx_brand_fact_suggestions_fact").using(
      "btree",
      table.factId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
      name: "brand_fact_suggestions_organization_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.brandProfileId],
      foreignColumns: [brandPresenceProfiles.id],
      name: "brand_fact_suggestions_brand_profile_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.factId],
      foreignColumns: [brandFacts.id],
      name: "brand_fact_suggestions_fact_id_fkey",
    }).onDelete("cascade"),
    check(
      "brand_fact_suggestions_status_check",
      sql`status = ANY (ARRAY['proposed'::text, 'accepted'::text, 'dismissed'::text])`,
    ),
    pgPolicy("Service role full access for brand_fact_suggestions", {
      as: "permissive",
      for: "all",
      to: ["service_role"],
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy("Org members can view brand_fact_suggestions", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`check_organization_membership(organization_id, (select auth.uid()))`,
    }),
  ],
);

// The Brand Identity page's AI Brand Narrative store ("The read") — 4th
// instance of the synthesis playbook (optimization_syntheses →
// attribution_syntheses precedents). One row per generated narrative
// (history kept; latest-ready-per-brand is the hot read). The LLM never
// sources a fact — the pack is built from live brand_facts via the shared
// insight selectors; the call counts against the Brand Object monthly LLM
// cap on brand_object_state.cost. Domain logic: lib/brand-object/synthesis/.
```

### 13.18 `brand_context_rows` (`drizzle/schema.ts:10422-10530`)

```ts
export const brandContextRows = pgTable(
  "brand_context_rows",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    organizationId: uuid("organization_id").notNull(),
    brandProfileId: uuid("brand_profile_id").notNull(),
    // Semantic slug, e.g. fact_usp_13g_protein / voice_playful_tone /
    // rule_no_medical_claims / persona_busy_parent / asset_brand_logo.
    rowId: text("row_id").notNull(),
    rowType: text("row_type").notNull(),
    version: integer().notNull(),
    priority: integer().notNull(),
    // Selection tags: {channels?, products?, audiences?, stages?} — string
    // arrays; only NON-EMPTY arrays are stored (absent axis = applies
    // everywhere). Distinct from the agentic `tags` slot below.
    tagFilters: jsonb("tag_filters").default({}).notNull(),
    // Type-shaped payload with a `kind` discriminator.
    content: jsonb("content").notNull(),
    // sha256 hex over canonical JSON of {content, priority, tagFilters} —
    // the ingest change detector (sourceRef deliberately excluded).
    contentHash: text("content_hash").notNull(),
    // Upstream lineage: {kind:'brand_fact', factId, section, factKey, status,
    // confidence} | {kind:'brand_kit', assetKind, productImageId?}.
    sourceRef: jsonb("source_ref").default({}).notNull(),
    // NULL = the latest version of this row_id.
    supersededAt: timestamp("superseded_at", {
      withTimezone: true,
      mode: "string",
    }),
    // Set on the LATEST version when the upstream identity vanished
    // (lifecycle stamp, not a content edit).
    retiredAt: timestamp("retired_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    tags: jsonb("tags").default({}).notNull(),
    scores: jsonb("scores").default({}).notNull(),
    entityConstraints: jsonb("entity_constraints").default({}).notNull(),
    editHistory: jsonb("edit_history").default([]).notNull(),
  },
  (table) => [
    uniqueIndex("brand_context_rows_identity_unique").using(
      "btree",
      table.brandProfileId.asc().nullsLast().op("uuid_ops"),
      table.rowId.asc().nullsLast().op("text_ops"),
      table.version.asc().nullsLast(),
    ),
    // Exactly ONE latest version per identity; forces stamp-superseded-FIRST-
    // then-insert and makes concurrent ingests fail loudly (23505).
    uniqueIndex("brand_context_rows_latest_unique")
      .using(
        "btree",
        table.brandProfileId.asc().nullsLast().op("uuid_ops"),
        table.rowId.asc().nullsLast().op("text_ops"),
      )
      .where(sql`(superseded_at IS NULL)`),
    // The hot "live rows for profile" read (compile input + rows list).
    index("idx_brand_context_rows_profile_live")
      .using(
        "btree",
        table.brandProfileId.asc().nullsLast().op("uuid_ops"),
        table.rowType.asc().nullsLast().op("text_ops"),
      )
      .where(sql`((superseded_at IS NULL) AND (retired_at IS NULL))`),
    index("idx_brand_context_rows_org").using(
      "btree",
      table.organizationId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
      name: "brand_context_rows_organization_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.brandProfileId],
      foreignColumns: [brandPresenceProfiles.id],
      name: "brand_context_rows_brand_profile_id_fkey",
    }).onDelete("cascade"),
    check(
      "brand_context_rows_row_type_check",
      sql`row_type = ANY (ARRAY['fact'::text, 'voice'::text, 'rule'::text, 'asset'::text, 'persona'::text])`,
    ),
    check("brand_context_rows_version_check", sql`version >= 1`),
    pgPolicy("Service role full access for brand_context_rows", {
      as: "permissive",
      for: "all",
      to: ["service_role"],
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy("Org members can view brand_context_rows", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`check_organization_membership(organization_id, (select auth.uid()))`,
    }),
  ],
);

/**
 * Compiled brand context packs, keyed by the sha256 fingerprint of the pack's
 * canonical JSON (natural-key PK is deliberate — the locked architecture
 * dedupes by fingerprint with insert-or-reuse; cross-tenant collision is
 * impossible because meta.brandProfileId participates in the hash). Rows are
 * immutable — no updated_at.
 */
```

### 13.19 `brand_context_packs` (`drizzle/schema.ts:10531-10602`)

```ts
export const brandContextPacks = pgTable(
  "brand_context_packs",
  {
    fingerprint: text().primaryKey().notNull(),
    organizationId: uuid("organization_id").notNull(),
    brandProfileId: uuid("brand_profile_id").notNull(),
    compilerVersion: integer("compiler_version").notNull(),
    pack: jsonb("pack").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`timezone('utc'::text, now())`)
      .notNull(),
    tags: jsonb("tags").default({}).notNull(),
    scores: jsonb("scores").default({}).notNull(),
    entityConstraints: jsonb("entity_constraints").default({}).notNull(),
    editHistory: jsonb("edit_history").default([]).notNull(),
  },
  (table) => [
    index("idx_brand_context_packs_org").using(
      "btree",
      table.organizationId.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_brand_context_packs_profile_created").using(
      "btree",
      table.brandProfileId.asc().nullsLast().op("uuid_ops"),
      table.createdAt.desc().nullsLast(),
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
      name: "brand_context_packs_organization_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.brandProfileId],
      foreignColumns: [brandPresenceProfiles.id],
      name: "brand_context_packs_brand_profile_id_fkey",
    }).onDelete("cascade"),
    check(
      "brand_context_packs_fingerprint_check",
      sql`fingerprint ~ '^[0-9a-f]{64}$'`,
    ),
    pgPolicy("Service role full access for brand_context_packs", {
      as: "permissive",
      for: "all",
      to: ["service_role"],
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy("Org members can view brand_context_packs", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`check_organization_membership(organization_id, (select auth.uid()))`,
    }),
  ],
);

/**
 * Internal creative-QA labels — one evaluative verdict per (candidate, labeler)
 * plus one auto-label per judged candidate (plan item 9). Deliberately NOT a
 * descriptive label table like `ad_labels`/`own_ad_labels`: rows say whether a
 * generated creative is defective, keyed to the versioned taxonomy in
 * `lib/creative-engine/qa/taxonomy.ts` so human labels and judge shadow verdicts
 * are directly comparable (κ + gold-set feed).
 *
 * `organization_id` is the org OF THE CREATIVE, not the labeler's org — the
 * labeling surface is cross-tenant and team-gated in its route, and the RLS
 * SELECT policy is visibility only.
 *
 * Partial uniques encode the one-per-source rule: at most one judge row per
 * candidate, at most one row per (candidate, human labeler). A `clean` verdict
 * must carry an empty defect array; a judge row never has a labeler.
 */
```

### 13.20 `job_queue` (`drizzle/schema.ts:824-945`)

```ts
export const jobQueue = pgTable(
  "job_queue",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    type: text().notNull(),
    jobSubtype: text("job_subtype"),
    dedupeKey: text("dedupe_key"),
    status: text().default("pending").notNull(),
    priority: integer().default(0),
    payload: jsonb().default({}).notNull(),
    result: jsonb(),
    attempts: integer().default(0),
    maxAttempts: integer("max_attempts").default(3),
    errorMessage: text("error_message"),
    organizationId: uuid("organization_id"),
    userId: uuid("user_id"),
    parentJobId: uuid("parent_job_id"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).defaultNow(),
    scheduledFor: timestamp("scheduled_for", {
      withTimezone: true,
      mode: "string",
    }).defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
    claimToken: uuid("claim_token"),
  },
  (table) => [
    index("idx_job_queue_claim_token").using(
      "btree",
      table.claimToken.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_job_queue_created").using(
      "btree",
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("idx_job_queue_llm_active_dedupe")
      .using(
        "btree",
        table.jobSubtype.asc().nullsLast().op("text_ops"),
        table.dedupeKey.asc().nullsLast().op("text_ops"),
        table.organizationId.asc().nullsLast().op("uuid_ops"),
        table.userId.asc().nullsLast().op("uuid_ops"),
        table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
      )
      .where(
        sql`(type = 'llm_task'::text AND status = ANY (ARRAY['pending'::text, 'processing'::text]))`,
      ),
    uniqueIndex("idx_job_queue_ga4_enrichment_active_dedupe")
      .using("btree", table.dedupeKey.asc().nullsLast().op("text_ops"))
      .where(
        sql`(type = 'ga4_attribution_enrichment'::text AND dedupe_key IS NOT NULL AND status = ANY (ARRAY['pending'::text, 'processing'::text]))`,
      ),
    index("idx_job_queue_org").using(
      "btree",
      table.organizationId.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_job_queue_parent")
      .using("btree", table.parentJobId.asc().nullsLast().op("uuid_ops"))
      .where(sql`(parent_job_id IS NOT NULL)`),
    index("idx_job_queue_status_priority")
      .using(
        "btree",
        table.status.asc().nullsLast().op("text_ops"),
        table.priority.desc().nullsFirst().op("int4_ops"),
        table.scheduledFor.asc().nullsLast().op("text_ops"),
      )
      .where(sql`(status = ANY (ARRAY['pending'::text, 'processing'::text]))`),
    index("idx_job_queue_type_status").using(
      "btree",
      table.type.asc().nullsLast().op("text_ops"),
      table.status.asc().nullsLast().op("text_ops"),
    ),
    index("idx_job_queue_user_id").using(
      "btree",
      table.userId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
      name: "job_queue_organization_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.parentJobId],
      foreignColumns: [table.id],
      name: "job_queue_parent_job_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "job_queue_user_id_fkey",
    }),
    pgPolicy("Service role has full access to job_queue", {
      as: "permissive",
      for: "all",
      to: ["service_role"],
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy("Users can create jobs for their organizations", {
      as: "permissive",
      for: "insert",
      to: ["public"],
      withCheck: sql`(check_organization_membership(organization_id, (select auth.uid())) AND ((user_id IS NULL) OR (user_id = (select auth.uid()))))`,
    }),
    pgPolicy("Users can view own jobs", {
      as: "permissive",
      for: "select",
      to: ["public"],
      using: sql`((user_id = (select auth.uid())) OR check_organization_membership(organization_id, (select auth.uid())))`,
    }),
    check(
      "valid_status",
      sql`status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text, 'cancelled'::text])`,
    ),
  ],
);
```
