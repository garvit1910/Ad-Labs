import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  type CardArm,
  type CardCreative,
  type CardLearning,
  type CardRound,
  type CardTask,
  creativeOfRun,
  derivePhase,
  RUN_PHASES,
  recipeLabel,
  roundSummaryCard,
  winnersCard,
} from '@/lib/adlab/round-cards';

// B's sample round summary (sim/SAMPLE_ROUND_SUMMARY.json): run_demo, round 1.
const SAMPLE = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../sim/SAMPLE_ROUND_SUMMARY.json'), 'utf8'));
const RUN = 'run_demo';

const arms: CardArm[] = (SAMPLE.by_arm as Array<{ arm_id: string; strategy: string; angle: string | null; hook: string | null }>).map((arm) => ({
  arm_id: arm.arm_id,
  strategy: arm.strategy,
  angle: arm.angle ?? '',
  hook: arm.hook ?? '',
}));

const NAMES: Record<string, string> = {
  seg_keto_low_carb: 'Keto low-carb',
  seg_protein_athlete: 'Protein athlete',
  seg_nostalgic_adult: 'Nostalgic adult',
  seg_healthy_family: 'Healthy family',
  seg_taste_skeptic: 'Taste skeptic',
  seg_deal_seeker: 'Deal seeker',
};
const segments = Object.entries(NAMES).map(([segment_id, name]) => ({ segment_id, name }));

// The opened learnings as rows: the segment is in the id; the winner names arm_07.
const learnings: CardLearning[] = (SAMPLE.learnings.opened as Array<{ learning_id: string; kind: string; statement: string; directive: string }>).map((l) => ({
  ...l,
  run_id: RUN,
  segment_id: `seg_${Object.keys(NAMES).map((s) => s.slice(4)).find((s) => l.learning_id.startsWith(`lrn_demo_${s}_`))}`,
  arm_id: l.kind === 'winner' ? 'arm_07' : null,
  valid_from_round: 1,
  valid_to_round: null,
}));

const round1: CardRound = { run_id: RUN, round: 1, status: 'done', started_at: null, finished_at: null, summary: JSON.stringify(SAMPLE) };

const creative = (id: string, arm: string, segment: string, round: number, status = 'ranked'): CardCreative => ({
  creative_id: id,
  arm_id: arm,
  segment_id: segment,
  origin: 'generated',
  status,
  round_created: round,
  headline: `headline ${id}`,
  primary_text: 'text',
  cta: 'Shop Now',
  visual_description: 'a bowl',
});

describe('recipeLabel', () => {
  it('reads "angle × hook" in words, and names the control', () => {
    assert.equal(recipeLabel({ angle: 'health_nutrition', hook: 'testimonial', strategy: 'steal' }), 'health nutrition × testimonial');
    assert.equal(recipeLabel({ angle: '', hook: '', strategy: 'control' }), "Magic Spoon's current ads");
  });
});

describe('roundSummaryCard', () => {
  const card = roundSummaryCard(round1, { arms, segments, learnings, roundsPlanned: 3 });

  it('carries the round, totals and Jev numbers', () => {
    assert.equal(card.round, 1);
    assert.equal(card.rounds_planned, 3);
    assert.equal(card.status, 'done');
    assert.deepEqual(card.totals, { impressions: 705, buys: 1, taps: 13, jev_calls: 1410, jev_cost_usd: 0.0447, cache_hit_rate: 1 });
  });

  it('names segments and recipes on the leaderboard, with the control row', () => {
    assert.equal(card.leaderboard.length, 6);
    const keto = card.leaderboard[0];
    assert.equal(keto.segment_id, 'seg_keto_low_carb');
    assert.equal(keto.segment_name, 'Keto low-carb');
    assert.equal(keto.impressions, 155);
    assert.deepEqual(keto.top[0], {
      arm_id: 'arm_02',
      recipe: 'dietary fit × problem callout',
      strategy: 'steal',
      p_best: 0.8915,
      cpo_usd: 19.12,
      cpo_range_usd: [16.1, 23.53],
      share: 0.3871,
    });
    assert.equal(keto.control?.recipe, "Magic Spoon's current ads");
    assert.equal(keto.control?.strategy, 'control');
    assert.equal(keto.control?.cpo_usd, 58.18);
  });

  it('joins the opened learnings to their segment and arm, counts the closed, and lists the winners', () => {
    assert.equal(card.learnings_opened.length, 10);
    const winner = card.learnings_opened.find((l) => l.kind === 'winner')!;
    assert.equal(winner.segment_name, 'Protein athlete');
    assert.equal(winner.arm_id, 'arm_07');
    assert.equal(card.learnings_closed, 6);
    assert.deepEqual(card.winners, [
      {
        segment_id: 'seg_protein_athlete',
        segment_name: 'Protein athlete',
        arm_id: 'arm_07',
        recipe: 'health nutrition × testimonial',
        statement: winner.statement,
      },
    ]);
  });

  it('falls back to the summary’s by_arm when the arm table lacks an arm', () => {
    const bare = roundSummaryCard(round1, { arms: [], segments: [], learnings: [], roundsPlanned: 3 });
    assert.equal(bare.leaderboard[0].top[0].recipe, 'dietary fit × problem callout');
    assert.equal(bare.leaderboard[0].segment_name, 'seg_keto_low_carb');
    assert.equal(bare.winners.length, 0);
  });
});

