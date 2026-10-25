import { CONTROL_ARM_ID, generatedCreativeId } from './contract';

/*
 * Pure views of B's run for the agents' cards (docs/AGENT_API.md "Strategist"): one round's
 * summary card, each segment's winner, and the run's phase. Inputs are rows as the readers in
 * agent-api.ts return them; nothing here does I/O.
 */

export interface CardArm {
  arm_id: string;
  angle: string | null;
  hook: string | null;
  strategy: string;
}

export interface CardSegment {
  segment_id: string;
  name: string;
  share?: number;
}

export interface CardLearning {
  learning_id: string;
  run_id: string;
  segment_id: string;
  arm_id: string | null;
  kind: string;
  statement: string;
  directive: string;
  valid_from_round: number;
  valid_to_round: number | null;
}

export interface CardRound {
  run_id: string;
  round: number;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  summary: string;
}

export interface CardCreative {
  creative_id: string;
  arm_id: string;
  segment_id: string;
  origin: string;
  status: string;
  round_created: number;
  headline: string;
  primary_text: string;
  cta: string;
  visual_description: string;
}

export interface CardTask {
  task_id: string;
  run_id: string;
  kind: string;
  status: string;
  claimed_by: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface CardRun {
  run_id: string;
  status: string;
  rounds_planned: number;
}

// ── B's round summary (sim: the round row's summary json) ────────────────────

interface SummaryEntry {
  arm_id: string;
  share_this_round?: number;
  impressions?: number;
  p_best?: number;
  cpo_usd?: number | null;
  cpo_range_usd?: [number, number] | null;
}

interface SummaryJson {
  impressions?: number;
  taps?: number;
  buys?: number;
  jev?: { calls?: number; cost_usd?: number; cache_hit_rate?: number };
  leaderboard?: Array<{ segment_id: string; impressions_this_round?: number; top?: SummaryEntry[]; control?: SummaryEntry | null }>;
  learnings?: { opened?: Array<{ learning_id: string; kind: string; statement: string; directive: string }>; closed?: string[]; live?: number };
  by_arm?: Array<{ arm_id: string; strategy?: string; angle?: string | null; hook?: string | null }>;
}

export function parseSummary(text: string): SummaryJson {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as SummaryJson) : {};
  } catch {
    return {};
  }
}

const words = (token: string) => token.replace(/_/g, ' ');

/** "angle × hook" in words ("health nutrition × testimonial"); the control is Magic Spoon's live ads. */
export function recipeLabel(arm: Pick<CardArm, 'angle' | 'hook' | 'strategy'> | undefined): string {
  if (!arm || arm.strategy === 'control' || !arm.angle || !arm.hook) return "Magic Spoon's current ads";
  return `${words(arm.angle)} × ${words(arm.hook)}`;
}

/** Arm details from the arm table, falling back to the summary's by_arm. */
function armLookup(arms: CardArm[], summary: SummaryJson): (armId: string) => CardArm | undefined {
  const table = new Map(arms.map((arm) => [arm.arm_id, arm]));
  const fromSummary = new Map(
    (summary.by_arm ?? []).map((arm) => [arm.arm_id, { arm_id: arm.arm_id, angle: arm.angle ?? null, hook: arm.hook ?? null, strategy: arm.strategy ?? '' }]),
  );
  return (armId) => table.get(armId) ?? fromSummary.get(armId);
}

export interface LeaderboardEntry {
  arm_id: string;
  recipe: string;
  strategy: string;
  p_best: number | null;
  cpo_usd: number | null;
  cpo_range_usd: [number, number] | null;
  share: number | null;
}

