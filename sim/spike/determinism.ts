import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv, SIM_ROOT } from "../src/config.js";
import { loadWorld } from "../src/fixtures.js";
import { JevClient } from "../src/jev.js";
import { type Shape, choiceRequest, noulRequest } from "./shapes.js";
import { buildStates } from "./states.js";

// How much does Jev's answer move when the identical request is sent again? Repeats bypass the
// cache on purpose (the first answer of each request is already cached by sim:spike).
// Sequential repeats vs concurrent repeats separates "noisy model" from "batch effects".
// Usage: npx tsx spike/determinism.ts

loadEnv();
const world = loadWorld();
const { base } = buildStates(world);
const ad = (id: string) => world.creatives.find((c) => c.creative_id === id)!;
const NEIGHBOURS = [ad("cr_cc_live_2"), ad("cr_tw_live_1")];
const REPEATS = 10;
const client = new JevClient({ cachePath: null, concurrency: REPEATS });

// One client per concurrent repeat: a shared client would merge identical in-flight requests.
async function pOursFresh(shape: Shape, stateIdx: number): Promise<number> {
  const own = new JevClient({ cachePath: null });
  try {
    return await pOurs(shape, stateIdx, own);
  } finally {
    own.close();
  }
}

async function pOurs(shape: Shape, stateIdx: number, c: JevClient = client): Promise<number> {
  const s = base[stateIdx]!;
  const ours = world.creatives.find((c) => c.origin === "generated" && c.segment_id === s.shopper.segment_id)!;
  const ads = [ours, ...NEIGHBOURS];
  if (shape === "choice") {
    const r = choiceRequest(s, ads, world);
    return (await c.ask(r.state, r.questions)).answers.tap.probabilities.A!;
  }
  const r = noulRequest(s, ads, world);
  return (await c.ask(r.state, r.questions)).answers.tap_A.noul;
}

const summary = (xs: number[]) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
  return { mean: +m.toFixed(4), sd: +sd.toFixed(4), min: Math.min(...xs), max: Math.max(...xs), distinct: new Set(xs).size, values: xs };
};

const rows = [];
for (const shape of ["choice", "noul"] as Shape[]) {
  for (const idx of [0, 4, 8]) {
    const sequential: number[] = [];
    for (let i = 0; i < REPEATS; i++) sequential.push(await pOurs(shape, idx));
    const concurrent = await Promise.all(Array.from({ length: REPEATS }, () => pOursFresh(shape, idx)));
    const row = { shape, state: base[idx]!.id, sequential: summary(sequential), concurrent: summary(concurrent) };
    rows.push(row);
    console.log(
      `${shape.padEnd(6)} ${row.state.padEnd(22)} sequential mean ${row.sequential.mean} sd ${row.sequential.sd} [${row.sequential.min}-${row.sequential.max}] ${row.sequential.distinct} distinct` +
        ` | concurrent mean ${row.concurrent.mean} sd ${row.concurrent.sd} [${row.concurrent.min}-${row.concurrent.max}] ${row.concurrent.distinct} distinct`,
    );
  }
}
client.close();
const dir = join(SIM_ROOT, "spike", "results");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "determinism.json"), JSON.stringify(rows, null, 2));
