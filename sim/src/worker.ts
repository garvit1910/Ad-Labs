import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { config, loadEnv } from "./config.js";
import type { Asker } from "./engine.js";
import { type World, loadWorld } from "./fixtures.js";
import { JevClient } from "./jev.js";
import { PerceptionStore, keywordPerceiver, perceiveAll } from "./perceive.js";
import { SimRun } from "./run.js";
import { type Db, SpacetimeError, SpacetimeHttp, isLocalUri, loadWorldFromDb, sqlString, writer } from "./spacetime.js";

// The sim worker (docs/PLAN.md "B4"): claims run_round tasks from the task board, runs the round
// on A's rows, writes B's tables and the round summary, then queues generate_creatives with the
// learning ids. A and B meet only in SpacetimeDB.
//
// A run lives in memory between rounds. A worker that restarts mid-run rebuilds it by replaying
// the earlier rounds from the Jev cache, each on the creatives that existed in that round; it
// refuses if the replay's calibration or config doesn't match the run row (D63).
//
// Usage: npm run sim:worker -- [--fixtures] [--once] [--poll 3000] [--auto-next]
//        npm run sim:worker -- --enqueue <run_id> [--round 0]   (stands in for A's start-rounds)
//   --fixtures   read the world from sim/fixtures instead of A's tables (and write its products)
//   --once       exit when no queued run_round is left
//   --auto-next  also queue the next run_round, standing in for A's creative worker (testing)

export type Task = { task_id: string; run_id: string; kind: string; payload: string; status: string; created_at: string };
export type RoundPayload = { run_id: string; round: number };

export type WorkerOptions = {
  db: Db;
  jev: Asker;
  source: "fixtures" | "db";
  store?: PerceptionStore | null;
  autoNext?: boolean;
  log?: (line: string) => void;
};

// A new run's settings; the run row keeps them for later rounds and replays.
export const RUN_DEFAULTS = { seed: config.run.seed, population: config.run.population, roundsPlanned: config.run.roundsPlanned };

export class Worker {
  private runs = new Map<string, { run: SimRun; next: number }>();
  private log: (line: string) => void;

  constructor(private opts: WorkerOptions) {
    this.log = opts.log ?? ((l) => console.log(l));
  }

