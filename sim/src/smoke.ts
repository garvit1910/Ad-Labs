import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { config, loadEnv } from "./config.js";
import { assembleFeed, feedQuestions, tapProbabilities } from "./feed.js";
import { loadWorld } from "./fixtures.js";
import { JevClient } from "./jev.js";
import { makeShopper } from "./population.js";
import { renderFeedState, wordCount } from "./render.js";

// B0 smoke: one feed call (a tap Noul per post + believes) for one fixture shopper.
// Usage: npm run sim:smoke -- [--shopper 0] [--no-cache] [--dry-run]

const { values: args } = parseArgs({
  options: {
    shopper: { type: "string", default: "0" },
    "no-cache": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

loadEnv();
const world = loadWorld();
const seed = config.run.seed;
const tick = 0;
const shopper = makeShopper(Number(args.shopper), world, seed);

const generated = world.creatives.filter((c) => c.origin === "generated" && c.status === "ranked");
const ours = generated.find((c) => c.segment_id === shopper.segment_id) ?? generated[0];
if (!ours) throw new Error("no ranked generated creative in fixtures");

const options = assembleFeed(shopper, ours, world, seed, tick);
const questions = feedQuestions(options, ours, world);
const state = renderFeedState(shopper, world, tick, options.map((o) => o.creative));
const words = wordCount(state);

if (args["dry-run"]) {
  console.log(JSON.stringify({ model: config.jev.model, state, questions }, null, 2));
  process.exit(0);
}

const client = new JevClient({ cachePath: args["no-cache"] ? null : config.paths.cacheDb });
try {
  const res = await client.ask(state, questions);

  mkdirSync(dirname(config.paths.lastCall), { recursive: true });
  writeFileSync(
    config.paths.lastCall,
    JSON.stringify({ request: res.request, response: { model: res.model, answers: res.answers, usage: res.usage } }, null, 2),
  );

  const pct = (p: number) => `${(p * 100).toFixed(1)}%`.padStart(6);
  console.log(`shopper   ${shopper.shopper_id} ${shopper.display_name} (${shopper.segment_id}, in_market=${shopper.in_market})`);
  console.log(`our ad    ${ours.creative_id} (${ours.arm_id})`);
  console.log(`state     ${words} words\n`);
  console.log(state.replace(/^/gm, "  | "));
  console.log(`\nfeed call  model=${res.model}  latency=${res.latencyMs}ms  cache_hit=${res.cacheHit}  ` +
    `input_tokens=${res.usage.input_tokens}  output_tokens=${res.usage.output_tokens}`);
  const taps = tapProbabilities(options, res.answers);
  console.log("\ntap (one noul per post, raw, uncalibrated)");
  for (const o of options) {
    const mark = o.creative.creative_id === ours.creative_id ? "  <- ours" : "";
    console.log(`  ${o.key}  ${pct(taps[o.creative.creative_id]!)}  ${o.creative.creative_id}${mark}`);
  }
  console.log(`\nbelieves (noul) ${pct(res.answers.believes.noul)}  ${ours.creative_id}`);
  console.log(`\nraw request and response: ${config.paths.lastCall}`);
} finally {
  client.close();
}
