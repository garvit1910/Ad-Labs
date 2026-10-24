# Ad Lab — master plan

Last updated Sat Oct 24, 2026, 4:44 PM PT

Ad Lab tests Magic Spoon ad recipes on Jev-driven shoppers built from real customer voice, then keeps and refines the winners. Person A owns data and agents; Person B owns the simulation. Both halves are planned below, phase by phase, with a ready prompt for every phase in the "Appendix: Phase prompts" at the end of this file.

## Locked decisions

Everything here is settled. Change a row only by editing this table, so both of you see it.

| Topic | Decision |
| --- | --- |
| Demo brand | Magic Spoon, against seven brands that run Meta ads today (locked Oct 24, agreed by A and B): the protein cereals Catalina Crunch, Seven Sundays and Surreal, and the protein-adjacent GHOST, Premier Protein, Legendary Foods and Quest Nutrition. Page ids are in A2. This replaces Catalina Crunch, Three Wishes and Wonderworks, of which only Catalina Crunch runs ads. B's fixtures still use the old names |
| Meta ads | Scraped only by the advertiser's own page (Ad Library `view_all_page_id`, or the facebook.com page the brand's website links to), never by keyword search. A keyword search returns mostly unrelated advertisers. Each page is shown to Person A before its full scrape |
| Sponsor tracks | Apify, Fetch.ai, SpacetimeDB, Visa |
| Shopper decisions | Jev (TypeSafe), pinned to `jev-1.13.0`. Not a sponsor track |
| Sources | Reddit, Trustpilot, Google reviews, X, Instagram, TikTok, Meta Ad Library. About 300 items per source, up to 50 ads per competitor |
| Reused from Adcero | Scraping, structuring, competitor analysis, creative generation, the bandit arm enums, and the look of the brand identity and competitor pages |
| Storage | A fresh Supabase project for raw data and the reused pipeline; SpacetimeDB for everything live and shared |
| Screens | ASI:One chat starts runs and shows summary cards. The web app shows the Adcero-style pages, the agents at work (`/agents`) and the live sim (`/sim`) |
| Agents (Fetch.ai) | Four uAgents run the loop as an agent-to-agent system. **Ad Lab**, the only one in the ASI:One chat, delegates to three others. **Scout** triggers the Apify runs and distillation through the job queue. **Strategist** builds recipes, queues and watches rounds, and decides when to stop. **Copywriter** claims each round's creative task and writes the ads. They talk in typed protocols, and each is registered on Agentverse. Every message, agent status and Apify job is mirrored into SpacetimeDB, where `/agents` shows them live. The bulk scrape is pre-run through the same jobs; the demo refreshes it live |
| Simulation | Rebuilt from scratch on Jev, no graph database. ShopSim's rules carry over, its code does not |
| Language | TypeScript everywhere, except a thin Python layer for Fetch's uAgents |
| Split | Person A: setup, Apify, Fetch, everything up to segments, arms and creatives landing in SpacetimeDB. Person B: simulation, bandit, learnings, live sim views |
| Out of scope | Mana, backtest, a custom Apify actor, a Visa shopper-facing product (maybe later), images inside the sim. The Payment Protocol is A6's last step, only if time remains |
| Recipes (bandit arms) | Angle × hook. Angles are Adcero's food-industry tokens (taste\_indulgence, health\_nutrition, …), hooks are HOOK\_ARCHETYPES limited to the ones Adcero's copywriter can produce. 10–12 recipes plus a control |
| Creative generation | Adcero's text-only path, one brief per (persona, angle). Image judge and ranking off; the sim ranks. Competitor market-prior statements never reach copy. Learnings reach copy only as number-free notes. Numbers are checked on whole-number boundaries |

## Status

As of Sat Oct 24, 3 PM PT.

| | Done | In progress | Next |
| --- | --- | --- | --- |
| A | A0 setup, A1 Adcero port, A's half of the contract in SpacetimeDB (`tables_a.ts`, `reducers_a.ts`) | A2 ingest, on its own agent (`feat/a2-ingest`) | A3 distill, then A4 writes the contract rows. A5 and A6 can start in parallel, on fixtures first |
| B | B0–B4: fixtures, Jev spike, engine, calibration, bandit, learnings, task board and worker | — | B5 live sim views. B4's integration step waits on A4's rows |

**Branches.** `simulation` is the integration branch: B commits there, and every A phase opens its PR against it. `B`, GitHub's default branch, is stale; don't branch from it or target it.

**Shared database.** The SpacetimeDB database `adlab-calhacks13` on Maincloud is live, with the whole contract published from `simulation` at 3 PM PT:

- 14 public tables: A's 5 and B's 9, the task board included.
- 20 reducers: `ping`, A's 6 and B's 13.
- Every table was empty at publish time. Rows arrive with A4 and B's first real round.
- A6 adds three A tables for the agents (`agent`, `agent_message`, `ingest_job`; see The contract) and publishes them in place.

How to work with it:

- **Who publishes.** Only A can: the database belongs to A's SpacetimeDB login. Publish from an up-to-date `simulation` with `npm run spacetime:publish`, which stops instead of breaking clients. `npm run spacetime:publish:clear` wipes both sides' data, so agree first.
- **Clients.** B's worker and A's agents call reducers and SQL over HTTP. The web app subscribes through the `spacetimedb` SDK, using the generated client in `lib/spacetime/`. After any module change, run `npm run spacetime:generate` and commit the result.

**Supabase.** The 17 Adcero tables, `library_ads_enriched` and `job_queue` are applied (`npm run db:migrate`). A2 is filling them.

**Agents.** Since Oct 24, 4:30 PM, Fetch's agents run the loop as an agent-to-agent system, mirrored in SpacetimeDB: see Locked decisions ("Agents") and A6.

## How A and B fit together

A and B never call each other's code. A writes segments, recipes and creatives; B reads them, runs the simulation and writes results and learnings back; the task board says whose turn it is.

```
 PERSON A · data + agents          SPACETIMEDB (shared)            PERSON B · simulation
 +-----------------------+  writes +-----------------------+ reads  +-----------------------+
 | Ingest + analysts     |-------->| Written by A          |------->| Sim worker            |
 | Apify scrapes,        |         | segment · arm         |        | builds shoppers, asks |
 | personas, recipes,    |         | creative · brand      |        | Jev, rolls the dice   |
 | first creatives       |         | concept · agent tables|        |                       |
 +-----------------------+         +-----------------------+        +-----------------------+
 +-----------------------+  tasks  +-----------------------+ tasks  +-----------------------+
 | Fetch agents (A2A)    |<------->| Task board            |<------>| Bandit                |
 | Ad Lab, Scout,        |         | run_round             |        | picks recipes, queues |
 | Strategist and        |         | generate_creatives    |        | new creatives         |
 | Copywriter            |         |                       |        |                       |
 +-----------------------+         +-----------------------+        +-----------------------+
 +-----------------------+  reads  +-----------------------+ writes +-----------------------+
 | Copywriter agent +    |<--------| Written by B          |<-------| Learnings + views     |
 | creative engine       |         | decision · arm_stat   |        | writes findings; live |
 | reads learnings,      |         | learning · round      |        | sim views read them   |
 | writes next variants  |         | shopper · product     |        |                       |
 +-----------------------+         +-----------------------+        +-----------------------+
```

Person A and Person B only meet in SpacetimeDB. Each side writes only its own tables; the task board passes the baton between them each round.

Each round crosses the middle twice: B's bandit queues new creatives for A, and A's Copywriter agent queues the next round for B. That's also the SpacetimeDB pitch: agents coordinating through one live, shared world state.

Three layers, each with one job:

- **Fetch agents decide and talk.** Ad Lab, Scout, Strategist and Copywriter message each other in typed protocols (A6).
- **SpacetimeDB is the shared world they act on.** It holds the contract rows and the task board, plus a live record of every agent message, agent status and Apify job.
- **Workers do the heavy compute.** The job worker runs the Apify actors and Adcero's processors; B's sim worker asks Jev.

An agent never calls another person's code: it messages an agent or writes a row.

## The contract

These SpacetimeDB tables are the entire interface between A and B. Each side writes only its own tables and reads the other's. B builds against fixture rows with exactly these shapes tonight, so A's real data later is a data load, not a code change.

**Written by Person A, read by Person B**

| Table | Fields | Rules |
| --- | --- | --- |
| brand | brand\_id, name, is\_client | Magic Spoon is the client; the seven competitors are not |
| concept | concept\_id, key, label | The closed claim vocabulary (draft in Simulation design). A's analysts map brand facts onto the same keys |
| segment | segment\_id, name, description, share, prior\_weights (json: concept key → 0..1), quotes (json: 8–20 real customer quotes), budget\_mean\_usd, budget\_sd\_usd, in\_market\_rate | description is life context only (who they are, their routine), never preferences; those live only in prior\_weights. Shares sum to 1. Built from Adcero's personas in A4 |
| arm | arm\_id, angle, hook, strategy (steal / double\_down / gap / control), rationale, evidence | angle uses the food-industry tokens Adcero's labeller writes (taste\_indulgence, health\_nutrition, convenience, natural\_clean, craving, dietary\_fit, price\_value, trust\_safety); hook uses HOOK\_ARCHETYPES. Exactly one control arm: Magic Spoon's own live ads |
| creative | creative\_id, arm\_id (empty for competitors), brand\_id, origin (generated / brand\_live / competitor\_live), headline, primary\_text, cta, visual\_description, image\_url, landing\_product\_id, days\_running, round\_created, learning\_ids (json), segment\_id, pack\_fingerprint, status (ranked / gated\_out) | Competitor ads appear only as feed neighbours. learning\_ids records which learnings the generator used. segment\_id is the persona a generated ad was written for (empty for live ads). Only ranked creatives enter feeds |

**Written by Person B, read by Person A**

| Table | Fields | Rules |
| --- | --- | --- |
| product | product\_id, brand\_id, name, price\_usd, subscription\_price\_usd, rating, review\_count, page\_highlights (json), shipping\_note | Filled by hand from the brands' sites tonight. A may refresh rating and review\_count from scraped data |
| creative\_perception | creative\_id, claims (json: concept key → strength 0..1), offer\_pct, input\_hash | Worked out once per creative, then frozen |
| run | run\_id, seed, population, rounds\_planned, ticks\_per\_round, status, calibration (json), jev\_model, config\_hash, created\_at | One row per simulation run |
| round | run\_id, round, status, started\_at, finished\_at, summary (json) | summary is what A's ASI:One cards render |
| shopper | run\_id, shopper\_id, segment\_id, display\_name, in\_market, budget\_left\_usd, state\_text | state\_text is the exact text Jev last read for this shopper |
| decision | run\_id, round, tick, shopper\_id, kind (feed / page), creative\_id, options (json), p\_raw (json), p\_cal (json), draw, action, believes\_claim, objection, latency\_ms, cache\_hit | One row per Jev call; it stores inputs, probabilities, the dice roll and the outcome |
| arm\_stat | run\_id, round, segment\_id, arm\_id, impressions, mean\_reward, post\_mean, post\_sd, p\_best, est\_cost\_per\_order\_usd | Refreshed at the end of every sim day |
| learning | learning\_id, run\_id, segment\_id, arm\_id, kind, statement, directive, evidence (json), source, valid\_from\_round, valid\_to\_round | source is always `simulated`. A new version closes the old one; a learning never edits an observed brand fact. directive is the same point with every number removed, and only directives reach the copywriter |

**Shared: the task board**

| Table | Fields | Rules |
| --- | --- | --- |
| task | task\_id, run\_id, kind (run\_round / generate\_creatives), payload (json), status (queued / claimed / done / failed), claimed\_by, result (json), created\_at, updated\_at | Claimed only through one `claim_task` reducer, so two workers can never take the same task. claimed\_by names the agent or worker holding it, for example `copywriter` |

Payloads:

- `run_round`: `{run_id, round}`
- `generate_creatives`: `{run_id, round, arms: [{arm_id, segment_ids}], n_per_arm, learning_ids}`

**Written by A's agents, read by anyone (the `/agents` view)**