describe('winnersCard', () => {
  const creatives = [
    creative('cr_g0_07_protein_athlete_1', 'arm_07', 'seg_protein_athlete', 0),
    creative('cr_g1_demo_07_protein_athlete_1', 'arm_07', 'seg_protein_athlete', 1),
    creative('cr_g2_otherrun_07_protein_athlete_1', 'arm_07', 'seg_protein_athlete', 2),
    creative('cr_g2_demo_07_protein_athlete_1', 'arm_07', 'seg_protein_athlete', 2, 'gated_out'),
    creative('cr_g0_02_keto_low_carb_1', 'arm_02', 'seg_keto_low_carb', 0),
  ];
  const cards = winnersCard({ runId: RUN, learnings, arms, segments, creatives, latestDone: round1 });

  it('declares a live winner learning, with its run’s latest ranked creative and the leaderboard numbers', () => {
    const athlete = cards.find((c) => c.segment_id === 'seg_protein_athlete')!;
    assert.equal(athlete.basis, 'winner');
    assert.equal(athlete.declared, true);
    assert.equal(athlete.arm_id, 'arm_07');
    assert.equal(athlete.recipe, 'health nutrition × testimonial');
    assert.equal(athlete.p_best, 1);
    assert.equal(athlete.cpo_usd, 10.09);
    assert.equal(athlete.control_cpo_usd, 54.87);
    // Not the other run's round 2, not this run's gated-out one: this run's round 1.
    assert.equal(athlete.creative?.creative_id, 'cr_g1_demo_07_protein_athlete_1');
  });

  it('falls back to the leading non-control arm, with round 0’s creative', () => {
    const keto = cards.find((c) => c.segment_id === 'seg_keto_low_carb')!;
    assert.equal(keto.basis, 'leading');
    assert.equal(keto.declared, false);
    assert.equal(keto.arm_id, 'arm_02');
    assert.match(keto.statement, /dietary fit × problem callout leads for Keto low-carb so far \(89% chance it's best\)/);
    assert.equal(keto.creative?.creative_id, 'cr_g0_02_keto_low_carb_1');
    const family = cards.find((c) => c.segment_id === 'seg_healthy_family')!;
    assert.equal(family.creative, null);
    assert.equal(cards.length, 6);
  });

  it('skips the control when it leads a segment, and falls back to the leading recipe', () => {
    const summary = structuredClone(SAMPLE);
    const keto = summary.leaderboard.find((row: { segment_id: string }) => row.segment_id === 'seg_keto_low_carb');
    keto.top = [keto.control, ...keto.top];
    const card = winnersCard({ runId: RUN, learnings, arms, segments, creatives, latestDone: { ...round1, summary: JSON.stringify(summary) } });
    const row = card.find((c) => c.segment_id === 'seg_keto_low_carb')!;
    assert.equal(row.basis, 'leading');
    assert.equal(row.arm_id, 'arm_02');
    assert.equal(card.length, 6);
  });

  it('ignores closed winners and returns nothing before any round is done', () => {
    const closed = learnings.map((l) => ({ ...l, valid_to_round: 2 }));
    const card = winnersCard({ runId: RUN, learnings: closed, arms, segments, creatives, latestDone: round1 });
    assert.equal(card.find((c) => c.segment_id === 'seg_protein_athlete')?.basis, 'leading');
    assert.deepEqual(winnersCard({ runId: RUN, learnings: [], arms, segments, creatives, latestDone: null }), []);
  });

  it('tells a run’s creatives from another run’s', () => {
    assert.ok(creativeOfRun(creatives[0], RUN));
    assert.ok(creativeOfRun(creatives[1], RUN));
    assert.ok(!creativeOfRun(creatives[2], RUN));
    assert.ok(!creativeOfRun({ creative_id: 'cr_g1_demo_2_07_protein_athlete_1', arm_id: 'arm_07', segment_id: 'seg_protein_athlete', round_created: 1 }, RUN));
  });
});

describe('derivePhase', () => {
  const T = (id: string, kind: string, status: string, round: number, minute: number): CardTask => ({
    task_id: id,
    run_id: RUN,
    kind,
    status,
    claimed_by: status === 'queued' ? null : 'w',
    payload: { run_id: RUN, round },
    created_at: `2026-10-25T07:${String(minute).padStart(2, '0')}:00.000Z`,
  });
  const run = (statusName = 'running') => ({ run_id: RUN, status: statusName, rounds_planned: 2 });
  const r0 = T('tsk_run_run_demo_r0', 'run_round', 'done', 0, 0);
  const g0 = (s: string) => T('tsk_gen_run_demo_r0', 'generate_creatives', s, 0, 1);
  const r1 = (s: string) => T('tsk_run_run_demo_r1', 'run_round', s, 1, 2);
  const done0 = [{ round: 0, status: 'done' }];

  const cases: Array<[string, ReturnType<typeof run> | null, Array<{ round: number; status: string }>, CardTask[], string, number | null]> = [
    ['nothing yet', null, [], [], 'not_started', null],
    ['placeholder row, no task', run('calibrating'), [], [], 'not_started', null],
    ['round 0 queued', run('calibrating'), [], [T('tsk_run_run_demo_r0', 'run_round', 'queued', 0, 0)], 'waiting_for_worker', 0],
    ['round 0 claimed, no round row', run('calibrating'), [], [T('tsk_run_run_demo_r0', 'run_round', 'claimed', 0, 0)], 'calibrating', 0],
    ['round 0 claimed and running', run(), [{ round: 0, status: 'running' }], [T('tsk_run_run_demo_r0', 'run_round', 'claimed', 0, 0)], 'round_running', 0],
    ['round 0 done, no gen task yet', run(), done0, [r0], 'waiting_for_bandit', 0],
    ['gen queued', run(), done0, [r0, g0('queued')], 'creatives_queued', 0],
    ['gen claimed', run(), done0, [r0, g0('claimed')], 'writing_creatives', 0],
    ['gen done, round 1 not queued yet', run(), done0, [r0, g0('done')], 'waiting_for_worker', 0],
    ['round 1 queued', run(), done0, [r0, g0('done'), r1('queued')], 'waiting_for_worker', 1],
    ['round 1 claimed', run(), done0, [r0, g0('done'), r1('claimed')], 'round_running', 1],
    ['gen failed', run(), done0, [r0, g0('failed')], 'failed', 0],
    ['a failed gen superseded by a later round', run(), done0, [r0, g0('failed'), r1('queued')], 'waiting_for_worker', 1],
    ['run done', run('done'), done0, [r0], 'done', 0],
    ['run row gone mid-run', null, done0, [r0, g0('done'), r1('queued')], 'lost', 1],
    ['a run row with no tasks', run(), [], [], 'lost', null],
  ];

  for (const [name, runRow, rounds, tasks, phase, current] of cases) {
    it(name, () => {
      assert.deepEqual(derivePhase(runRow, rounds, tasks), { phase, current_round: current });
    });
  }

  it('covers every phase in the contract', () => {
    const seen = new Set(cases.map((c) => c[4]));
    assert.deepEqual([...RUN_PHASES].filter((p) => !seen.has(p)), []);
  });
});
