# Ad Lab

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

Cal Hacks 13.0. Ad Lab tests Magic Spoon ad recipes on simulated shoppers built from real customer voice, then keeps and refines the winners. Person A owns data and agents; Person B owns the simulation. The plan, its live status and a prompt for every phase are in [docs/PLAN.md](docs/PLAN.md).

## Fetch.ai agents

You talk to **Ad Lab** in ASI:One. It delegates to three other uAgents, and every hop between them is a typed message logged to SpacetimeDB, so `/agents` shows the conversation live.

| Agent | Address | Job |
| --- | --- | --- |
| Ad Lab | `agent1qdefjvvn2z2lhxx394lvgw6upyk979a7znajm8xwuy2kqlssc932q5r7q3m` | The ASI:One chat: delegates, posts the brand, competitor, recipe, leaderboard and winner cards, answers "status" |
| Ad Lab Scout | see `npm run agents:addresses` | Picks the stalest competitor pages and review sources, refreshes them through Apify, reports brand and competitor intel |
| Ad Lab Strategist | see `npm run agents:addresses` | Checks the recipes, queues the simulation rounds on the task board, reports each round, declares the winners |
| Ad Lab Copywriter | see `npm run agents:addresses` | Claims each round's creative task, chooses which learnings to apply, writes the next round's ads |

How they work, how to register them on Agentverse and how to test them: [agents/README.md](agents/README.md). The HTTP API they call is [docs/AGENT_API.md](docs/AGENT_API.md).

## How it fits together

- **Supabase** holds Adcero's pipeline data: brand mentions, competitor ads, labels and distilled brand facts. A's `worker/` runs Adcero's copied processors over its `job_queue`.
- **SpacetimeDB** (`adlab-calhacks13` on Maincloud) is the shared, live world.
  - A writes segments, recipes and creatives; B's simulation writes runs, decisions, stats and learnings.
  - A task board passes each round between the two.
  - The contract is in docs/PLAN.md "The contract".
- **The Next app** at the root shows the Adcero-style pages and, at `/sim`, the live simulation.

## Layout

| Path | What | Owner |
| --- | --- | --- |
| `app/`, `components/`, `hooks/`, `lib/`, `services/` | Next app and the Adcero code it reuses: the Brand Identity and Competitor Analysis pages (A7), `/agents` and the agents' API in `app/api/agent/` (A6) | A, except `app/sim/` and `app/api/sim/` (B) |
| `lib/spacetime/` | the web app's SpacetimeDB client (generated bindings and config) | shared |
| `spacetime/` | the SpacetimeDB module: `tables_a.ts` and `reducers_a.ts` (A), `tables_b.ts` and `reducers_b.ts` (B) | shared |
| `sim/` | the simulation engine and its worker ([sim/DECISIONS.md](sim/DECISIONS.md)) | B |
| `worker/`, `supabase/`, `scripts/` | the job worker and A5's creative worker (`worker/creatives/`), the Supabase migrations, phase scripts | A |
| `lib/adlab/` | A's shared glue: the org id, Supabase client, SpacetimeDB HTTP client, contract vocabulary and the contract check | A |
| `agents/` | Python uAgents for Fetch.ai | A |
| `docs/` | the plan and the Adcero and ShopSim exports | both |

## Setup on a new laptop

1. Install Node 22 or newer, then the three packages:
   ```
   npm install
   npm --prefix sim install
   npm --prefix spacetime install
   ```
2. Copy `.env.example` to `.env.local` and fill in the keys. Secrets live only there; it is gitignored.
3. Run `npm run check:connections`. Every row should say PASS.

Publishing the SpacetimeDB module also needs the `spacetime` CLI 2.13, logged in as the database's owner (Person A's login).

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | the Next app on http://localhost:3000 |
| `npm run typecheck`, `npm test`, `npm run build` | root checks |
| `npm run check:connections` | one tiny call per external service, as a pass/fail table |
| `npm run db:migrate` | applies new files in `supabase/migrations/`; reruns are no-ops |
| `npm run worker` | drains Supabase's `job_queue` through the copied Adcero processors; add `-- --watch` to keep polling, `-- --concurrency=N` for parallel jobs |
| `npm run a2:ingest`, `a3:distill`, `a3:report` | A2's scrape and A3's distillation, run through the same job worker in-process |
| `npm run a4:rows -- check` | A's contract rows in SpacetimeDB: `check` is read-only; with no argument it rebuilds and upserts them (`--keep-arms` keeps the recipes, `--dry-run` writes nothing) |
| `npm run a5:creatives -- check \| round0 \| round0-status \| worker` | A5's creative worker: whether A4's rows are usable, round 0, whether round 0 is complete (B queues round 0 only then), and the task-board loop that answers each `generate_creatives` task |
| `npm run spacetime:publish` | publishes `spacetime/` to Maincloud (Person A only). Stops instead of breaking clients |
| `npm run spacetime:publish:clear` | publishes and wipes every table, both sides'. Agree first |
| `npm run spacetime:generate` | regenerates `lib/spacetime/bindings/` after a module change |
| `npm run sim:smoke` | B's one-call Jev smoke test |
| `npm --prefix sim run sim:run`, `sim:worker`, `test`, `test:module` | B's simulation CLI, task worker and tests |
| `npm run agents`, `agents:solo`, `agents:addresses`, `agents:test`, `agents:e2e` | A6's four uAgents in one Bureau (needs `uv`); see [agents/README.md](agents/README.md). `npm run agent` is A0's hello-world agent; never run it together with `agents` |
| `npm run bench -- snapshot \| seed \| verify \| start-run \| verify-run \| status` | the test bench: a seeded copy of the demo database's shared rows, and end-to-end run checks read straight from SpacetimeDB |
| `npm run dev:local`, `sim:worker:local`, `a5:worker:local` (and `:live`) | the web app, B's sim worker and A5's creative worker, each pointed at the bench (`adlab-local`) or the stage database (`adlab-live`) |
| `npm run test:all` | every root, sim, module and agent test |

## Running the stack

The agents never run on `adlab-calhacks13`, which holds B's demo run. The creative table has no run column, so each generating run gets its own database: the local bench for tests, `adlab-live` on Maincloud for the stage. Every script below sets its database itself, so never type an env prefix by hand.

**Local bench** (one terminal each):

```
npm run bench:server                                   # in-memory SpacetimeDB on 127.0.0.1:3100
npm run spacetime:publish:local
npm run bench -- snapshot                              # once: reads adlab-calhacks13 (needs the network)
npm run bench -- seed --target local --from-snapshot   # brands, segments, recipes, live ads, round 0, product
npm run dev:local                                      # http://localhost:3000: /agents, /sim, the two Adcero pages
npm run sim:worker:local                               # B's worker; never --auto-next or --fixtures here
npm run a5:worker:local                                # the creative fallback (claims tasks left unclaimed for 60 s)
npm run agents                                         # or: npm run agents:e2e -- --rounds 2 (headless, offline agents)
```

One run per database: `npm run bench:reset:local` wipes the bench and reseeds it from the snapshot in about 30 seconds. `npm run bench -- verify-run --latest --target local --claimer copywriter` checks a finished run end to end.

**Stage** (`adlab-live`, A's SpacetimeDB login): `npm run spacetime:publish:live`, `npm run bench -- seed --target live --from-snapshot`, then the `:live` scripts and `npm run worker:live` (a small Apify cap, with the brand-object rebuild frozen). Clear it between runs with `npm run spacetime:publish:live:clear` and reseed.

## Branches

`simulation` is the integration branch. Branch off it and open pull requests against it. `B`, GitHub's default branch, is stale.