| Table | Fields | Rules |
| --- | --- | --- |
| agent | agent\_id, name, role, address, status (idle / working / error), current\_step, updated\_at | One row per agent: `agt_ad_lab`, `agt_scout`, `agt_strategist`, `agt_copywriter`. address is its `agent1q…` address. Each agent updates its row whenever its step changes |
| agent\_message | message\_id, run\_id, from\_agent, to\_agent, protocol, kind (request / reply / progress / result), summary, payload (json), created\_at | One row per message between agents, written by the sender as it sends, so nothing happens off the record. `user` stands for the ASI:One user, so the chat shows up too. summary is one readable line of at most 140 characters; payload is at most 4 KB. run\_id is empty outside a run |
| ingest\_job | job\_id, requested\_by, job\_type, target, actor, status (pending / processing / completed / failed / skipped), items, error, created\_at, updated\_at | One row per Supabase `job_queue` job an agent starts, keyed by that job's id. target is readable ("Catalina Crunch · Meta ads"). actor names the Apify actor, empty for steps that don't call Apify. items is the rows the step added when it reports them, else 0. The endpoint writes the row when it enqueues the job; the worker updates it |

Housekeeping:

- One SpacetimeDB module in `spacetime/src/`. `schema.ts` builds it from `tables_a.ts` (A) and `tables_b.ts` (B). Each side's reducers are in `reducers_a.ts` and `reducers_b.ts`, and `index.ts` exports both. The agent tables live in `tables_a.ts` and `reducers_a.ts` too. Add columns; don't drop them mid-hackathon (SpacetimeDB can't drop columns automatically). In development, republish with data cleared instead.
- Empty values and reducer arguments differ by side, as each table file documents. A's tables write `""` for an empty value and their upsert reducers take typed row arrays. B's tables use options for empty values and their batch reducers take one JSON string (`rows_json`). Fields marked json are JSON strings on both sides.
- Ids are strings with a prefix (`seg_`, `arm_`, `cr_`, `shp_`, `agt_`, `msg_`).
- How Adcero's creative output maps onto the creative fields gets confirmed when the creative export lands.

## Running a phase with a coding agent

Each phase is one prompt to a coding agent working in the new repo. The agent reads this plan and the exports from `docs/`, so a prompt only names the phase and points at its inputs. You never paste Adcero or ShopSim files: give the agent those repos read-only, and only in the phases marked below.

**Once, before A1:**

1. Save this file as `docs/PLAN.md`. Replace it whenever the plan changes.
2. Copy Adcero's `reuse-export/` to `docs/reuse-export/`, and ShopSim's `sim-export/` to `docs/sim-export/`.
3. Keep the Adcero and ShopSim checkouts next to the new repo. In the phases that need them, start the agent with `claude --add-dir ../adcero` (or `../shopsim`) and tell it the folder is read-only.

**Repo layout**

```
/                      Next app at the root, Adcero layout (app/, components/, hooks/, lib/, services/, messages/, i18n/)
app/sim/               B: live sim views
app/api/agent/         A: HTTP API the Python agents call
app/agents/             A: the live agent view (/agents)
lib/adlab/             A: Ad Lab glue (the constant org id, the service-role Supabase client)
lib/spacetime/         shared: the web app's SpacetimeDB client (generated bindings and config)
sim/                   B: simulation engine (TypeScript)
spacetime/             shared SpacetimeDB module: tables_a.ts and reducers_a.ts (A), tables_b.ts and reducers_b.ts (B)
worker/                A: job_queue worker for the copied Adcero processors
agents/                A: Python uAgents for Fetch.ai
scripts/               A: connection check, Supabase setup, phase scripts
supabase/              A: migrations/ (the copied tables, view and job_queue) and migrate.mts
tests/                 A: unit tests for edits to copied code
docs/                  PLAN.md, reuse-export/, sim-export/
```

**Prompt template**

```
Ad Lab, phase {ID}: {name}. Cal Hacks 13.0; hard deadline Sun Oct 25, 9 AM PT.
Read first: docs/PLAN.md sections "Locked decisions", "The contract", {phase sections}.
Also read: {extra inputs from the table below}.
{If the table names a read-only repo: "../adcero is read-only reference. Never write there."}
Goal: {the phase's checklist, copied from the plan}.
Done when: {the phase's check}.
Rules:
- Branch off `simulation` and open the PR against `simulation`.
- Write only inside {paths}. Never edit the other person's files or SpacetimeDB tables.
- Use the versions in docs/reuse-export/deps.json. Ask before adding any other dependency.
- Secrets come from .env.local. Never commit them.
- Prefer copied Adcero code to rewriting it. If you change a copied file, say which and why.
- Stop and ask if a contract field needs to change.
Finish with: what works, what is stubbed or skipped, the command that proves the done-when check, and a commit named "{ID}: {summary}".
```

**Inputs per phase**

| Phase | Plan sections to read | Extra inputs | Read-only repo |
| --- | --- | --- | --- |
| A0 Setup | Locked decisions, The contract | Fetch hackpack and "ASI:One compatible uAgents" guide; SpacetimeDB TypeScript quickstart | — |
| A1 Port core | The contract, Person A | reuse-export: REUSE\_MANIFEST §0, §8, §12, §13, files.txt, deps.json | Adcero, for `services/job-processor/job-executor.ts` L121–165 (the worker registry) |
| A2 Ingest | Person A | REUSE\_MANIFEST §1, §2, §3, §10 | Adcero, for `tests/fixtures/ad-library/apify-sample.json` (normalizer smoke test) |
| A3 Distill | Person A | REUSE\_MANIFEST §4, §5 | Adcero, for `scripts/brand-object-{build,promote,distill}.ts`, the in-process run harness that wasn't copied |
| A4 Contract rows | The contract, Simulation design, Person A | reuse-export `contracts.ts` (PersonaDetails, EnrichedAd); `spacetime/tables_b.ts` | — |
| A5 Creatives | The contract, Reward bandit and learnings, Person A | CREATIVE\_MANIFEST.md (§1b, §2–§6, §8, §9, Text-only mode, §11.3–§11.5), contracts-creative.ts, the two creative fixtures | Adcero |
| A6 Fetch agents | Locked decisions, How A and B fit together, The contract, A6, Demo | Fetch hackpack requirements; Innovation Lab docs on uAgent-to-uAgent communication, mailbox agents, ASI-compatible agents and Interactive Cards; `agents/hello_agent.py`; B's `sim/SAMPLE_ROUND_SUMMARY.json`; A2's `scripts/a2-ingest.ts` and `worker/loop.ts` | — |
| A7 Adcero pages | Person A | REUSE\_MANIFEST §5.5 (dashboard rewrite), §7; the two fixtures | Adcero, for the original `app/api/brand-identity/` routes, `design.md`, `.claude/brand-book.md` |
| B0 Setup | Locked decisions, The contract, Simulation design, The Jev calls | TypeSafe Jev docs (request and response shapes) | — |
| B1 Spike | The Jev calls | — | — |
| B2 Engine | Simulation design, The Jev calls | sim-export `SIM_NOTES.md` §0, §3, §4 | — |
| B3 Bandit | Reward, bandit and learnings | sim-export `contracts.ts` (FUNNEL\_BANDS) | — |
| B4 SpacetimeDB | The contract | SpacetimeDB TypeScript module and client docs; `spacetime/tables_a.ts` | — |
| B5 Views | Status, Live sim views | `components/ui/`, `app/globals.css`, `lib/spacetime/` | ShopSim (public: github.com/garvit1910/shopsim), for `web/components/{AllocationRiver,charts}.tsx`; `Inspector.tsx` for layout only |
| B6 Demo | Demo, cut lines and risks | — | — |

Paste text into a prompt only for things that live in no repo:

- Fetch or TypeSafe docs, if the agent can't reach the web.
- B's sample round summary, for A6.

Ready-to-paste prompts for every phase, built from this template, are in the "Appendix: Phase prompts" at the end of this file.

## Person A: build phases

A turns Magic Spoon's public footprint into the rows the sim needs, writes the ads, and wraps the loop in Fetch agents. Port Adcero the way both exports recommend: copy its code unchanged behind 18 small stubs, run the data processors with a local job worker, and drive ad writing with a \~200-line text-only orchestrator around Adcero's pure functions.

**What the exports changed**

- **Customer voice** lives in `brand_mentions`, which feeds phrases and then themes. Brand context is `brand_facts` plus `brand_chunks`.
- **Distillation is six jobs:** crawl → identity → promote → market → personas → chunks. Only identity and personas call an LLM.
- **Segment = persona, everywhere.** Adcero makes 2–4 personas with real verbatims; each becomes a sim segment, and every ad brief is compiled for exactly one persona.
- **One brief carries one angle.** Recipes that share a (persona, angle) share a brief, and each recipe's hook becomes one copy variant.
- **Ads never touch Adcero's image pipeline.** Copy is written before any image, so the text path calls the pure stages directly. The one Adcero file it edits is the strategy block in `brand-copy.ts` (A5).
- **Meta only.** The Google Ads actor is a rental and isn't needed. Gemini video labels are skipped; video ads fall back to their poster image.
- **Adcero's own bandit stays parked.** It samples angle, hook and format separately and can't explore untried values. B's bandit picks recipes.

**Gotchas to handle early**

- **Model access.** The data path defaults to gpt-5.4, gpt-5.4-mini, gpt-6-luna and text-embedding-3-small; ad copy defaults to gpt-4o. Check every one in A0. Override any your key can't reach with the role env vars (REUSE\_MANIFEST §9, CREATIVE\_MANIFEST §9).
- **Speed.** Set `LLM_FLEX_TIER=0`. Flex is cheaper but queues requests.
- **Reruns.** Identity has a 7-day cooldown, personas a 24-hour one, and each brand is capped at 60 LLM calls a month. To rerun, raise `BRAND_OBJECT_MONTHLY_LLM_CALL_CAP` and clear the cooldown fields in `brand_object_state`.
- **Genome check.** Outside `NODE_ENV=production`, building an ad throws when the persona text has no demographic words. Run the creative worker with `NODE_ENV=production`.
- **Google Maps.** Magic Spoon sells online, so the Maps probe may find no place. That's a clean skip, not a bug.
- **TikTok.** Its comment field names were never pinned. Do one \~20-item run before the real harvest.

### A0 · Sat 2:30 – 4 AM · Setup and connections

- [x] New repo in the layout above. Next app at the root (Next 16.4, React 19.3, Tailwind 4), npm.
- [x] Fresh Supabase project with the `vector` extension enabled; note the service role key.
- [x] SpacetimeDB module in `spacetime/`, published to Maincloud so both laptops share one database. Include a `ping` reducer and empty `tables_a.ts` and `tables_b.ts`.
- [x] `.env.example` listing every key and setting:
  - keys: APIFY\_TOKEN, OPENAI\_API\_KEY, SUPABASE\_URL, SUPABASE\_SERVICE\_ROLE\_KEY, the SpacetimeDB URI and database name, TYPESAFE\_API\_KEY (B), the Agentverse and ASI:One keys, ANTHROPIC\_API\_KEY (only if B's perception uses Claude)
  - settings: `LLM_FLEX_TIER=0`, `APIFY_AD_LIBRARY_MAX_ADS=50`, `CREATIVE_JUDGE_GATE_MODE=off`
- [x] `npm run check:connections`: one tiny call per service, printed as a pass/fail table. Cover the Supabase select plus pgvector, SpacetimeDB ping, the Apify user, each OpenAI model the code uses, one Jev call and one ASI:One call.
- [x] A hello-world uAgent with the chat protocol, registered on Agentverse through a mailbox, that answers inside ASI:One. This takes Fetch's biggest unknown off the table early.
- [x] **Insurance:** start the Meta Ad Library actor for Magic Spoon's page and each competitor's page, and the Trustpilot reviews actor, with the manifest's inputs. If the port slips, A2 imports these datasets. Done Oct 24; dataset ids are under A2.

**Done when** the connection check is all green and the agent replies in ASI:One.

### A1 · Sat 4 – 8 AM · Port the Adcero core (384 files)

- [x] rsync `files.txt` from Adcero, then `npm install --prefer-dedupe` with the deps.json versions.
- [x] Write the 18 same-path stubs (REUSE\_MANIFEST §8.2). Only `lib/llm/clients.ts` and `services/r2-service.ts` need real code. The R2 stub writes to local disk, and its `downloadFile` must return the bytes, because identity reads crawled pages back from it.
- [x] Apply the 11 copy + edits (§8.3), including the market-processor paging fix.
- [x] One more edit: make `findUngroundedNumerals` in `lib/creative-engine/brand-check/grounding.ts` match whole numbers, so "30" no longer grounds on "3,000" while "4.7" still grounds on "4.7 out of 5".
- [x] `supabase/migrations/`:
  - the §13 tables, without org foreign keys or RLS, and one constant org id
  - the `library_ads_enriched` view
  - the `job_queue` subset with its two dedupe indexes
- [x] `worker/`: the \~60-line loop from §8.4, using the registry from Adcero's `job-executor.ts`.
- [x] App shell from §7.6 (layout, providers, globals.css, fonts) so B can add `/sim`.

**Done when** `npm run typecheck` passes, `npm run worker` drains an empty queue, and `/` renders in Adcero's dark theme.

### A2 · Sat 8 – 10:30 AM · Ingest Magic Spoon and its seven competitors

- [ ] Run `brand_presence_discover` on magicspoon.com. Check the draft profile's name variants and competitor list, then confirm it.
- [ ] Sources: Reddit, Trustpilot, Google Maps, X, Instagram, TikTok. Where discovery missed a handle, set it by hand and confirm it through the copied `confirm-source.ts` functions from a script.
- [ ] Caps: Reddit and X about 300 each, reviews about 100–200, Instagram and TikTok comments from about 10 posts each (Adcero's planner defaults).
- [ ] `tracked_competitors`, Meta only, with `APIFY_AD_LIBRARY_MAX_ADS=50`:
  - the seven competitors under Locked decisions, each tracked by its Meta page id (table below), never a keyword
  - Magic Spoon's own page ("Magic Spoon Cereal", page id 1978160732305312), which feeds the control and double-down recipes
- Competitor set, locked Oct 24: the seven brands with a page id below. Page ids come from each brand's own website; "live" means running Meta ads that day:

  | Brand | Page id | Live ads | Fit |
  | --- | --- | --- | --- |
  | Catalina Crunch | 140848183352200 | 5 (all it runs) | direct protein cereal |
  | Seven Sundays | 215741341794742 | yes, about half on cereal | direct protein cereal |
  | Surreal | 103157908647433 | yes, mostly cereal | direct high-protein, low-sugar cereal; UK brand |
  | GHOST | 1453082168348885 | yes, mostly whey and supplements | protein-adjacent |
  | Premier Protein | 78022578902 | yes, shakes | protein-adjacent |
  | Legendary Foods | 435452713326784 | yes, protein mac & cheese | protein-adjacent |
  | Quest Nutrition | 109793645727352 | yes, snacks | protein-adjacent |
  | Three Wishes, HighKey, Schoolyard Snacks, Snack House, Lovebird, Nature's Path | — | none | — |
  | Wonderworks | no page of its own (General Mills line) | none | — |
- Insurance datasets from A0 (Apify): Magic Spoon ads `3gFmofqMK6sEyeHto` (45), Catalina Crunch ads `1IPZWLnFfFMWN01fa` (5), Magic Spoon Trustpilot, English, `8XhvrGA89aht0K74A` (39 reviews).
- [ ] Keep Magic Spoon's own ads out of market priors with Adcero's own flag: its `tracked_competitors` row gets `is_brand_self = true` and Magic Spoon's `brand_profile_id`. The market step skips self rows; the identity step reads their ad copy.
- [ ] Run competitor sync → label → embed.
- [ ] **If an actor fails or comes back empty:** import that source's A0 insurance dataset through the copied normalizers instead.

**Done when** brand\_mentions has rows from at least 5 sources, and library\_ads has labelled, embedded ads for Magic Spoon's page and every competitor page.

### A3 · Sat 10:30 AM – 1 PM · Distill the brand context

- [ ] Let listening drain: relevance → extract → cluster → promote.
- [ ] Run `brand_object_crawl` with `chain: true`: crawl → identity → market → personas → chunks. The identity facts (positioning, USPs, proof points such as grams of protein) are what the ads get built from.
- [ ] Count facts per section, and spot-check 10 VOC facts against their quotes.
- [ ] Smoke-test `retrieveBrandSlice` with "protein", "taste" and "price".

**Done when** brand\_facts holds identity, voc\_\*, market\_prior and 2–4 persona facts, and retrieval returns sensible quotes.

### A4 · Sat 1 – 2:30 PM · Write the contract rows (2:30 PM integration with B)

- [ ] **brand:** 8 rows (Magic Spoon and the seven competitors). **concept:** the shared vocabulary from Simulation design.
- [ ] **Segment builder:** one script, one strict-JSON LLM call per persona.
- [ ] **Arm builder:** deterministic picks, plus one LLM call for the rationale text.
- [ ] **Live ads to creatives:** competitor\_live and brand\_live rows.

**Segment builder: persona → segment**

| Segment field | Built from |
| --- | --- |
| segment\_id, name | The persona fact's row id and name. The segment id must equal the persona row id the ad compiler uses (`personaRef`) |
| description | The persona description, rewritten by the LLM as life context only (situation, routine) with every preference removed. This keeps the single-entry rule |
| quotes | The persona's verbatims, topped up to 8+ with the best verbatims of its linked pain, desire and objection facts. All are exact substrings of real mentions |
| prior\_weights | The LLM maps the persona's pains, desires and objections onto the concept vocabulary as 0..1 weights (strict schema) |
| share | Each persona's linked-fact frequency ÷ the total. If Adcero emits an "unaware" projection, treat it as one more segment at 10% |
| budget\_mean\_usd, budget\_sd\_usd | Hand-set for cereal: start near $45 ± $15 a month; B tunes |
| in\_market\_rate | 0.12 by default; higher for personas whose pains mention running out or restocking |

**Arm builder rules**

- **Vocabulary:** angle = the food-industry tokens; hook = a HOOK\_ARCHETYPE the copywriter can produce:
  - always: problem\_callout, bold\_claim, question, curiosity, pov\_relatable, story\_narrative
  - only with backing: statistic (a numeric fact), social\_proof (a proof\_point or voc\_praise fact), testimonial (persona verbatims), offer\_led (an offer fact)
  - never: demo, comparison, other
- **steal (4–5):** the (angle, hook) pairs with the highest winner lift across competitor ads, each backed by at least 2 winning ads. If a pair's hook isn't producible, take the next pair. With fewer than 5 winners in total, use the dashboard's over-index rows instead.
- **double\_down (2–3):** the (angle, hook) pairs from Magic Spoon's own ads with the longest longevity\_days.
- **gap (2–3):** voc\_pain and voc\_objection facts that no winning angle addresses. The LLM picks an angle and hook that answer each one, and the rationale cites the fact.
- **control (1):** Magic Spoon's live ads.
- Dedupe to 10–12 arms plus the control. Recipes sharing an angle must use different hooks. Each arm's evidence lists its ad ids or fact ids.

**Live ads to creative rows**

| Creative field | From library\_ads and ad\_labels |
| --- | --- |
| headline | creative\_link\_titles\[0\], else hook\_text |
| primary\_text | creative\_bodies\[0\] |
| cta | Not stored by Adcero; default "Shop Now" |
| visual\_description | ad\_labels.summary plus fingerprint.visual\_hook |
| image\_url | media\_urls\[0\]. Meta CDN links expire, which is fine for a weekend |
| days\_running | longevity\_days |
| origin, segment\_id, status | competitor\_live (or brand\_live for Magic Spoon's own page); no segment; ranked |

Keep only ads with body text, active ones first.

**Done when** B's warm-up round runs on these rows at 2:30 PM.

### A5 · Sat 2:30 – 5:30 PM · Creative generation worker

A \~200-line orchestrator in `worker/creatives/` that calls Adcero's pure creative stages directly and never enters the image pipeline. It follows CREATIVE\_MANIFEST's "Text-only mode" sequence, with five changes marked **ours**.

1. **Rows.** Load live brand\_facts. **Ours:** drop `market_prior` facts first, so competitor share statements never become "brand facts" or proof for numbers. Then `buildDesiredRows`. Recompile packs every run; never store them.
2. **Pack hints.** `derivePackHints(rows)`, the \~15-line rewrite from CREATIVE\_MANIFEST §4.
3. **Group.** Group the task's recipes by (segment, angle). Each group becomes one brief, and each recipe's hook becomes one copy variant.
4. **Strategy.** `strategyFromArms`, the \~30-line rewrite from §4. **Ours:** it validates the angle against the food-industry vocabulary instead of the 8 universal angles, and rejects hooks the pack hints can't produce.
5. **Brief and pack.** `composeBrief` → `canonicalAngleUniversal` → `compile`, with:
   - `personaRef` = the segment id (the persona row)
   - **ours:** `angleTheme` = the recipe's food token, set directly. That fixes the export's dropped-fact bug, where a universal angle like "health" matched no fact tagged health\_nutrition
   - **ours:** `keyMessageRef` = the strongest proof\_point or usp fact for that angle, when one exists, so the key claim always reaches the copywriter
6. **Copy.** `renderCopyPrompt`, then `generateBrandCopy` once per hook, in parallel (gpt-4o, with its built-in single retry). **Ours:** a one-file edit to `buildStrategyBlock` in `generation/brand-copy.ts` adds an optional `notes` list, rendered as "Notes from testing" from the learnings' number-free directives. The block sits outside the grounding text, so nothing in it can make a number "grounded".
7. **Checks.** `composeCopyBlock` → `buildGenome` → `runGates`, with no image and no judge. Any failed gate makes the creative `gated_out`. No ranking: the sim ranks.
8. **Write.** Creative rows with headline, primary\_text, cta, visual\_description (`visualConcept`, else the variation text), segment\_id, arm\_id, landing\_product\_id, pack\_fingerprint, learning\_ids and status.
9. **Hand back.** Mark the task done and queue `run_round` for the next round, until rounds\_planned.

Also in this phase:

- [ ] **Smoke test first:** run the orchestrator on `fixtures/creative-brief.json` and diff against `creative-output.json` before touching real data.
- [ ] **Round 0 by about 4 PM:** one creative per (recipe, segment). With 10–12 recipes and 3 segments that's 30–45 creatives, about 2¢ each, written in parallel. B then re-runs the warm-up on real creatives.
- [ ] Run the worker with `NODE_ENV=production` and `CREATIVE_JUDGE_GATE_MODE=off`.
- [ ] Export the whole sequence as `runGenerateCreatives(taskId)`. The worker loop and A6's Copywriter agent (through `app/api/agent/creatives`) both call it. The worker claims a `generate_creatives` task only after it has sat unclaimed for 60 seconds, so the Copywriter goes first and a stopped agent never stalls the loop.
- [ ] **If time remains:** a `competitorReference` for steal recipes (the winning ad's angle, hook and execution notes, competitor names scrubbed with `sanitizeExecutionNotes`), rendered in the same strategy block.

**Done when** a `generate_creatives` task turns into ranked creative rows and a queued `run_round` with nobody touching it.

### A6 · Sat 5:30 – 10:30 PM · Fetch agents: A2A orchestration in ASI:One

Four uAgents run the loop by messaging each other. SpacetimeDB is the shared world they act on and the record of everything they say; the workers do the heavy compute. A6 can start in parallel with A3–A5, in its own worktree: each endpoint serves the fixtures until its phase lands.

| Agent | Talks to | Owns | Decisions it makes |
| --- | --- | --- | --- |
| **Ad Lab** | the user in ASI:One, and every agent | the conversation, the run plan, the cards | what to delegate, when to ask the user, what to show |
| **Scout** | Ad Lab | Apify refreshes and distillation, through the job queue; brand and competitor intelligence | which pages and sources are stale enough to refresh (`last_synced_at`), when the brand context is ready |
| **Strategist** | Ad Lab, Copywriter | the recipes (A4's arm builder), the rounds on the task board, the results | how many rounds, stopping early once p\_best ≥ 0.8 in every segment, the winners per segment |
| **Copywriter** | Strategist, Ad Lab | each round's `generate_creatives` task | which learnings' directives to apply, how many variants per arm within the task's n\_per\_arm |

The loop, as one chat:

1. The user asks in ASI:One. Ad Lab acknowledges at once and sends Scout an intel request.
2. Scout refreshes the stalest Meta pages and sources through `ingest/refresh`, which enqueues the copied Adcero jobs; the job worker runs the Apify actors. While they run, Scout reports from the corpus already distilled, and Ad Lab posts the brand profile and competitor winners cards.
3. Ad Lab asks Strategist for a plan. Strategist builds the recipes (`contract/build`), and Ad Lab posts the recipes card.
4. On the user's go, Strategist queues `run_round` for round 0 on the task board, and B's sim worker claims it.
5. After each round, B's bandit queues `generate_creatives`. The Copywriter claims it, writes the variants through `creatives/generate`, completes the task and queues the next `run_round`, then tells Strategist.
6. Strategist sends each round's result, and Ad Lab posts the leaderboard card. When the winners are clear, or after rounds\_planned, Strategist reports the winners and Ad Lab posts the winning ads per segment.

Every hop is a typed message, logged to `agent_message` as it's sent, so `/agents` shows the conversation between the agents live, beside the chat.

- [ ] **SpacetimeDB:** the `agent`, `agent_message` and `ingest_job` tables (The contract) and their reducers in `tables_a.ts` and `reducers_a.ts`. Publish in place and regenerate the client.
- [ ] **HTTP API** in `app/api/agent/`, called by the agents. Every job an endpoint starts gets an `ingest_job` row.
  - ingest/refresh: a small live refresh (the stalest pages and sources, small limits) through the copied queue functions, reusing A2's steps
  - distill/start: `brand_object_crawl` with chain: true, when the brand context is missing or stale
  - jobs: the status of a set of job ids
  - brand-summary (top pains, desires and objections with quotes, via retrieveBrandSlice) and competitor-summary (winners and top recipes)
  - contract/build: A4's segment builder, arm builder and live-ad rows
  - creatives/generate: A5's `runGenerateCreatives` for a claimed task
  - rounds: start (queues `run_round` on the task board), status and summary
- [ ] **Job mirror:** `worker/loop.ts` reports each claim and finish, and the job's `ingest_job` row follows it.
- [ ] **Four uAgents** in `agents/`, started together by `npm run agents`:
  - each with its own seed, address and mailbox, registered on Agentverse in the Innovation Lab category;
  - typed protocols (uAgents Models) for every hop: intel request and report, progress, plan request and recipe plan, start run, round result, creatives written, run finished;
  - each also speaks the chat protocol, so judges can ask Scout or Strategist directly in ASI:One. The primary flow goes through Ad Lab only;
  - one helper sends every message and logs it to `agent_message` in the same step, and each agent keeps its `agent` row current;
  - Strategist and Copywriter watch SpacetimeDB (round rows, queued tasks) every few seconds and act on changes.
- [ ] **The ASI:One flow:** Ad Lab acknowledges every request at once and turns each hop between agents into a one-line progress message ("Scout started 4 Apify runs: Meta ads for Catalina Crunch, …"). Interactive Cards for:
  - the brand profile
  - competitor winners
  - the recipes
  - each round's leaderboard
  - the final winning ads per segment
- [ ] **/agents** in `app/agents/`, a live view built on `lib/spacetime`, with Adcero's components and a nav link next to `/sim`. It shows:
  - the four agents, with their status and current step
  - the message stream between them (from → to, kind, summary)
  - the ingest jobs, with their Apify actors and status
  - the task board
- [ ] **README:**
  - each agent's name, address and job
  - the innovationlab and hackathon badges
  - how to run it
- [ ] **If time remains:** the Payment Protocol. Ad Lab asks the user to approve a small fee before each test run.

**Done when** one ASI:One message ("find ads that beat Magic Spoon's current ones") makes the agents refresh the data on Apify, post the brand and competitor cards, propose recipes, run the rounds with the Copywriter writing between them, and post the winners, with no other screen needed. Every hop also shows up live on `/agents` and in `agent_message`.

### A7 · Sat 10:30 PM – Sun 1 AM · The two Adcero pages, live

- [ ] Route handlers for the endpoints in REUSE\_MANIFEST §7.4. Serve the fixtures first, then switch to Supabase. dashboard and competitors/list use the §5.5 rewrite.
- [ ] The Competitor Analysis page first, then Brand Identity.
- [ ] Nav links to `/sim` and `/agents`.

**Done when** both pages render Magic Spoon's real data in Adcero's look.

### A8 · Sun 1 – 8 AM · Demo and submission, with B

- [ ] A full cached run, and a rehearsed ASI:One flow with `/agents` beside the chat. If time allows, re-run the final dataset end to end through the agents, so the demo's data came through them.
- [ ] Videos: 3–5 minutes for Fetch (the ASI:One chat beside `/agents`), and the 3-minute pitch for judging.
- [ ] Devpost: repo, image, video, and the Apify, Fetch.ai, SpacetimeDB and Visa tracks. Register with the ASI:One submission agent too.

**Done when** everything is submitted by 8 AM.

### Person A cut lines

If A falls behind, cut in this order:

1. The competitor reference in copy
2. The Brand Identity page (keep Competitor Analysis)
3. TikTok and X
4. The Payment Protocol
5. The Copywriter as claimer: the A5 worker claims every creative task, and the Copywriter only reports what was written
6. Interactive Cards (send plain messages instead)
7. Polish on `/agents` (keep the message stream)

Never cut: real scraped data behind the segments and recipes, the identity crawl (it supplies the brand facts every ad is built from), the task-board loop, the ASI:One primary flow, and the agents messaging each other with every message in SpacetimeDB.

### Person A risks

| Risk | Fallback |
| --- | --- |
| The OpenAI key can't call a default model | Override per role with env vars, checked in A0 |
| The port hits a compile wall | The exports proved every import resolves, so fix stubs, not the pure logic. Time-box A1 to 8 AM, then import the insurance datasets |
| Distillation refuses to rerun | Raise the monthly LLM-call cap and clear the cooldown fields |
| Instagram or TikTok runs are slow or blocked | Start them first and keep the caps; drop them per cut line 3 |
| Fewer than 5 competitor winners, so no market priors | Build the steal recipes from the dashboard's over-index rows instead |
| Copy keeps failing the number check and falls back to the brief's own text | Check that proof-point facts exist and reach the pack through keyMessageRef |
| ASI:One times out on long steps | Acknowledge, send progress messages, and read precomputed results in the demo |
| An agent process dies mid-run | The loop never waits on it: the A5 worker claims creative tasks left unclaimed for 60 seconds, B's worker is independent, and the mailbox holds messages until `npm run agents` restarts it |
| The live Apify refresh is slow on stage | Small limits, and Scout answers from the corpus already distilled while the refresh runs; the demo never waits on it |
| Agentverse or ASI:One delivery lags | Ad Lab acknowledges at once, and `/agents` shows the work even when the chat is slow |
| Judges read the agents as a thin wrapper | Each agent makes real decisions (what to refresh, when to stop, which learnings to apply), and `agent_message` shows every one |
| Apify spend climbs | Keep the caps; check usage in the Apify console after A2 |

## Simulation design

Each sim day, every shopper scrolls a feed holding one of our ads and two real competitor ads. Jev says how likely each tap and each purchase is, code rolls the dice, and the shopper's memory updates. Default run: 300 shoppers across A's segments (Adcero's persona step makes 2–4), a warm-up round plus 5 rounds of 3 sim days each, seed 13.

**Donkey version.** Think of 300 pretend customers, each written up from real Magic Spoon reviews and posts. Every day each one scrolls past three ads. A judge (Jev) reads who they are and what they remember, and says "this person has a 2% chance of tapping that ad". We roll a die to decide what they actually do, and they remember it the next day. Across thousands of these moments, the ad recipes that earn orders rise to the top.

### What carries over from ShopSim

ShopSim's rules carry over; its code and graph database do not.

| ShopSim piece | In Ad Lab | Why |
| --- | --- | --- |
| Evidence hierarchy: seeing an ad never teaches taste; tap < stay < buy | Keep | Its rule 1 |
| Single entry: each variable enters once | Keep, as "each fact appears once in the text Jev reads" | Jev reads the whole state, so a repeated fact counts twice |
| Abstention: no belief means no belief | Keep, as literal lines ("No opinion of Magic Spoon yet") | Never fake a neutral number |
| The model gives a probability; code rolls the dice | Keep, with seeded, hash-keyed draws | Reproducible runs |
| Perception runs once and is frozen | Keep: each creative's claims are extracted once (Claude; image-capable for live ads) and cached | Jev takes no images |
| Calibrate to researched ranges; never inflate | Keep: one log-odds offset per gate, fitted on the warm-up round | Its rule 8 |
| Record decision inputs | Keep: every decision row stores the raw probabilities and the state hash | Its rule 9 |
| Graph database and motif paths | Drop: replaced by memory lines computed in code | Not a priority this time |
| Appraisal and choice formulas, gate thresholds | Drop: Jev answers the gates |  |
| Click → browse → cart → buy, with cart resume | Simplify to tap → stay → buy, no cart | Time |
| Social ties, habits, delivery and experience loop | Drop | Time |
| Versioned (bitemporal) records | Only for the learning table |  |
| Bug (a): first page visit ignored price and budget | Fixed: the page in the state always shows the price, and the budget guard always runs |  |
| Bug (b): a page visit counted twice | Fixed: one STAY event, one evidence row |  |
| Bug (e): an ad's promise checked against every brand page | Fixed: the page call shows the exact ad that was tapped |  |

### The world

- **Products and pages.** One landing product per brand to start (for example, Magic Spoon's variety 4-pack). Fill price, subscription price, rating, review count and page highlights from each brand's site tonight; don't trust memory for prices.
- **The feed.** One session per shopper per sim day, with 80% reach. A session holds 1 of our ads plus 2 competitor ads, sampled with weight proportional to days\_running, so long-running (likely profitable) ads show up more. A tap on a competitor ad counts as "lost to a competitor" and isn't modelled further.
- **Concept vocabulary (draft, agree with A):** high\_protein, low\_sugar, low\_carb\_keto, taste, nostalgia, crunch\_texture, flavor\_variety, clean\_ingredients, gluten\_grain\_free, keeps\_full, fitness, weight\_goals, kid\_friendly, convenience, value\_price, discount\_offer, subscription, social\_proof, other.
- **Fixture segments until A's personas land:** keto\_low\_carb, protein\_athlete, nostalgic\_adult, healthy\_family, taste\_skeptic, deal\_seeker. Each gets 3–5 placeholder quotes and prior weights. A's clustering replaces them.

### Shopper state

| Field | How it starts | How it changes |
| --- | --- | --- |
| segment, display name | Segment by share; name from a fixed list | Never |
| quotes | 2 drawn from the segment's pool | Never |
| preferences: concept → (w, E) | w \~ N(segment prior, 0.08), clipped to 0.05–0.95; E = 2 | Evidence table below |
| opinion of each brand: (value, E) | None (abstention) | STAY and BUY |
| exposure memory | Empty | Every ad seen: tick, creative, brand, claimed concepts |
| engagement history | Empty | Taps, stays, purchases |
| shopping-for-cereal flag | Bernoulli(in\_market\_rate) | Arrives each tick at the segment's rate (default 0.12), lasts 4 ticks, ends on a purchase |
| budget left | N(budget\_mean, budget\_sd), floor $15 | Minus each purchase |
| expected price per product | None | First sighting sets it; later 0.7 × old + 0.3 × seen |

### One sim day, step by step

1. **Needs:** expire old shopping flags, then draw new arrivals.
2. **Reach:** draw whether this shopper scrolls today (80%).
3. **Our ad:** the bandit picks an arm for this shopper's segment, then one creative within that arm.
4. **Neighbours:** draw 2 competitor ads, weighted by days\_running.
5. **Order:** shuffle the 3 ads with a seeded draw.
6. **Feed call:** render the state and ask Jev which ad, if any, gets tapped (cached).
7. **Page call:** always ask the page questions for our ad, whether or not it gets tapped. The reward needs them (cached).
8. **Guard and calibrate:** if price > budget left, P(buy) = 0. Then apply the calibration offsets.
9. **Dice:** draw the tap. If our ad is tapped, draw stay, then buy.
10. **Memory:** log every ad seen, apply the evidence table, update expected price, budget and the shopping flag.
11. **End of day:** write the day's rows to SpacetimeDB in one batch, then update the bandit.

Every draw uses its own key, `hash(seed, stream, shopper, tick, …)`, with streams need, reach, arm, variant, neighbours, order, tap, stay and buy. Changing the population size never changes an existing shopper's draws.

### Learning rules (the evidence table, with ShopSim's double count fixed)

The update rule is a weighted average that firms up with evidence:

```latex
w' = \frac{E \cdot w + wt \cdot target}{E + wt}, \qquad E' = \min(E + wt,\ 8)
```

| Event | Preference weight, toward 1.0, on our ad's claimed concepts | Opinion of the brand: weight → target |
| --- | --- | --- |
| SEEN | 0 (seeing never teaches taste) | 0 (awareness only) |
| TAP | 0.10 | — |
| STAY | 0.25 | 0.75 → 0.6 |
| BUY | 1.00 | 1.5 → 0.65 |
| Left the page within seconds | 0 | 0 |

An unheld concept starts at w 0.5, E 1.0, ShopSim's Phase 7 fix. A brand opinion starts empty, so the first event sets it outright. Changes smaller than 0.01 are ignored.

## The Jev calls

Each impression of our ad costs two Jev calls: a feed call (what gets tapped) and a page call (whether they'd stay and buy). Code builds the text; Jev only answers.

**Jev in one paragraph.** You send a block of text (the state) plus named questions with a fixed answer space. Jev returns probabilities, never prose. The three question types are Choice (pick one option), Score (a level on a rubric) and Noul (a yes/no probability). Questions in one call run side by side and can't see each other's answers. Endpoint: `POST https://api.typesafe.ai/v1/systemone`. Confirm the exact request and response field names in the TypeSafe docs during B0 before writing the wrapper.

### The state text

```
SHOPPER
{name}. {segment description: life context, one or two sentences}
In their own words: "{quote 1}" / "{quote 2}"
Cares a lot about: {…}. Cares somewhat about: {…}. Doesn't think about: {…}.
{Shopping for a new cereal right now and wants to buy within a few days. | Not shopping for cereal right now.}

MEMORY
{Has seen Magic Spoon ads 4 times this week, mostly about protein. | Has never seen a Magic Spoon ad.}
{Has also seen Catalina Crunch ads twice this week.}
{Opinion of Magic Spoon: likes it, from one page visit. | No opinion of Magic Spoon yet.}
{Tapped a Magic Spoon ad 2 days ago, looked at the page, didn't buy.}
{Thinks a Magic Spoon 4-pack costs about $40.}

RIGHT NOW
Scrolling Instagram on their phone. Three sponsored posts appear one after another.
```

The page call keeps SHOPPER and MEMORY and replaces RIGHT NOW with:

```
THEY TAPPED
{brand}: {headline}. {primary text} [Button: {cta}] [Image: {visual description}]

THE PAGE
{product} — ${price} one-time, ${subscription price} with subscription.
Rated {rating} from {review count} reviews. Page highlights: {…}. {shipping note}
Price compared with what they expected: {first time seeing a price | about what they expected | about 20% more than expected | cheaper than expected}
```

### The questions

| Call | Name | Type | Wording | Answer space |
| --- | --- | --- | --- | --- |
| Feed | tap | Choice | Which post, if any, does this shopper tap to learn more? | A, B, C (each described by its full ad text), none = keeps scrolling |
| Feed | believes | Noul | Does this shopper believe the main promise of the {brand} post that says "{headline}"? | Our ad only |
| Page | stays | Noul | Does the shopper look through this page instead of leaving within a few seconds? |  |
| Page | buys | Noul | If they stay, do they buy on this visit? | Phrased conditionally, so it can share the call with stays |
| Page | objection | Choice | What is the main thing holding them back, if anything? | price, taste\_doubt, trust, not\_now, other\_brand, nothing |

### Rendering rules

1. Keep each state under 450 words. Jev gets less accurate as irrelevant text grows.
2. Every fact appears once. Never put the segment name or an archetype label next to the preference line; that counts the prior twice.
3. Code turns numbers into words. Jev isn't a calculator: counts, dates and price gaps arrive pre-computed ("2 days ago", "about 20% more than expected").
4. The budget never appears in the text. It enters only through the code guard (price > budget left → P(buy) = 0), so it has exactly one entry point.
5. Abstention lines are literal. Missing knowledge says so; it is never a fake neutral value.
6. Option keys are neutral letters, and their order is shuffled per decision with a seeded draw.
7. Preference words: w ≥ 0.70 is "cares a lot", 0.45–0.70 "cares somewhat", below 0.45 "doesn't think about". Show at most 6 concepts: the strongest ones, plus any concept today's ads claim.
8. Opinion words: value ≥ 0.60 "likes it", 0.45–0.60 "mixed", below 0.45 "skeptical", followed by where it came from ("from one page visit", "from a purchase").

### Calibration

**Donkey version.** Jev's raw numbers may run hot, like a thermometer that reads 5 degrees high. We subtract one fixed amount per question on the log-odds scale. That moves the average into real-world ranges and keeps who-is-hotter-than-whom exactly the same.

```latex
p_{cal} = \sigma\left(\operatorname{logit}(p_{raw}) + b_{gate}\right)
```

- The warm-up round (round 0) shows every arm equally and collects raw probabilities.
- Bisection finds each offset b so the average calibrated probability hits its target. Targets are the middle of ShopSim's researched ranges:
  - tap: 1% per ad, range 0.5–2%
  - stay: 50%, bounce range 45–55%
  - buy given stay: 4%, which gives about 2% from visit to purchase (range 1–3%)
- For the feed Choice, calibrate P(tap any) = 1 − P(none), then split it across the three ads in proportion to Jev's raw shares.
- The offsets are frozen into the run's calibration column. Raw and calibrated values are both stored on every decision. Never loosen a gate to make the demo livelier.

### Cache and determinism

- **Cache key:** sha256(model version + question spec + state text + option order). Answers go in a local SQLite file. A re-run with the same seed costs nothing and gives identical numbers, which is the demo's safety net.
- **Run manifest:** the run row stores the config hash, model version, calibration offsets and seed.
- **Pinned model:** `jev-1.13.0`, not `jev-latest`. A silent model upgrade would shift the calibration.

### Call budget

| Item | Per round | Per full run (warm-up + 5 rounds) |
| --- | --- | --- |
| Feed calls (300 shoppers × 3 days × 80% reach) | \~720 | \~4,300 |
| Page calls (one per impression of our ad) | \~720 | \~4,300 |
| Input tokens (\~900 per call) | \~1.3M | \~7.8M |
| Cost at $0.042 per million input tokens | \~$0.05 | \~$0.33 |
| Wall time at 24 parallel calls × \~0.3 s | \~18 s | \~2 min |

TypeSafe lists latency at 70–500 ms. The rate limit is unknown until B1 measures it.

## Reward, bandit and learnings

The bandit scores each recipe by expected orders per impression, computed from Jev's probabilities rather than from dice rolls. That keeps rankings stable even when real taps are rare. It picks per shopper with Thompson sampling, pooled across segments, and always keeps Magic Spoon's live ads in play as the control.

### Reward

**Donkey version.** At a 1% tap rate, 300 shoppers produce only a handful of real taps per round, which is far too few coin flips to tell recipes apart. So instead of waiting to see who taps, we score every impression by its odds: tap chance × stay chance × buy chance. That's like judging a basketball shot by its angle and speed instead of only whether it went in. Same average, far less noise. The dice still decide what each shopper actually does and remembers.

For each impression of our ad:

```latex
r = P_{cal}(\text{tap our ad}) \times P_{cal}(\text{stay}) \times P_{cal}(\text{buy} \mid \text{stay}) \times \text{guard}
```

guard is 0 when the price is over the shopper's budget, else 1. r is in expected orders per impression.

The dashboard shows it as an estimated cost per order: CPM ÷ 1,000 ÷ r, using ShopSim's $13.88 CPM. That's an assumption; swap in a real Meta CPM for cereal if A finds one.

### Bandit

**Donkey version.** Each recipe has a best guess of its score, plus an error bar. For every impression we draw a random value inside each recipe's error bar and show the recipe with the highest draw. Recipes with wide error bars sometimes draw high, so they still get tried. Clear winners win most draws.

- **Arms:** A's 10–12 recipes (angle × hook from Adcero's enums) plus the control arm (Magic Spoon's live ads). Within an arm, each impression picks at random among the creatives written for the shopper's segment, falling back to any of the arm's creatives.
- **Context:** the shopper's segment. Each (segment, arm) cell has its own estimate, and thin cells borrow strength from the arm's average across all segments.
- **Estimate for segment s and arm a:**

```latex
\mu_{s,a} = \frac{n_0 \, m_a + \sum r}{n_0 + n}, \qquad \sigma_{s,a} = \frac{sd_{pool}}{\sqrt{n_0 + n}}, \qquad n_0 = 30
```

- m\_a is the arm's mean reward across all segments; an unseen arm uses the mean across all arms. sd\_pool is the spread of r across all impressions so far.
- **Per impression:** draw θ \~ N(μ, σ²) for every live arm, with a seeded draw, and show the arm with the highest θ.
- **Floors:** the control arm gets at least 10% of impressions and every other live arm at least 3%, so new variants get tried and the comparison with the brand's current ads stays measured.
- **Updates:** estimates refresh at the end of each sim day, not after every decision. That keeps a day's decisions independent of processing order.
- **p\_best:** 2,000 joint draws per segment give each arm's chance of truly being the best. It drives the learnings and the leaderboard.

### One round, end to end

1. **Round 0 (warm-up):** every arm gets equal impressions. Its raw probabilities fit the calibration offsets and seed the bandit.
2. **Rounds 1–5:** the bandit allocates impressions over 3 sim days.
3. **End of round:** B writes arm\_stat rows, new learnings and the round summary (top arm per segment, its cost per order against the control's, the new learnings, calls, cost and cache hit rate).
4. **Generation:** B takes the top arm per segment, dedupes, and keeps at most 3. It queues `generate_creatives` with 1 new variant per arm and the learning ids to use.
5. **Next round:** A's creative worker writes the new creatives and queues `run_round` for the next round, until rounds\_planned is reached.

B also ships a CLI, `sim run --rounds 5 --fixtures`, which reuses existing creatives and skips the task board. That lets B work without A all night.

### Learnings

Learnings are written from fixed templates, not by an LLM, so every number is traceable.

| Kind | Fires when | Statement template |
| --- | --- | --- |
| winner | p\_best ≥ 0.8 and n ≥ 100 | For {segment}, {angle} × {hook} leads: about ${cpo} per order vs ${cpo\_control} for Magic Spoon's current ads ({p}% chance it's truly best). |
| objection | ≥ 50 page calls for the segment | {segment} mostly hesitate over {objection} ({share}% of page visits). |
| claim\_doubt | mean believes < 0.40 and n ≥ 50 | {segment} don't believe {concept} claims (only {pct}% do). |
| wear\_out (if time) | tap chance falls ≥ 30% after 3 same-concept showings | {concept} ads lose about {x}% of their pull after 3 showings for {segment}. |

Each learning also gets a **directive**: the same point with every number removed. Only directives reach the copywriter, so a simulated percentage can never leak into an ad.

| Kind | Directive template |
| --- | --- |
| winner | For {segment}, keep leading with {angle} through a {hook} hook. |
| objection | Address {objection} early for {segment}. |
| claim\_doubt | {segment} doubt {concept} claims: back them with a concrete brand fact or drop them. |
| wear\_out | Rotate {concept} messages for {segment} after a few showings. |

Rules:

- A learning is keyed by (run, segment, kind, arm or concept). A new version sets valid\_to\_round on the old one; nothing is deleted.
- source is always `simulated`. Learnings feed the next round's creative generation only, through their number-free directive (for example, "address taste doubts early for keto shoppers"), so no simulated number can leak into an ad. They never edit an observed brand fact.

## Person B: build phases

B can start right now on fixtures and needs nothing from A until the 2:30 PM Saturday integration. Each phase ends with a check that proves it works; don't start the next phase until it passes.

Layout: the repo root is the Next app, Adcero-style. Put the engine in `sim/src/` (config, rng, population, perceive, render, jev, feed, engine, memory, calibrate, bandit, learnings, spacetime, worker, cli), fixtures in `sim/fixtures/magicspoon/`, views in `app/sim/`, and B's tables in `spacetime/tables_b.ts`. Match the app's versions: Next 16.4, React 19.3, Tailwind 4, npm.

### B0 · Fri 11:30 PM – Sat 1:30 AM · Setup and fixtures

- [x] Make one Choice call and one Noul call to Jev from Node. Write down the exact request and response field names from the TypeSafe docs.
- [x] Scaffold `packages/sim`: TypeScript, Node 20, zod (validate every Jev response), p-limit (concurrency), better-sqlite3 (cache).
- [x] Fixtures:
  - concepts.json: the draft vocabulary
  - segments.json: the 6 draft segments, each with 3–5 quotes and prior weights
  - products.json: one product per brand, prices copied from the sites tonight
  - arms.json: 10–12 placeholder recipes plus the control
  - creatives.json: one text ad per arm, 2–3 Magic Spoon live ads, 2 live ads per competitor copied from the Meta Ad Library
- [x] Spend 15 minutes with A agreeing the concept vocabulary and the contract table shapes.

**Done when** `npm run sim:smoke` sends one feed call for one fixture shopper and prints the probabilities.

### B1 · Sat 1:30 – 4 AM · Jev spike: settle the question shapes

Run these on about 10 hand-built states before writing the engine:

1. **Sensitivity:** a keto shopper should favour the low-carb ad, and a nostalgic shopper the childhood-taste ad, by at least 1.5×.
2. **Order:** shuffle the same 3 options 10 times. Each ad's tap share should move less than 20% (relative).
3. **Memory:** adding "seen 4 protein ads this week" should lower the protein ad's tap chance.
4. **Need:** adding "shopping for cereal right now" should raise P(buy).
5. **Mechanics:** p50 and p95 latency, the rate limit, error types and retry behaviour.

**Decision rule:** if test 2 fails, switch the feed call to one Noul per ad ("does the shopper tap this post?"), with the other two ads described in the state.

**Done when** `SPIKE.md` records the numbers, the chosen question shapes and the concurrency limit.

### B2 · Sat 4 – 9 AM · Engine core, in memory

- [x] Hash-keyed draws, population draw, perception (Claude, cached per creative).
- [x] State renderer that follows every rendering rule.
- [x] Feed assembly, feed call, page call, budget guard, dice, memory updates (the evidence table).
- [x] One-round JSON summary printed to the console.
- [x] Five tests:
  - same seed + warm cache gives identical output
  - the budget guard zeroes P(buy)
  - a tap → stay → buy chain matches hand-computed preference values
  - every state is under 450 words, with no segment names
  - option order changes with the seed

**Done when** `npm run sim:run -- --rounds 1 --fixtures` finishes in under 60 seconds and two runs print identical output.

### B3 · Sat 9 AM – 12 PM · Calibration, reward, bandit, learnings

- [x] Warm-up round and offset fitting by bisection; offsets saved on the run.
- [x] Reward per impression, pooled Thompson sampling, floors, p\_best.
- [x] Learning templates with versioning.
- [x] Planted-winner test: one fixture creative is written to fit one segment perfectly. By round 3 it should get more than 50% of that segment's impressions.

**Done when** a 5-round fixture run prints arm stats and learnings, and the planted winner wins.

### B4 · Sat 12 – 3 PM · SpacetimeDB, task board, integration

- [x] `tables_b.ts` with batch reducers: one call per table per sim day.
- [x] Worker that claims `run_round`, runs it, writes the summary and queues `generate_creatives`.
- [x] The round summary JSON A's ASI:One cards will render.
- [ ] **2:30 PM integration with A:** swap fixtures for A's real segments, arms, creatives and competitor ads. Re-run the warm-up round, because new personas need new calibration offsets.

**Done when** A starts a round from ASI:One, the worker runs it, and the summary lands in the round row.

### B5 · Sat 3 – 10 PM · Live sim views

Build the five views in the next section on SpacetimeDB subscriptions. The browser client is ready in `lib/spacetime/` (see Status).

Test them on a local bench before A4's rows reach the shared database:

- a local SpacetimeDB server seeded with B's fixtures;
- the real worker driving rounds against it;
- a `/sim/dev` page showing which database the page is on, live row counts and the task board.

Then point the same views at Maincloud.

**Done when** all five update live during a real round: first on the local bench, then on Maincloud once A4's rows are there.

### B6 · Sat 10 PM – Sun 2 AM · Demo run and pinned shopper

- [ ] A full run on real data, with the cache warm.
- [ ] A script that finds the shopper whose tap or buy chance on the same arm changed most between rounds, for a clear reason (a new shopping flag or ad wear-out).
- [ ] Pin that shopper, freeze their capture to JSON, and add a replay mode that plays the cached run at a chosen speed.

**Done when** the whole demo replays offline from cache with identical numbers.

### B7 · Sun 2 – 6 AM · Buffer and submission

- [ ] Write the README's simulation section: how it works, what's real vs simulated, calibration targets.
- [ ] Record screen clips for the video.
- [ ] Help A submit by 8 AM; the hard deadline is 9 AM.

## Live sim views

B builds five views on one `/sim` page, all fed by SpacetimeDB subscriptions, so changes push to the browser with no polling. They reuse the design tokens and components A imports from Adcero, so the sim looks like the rest of the app. Pick the chart approach once the export shows what Adcero already uses.

| View | What it shows | Reads |
| --- | --- | --- |
| Allocation river | Impressions per recipe per sim day as a stacked stream, control in a fixed colour. You watch the bandit pour impressions into winners. This is ShopSim's AllocationRiver idea | decision (feed rows) by round × arm |
| Leaderboard per segment | Estimated cost per order with its range, chance of being best, and the control row for comparison | arm\_stat |
| Decision ticker | The last 50 decisions: shopper, ad, tap chance, outcome. It shows the probability, not just the result, because most real outcomes are "kept scrolling" | decision |
| Shopper inspector | The pinned shopper: who they are, their quotes, the exact text Jev read, each question with its probability, the dice roll, and how their memory changed across rounds. A "what if" toggle removes one memory line, re-asks Jev (cached) and shows how the probability moves | shopper, decision, plus a small API route for what-if calls |
| Learnings feed | New learnings per round, each linked to the creative that used it next round | learning, creative.learning\_ids |

A header strip shows the run's progress (round, sim day), Jev calls, cost and cache hit rate.

The what-if toggle is the most Jev-native feature in the build. Remove one line, such as "shopping for cereal right now" or "seen 4 protein ads this week", and the screen shows exactly how much that one fact moved the decision. It's ShopSim's need-off counterfactual, applied to any line.

## Demo, cut lines and risks

The sim gets about 75 seconds of the 3-minute pitch. Every number in it comes from the cached run, so it replays identically. The agents open the pitch (about 45 seconds), and the Fetch video shows the whole chat.

### Agent demo beats

The ASI:One chat on one side of the screen, `/agents` on the other.

1. **Ask:** "Find ads that can beat Magic Spoon's current ones." Ad Lab acknowledges and hands off to Scout; the first messages appear on `/agents`.
2. **Scout goes to work:** it picks the stalest pages and sources and starts a live refresh on Apify. The jobs appear on `/agents` with their actors and status, while Scout's brand profile and competitor winners cards land in the chat.
3. **Strategist plans:** the recipes card, built from the competitor winners and the customers' pains. The user says go; Strategist queues round 0, and `/sim` starts filling.
4. **The loop runs itself:** after each round the Copywriter claims the creative task, writes new variants from the learnings and hands the next round back, and Strategist posts the leaderboard card.
5. **Done:** Strategist stops once the winners are clear, and Ad Lab posts the winning ads per segment. Honest line: "The agents ran the full scrape earlier through the same jobs; on stage they refresh it live."

### Sim demo beats

1. **Start:** A starts a round from ASI:One. The river fills and the ticker scrolls.
2. **Winners:** jump to round 4. In at least one segment, the winning recipe's cost per order beats Magic Spoon's current ads.
3. **One shopper:** the pinned shopper meets the same recipe in round 1 and round 4, and reacts differently. Flip the what-if toggle on the line that changed (shopping now, or ad wear-out) to prove why.
4. **It learned:** a learning card (for example, "keto shoppers doubt childhood-taste claims"), then the next round's creative that used it.
5. **Honest line:** "These are rankings, not forecasts. Jev reads shoppers built from real reviews, and rates are calibrated to industry ranges."

### Cut lines

If B falls behind, cut in this order:

1. The wear-out learning
2. The what-if toggle (keep the inspector)
3. Pooling across segments (estimate each segment on its own)
4. Shopping-flag arrivals (fixed flag per shopper instead)
5. Preference learning (keep exposure memory only)

Never cut: memory in the state text, the bandit with the allocation river, the comparison against the control arm, and the cache.

### Risks

| Risk | Fallback |
| --- | --- |
| Jev barely reacts to persona differences | B1 catches it at 4 AM. Use sharper quotes and plainer preference lines. If it's still flat, add a Score question ("how appealing is this post to them") and fold it into the tap estimate |
| The feed Choice favours whichever option comes first | Order is already shuffled; if the bias persists, switch to one Noul per ad (the B1 rule) |
| Rate limit lower than expected | Lower concurrency and drop to 150 shoppers. Rewards use probabilities, so rankings stay stable at smaller sizes |
| A's real data arrives late | Fixtures share the contract's shapes, so the swap is a data load |
| Calibrated tap rates make the ticker look empty | The ticker shows each decision's probability; charts use expected values |
| Live demo hiccup | Replay from cache, same numbers |
| SpacetimeDB write bursts | One batched reducer call per table per sim day |
| New personas shift Jev's raw numbers | Re-run the warm-up round after the 2 PM swap; offsets are per run |

Sources: ShopSim export `SIM_NOTES.md` and `contracts.ts` at commit b208e33, [TypeSafe Jev overview](https://nexos.ai/blog/what-is-jev/), [Cal Hacks prizes](https://hive.hackberkeley.org/prizes).

---

# Appendix: Phase prompts

Paste one block into the coding agent for that phase. Each assumes `docs/PLAN.md` (this file), `docs/reuse-export/` and `docs/sim-export/` are already in the repo.

## Person A

### A0 · Setup and connections

```
Ad Lab, phase A0: setup and connections. Cal Hacks 13.0; hard deadline Sun Oct 25, 9 AM PT. You are Person A's coding agent.
Read first: docs/PLAN.md sections "Locked decisions", "The contract", "Running a phase with a coding agent" (repo layout) and "A0" under "Person A: build phases".
Also read: the Fetch Cal Hacks hackpack (https://www.fetch.ai/events/hackathons/calhacks-13-0/hackpack) and its "How to create ASI:One compatible uAgents" guide; the SpacetimeDB TypeScript module quickstart.
Goal: every A0 checklist item except the Apify insurance runs (I start those by hand). Scaffold the repo layout; Supabase with the vector extension; a SpacetimeDB module in spacetime/ published to Maincloud with a ping reducer and empty tables_a.ts / tables_b.ts; .env.example; `npm run check:connections` printing a pass/fail table for Supabase + pgvector, SpacetimeDB, Apify, every OpenAI model the reused code uses (gpt-5.4, gpt-5.4-mini, gpt-6-luna, gpt-4o, text-embedding-3-small), Jev and ASI:One; a hello-world chat-protocol uAgent in agents/ registered on Agentverse through a mailbox.
Done when: check:connections is all green and the agent replies inside ASI:One.
Rules: write only the root scaffolding, spacetime/, agents/ and scripts/. Secrets only in .env.local. Ask before adding dependencies. Stop and ask if a contract field must change.
Finish with: what works, what is stubbed, the command that proves done-when, and a commit "A0: setup and connections".
```

### A1 · Port the Adcero core

```
Ad Lab, phase A1: port the Adcero core. Cal Hacks 13.0; hard deadline Sun Oct 25, 9 AM PT. You are Person A's coding agent.
Read first: docs/PLAN.md "Locked decisions", "The contract", "A1".
Also read: docs/reuse-export/REUSE_MANIFEST.md §0, §8 (all of it), §12, §13; files.txt; deps.json; CREATIVE_MANIFEST.md §0 and §9.
../adcero is a read-only reference; use it for services/job-processor/job-executor.ts L121–165 (the worker registry). Never write there.
Goal:
1. rsync files.txt from ../adcero, then npm install --prefer-dedupe with the deps.json versions.
2. The 18 same-path stubs of §8.2. Real code only in lib/llm/clients.ts and services/r2-service.ts (local disk; downloadFile must return the bytes).
3. The 11 copy + edits of §8.3, including the market-processor paging fix.
4. findUngroundedNumerals in lib/creative-engine/brand-check/grounding.ts matches whole numbers: "30" must not ground on "3,000", "4.7" must still ground on "4.7 out of 5". Add a unit test.
5. supabase/migrations: the §13 tables without org foreign keys or RLS, the library_ads_enriched view, the job_queue subset with its two dedupe indexes. One constant org id.
6. worker/: the loop from §8.4 with the job-executor registry.
7. The app shell from §7.6.
Never change pure logic in copied files beyond the listed edits; if something won't compile, fix the stub.
Done when: npm run typecheck passes, npm run worker drains an empty queue, and / renders in Adcero's dark theme.
Rules: secrets only in .env.local; deps only from deps.json; stop and ask if a contract field must change.
Finish with: what works, what is stubbed, the proving command, and a commit "A1: port Adcero core".
```

### A2 · Ingest

```
Ad Lab, phase A2: ingest Magic Spoon and its seven competitors. Cal Hacks 13.0; hard deadline Sun Oct 25, 9 AM PT. You are Person A's coding agent.
Read first: docs/PLAN.md "Locked decisions", "A2" and its gotchas.
Also read: REUSE_MANIFEST.md §1, §2, §3, §10.
../adcero is read-only; use tests/fixtures/ad-library/apify-sample.json for a normalizer smoke test.
Work on a new branch off simulation, and open the PR against simulation.
Goal: a script scripts/a2-ingest.ts that, through the copied job types and the worker:
- runs brand_presence_discover on magicspoon.com and confirms the profile;
- sets up and confirms Reddit, Trustpilot, Google Maps, X, Instagram and TikTok sources (handles I give you where discovery misses them), with the plan's caps. If Google Maps finds no place (Magic Spoon sells online), skip it cleanly;
- pins TikTok comment field names with one ~20-item run before the real harvest;
- creates Meta-only tracked_competitors for the seven locked competitors and Magic Spoon's own page (page ids in A2): each with meta_page_id set and no keyword, all tagged with Magic Spoon's brand_profile_id, and Magic Spoon's row with is_brand_self = true. Show me all eight pages (brand, page id, Ad Library link) and wait for my OK before the full scrape. Then, with APIFY_AD_LIBRARY_MAX_ADS=50, run sync → label → embed;
- keeps Magic Spoon's own ads out of market priors through that is_brand_self flag (the market step skips self rows). Prove it with a query; don't edit the market step.
Know before you start:
- Use ADLAB_ORG_ID (lib/adlab/org.ts) and serviceSupabase() (lib/adlab/supabase.ts). Run the script the way npm run worker runs (node --env-file-if-exists=.env.local --import tsx), so .env.local loads before any copied module, and add an npm script for it.
- worker/index.ts runs on import. If the script drains the queue in-process, move the loop into an exported function that npm run worker also uses; don't copy it.
- Every competitor sync enqueues adlib_media_rehost jobs, which A1 didn't port (expiring Meta CDN links are fine for the weekend). Make the worker mark them cancelled as skipped, not failed.
- Surreal is a UK brand. If its US sync returns no ads, set its country to GB and resync.
- The ad labeller's industry classifier defaults to gpt-4o-mini, which A0's model check didn't cover. If it fails, override ADLIB_INDUSTRY_MODEL.
- If an actor fails or comes back empty, import that source's A0 insurance dataset (ids in A2) through the copied normalizers, and tell me.
Done when: brand_mentions has rows from at least 5 sources, and library_ads has labelled, embedded ads for Magic Spoon's page and every competitor page. Print the counts.
Rules: write only scripts/, worker/ and config. Never edit copied Adcero files; stop and ask if one must change. Secrets only in .env.local.
Finish with: counts per source and per page, anything skipped and why, and a commit "A2: ingest".
```

### A3 · Distill

```
Ad Lab, phase A3: distill the brand context. Cal Hacks 13.0; hard deadline Sun Oct 25, 9 AM PT. You are Person A's coding agent.
Read first: docs/PLAN.md "A3" and the A gotchas (cooldowns, the 60-call cap, LLM_FLEX_TIER=0).
Also read: REUSE_MANIFEST.md §4 and §5.
../adcero is read-only; use scripts/brand-object-{build,promote,distill}.ts as the reference run harness.
Goal: let listening drain (relevance → extract → cluster → promote), then run brand_object_crawl with chain: true (crawl → identity → market → personas → chunks). Write scripts/a3-report.ts printing fact counts per section, 10 random VOC facts with their quotes, and retrieveBrandSlice results for "protein", "taste" and "price".
Done when: brand_facts holds identity, voc_*, market_prior and 2–4 persona facts, and retrieval returns sensible quotes.
Rules: change copied code only to fix a real bug, and tell me which file. Secrets only in .env.local.
Finish with: the report output and a commit "A3: distill".
```

### A4 · Contract rows

```
Ad Lab, phase A4: write the contract rows into SpacetimeDB. Cal Hacks 13.0; hard deadline Sun Oct 25, 9 AM PT. You are Person A's coding agent.
Read first: docs/PLAN.md "The contract", "Simulation design" (the concept vocabulary), and "A4" (segment builder table, arm builder rules, live-ads mapping table).
Also read: docs/reuse-export/contracts.ts (PersonaDetails, EnrichedAd, CompetitorAd) and contracts-creative.ts (HOOK_ARCHETYPES, producibility lists); spacetime/tables_b.ts so nothing collides.
Goal: spacetime/tables_a.ts (brand, concept, segment, arm, creative) with batch reducers, and scripts/a4-build-rows.ts that writes 4 brands, the concept vocabulary, one segment per persona (segment_id = the persona row id), 10–12 recipes plus the control per the arm rules, and competitor_live / brand_live creative rows. LLM calls use strict JSON schemas.
Done when: the rows are in SpacetimeDB and B's warm-up round runs on them.
Rules: write only spacetime/tables_a.ts and scripts/. Stop and ask if a contract field must change.
Finish with: row counts, the recipe list with strategy tags and evidence, and a commit "A4: contract rows".
```

### A5 · Creative generation worker

```
Ad Lab, phase A5: the text-only creative worker. Cal Hacks 13.0; hard deadline Sun Oct 25, 9 AM PT. You are Person A's coding agent.
Read first: docs/PLAN.md "The contract", "Reward, bandit and learnings" (the round flow and directive templates), and "A5" (all nine steps and the changes marked ours).
Also read: CREATIVE_MANIFEST.md §1b, §2–§6, §9, "Text-only mode" and §11.3–§11.5; contracts-creative.ts; fixtures/creative-brief.json and creative-output.json.
../adcero is read-only; arena/driver/operator.ts L73–100 is the model for strategyFromArms.
Goal: worker/creatives/ that claims generate_creatives tasks and follows the A5 steps exactly: drop market_prior facts, derivePackHints, group by (segment, angle), strategyFromArms accepting the food-industry angle tokens, compile with personaRef = segment id, angleTheme = the food token and keyMessageRef = the strongest proof_point/usp fact, generateBrandCopy per hook in parallel, gates without image or judge, no ranking, write creative rows, then queue run_round. The only edit to copied Adcero code: an optional notes list in buildStrategyBlock (generation/brand-copy.ts) for the learnings' directives.
Export the sequence as runGenerateCreatives(taskId), called by both the worker loop and A6's Copywriter agent (app/api/agent/creatives). The worker claims a generate_creatives task only after it has sat unclaimed for 60 seconds, so the Copywriter goes first.
First run it on fixtures/creative-brief.json and diff against creative-output.json. Then generate round 0: one creative per (recipe, segment).
Env: NODE_ENV=production, CREATIVE_JUDGE_GATE_MODE=off.
Done when: a generate_creatives task becomes ranked creative rows plus a queued run_round with nobody touching it.
Finish with: the fixture diff, round-0 counts (ranked vs gated_out), cost, and a commit "A5: creative worker".
```

### A6 · Fetch agents

```
Ad Lab, phase A6: Fetch agents, the A2A orchestration in ASI:One. Cal Hacks 13.0; hard deadline Sun Oct 25, 9 AM PT. You are Person A's coding agent.
Read first: docs/PLAN.md "Locked decisions", "How A and B fit together", "The contract" (the task board and the agent tables), "A6" and "Demo, cut lines and risks".
Also read: the Fetch hackpack requirements (https://www.fetch.ai/events/hackathons/calhacks-13-0/hackpack); the Innovation Lab docs on uAgent-to-uAgent communication, mailbox agents, ASI:One compatible agents and Interactive Cards; agents/hello_agent.py (A0's working chat-protocol agent); sim/SAMPLE_ROUND_SUMMARY.json; scripts/a2-ingest.ts (A2's ingest steps) and worker/loop.ts.
Work on a branch off simulation, and open the PR against simulation. You can start before A3–A5 land: each endpoint serves the fixtures until its phase is merged.
Goal, in this order:
1. SpacetimeDB: the agent, agent_message and ingest_job tables ("The contract") in spacetime/src/tables_a.ts, with reducers in reducers_a.ts. Publish in place with npm run spacetime:publish (only A's login can), then regenerate the client with npm run spacetime:generate.
2. The HTTP API in app/api/agent/:
   - ingest/refresh: a small live refresh of the stalest Meta pages and sources, through the copied queue functions and reusing A2's steps;
   - distill/start, jobs, brand-summary and competitor-summary;
   - contract/build (A4's builders) and creatives/generate (A5's runGenerateCreatives);
   - rounds start, status and summary.
   Every job an endpoint starts gets an ingest_job row.
3. worker/loop.ts reports each claim and finish, and the job's ingest_job row follows it.
4. Four uAgents in agents/ (Ad Lab, Scout, Strategist, Copywriter), started together by npm run agents:
   - each has its own seed, address and mailbox, and is registered on Agentverse in the Innovation Lab category;
   - each speaks the chat protocol, plus typed protocols (uAgents Models) for every hop between them;
   - one helper sends each message and logs it to agent_message in the same step; each agent keeps its agent row current;
   - Strategist and Copywriter watch SpacetimeDB and act on new round rows and queued generate_creatives tasks. The Copywriter claims through claim_task, calls creatives/generate, completes the task and queues the next run_round;
   - each agent makes the decisions in A6's table.
5. The ASI:One flow, through Ad Lab only: acknowledge at once, send a one-line progress message for each hop between agents, and use Interactive Cards for the brand profile, competitor winners, recipes, each round's leaderboard and the final winning ads per segment.
6. app/agents/: the live /agents view from lib/spacetime (the agents and their steps, the message stream, the ingest jobs with their Apify actors, the task board), with a nav link next to /sim.
7. README: each agent's name, address and job, the innovationlab and hackathon badges, and how to run it.
8. Only if time remains: the Payment Protocol, with Ad Lab asking the user to approve a small fee before each test run.
New env names (a seed per agent, the local API URL) go in .env.example; ask me for the values.
Done when: one ASI:One message ("find ads that beat Magic Spoon's current ones") makes the agents refresh the data on Apify, post the brand and competitor cards, propose recipes, run the rounds with the Copywriter writing between them, and post the winners, with no other screen needed. Every hop also shows up live on /agents and in agent_message.
Rules: write only app/api/agent/, app/agents/, agents/, worker/, spacetime/src/tables_a.ts and reducers_a.ts, README and config. Never write B's tables; touch the task board only through its reducers.
Finish with: a transcript of one full chat, a screenshot of /agents mid-run, the agent addresses, and a commit "A6: Fetch agents".
```

### A7 · The two Adcero pages

```
Ad Lab, phase A7: the Brand Identity and Competitor Analysis pages, live. Cal Hacks 13.0; hard deadline Sun Oct 25, 9 AM PT. You are Person A's coding agent.
Read first: docs/PLAN.md "A7".
Also read: REUSE_MANIFEST.md §5.5 (the dashboard rewrite) and §7 (routes, component trees, endpoints, look); docs/reuse-export/fixtures/.
../adcero is read-only; use the original app/api/brand-identity/ routes, design.md and .claude/brand-book.md as reference.
Goal: route handlers for every §7.4 endpoint, serving the fixtures first and then Supabase (dashboard and competitors/list via the §5.5 rewrite). The Competitor Analysis page first, then Brand Identity. Nav links to /sim and /agents.
Done when: both pages render Magic Spoon's real data in Adcero's look.
Rules: no edits to copied components beyond imports; write only app/api/ and the page shell.
Finish with: screenshots of both pages and a commit "A7: Adcero pages".
```

### A8 · Demo and submission

```
Ad Lab, phase A8: demo and submission prep. Cal Hacks 13.0; submit by Sun Oct 25, 8 AM PT. You are Person A's coding agent.
Read first: docs/PLAN.md "Demo, cut lines and risks" and "A8".
Goal: a scripts/demo.sh that warms the cache and replays the full run, shown as the ASI:One chat beside /agents and /sim; if time allows, a re-run of the final dataset end to end through the agents; a README pass covering what each sponsor technology does in the product (Apify, Fetch.ai, SpacetimeDB, Visa), what's real vs simulated, and how to run; a checklist of Devpost fields and the ASI:One submission-agent steps.
Done when: a fresh clone runs the demo from the README.
Finish with: the checklist and a commit "A8: demo and README".
```

## Person B

B7 (README section and video clips) needs no prompt.

### B0 · Setup and fixtures

```
Ad Lab, phase B0: sim setup and fixtures. Cal Hacks 13.0; hard deadline Sun Oct 25, 9 AM PT. You are Person B's coding agent.
Read first: docs/PLAN.md "Locked decisions", "The contract", "Simulation design", "The Jev calls" and "B0".
Also read: the TypeSafe Jev docs (request and response field names for Choice, Score and Noul; the Node SDK).
Goal: sim/ scaffold (TypeScript, Node 20, zod for every Jev response, p-limit, better-sqlite3 for the cache); a Jev wrapper with one Choice and one Noul call that records the exact field names; sim/fixtures/magicspoon/ with concepts.json, segments.json (6 drafts with quotes and prior weights), products.json (prices I give you from the brand sites), arms.json (10–12 placeholder recipes plus the control) and creatives.json (one text ad per recipe, 2–3 Magic Spoon live ads, 2 live ads per competitor that I paste in). All fixture shapes match the contract exactly.
Done when: npm run sim:smoke sends one feed call for one fixture shopper and prints the probabilities.
Rules: write only sim/. Secrets only in .env.local. Stop and ask if a contract field must change.
Finish with: the smoke output and a commit "B0: sim setup".
```

### B1 · Jev spike

```
Ad Lab, phase B1: Jev spike to settle the question shapes. Cal Hacks 13.0; hard deadline Sun Oct 25, 9 AM PT. You are Person B's coding agent.
Read first: docs/PLAN.md "The Jev calls" and "B1".
Goal: sim/spike/ running the five B1 tests on about 10 hand-built states (sensitivity ≥1.5×, option-order stability within 20% relative over 10 shuffles, memory effect, need effect, p50/p95 latency plus rate limit and error types). Apply the decision rule: if the order test fails, switch the feed call to one Noul per ad.
Done when: sim/SPIKE.md records every number, the chosen question shapes and the concurrency limit.
Rules: write only sim/. Cache every call.
Finish with: SPIKE.md and a commit "B1: Jev spike".
```

### B2 · Engine core

```
Ad Lab, phase B2: the simulation engine, in memory. Cal Hacks 13.0; hard deadline Sun Oct 25, 9 AM PT. You are Person B's coding agent.
Read first: docs/PLAN.md "Simulation design", "The Jev calls" (state template, questions, rendering rules, cache) and "B2"; sim/SPIKE.md.
Also read: docs/sim-export/SIM_NOTES.md §0, §3 and §4 for the carried-over rules and the bugs to avoid.
Goal: hash-keyed draws; population draw; perception (claims per creative, cached); the state renderer following every rendering rule; feed assembly; feed and page calls; the budget guard; dice; memory updates with the evidence table (one STAY row, cold start w 0.5 / E 1.0, cap E 8); a one-round JSON summary. Five tests: determinism with a warm cache, the guard zeroes P(buy), a tap → stay → buy chain matches hand-computed values, every state under 450 words with no segment names, option order changes with the seed.
Done when: npm run sim:run -- --rounds 1 --fixtures finishes in under 60 seconds and two runs print identical output.
Rules: write only sim/. No graph database.
Finish with: test output, timings and a commit "B2: engine core".
```

### B3 · Calibration, reward, bandit, learnings

```
Ad Lab, phase B3: calibration, reward, bandit and learnings. Cal Hacks 13.0; hard deadline Sun Oct 25, 9 AM PT. You are Person B's coding agent.
Read first: docs/PLAN.md "The Jev calls" (calibration), "Reward, bandit and learnings" (all of it, including the directive templates) and "B3".
Also read: docs/sim-export/contracts.ts (FUNNEL_BANDS).
Goal: the warm-up round with per-gate log-odds offsets fitted by bisection and frozen on the run; reward per impression; pooled Gaussian Thompson sampling per impression with floors (control ≥10%, others ≥3%), updates at the end of each sim day, p_best from 2,000 draws; within an arm, prefer creatives written for the shopper's segment; learnings from the templates, each with its number-free directive, versioned by key; choosing up to 3 recipes for generation. A planted-winner test: one fixture creative written to fit one segment perfectly gets >50% of that segment's impressions by round 3.
Done when: a 5-round fixture run prints arm stats and learnings, and the planted winner wins.
Rules: write only sim/.
Finish with: the run printout and a commit "B3: bandit and learnings".
```

### B4 · SpacetimeDB, task board, integration

```
Ad Lab, phase B4: SpacetimeDB tables, task worker and integration with A. Cal Hacks 13.0; hard deadline Sun Oct 25, 9 AM PT. You are Person B's coding agent.
Read first: docs/PLAN.md "The contract" (all tables and payloads), "How A and B fit together" and "B4".
Also read: the SpacetimeDB TypeScript module and client SDK docs; spacetime/tables_a.ts (read-only for you).
Goal: spacetime/tables_b.ts (product, creative_perception, run, round, shopper, decision, arm_stat, learning) plus the shared task table and a claim_task reducer, all with batch reducers (one call per table per sim day); sim/src/worker.ts that claims run_round, runs the round on A's rows, writes results and the round summary JSON, then queues generate_creatives with learning_ids. At the 2:30 PM integration, switch from fixtures to A's rows and re-run the warm-up round.
Done when: A starts a round from ASI:One, the worker runs it, and the summary lands in the round row.
Rules: never write tables_a.ts or A's tables. Stop and ask if a contract field must change.
Finish with: a sample round summary JSON (A needs it for A6) and a commit "B4: SpacetimeDB and worker".
```

### B5 · Live sim views

```
Ad Lab, phase B5: the live sim views. Cal Hacks 13.0; hard deadline Sun Oct 25, 9 AM PT. You are Person B's coding agent.
Read first: docs/PLAN.md "Status", "Live sim views" and "B5".
Also read: components/ui/, app/globals.css, app/layout.tsx and app/providers.tsx (Adcero's look and the dark shell every page sits in); lib/spacetime/.
Work on a branch off an up-to-date simulation, and run npm install at the root first: it brings A1's packages and the SpacetimeDB client.
The SpacetimeDB client is ready:
- spacetimedb 2.13.0, whose spacetimedb/react has SpacetimeDBProvider and useTable;
- the typed bindings in lib/spacetime/bindings (DbConnection.builder()), generated, so never edit them;
- lib/spacetime/config.ts for the URI and database name. It reads NEXT_PUBLIC_SPACETIMEDB_URI and NEXT_PUBLIC_SPACETIMEDB_DB_NAME first and defaults to Maincloud, so Maincloud needs no env.
If the module changes, A republishes and regenerates.
ShopSim is a read-only reference: github.com/garvit1910/shopsim (public), cloned next to this repo as ../shopsim. Only its drawing code carries over, because its engine was a graph database and Ad Lab's is Jev:
- adapt web/components/AllocationRiver.tsx, a dependency-free SVG stream of impressions per ad per day; feed it the decision feed rows counted per arm per sim day;
- adapt web/components/charts.tsx (SVG sparklines, a line chart with bands, a palette) for the leaderboard ranges and the header strip;
- use web/components/Inspector.tsx for layout ideas only. Its data (belief nodes, motif traces, formula dimensions) doesn't exist here, but its need-off counterfactual is the ancestor of the what-if toggle;
- ignore web/lib/market.ts and web/lib/selectors.ts. They poll ShopSim's engine and parse its saw → click → browse → cart → buy events, while B5 subscribes to SpacetimeDB and Ad Lab's funnel is tap → stay → buy.
If ../shopsim is missing, skip it: the "Live sim views" table and Adcero's components are enough.
Goal: app/sim/ with the allocation river, the leaderboard per segment (control row included), the decision ticker (probabilities, not just outcomes), the shopper inspector with the exact state text, the questions, probabilities, dice and memory across rounds, plus a what-if toggle that removes one memory line and re-asks Jev through a small cached API route, and the learnings feed linked to the creatives that used them. A header strip with round, sim day, Jev calls, cost and cache hit rate. Live through SpacetimeDB subscriptions, no polling.
Then build a local test bench, so the views can be tested before A4's rows reach the shared database. Never write to Maincloud while testing.
1. Start a local SpacetimeDB on port 3100 (next dev uses 3000): spacetime start --listen-addr 127.0.0.1:3100 --in-memory. If the CLI is missing, install it from spacetimedb.com/install, then pin it: spacetime version install 2.13.0 && spacetime version use 2.13.0. Publish the module there: spacetime publish adlab-local --server http://127.0.0.1:3100 --module-path spacetime --yes. It's in memory, so restarting the server and republishing starts over.
2. Seed it: write sim/src/local-seed.ts and an npm script for it in sim/package.json. It loads the fixture world's brands, concepts, segments, arms and creatives into the local database through A's upsert reducers; the worker writes products itself in --fixtures mode. Reuse the loading code in sim/test/module/module.test.ts. On the local bench this stands in for A4. It refuses to run unless SPACETIMEDB_URI is a localhost address.
3. Drive rounds with the real worker: SPACETIMEDB_URI=http://127.0.0.1:3100 SPACETIMEDB_DB_NAME=adlab-local npm --prefix sim run sim:worker -- --fixtures --enqueue run_local --auto-next. The worker doesn't print where it writes yet: add a startup line naming the URI and database, and check it says local before letting it run. Fixture runs reuse the Jev cache, so reruns cost almost nothing.
4. Point the web app at it: NEXT_PUBLIC_SPACETIMEDB_URI=http://127.0.0.1:3100 NEXT_PUBLIC_SPACETIMEDB_DB_NAME=adlab-local npm run dev, then open http://localhost:3000/sim.
5. Build app/sim/dev/page.tsx, a small test-bench page, linked from /sim but not from the app's navigation. It shows:
   - a banner naming the database it's connected to, green for LOCAL and red for MAINCLOUD;
   - live row counts for all 14 tables;
   - the task board (queued, claimed, done, failed) with each task's result or error;
   - a "Queue next round" button that calls enqueue_task with the next run_round. The button is enabled only on a local database; against Maincloud the page is read-only.
6. Walk it once:
   - seed, then queue round 0, and watch all five views fill as the worker writes each sim day;
   - let --auto-next run two more rounds;
   - open /sim against Maincloud too, with no env overrides, and check it loads with empty tables and no errors.
Done when: all five views update live during a real round on the local bench, and /sim loads cleanly against Maincloud. Once A4's rows are there, check them on Maincloud too.
Rules: write only app/sim/, app/api/sim/, and in sim/ the seed script, its npm script and the worker's startup line. Reuse Adcero's components and tokens. A's tables are written only on the local database, as test stand-ins; never write A's tables, or anything at all, on Maincloud from the bench.
Finish with: screenshots of /sim and /sim/dev on the local bench, the exact commands that bring the bench up, and a commit "B5: live sim views".
```

### B6 · Demo run and pinned shopper

```
Ad Lab, phase B6: the demo run and the pinned shopper. Cal Hacks 13.0; hard deadline Sun Oct 25, 9 AM PT. You are Person B's coding agent.
Read first: docs/PLAN.md "Demo, cut lines and risks" and "B6".
Goal: a full run on real data with a warm cache; a script that finds the shopper whose tap or buy chance on the same recipe changed most between rounds for a clear reason (a new shopping flag or ad wear-out); pin that shopper, freeze their capture to JSON, and add a replay mode that plays the cached run at a chosen speed.
Done when: the whole demo replays offline from cache with identical numbers.
Finish with: the pinned shopper's before/after and a commit "B6: demo run".
```