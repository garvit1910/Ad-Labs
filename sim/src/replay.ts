import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadEnv } from "./config.js";
import { JevClient } from "./jev.js";
import { PerceptionStore, keywordPerceiver } from "./perceive.js";
import { configHash } from "./run.js";
import { type Db, SpacetimeHttp, type SqlRow, isLocalUri, sqlString } from "./spacetime.js";
import { Worker } from "./worker.js";

// B6: replay a finished run from the Jev cache at a chosen speed (docs/PLAN.md "B6": the demo
// replays offline from cache with identical numbers). The worker runs every round again under a
// new run id, pausing after each sim day, so /sim fills live as it did the first time.
//
// - Offline: the Jev client answers only from the cache; a miss stops the replay.
// - Off the task board: rounds run directly and no generate_creatives task is queued, so A's
//   agents never act on a replay.
// - At the end, every decision and round summary is compared with the source run.
//
// Usage: npm run sim:replay -- --from <run_id> [--as <new_id>] [--day-ms 3000] [--fixtures] [--allow-maincloud]
//   --fixtures  the source run read sim/fixtures (the bench); without it, A's rows in the database.
//               In that mode creatives aren't tagged by run, so a replay is exact only while A's
//               creative rows are unchanged; the final check says so if they aren't.

// Decision fields that must match; run_id, latency and cache_hit legitimately differ.
const DECISION_FIELDS = ["round", "tick", "shopper_id", "kind", "creative_id", "options", "p_raw", "p_cal", "draw", "action", "believes_claim", "objection"];

export async function compareRuns(db: Db, from: string, as: string): Promise<{ decisions: number; rounds: number; diffs: string[] }> {
  const key = (d: SqlRow) => `${d.shopper_id}|${d.tick}|${d.kind}`;
  const [a, b] = await Promise.all([from, as].map((id) => db.sql(`SELECT * FROM decision WHERE run_id = ${sqlString(id)}`)));
  const diffs: string[] = [];
  const replayed = new Map(b!.map((d) => [key(d), d]));
  if (a!.length !== b!.length) diffs.push(`decision count ${a!.length} vs ${b!.length}`);
  for (const d of a!) {
    const r = replayed.get(key(d));
    const bad = r ? DECISION_FIELDS.find((f) => JSON.stringify(d[f]) !== JSON.stringify(r[f])) : "missing";
    if (bad) diffs.push(`decision ${key(d)}: ${bad}`);
    if (diffs.length >= 10) break;
  }
  // Summaries name the run (and learning ids derive from it); the cache hit rate depends on
  // whether the source run was cold.
  const strip = (id: string) => id.replace(/^run_/, "");
  const norm = (summary: unknown) => {
    const s = JSON.parse(String(summary)) as { jev?: Record<string, unknown> };
    delete s.jev?.cache_hit_rate;
    return JSON.stringify(s).replaceAll(strip(as), strip(from));
  };
  const [ra, rb] = await Promise.all([from, as].map((id) => db.sql(`SELECT * FROM round WHERE run_id = ${sqlString(id)}`)));
  const byRound = new Map(rb!.map((r) => [Number(r.round), r]));
  if (ra!.length !== rb!.length) diffs.push(`round count ${ra!.length} vs ${rb!.length}`);
  for (const r of ra!) {
    const other = byRound.get(Number(r.round));
    if (!other || norm(r.summary) !== norm(other.summary)) diffs.push(`round ${r.round} summary differs`);
  }
  return { decisions: a!.length, rounds: ra!.length, diffs };
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      from: { type: "string" },
      as: { type: "string" },
      "day-ms": { type: "string", default: "3000" },
      fixtures: { type: "boolean", default: false },
      "allow-maincloud": { type: "boolean", default: false },
    },
  });
  if (!args.from) {
    console.error("usage: npm run sim:replay -- --from <run_id> [--as <new_id>] [--day-ms 3000] [--fixtures] [--allow-maincloud]");
    process.exit(2);
  }
  loadEnv();
  const uri = process.env.SPACETIMEDB_URI ?? "";
  const local = isLocalUri(uri);
  if (!local && !args["allow-maincloud"]) {
    console.error(`refusing to replay into ${uri}: not a local database (pass --allow-maincloud on purpose)`);
    process.exit(2);
  }
  const db = await SpacetimeHttp.connect("sim-replay");
  console.log(`sim replay ${db.name} → ${uri} / ${process.env.SPACETIMEDB_DB_NAME} (${local ? "LOCAL" : "MAINCLOUD"})`);

  const runs = await db.sql("SELECT * FROM run");
  const source = runs.find((r) => r.run_id === args.from);
  if (!source) throw new Error(`no run ${args.from}`);
  if (source.status !== "done") throw new Error(`run ${args.from} is ${source.status}; replay a finished run`);
  const settings = { seed: Number(source.seed), population: Number(source.population), roundsPlanned: Number(source.rounds_planned) };
  if (configHash({ ...settings, perceiverId: keywordPerceiver.id }) !== source.config_hash) {
    throw new Error(`run ${args.from} was made with a different config; a replay would differ`);
  }
  const taken = new Set(runs.map((r) => String(r.run_id)));
  let as = args.as ?? `${args.from}_replay`;
  if (taken.has(as)) {
    if (args.as) throw new Error(`run ${as} already exists`);
    let n = 2;
    while (taken.has(`${as}_${n}`)) n++;
    as = `${as}_${n}`;
  }

  const dayMs = Number(args["day-ms"]);
  const jev = new JevClient({ offline: true });
  const store = new PerceptionStore();
  const worker = new Worker({
    db,
    jev,
    source: args.fixtures ? "fixtures" : "db",
    store,
    settings,
    queueGeneration: false,
    dayMs,
    log: (l) => console.log(l),
  });
  const started = performance.now();
  console.log(`replaying ${args.from} as ${as}: ${settings.roundsPlanned + 1} rounds, ${dayMs} ms per sim day, Jev from cache only`);
  try {
    for (let round = 0; round <= settings.roundsPlanned; round++) {
      const r = await worker.runRoundTask({ run_id: as, round });
      console.log(`  round ${round}: ${r.impressions} impressions, ${r.buys} buys`);
    }
  } finally {
    jev.close();
    store.close();
  }
  const { decisions, rounds, diffs } = await compareRuns(db, args.from, as);
  const secs = ((performance.now() - started) / 1000).toFixed(0);
  if (diffs.length) {
    console.log(`NOT identical to ${args.from} (${secs} s):`);
    for (const d of diffs) console.log(`  ${d}`);
    process.exit(1);
  }
  console.log(`identical to ${args.from}: ${decisions.toLocaleString()} decisions, ${rounds} round summaries (${secs} s, no Jev calls)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