export interface RoundSummaryCard {
  round: number;
  rounds_planned: number;
  status: string;
  totals: { impressions: number; buys: number; taps: number; jev_calls: number; jev_cost_usd: number; cache_hit_rate: number | null };
  leaderboard: Array<{ segment_id: string; segment_name: string; impressions: number; top: LeaderboardEntry[]; control: LeaderboardEntry | null }>;
  learnings_opened: Array<{ learning_id: string; segment_id: string; segment_name: string; arm_id: string | null; kind: string; statement: string; directive: string }>;
  learnings_closed: number;
  winners: Array<{ segment_id: string; segment_name: string; arm_id: string; recipe: string; statement: string }>;
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export function roundSummaryCard(
  round: CardRound,
  ctx: { arms: CardArm[]; segments: CardSegment[]; learnings: CardLearning[]; roundsPlanned: number },
): RoundSummaryCard {
  const summary = parseSummary(round.summary);
  const armOf = armLookup(ctx.arms, summary);
  const segmentName = (id: string) => ctx.segments.find((segment) => segment.segment_id === id)?.name ?? id;
  const entry = (e: SummaryEntry): LeaderboardEntry => {
    const arm = armOf(e.arm_id);
    return {
      arm_id: e.arm_id,
      recipe: recipeLabel(arm ?? (e.arm_id === CONTROL_ARM_ID ? { angle: null, hook: null, strategy: 'control' } : undefined)),
      strategy: arm?.strategy ?? (e.arm_id === CONTROL_ARM_ID ? 'control' : ''),
      p_best: num(e.p_best),
      cpo_usd: num(e.cpo_usd),
      cpo_range_usd: Array.isArray(e.cpo_range_usd) ? e.cpo_range_usd : null,
      share: num(e.share_this_round),
    };
  };
  const learningRow = new Map(ctx.learnings.map((row) => [row.learning_id, row]));
  const opened = (summary.learnings?.opened ?? []).map((l) => {
    const row = learningRow.get(l.learning_id);
    const segmentId = row?.segment_id ?? '';
    return {
      learning_id: l.learning_id,
      segment_id: segmentId,
      segment_name: segmentId ? segmentName(segmentId) : '',
      arm_id: row?.arm_id ?? null,
      kind: l.kind,
      statement: l.statement,
      directive: l.directive,
    };
  });
  return {
    round: round.round,
    rounds_planned: ctx.roundsPlanned,
    status: round.status,
    totals: {
      impressions: summary.impressions ?? 0,
      buys: summary.buys ?? 0,
      taps: summary.taps ?? 0,
      jev_calls: summary.jev?.calls ?? 0,
      jev_cost_usd: summary.jev?.cost_usd ?? 0,
      cache_hit_rate: num(summary.jev?.cache_hit_rate),
    },
    leaderboard: (summary.leaderboard ?? []).map((row) => ({
      segment_id: row.segment_id,
      segment_name: segmentName(row.segment_id),
      impressions: row.impressions_this_round ?? 0,
      top: (row.top ?? []).map(entry),
      control: row.control ? entry(row.control) : null,
    })),
    learnings_opened: opened,
    learnings_closed: summary.learnings?.closed?.length ?? 0,
    winners: opened
      .filter((l) => l.kind === 'winner' && l.arm_id)
      .map((l) => ({ segment_id: l.segment_id, segment_name: l.segment_name, arm_id: l.arm_id!, recipe: recipeLabel(armOf(l.arm_id!)), statement: l.statement })),
  };
}

// ── Winners per segment ──────────────────────────────────────────────────────

export interface WinnerCard {
  segment_id: string;
  segment_name: string;
  arm_id: string;
  recipe: string;
  statement: string;
  basis: 'winner' | 'leading';
  declared: boolean;
  p_best: number | null;
  cpo_usd: number | null;
  control_cpo_usd: number | null;
  creative: { creative_id: string; headline: string; primary_text: string; cta: string; visual_description: string } | null;
}

/** A generated creative of this run: round 0's shared ids, or a later round's ids carrying the run. */
export function creativeOfRun(creative: Pick<CardCreative, 'creative_id' | 'arm_id' | 'segment_id' | 'round_created'>, runId: string): boolean {
  const variant = /_(\d+)$/.exec(creative.creative_id);
  if (!variant || !creative.arm_id.startsWith('arm_') || !creative.segment_id.startsWith('seg_')) return false;
  try {
    return generatedCreativeId(creative.round_created, runId, creative.arm_id, creative.segment_id, Number(variant[1])) === creative.creative_id;
  } catch {
    return false;
  }
}

/** The run's best ranked creative for (arm, segment): its latest round, then the lowest id. */
export function bestCreative(creatives: CardCreative[], runId: string, armId: string, segmentId: string): CardCreative | null {
  const mine = creatives
    .filter((c) => c.origin === 'generated' && c.status === 'ranked' && c.arm_id === armId && c.segment_id === segmentId && creativeOfRun(c, runId))
    .sort((a, b) => b.round_created - a.round_created || (a.creative_id < b.creative_id ? -1 : 1));
  return mine[0] ?? null;
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

export function winnersCard(i: {
  runId: string;
  learnings: CardLearning[];
  arms: CardArm[];
  segments: CardSegment[];
  creatives: CardCreative[];
  /** The latest done round's row, or null before any round is done. */
  latestDone: CardRound | null;
}): WinnerCard[] {
  const summary = i.latestDone ? parseSummary(i.latestDone.summary) : {};
  const armOf = armLookup(i.arms, summary);
  const isControl = (armId: string | null) => !armId || armId === CONTROL_ARM_ID || armOf(armId)?.strategy === 'control';
  const out: WinnerCard[] = [];
  for (const segment of i.segments) {
    const board = (summary.leaderboard ?? []).find((row) => row.segment_id === segment.segment_id);
    const declared = i.learnings
      .filter((l) => l.run_id === i.runId && l.kind === 'winner' && l.valid_to_round === null && l.segment_id === segment.segment_id && !isControl(l.arm_id))
      .sort((a, b) => b.valid_from_round - a.valid_from_round || (a.learning_id < b.learning_id ? 1 : -1))[0];
    const leader = board?.top?.[0];
    let armId: string;
    let statement: string;
    let basis: WinnerCard['basis'];
    if (declared?.arm_id) {
      armId = declared.arm_id;
      statement = declared.statement;
      basis = 'winner';
    } else if (leader && !isControl(leader.arm_id)) {
      armId = leader.arm_id;
      const recipe = recipeLabel(armOf(armId));
      statement = `${recipe} leads for ${segment.name} so far${typeof leader.p_best === 'number' ? ` (${pct(leader.p_best)} chance it's best)` : ''}.`;
      basis = 'leading';
    } else continue;
    const stats = board?.top?.find((e) => e.arm_id === armId);
    const creative = bestCreative(i.creatives, i.runId, armId, segment.segment_id);
    out.push({
      segment_id: segment.segment_id,
      segment_name: segment.name,
      arm_id: armId,
      recipe: recipeLabel(armOf(armId)),
      statement,
      basis,
      declared: basis === 'winner',
      p_best: num(stats?.p_best),
      cpo_usd: num(stats?.cpo_usd),
      control_cpo_usd: num(board?.control?.cpo_usd),
      creative: creative
        ? {
            creative_id: creative.creative_id,
            headline: creative.headline,
            primary_text: creative.primary_text,
            cta: creative.cta,
            visual_description: creative.visual_description,
          }
        : null,
    });
  }
  return out;
}

// ── The run's phase ──────────────────────────────────────────────────────────

export const RUN_PHASES = [
  'not_started',
  'waiting_for_worker',
  'calibrating',
  'round_running',
  'waiting_for_bandit',
  'creatives_queued',
  'writing_creatives',
  'done',
  'failed',
  'lost',
] as const;
export type RunPhase = (typeof RUN_PHASES)[number];

const roundOf = (task: CardTask): number => {
  const r = task.payload.round;
  if (typeof r === 'number' && Number.isInteger(r)) return r;
  const m = /_r(\d+)$/.exec(task.task_id);
  return m ? Number(m[1]) : -1;
};

const byCreated = (a: CardTask, b: CardTask) =>
  a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0;

/**
 * Where the run is, from its run row, round rows and tasks:
 * - the latest task failed (or the run row says failed): failed;
 * - the run row is done: done;
 * - no run row and no task: not_started; a run row (not startRun's placeholder) with no task, or
 *   tasks past round 0 with no run row: lost;
 * - otherwise the latest run_round (highest round) decides: queued → waiting_for_worker; claimed →
 *   calibrating (round 0 before its round row) or round_running; done → the round's
 *   generate_creatives task: missing → waiting_for_bandit, queued → creatives_queued, claimed →
 *   writing_creatives, done → waiting_for_worker (the next round is about to be queued).
 */
export function derivePhase(run: CardRun | null, rounds: Pick<CardRound, 'round' | 'status'>[], tasks: CardTask[]): { phase: RunPhase; current_round: number | null } {
  const ordered = [...tasks].sort(byCreated);
  const runRounds = ordered.filter((task) => task.kind === 'run_round');
  const latestRun = runRounds.sort((a, b) => roundOf(a) - roundOf(b) || byCreated(a, b)).at(-1);
  const current = latestRun ? roundOf(latestRun) : rounds.length ? Math.max(...rounds.map((r) => r.round)) : null;
  const at = (phase: RunPhase) => ({ phase, current_round: current });

  if (ordered.at(-1)?.status === 'failed' || run?.status === 'failed') return at('failed');
  if (run?.status === 'done') return at('done');
  if (!run && ordered.length === 0) return at('not_started');
  if (!latestRun) return at(run?.status === 'calibrating' ? 'not_started' : 'lost');
  if (!run && runRounds.some((task) => roundOf(task) > 0 || task.status === 'done')) return at('lost');

  const r = roundOf(latestRun);
  switch (latestRun.status) {
    case 'queued':
      return at('waiting_for_worker');
    case 'claimed':
      return at(r === 0 && !rounds.some((row) => row.round === 0) ? 'calibrating' : 'round_running');
    case 'done': {
      const gen = ordered.filter((task) => task.kind === 'generate_creatives' && roundOf(task) === r).at(-1);
      if (!gen) return at('waiting_for_bandit');
      if (gen.status === 'queued') return at('creatives_queued');
      if (gen.status === 'claimed') return at('writing_creatives');
      if (gen.status === 'failed') return at('failed');
      return at('waiting_for_worker');
    }
    default:
      return at('failed');
  }
}
