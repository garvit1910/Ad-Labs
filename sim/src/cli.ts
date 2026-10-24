import { parseArgs } from "node:util";
import { config, loadEnv } from "./config.js";
import { Engine } from "./engine.js";
import { loadWorld } from "./fixtures.js";
import { type JevAttempt, JevClient } from "./jev.js";
import { PerceptionStore, keywordPerceiver, perceiveAll } from "./perceive.js";
import { roundSummary } from "./summary.js";

// sim run: rounds 0..N-1 on the fixtures, in memory. Round 0 is the warm-up.
// Usage: npm run sim:run -- --rounds 1 --fixtures [--seed 13] [--population 300] [--no-cache]
//
// stdout carries only the round summaries, which depend on Jev's answers and the seed alone,
// so two runs with a warm cache print identical output. Timings and cache stats go to stderr.

const { values: args } = parseArgs({
  options: {
    rounds: { type: "string", default: "1" },
    fixtures: { type: "boolean", default: false },
    seed: { type: "string", default: String(config.run.seed) },
    population: { type: "string", default: String(config.run.population) },
    "no-cache": { type: "boolean", default: false },
  },
});

if (!args.fixtures) {
  console.error("Only --fixtures runs exist until B4 reads A's rows from SpacetimeDB.");
  process.exit(2);
}

loadEnv();
const started = performance.now();
const rounds = Number(args.rounds);
const seed = Number(args.seed);
const population = Number(args.population);
const world = loadWorld();

const store = new PerceptionStore();
const perceptions = await perceiveAll(world, keywordPerceiver, store);
store.close();

const attempts: JevAttempt[] = [];
const client = new JevClient({ cachePath: args["no-cache"] ? null : config.paths.cacheDb, onAttempt: (a) => attempts.push(a) });
const run_id = `run_fixtures_s${seed}_p${population}`;
const engine = new Engine(world, client, perceptions, { run_id, seed, population });

try {
  for (let round = 0; round < rounds; round++) {
    const roundStarted = performance.now();
    const days = await engine.runRound(round);
    console.log(JSON.stringify(roundSummary(world, { run_id, seed, population, offsets: engine.offsets }, days), null, 2));
    const decisions = days.flatMap((d) => d.decisions);
    const fresh = decisions.filter((d) => !d.cache_hit);
    const latencies = fresh.map((d) => d.latency_ms).sort((a, b) => a - b);
    const pct = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] ?? 0;
    console.error(
      `round ${round}: ${decisions.length} calls, ${decisions.length - fresh.length} cached, ${fresh.length} fresh` +
        (fresh.length ? ` (p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms)` : "") +
        `, ${Math.round(performance.now() - roundStarted)} ms`,
    );
  }
  const retries = attempts.filter((a) => a.attempt > 0).length;
  console.error(`total ${((performance.now() - started) / 1000).toFixed(1)} s, ${attempts.length} HTTP attempts, ${retries} retries`);
} finally {
  client.close();
}
