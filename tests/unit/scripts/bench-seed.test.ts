import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SqlRow } from '@/lib/adlab/spacetime-http';
import { benchTarget } from '@/lib/adlab/targets';
import { applySeed, planSeed, readOnly, readTargetState, selectSeedRows, type SeedTables } from '@/scripts/bench/seed';
import { verifyRun } from '@/scripts/bench/verify';
import { FakeStdb, a4Tables } from '../worker/creatives/helpers';

const generated = (creative_id: string, round_created: number): SqlRow => ({
  ...a4Tables().creative[0],
  creative_id,
  origin: 'generated',
  arm_id: 'arm_health_nutrition_statistic',
  segment_id: 'seg_the_macro_tracker',
  round_created,
});

function source(): SeedTables {
  const t = a4Tables();
  return {
    brand: t.brand,
    concept: t.concept,
    segment: t.segment,
    arm: t.arm,
    product: [...t.product, { product_id: 'prd_stray', brand_id: 'br_unknown', name: 'Stray' }],
    creative: [...t.creative, generated('cr_g0_health_nutrition_statistic_the_macro_tracker_1', 0), generated('cr_g1_demo_health_nutrition_statistic_the_macro_tracker_1', 1)],
  };
}

const empty = () => new FakeStdb({ brand: [], concept: [], segment: [], arm: [], product: [], creative: [], run: [], task: [] }, { target: benchTarget('local') });

describe('bench seed', () => {
  it("keeps live ads and round 0, never another run's later creatives or a stray product", () => {
    const { rows, skippedCreatives, skippedProducts, problems } = selectSeedRows(source());
    assert.deepEqual(problems, []);
    assert.deepEqual(rows.creative.map((c) => c.creative_id).sort(), ['cr_g0_health_nutrition_statistic_the_macro_tracker_1', 'cr_live_halden_1', 'cr_live_rival_1']);
    assert.deepEqual(skippedCreatives, ['cr_g1_demo_health_nutrition_statistic_the_macro_tracker_1']);
    assert.deepEqual(skippedProducts, ['prd_stray']);
    assert.equal(selectSeedRows(source(), { withoutRound0: true }).rows.creative.length, 2);
  });

  it('writes everything once, in load order with brand_live last, then nothing on a rerun', async () => {
    const db = empty();
    const { rows } = selectSeedRows(source());
    const calls = await applySeed(db, planSeed(rows, await readTargetState(db)), () => {});
    assert.deepEqual(
      db.reducerCalls.map((c) => c.reducer),
      ['upsert_brands', 'upsert_concepts', 'upsert_segments', 'upsert_arms', 'upsert_products', 'upsert_creatives'],
    );
    assert.equal(calls, 6);
    const written = (db.reducerCalls.at(-1)!.args[0] as SqlRow[]).map((c) => c.origin);
    assert.deepEqual(written, ['competitor_live', 'generated', 'brand_live']);
    assert.equal(typeof db.reducerCalls[4].args[0], 'string', 'upsert_products takes one JSON string');
    const again = planSeed(rows, await readTargetState(db));
    assert.equal(again.writes, 0);
    assert.equal(await applySeed(db, again, () => {}), 0);
  });

  it("refuses a target holding other rows, or one whose runs simulated rows that would change", async () => {
    const { rows } = selectSeedRows(source());
    const fixtures = empty();
    fixtures.tables.brand = [{ brand_id: 'br_three_wishes', name: 'Three Wishes', is_client: false }];
    assert.match(planSeed(rows, await readTargetState(fixtures)).refusals.join(' '), /brand rows the source doesn't/);

    const used = empty();
    used.tables.run = [{ run_id: 'run_old', status: 'done' }];
    assert.match(planSeed(rows, await readTargetState(used)).refusals.join(' '), /run_old/);

    const later = empty();
    await applySeed(later, planSeed(rows, await readTargetState(later)), () => {});
    later.tables.creative.push(generated('cr_g1_old_x_y_1', 1));
    const plan = planSeed(rows, await readTargetState(later));
    assert.deepEqual(plan.refusals, []);
    assert.match(plan.warnings.join(' '), /earlier runs/);
  });

  it('never writes to the source', async () => {
    await assert.rejects(readOnly(empty()).call('upsert_brands', [[]]), /read-only/);
  });
});

describe('bench verify-run', () => {
  // A finished two-round run: B's worker held every run_round, A5 wrote the creatives between rounds.
  function finishedRun(claimer = 'creative_worker') {
    const now = '2026-10-25T07:00:00.000Z';
    const task = (task_id: string, kind: string, claimed_by: string, result: object, payload: object = {}) => ({
      task_id,
      run_id: 'run_t',
      kind,
      status: 'done',
      claimed_by,
      payload: JSON.stringify({ run_id: 'run_t', ...payload }),
      result: JSON.stringify(result),
      created_at: now,
      updated_at: now,
    });
    const gen = (r: number) =>
      task(`tsk_gen_run_t_r${r}`, 'generate_creatives', claimer, { round_created: r + 1, ranked: 1, creative_ids: [`cr_g${r + 1}_t_a_s_1`], next_task: r + 1 <= 2 ? `tsk_run_run_t_r${r + 1}` : null }, { arms: [{ arm_id: 'arm_a' }] });
    return new FakeStdb({
      run: [{ run_id: 'run_t', status: 'done', rounds_planned: 2, created_at: now }],
      round: [0, 1, 2].map((r) => ({ run_id: 'run_t', round: r, status: 'done', summary: JSON.stringify({ impressions: 700, generation: r < 2 ? { arms: [{ arm_id: 'arm_a' }] } : null }) })),
      task: [
        ...[0, 1, 2].map((r) => task(`tsk_run_run_t_r${r}`, 'run_round', 'sim-worker:abc', {})),
        gen(0),
        gen(1),
      ],
      creative: [1, 2].map((r) => ({ creative_id: `cr_g${r}_t_a_s_1`, origin: 'generated', round_created: r, status: 'ranked' })),
      decision: [1, 2].map((r) => ({ run_id: 'run_t', round: r, creative_id: `cr_g${r}_t_a_s_1` })),
    });
  }

  it('passes a run that went end to end', async () => {
    const report = await verifyRun(finishedRun(), { runId: 'run_t', rounds: 2, claimer: 'creative_worker' });
    assert.equal(report.failed, false, report.lines.filter((l) => l.level === 'FAIL').map((l) => l.text).join('\n'));
  });

  it('fails the wrong claimer, a failed task, and another run in the feed', async () => {
    assert.equal((await verifyRun(finishedRun('someone'), { runId: 'run_t', claimer: 'copywriter' })).failed, true);
    const failed = finishedRun();
    failed.tables.task[0].status = 'failed';
    assert.equal((await verifyRun(failed, { runId: 'run_t' })).failed, true);
    const foreign = finishedRun();
    foreign.tables.creative.push({ creative_id: 'cr_g1_other_a_s_1', origin: 'generated', round_created: 1, status: 'ranked' });
    const report = await verifyRun(foreign, { runId: 'run_t' });
    assert.ok(report.lines.some((l) => l.level === 'FAIL' && l.text.startsWith('R8')));
  });
});
