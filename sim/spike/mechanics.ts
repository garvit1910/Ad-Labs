import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { config, loadEnv, SIM_ROOT } from "../src/config.js";
import { assembleFeed, feedQuestions } from "../src/feed.js";
import { loadWorld } from "../src/fixtures.js";
import { type JevAttempt, JevClient } from "../src/jev.js";
import { makeShopper } from "../src/population.js";
import { renderFeedState } from "../src/render.js";

// B1 test 5: latency, rate limit, error types, retry behaviour, determinism.
// Each run draws its shoppers from a fresh seed, so the ramp hits the API instead of the cache
// (every answer is still cached). Usage: npm run sim:spike:mechanics [-- --levels 8,16,32,64,128]

const { values: args } = parseArgs({
  options: {
    levels: { type: "string", default: "8,16,32,64,128" },
    "per-level": { type: "string", default: "128" },
  },
});

loadEnv();
const world = loadWorld();
const runSeed = Date.now() % 1_000_000_000;
const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? null;
};

function feedRequest(i: number, seed: number) {
  const shopper = makeShopper(i, world, seed);
  const ours = world.creatives.find((c) => c.origin === "generated" && c.segment_id === shopper.segment_id)!;
  const options = assembleFeed(shopper, ours, world, seed, 0);
  return { state: renderFeedState(shopper, world, 0, options.map((o) => o.creative)), questions: feedQuestions(options, ours, world) };
}

// --- Ramp: concurrency levels until 429s appear ---
const ramp = [];
let offset = 0;
for (const level of args.levels.split(",").map(Number)) {
  const attempts: JevAttempt[] = [];
  const client = new JevClient({ concurrency: level, onAttempt: (a) => attempts.push(a) });
  const n = Number(args["per-level"]);
  const started = performance.now();
  const settled = await Promise.allSettled(
    Array.from({ length: n }, (_, i) => {
      const r = feedRequest(offset + i, runSeed);
      return client.ask(r.state, r.questions);
    }),
  );
  const wallMs = performance.now() - started;
  offset += n;
  client.close();
  const ok = attempts.filter((a) => a.status === 200);
  const s429 = attempts.filter((a) => a.status === 429);
  const other = attempts.filter((a) => a.status !== 200 && a.status !== 429);
  const failed = settled.filter((s) => s.status === "rejected");
  const row = {
    concurrency: level,
    requests: n,
    attempts: attempts.length,
    http200: ok.length,
    http429: s429.length,
    otherStatuses: [...new Set(other.map((a) => a.status))],
    retryAfterValues: [...new Set(s429.map((a) => a.retryAfter))],
    failedAfterRetries: failed.length,
    failureMessages: [...new Set(failed.map((f) => String((f as PromiseRejectedResult).reason?.message ?? f).slice(0, 160)))],
    wallSeconds: Math.round(wallMs / 100) / 10,
    requestsPerSecond: Math.round((n / wallMs) * 1000 * 10) / 10,
    p50_ms: pct(ok.map((a) => a.latencyMs), 0.5),
    p95_ms: pct(ok.map((a) => a.latencyMs), 0.95),
    max_ms: pct(ok.map((a) => a.latencyMs), 1),
  };
  ramp.push(row);
  console.log(
    `c=${String(level).padStart(3)}  ${n} req in ${row.wallSeconds}s = ${row.requestsPerSecond} req/s  ` +
      `p50 ${row.p50_ms}ms p95 ${row.p95_ms}ms max ${row.max_ms}ms  429s ${row.http429}  other ${JSON.stringify(row.otherStatuses)}  failed ${row.failedAfterRetries}`,
  );
  if (s429.length > n * 0.2 || failed.length > 0) break;
}

// --- Determinism: the same request five times, bypassing the cache for the repeats ---
const probe = feedRequest(0, runSeed + 1);
const cachedClient = new JevClient();
const first = await cachedClient.ask(probe.state, probe.questions);
cachedClient.close();
const nocache = new JevClient({ cachePath: null });
const repeats = await Promise.all(Array.from({ length: 4 }, () => nocache.ask(probe.state, probe.questions)));
nocache.close();
const signatures = [first, ...repeats].map((r) => JSON.stringify(r.answers));
const determinism = { identical: new Set(signatures).size === 1, distinct: [...new Set(signatures)] };
console.log(`\ndeterminism: 5 identical requests -> ${determinism.distinct.length} distinct answer(s)`);

// --- Error types: raw requests that break each rule ---
async function raw(label: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(config.jev.endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`  ${label.padEnd(34)} ${res.status}  ${text.slice(0, 140).replace(/\s+/g, " ")}`);
  return { label, status: res.status, body: text.slice(0, 400) };
}
const noul = { q: { type: "noul", instructions: "Is this about cereal?" } };
console.log("\nerror types:");
const errors = [
  await raw("bad API key", { model: config.jev.model, state: "x", questions: noul }, { Authorization: "Bearer not-a-key" }),
  await raw("unknown model", { model: "jev-9.9.9", state: "x", questions: noul }),
  await raw("missing state", { model: config.jev.model, questions: noul }),
  await raw("empty questions", { model: config.jev.model, state: "x", questions: {} }),
  await raw("choice without criteria", { model: config.jev.model, state: "x", questions: { q: { type: "choice", instructions: "?" } } }),
  await raw("choice with 256 options", {
    model: config.jev.model,
    state: "x",
    questions: { q: { type: "choice", instructions: "?", criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, null])) } },
  }),
  await raw("score with 11 levels", { model: config.jev.model, state: "x", questions: { q: { type: "score", instructions: "?", criteria: Array.from({ length: 11 }, (_, i) => `level ${i}`) } } }),
  await raw("malformed JSON", "{not json"),
  await raw("state over 64k tokens", { model: config.jev.model, state: "cereal ".repeat(80_000), questions: noul }),
];

const out = { model: config.jev.model, runSeed, ramp, determinism, errors };
const dir = join(SIM_ROOT, "spike", "results");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "mechanics.json"), JSON.stringify(out, null, 2));
console.log(`\nresults: ${join(dir, "mechanics.json")}`);
