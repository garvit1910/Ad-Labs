# Ad Lab

Cal Hacks 13.0. Ad Lab tests Magic Spoon ad recipes on simulated shoppers built from real customer voice, then keeps and refines the winners. Person A owns data and agents; Person B owns the simulation. The plan, its live status and a prompt for every phase are in [docs/PLAN.md](docs/PLAN.md).

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
| `app/`, `components/`, `hooks/`, `lib/`, `services/` | Next app and the Adcero code it reuses | A, except `app/sim/` and `app/api/sim/` (B) |
| `lib/spacetime/` | the web app's SpacetimeDB client (generated bindings and config) | shared |
| `spacetime/` | the SpacetimeDB module: `tables_a.ts` and `reducers_a.ts` (A), `tables_b.ts` and `reducers_b.ts` (B) | shared |
| `sim/` | the simulation engine and its worker ([sim/DECISIONS.md](sim/DECISIONS.md)) | B |
| `worker/`, `supabase/`, `scripts/` | the job worker, the Supabase migrations, phase scripts | A |
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
| `npm run spacetime:publish` | publishes `spacetime/` to Maincloud (Person A only). Stops instead of breaking clients |
| `npm run spacetime:publish:clear` | publishes and wipes every table, both sides'. Agree first |
| `npm run spacetime:generate` | regenerates `lib/spacetime/bindings/` after a module change |
| `npm run sim:smoke` | B's one-call Jev smoke test |
| `npm --prefix sim run sim:run`, `sim:worker`, `test`, `test:module` | B's simulation CLI, task worker and tests |
| `npm run agent` | the Fetch.ai uAgent (needs `uv`) |

## Branches

`simulation` is the integration branch. Branch off it and open pull requests against it. `B`, GitHub's default branch, is stale.
