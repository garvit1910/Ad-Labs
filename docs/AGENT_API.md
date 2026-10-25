# Ad Lab agent API (contract v1)

The HTTP API the four Fetch.ai agents call (`app/api/agent/**`). The agents never touch SpacetimeDB, Supabase or Apify directly; the API decides which database is in use. This file is the contract both sides code against. Change it only by agreement, and keep it out of PLAN.md's "The contract" section, which B's module test parses.

## Basics

- **Base URL:** `ADLAB_API_URL`, default `http://localhost:3000/api/agent`. JSON in and out.
- **Envelope:** every response is `{ok: true, data}` or `{ok: false, error, code}`.
- **Error codes:**

  | code | HTTP | meaning |
  | --- | --- | --- |
  | `bad_request` | 400 | body or query failed validation |
  | `not_supported` | 400 | e.g. `contract/build` mode `rebuild` |
  | `runs_not_allowed` | 403 | the server targets a database agents may not write (B's demo database or any other) |
  | `task_not_found` | 404 | |
  | `db_has_run` | 409 | the database already holds a run: reset it first |
  | `run_exists` | 409 | this run id is taken |
  | `round0_incomplete` | 409 | A5's round 0 isn't complete |
  | `not_ready` | 409 | e.g. a round summary for a round that isn't done |
  | `claim_lost` | 409 | another worker holds the creative task (A5's fallback took it) |
  | `generate_failed` | 502 | the copy step threw; the task stays claimed by `copywriter` |
  | `upstream` | 502 | SpacetimeDB or Supabase error |
  | `internal` | 500 | |

**Server rules:**
- **Database:** the target is `SPACETIMEDB_URI` / `SPACETIMEDB_DB_NAME`, set by `npm run dev:local` (`adlab-local`) or `dev:live` (the stage database). One memoized connection serves each process.
- **Mode:** `ADLAB_AGENT_MODE` is `test` (the default) or `live`.
- **Routes:** every route is `runtime = 'nodejs'` and `dynamic = 'force-dynamic'`. `creatives/generate` sets `maxDuration = 600`.
- **Write guard:** writing endpoints return 403 `runs_not_allowed` when `runs_allowed` is false. These are `log/*`, `ingest/refresh` (execute), `rounds/start`, `creatives/generate` and `creatives/fail`.
- **Parties:** `agt_ad_lab`, `agt_scout`, `agt_strategist`, `agt_copywriter`, and `user` (the ASI:One user).

## Endpoints

### Health and logging

- **GET `/health`** → `{db_label, db_name, db_uri, is_local, mode, runs_allowed, run_slot_free, blocked_reason, runs, browser_db_name, browser_uri, browser_matches, spacetime_ok, agent_tables}`.
  - It never throws.
  - `run_slot_free` is false once any run row or `run_round` task exists: one generating run per database.
- **POST `/log/message`** `{from_agent, to_agent (≠ from), protocol, kind: request|reply|progress|result, summary, payload: object, run_id?}` → `{message_id}`.
  - The server mints `msg_<base36 ms>_<8 hex>`.
  - It clamps `summary` to one line of at most 140 code points, ending in `…` when cut.
  - A payload over 4096 bytes becomes `{truncated: true, bytes, keys}`.
- **POST `/log/status`** `{agent_id, name ≤ 40, role ≤ 80, address: '' | agent1…, status: idle|working|error, current_step ≤ 140}` → `{}`.

### Brand kit

- **GET `/brand-kit`** → `{ready, reason, brand_url, brand_name, image_file, image_path, image_url, updated_at}`.
  - The onboarding step (`/start`, right after the landing page) writes the one `brand_kit` row: the brand's website and a product reference photo, stored in `data/brand-kit/`.
  - `ready` is true when the row exists and its photo is on disk. **Ad Lab starts nothing until it is.**
  - `brand_name` is the onboarded brand the URL matched (else `""`). `image_path` is the app-relative photo URL; `image_url` is absolute only when `ADLAB_PUBLIC_BASE_URL` is set (ASI:One cards can't load localhost).
  - The app saves the kit through `POST /api/brand-kit` (multipart `url`, `image`; outside this API), which refuses on a database agents may not write.

### Scout

- **POST `/ingest/refresh`** `{requested_by, dry?, targets?: [{kind: page|source, ref_id}], pages?: 0..4 = 2, sources?: 0..3 = 1}` → `{mode, planned: [{kind, target, actor, job_type, ref_id, last_synced_at|null}], jobs: [{job_id, target, actor, status, dry, deduped}]}`.
  - With `dry: true` it only returns the plan: every candidate, stalest first, nothing written.
  - Executing in test mode writes `ingest_job` rows with status `skipped` and `error` "dry run (test mode)". It never touches Supabase's `job_queue`.
  - Executing in live mode enqueues the copied Adcero jobs, writes `pending` `ingest_job` rows, then reconciles them.
- **GET `/jobs?ids=a,b`** (at most 20) → `{jobs: [{job_id, job_type, status, error, items, target, actor, attempts}]}`. `cancelled` is reported as `skipped`.
- **POST `/distill/start`** `{requested_by, force?}` → `{started: false, reason, facts: {total, persona, market_prior, voc}}`. It reports freshness only and never enqueues tonight.
- **GET `/brand-summary`** → `{brand: {name, positioning, proof_points[]}, pains|desires|objections: [{label, quote, frequency, platforms}], personas: [{segment_id, name, share}]}`. It caches for 5 minutes; `?fresh=1` bypasses the cache.
- **GET `/competitor-summary`** → `{competitors: [{name, ads, winners}], winners: [{brand, angle, hook, headline, days_running, image_url, creative_id}], patterns: [{concept, share}]}`. It excludes Magic Spoon's own page, and its numbers equal the Competitor Analysis page's.

### Strategist

- **POST `/contract/build`** `{mode: 'check'}` → `{recipes: [{arm_id, strategy, angle, hook, rationale}], segments: [{segment_id, name, share}], check: {ok, failures[], warnings[]}, round0: {complete, expected, ranked, gated_out, problems[]}}`. `{mode: 'rebuild'}` returns 400 `not_supported`.
- **POST `/rounds/start`** `{run_id ^run_[a-z0-9_]{1,40}$, rounds_planned 1..5 = 3, population 50..300 = 300, seed = 13, requested_by}` → `{run_id, task_id, rounds_planned, population, seed, requeued}`.
  - It is implemented by `lib/adlab/runs.ts` `startRun`.
  - It pre-creates the run row (status `calibrating`), then queues `tsk_run_<run>_r0`.
  - Refusals: `runs_not_allowed`, `db_has_run`, `run_exists`, `round0_incomplete`.
- **GET `/rounds/status?run_id=`** → `{run|null, rounds: [{round, status, started_at, finished_at}], tasks: [Task], phase, current_round}`.
  - `phase` is one of `not_started`, `waiting_for_worker`, `calibrating`, `round_running`, `waiting_for_bandit`, `creatives_queued`, `writing_creatives`, `done`, `failed`, `lost`.
  - `failed` applies only when the latest task failed.
- **GET `/rounds/summary?run_id=&round?`** (default: the latest done round) → `{round, rounds_planned, status, totals: {impressions, buys, taps, jev_calls, jev_cost_usd, cache_hit_rate}, leaderboard: [{segment_id, segment_name, impressions, top: [{arm_id, recipe, strategy, p_best, cpo_usd, cpo_range_usd, share}], control}], learnings_opened: [{learning_id, segment_id, segment_name, arm_id, kind, statement, directive}], learnings_closed, winners: [{segment_id, segment_name, arm_id, recipe, statement}]}`.
  - `recipe` reads "angle × hook".
  - A round that isn't done returns 409 `not_ready`.
- **GET `/rounds/winners?run_id=`** → `{winners: [{segment_id, segment_name, arm_id, recipe, statement, basis: winner|leading, declared, p_best, cpo_usd, control_cpo_usd, creative: {creative_id, headline, primary_text, cta, visual_description}|null}]}`.
  - `declared` is true when a live `winner` learning exists.
  - Otherwise the row is the leading non-control arm of the latest done round.

### Copywriter

- **GET `/learnings?run_id=&ids=a,b`** → `{learnings: [{learning_id, segment_id, segment_name, arm_id|null, kind, statement, directive, topic, valid_from_round, valid_to_round|null}]}`. `topic` is the objection key (`price`, `taste_doubt`, `trust`, `not_now`) or the doubted concept, else `""`. The Copywriter leaves out `not_now` objections: they're about when a shopper buys, not what the ad says.
- **GET `/tasks?kind=&status=&run_id=&task_id=`** → `{tasks: [Task]}`.
- **POST `/creatives/generate`** `{task_id, learning_ids? (≤ 50), next_round?: queue|skip}` → A5's `TaskResult` plus `learning_ids_applied`.
  - It is synchronous, with one in-flight call per task: a repeat call joins it.
  - `learning_ids` can only narrow the task's own list (an intersection).
  - A lost claim returns 409 `claim_lost`.
  - Any other throw returns 502 `generate_failed`, and the task stays claimed by `copywriter`.
  - An empty body returns a fast 400, which the agents use to warm the route.
- **POST `/creatives/fail`** `{task_id, error}` → `{failed}`. It calls `failTask(…, 'copywriter')`, which fails the task only if the Copywriter still holds it.

### The Task shape

`Task` = `{task_id, run_id, kind: run_round|generate_creatives, status: queued|claimed|done|failed, claimed_by|null, payload: object, result: object|null, created_at, updated_at}`. The timestamps are ISO strings.

## Python client rules

- Use `httpx.AsyncClient` only. Never make a blocking call inside a uagents handler.
- **Startup:** warm `/log/status` and `POST /creatives/generate {}` with 30-second timeouts. After that, log calls time out at 5 seconds, and a logging failure never breaks the flow.
- **`creatives/generate`:**
  - The timeout is 330 seconds. On a timeout, poll `GET /tasks?task_id=`.
  - On `generate_failed`, retry 3 times, after 20, 40 and 80 seconds, then call `/creatives/fail`.
  - On `claim_lost`, report the hand-off and don't retry.
- **The Strategist** starts a run only when `/health` shows `runs_allowed` and `run_slot_free`. Run ids are `run_<mode>_<MMDD>_<HHMM>` (UTC).