  // One step: claim and run the oldest queued run_round. False when there was nothing to do.
  async tick(): Promise<boolean> {
    const task = await this.claimNext();
    if (!task) return false;
    try {
      const result = await this.runRoundTask(JSON.parse(task.payload) as RoundPayload);
      await this.opts.db.call("complete_task", [task.task_id, JSON.stringify(result)]);
      this.log(`task ${task.task_id} done: round ${result.round} of ${result.run_id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`task ${task.task_id} failed: ${message}`);
      await this.opts.db.call("fail_task", [task.task_id, message.slice(0, 2000)]);
    }
    return true;
  }

  // claim_task flips queued -> claimed in one transaction; a task another worker took first
  // rejects, and this worker moves on to the next.
  async claimNext(): Promise<Task | null> {
    const queued = (await this.opts.db.sql(`SELECT * FROM task WHERE status = 'queued'`)) as Task[];
    const mine = queued
      .filter((t) => t.kind === "run_round")
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.task_id.localeCompare(b.task_id));
    for (const t of mine) {
      try {
        await this.opts.db.call("claim_task", [t.task_id, this.opts.db.name]);
        return t;
      } catch (err) {
        if (!(err instanceof SpacetimeError)) throw err;
      }
    }
    return null;
  }

  async worldFor(round: number): Promise<World> {
    return this.opts.source === "fixtures" ? loadWorld() : loadWorldFromDb(this.opts.db, round);
  }

  async runRoundTask({ run_id, round }: RoundPayload) {
    const { db } = this.opts;
    const world = await this.worldFor(round);
    const perceptions = await perceiveAll(world, keywordPerceiver, this.opts.store ?? null);
    if (this.opts.source === "fixtures") await writer.products(db, world);
    await writer.perceptions(db, perceptions);

    const state = await this.runFor(run_id, round, world, perceptions);
    const { run } = state;
    run.setWorld(world, perceptions);
    await writer.startRound(db, run_id, round);
    const r = await run.runRound(round, (day, armStats) =>
      writer.day(db, run_id, day, run.engine.shoppers, (id) => run.engine.lastState.get(id)?.page ?? "", armStats),
    );
    await writer.learnings(db, [...r.opened, ...r.closed]);
    // The round row's summary: the run's round report plus the cache hit rate, which the CLI keeps
    // off stdout because it differs between a cold and a warm run (D45).
    const report = run.report(r);
    const decisions = r.days.flatMap((d) => d.decisions);
    const summary = {
      ...report,
      jev: { ...report.jev, cache_hit_rate: Math.round((decisions.filter((d) => d.cache_hit).length / Math.max(1, decisions.length)) * 1e4) / 1e4 },
    };
    await writer.finishRound(db, run_id, round, "done", summary);
    state.next = round + 1;
    if (r.generation) {
      await writer.generation(db, r.generation);
      if (this.opts.autoNext) await writer.enqueue(db, `tsk_run_${run_id}_r${round + 1}`, "run_round", { run_id, round: round + 1 });
    } else {
      await writer.run(db, this.runRow(run, "done"));
    }
    return {
      run_id,
      round,
      impressions: summary.impressions,
      buys: summary.buys,
      learnings_opened: r.opened.length,
      generate_creatives: r.generation ? `tsk_gen_${run_id}_r${round}` : null,
    };
  }

  // The run for this round: in memory if this worker ran the previous round; new on round 0;
  // otherwise rebuilt from the run row by replaying rounds 0..round-1 from the Jev cache.
  private async runFor(run_id: string, round: number, world: World, perceptions: Awaited<ReturnType<typeof perceiveAll>>) {
    const held = this.runs.get(run_id);
    if (held) {
      if (held.next !== round) throw new Error(`run ${run_id} is at round ${held.next}, not ${round}`);
      return held;
    }
    const [row] = await this.opts.db.sql(`SELECT * FROM run WHERE run_id = ${sqlString(run_id)}`);
    if (round === 0) {
      const settings = row
        ? { seed: Number(row.seed), population: Number(row.population), roundsPlanned: Number(row.rounds_planned) }
        : RUN_DEFAULTS;
      const run = new SimRun(world, this.opts.jev, perceptions, { run_id, ...settings, perceiverId: keywordPerceiver.id });
      await run.calibrate();
      await this.opts.db.call("upsert_run", [JSON.stringify(this.runRow(run, "running"))]);
      const state = { run, next: 0 };
      this.runs.set(run_id, state);
      return state;
    }
    if (!row) throw new Error(`run ${run_id} has no run row; queue round 0 first`);
    const run = new SimRun(world, this.opts.jev, perceptions, {
      run_id,
      seed: Number(row.seed),
      population: Number(row.population),
      roundsPlanned: Number(row.rounds_planned),
      perceiverId: keywordPerceiver.id,
    });
    if (run.configHash !== row.config_hash) throw new Error(`run ${run_id}: config changed since it started; replay would differ`);
    this.log(`replaying ${run_id} rounds 0-${round - 1} from the Jev cache`);
    run.setWorld(await this.worldFor(0), await perceiveAll(await this.worldFor(0), keywordPerceiver, this.opts.store ?? null));
    await run.calibrate();
    const stored = (JSON.parse(String(row.calibration)) as { offsets: Record<string, number> }).offsets;
    if (JSON.stringify(stored) !== JSON.stringify(run.fit.offsets)) {
      throw new Error(`run ${run_id}: replayed calibration differs from the run row (is the Jev cache missing?)`);
    }
    for (let r = 0; r < round; r++) {
      const w = await this.worldFor(r);
      run.setWorld(w, await perceiveAll(w, keywordPerceiver, this.opts.store ?? null));
      await run.runRound(r);
    }
    const state = { run, next: round };
    this.runs.set(run_id, state);
    return state;
  }

  // The contract's run row: settings, status, calibration (offsets, the warm-up fit, the probe's
  // Jev usage), model and config hash.
  runRow(run: SimRun, status: string) {
    return {
      run_id: run.opts.run_id,
      seed: run.opts.seed,
      population: run.opts.population,
      rounds_planned: run.opts.roundsPlanned,
      ticks_per_round: config.run.ticksPerRound,
      status,
      calibration: { offsets: run.fit.offsets, warm_up_fit: run.fit, probe_jev: run.probe },
      jev_model: config.jev.model,
      config_hash: run.configHash,
    };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: args } = parseArgs({
    options: {
      fixtures: { type: "boolean", default: false },
      once: { type: "boolean", default: false },
      poll: { type: "string", default: "3000" },
      "auto-next": { type: "boolean", default: false },
      enqueue: { type: "string" },
      round: { type: "string", default: "0" },
    },
  });
  loadEnv();
  const db = await SpacetimeHttp.connect();
  // Say where this worker writes before it touches anything (the B5 bench must read LOCAL).
  const where = `${process.env.SPACETIMEDB_URI} / ${process.env.SPACETIMEDB_DB_NAME}`;
  console.log(`sim worker ${db.name} → ${where} (${isLocalUri(process.env.SPACETIMEDB_URI ?? "") ? "LOCAL" : "MAINCLOUD"})`);
  if (args.enqueue) {
    const round = Number(args.round);
    const task_id = `tsk_run_${args.enqueue}_r${round}`;
    await writer.enqueue(db, task_id, "run_round", { run_id: args.enqueue, round });
    console.log(`queued ${task_id}`);
    process.exit(0);
  }
  const jev = new JevClient();
  const store = new PerceptionStore();
  const worker = new Worker({ db, jev, source: args.fixtures ? "fixtures" : "db", store, autoNext: args["auto-next"] });
  console.log(`sim worker ${db.name}: ${args.fixtures ? "fixtures" : "A's rows"}, polling every ${args.poll} ms`);
  try {
    for (;;) {
      const worked = await worker.tick();
      if (!worked && args.once) break;
      if (!worked) await new Promise((r) => setTimeout(r, Number(args.poll)));
    }
  } finally {
    jev.close();
    store.close();
  }
}
