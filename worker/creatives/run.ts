import type { SupabaseClient } from '@supabase/supabase-js';
import { generatedCreativeId } from '@/lib/adlab/contract';
import { adWords } from '@/lib/adlab/contract-check';
import { ADLAB_ORG_ID } from '@/lib/adlab/org';
import { feedHeadline, feedImage, feedPrimary } from '@/lib/adlab/sim-text';
import { connectSpacetime, SpacetimeError, sqlString, type Spacetime } from '@/lib/adlab/spacetime-http';
import { serviceSupabase } from '@/lib/adlab/supabase';
import type { BrandContextRow } from '@/lib/creative-engine/brand-context/types';
import { generateBrief } from './brief';
import { checkA4Rows, readA4Tables, type A4Tables } from './check';
import { keyMessageFor, loadClientRows, personaAudience, valuePropositions, type ClientRows } from './facts';
import { spacetimeInputs, type CreativeInputs } from './inputs';
import { derivePackHints, segmentRows } from './pack-hints';
import { planPairs } from './pairs';
import type { CreativeRow, GeneratedCreative, Pair, Recipe, Skip } from './types';

/** Who the worker loop claims tasks as. Stable across restarts, so a restarted worker resumes its own claims. */
export const CREATIVE_WORKER = 'creative_worker';

const BRIEF_CONCURRENCY = 6;
/** A brief that throws (an LLM or compile error) is tried this many times before it's reported. */
const BRIEF_ATTEMPTS = 3;
/**
 * The longest generated ad, in the words B's renderAd prints, that the sim can show
 * next to two competitor ads and still stay under its 450-word state limit. The feed
 * cuts (lib/adlab/sim-text.ts) keep ads well under it; this is the backstop.
 */
export const MAX_AD_WORDS = 60;

export interface RunDeps {
  spacetime?: Spacetime;
  db?: SupabaseClient;
  /** Pre-loaded compiler rows; otherwise the live facts are read through `db`. */
  client?: ClientRows;
  log?: (line: string) => void;
}

/** A generated creative and the row it becomes. */
export interface WrittenCreative extends GeneratedCreative {
  row: CreativeRow;
}

export interface GenerateResult {
  creatives: WrittenCreative[];
  /** Briefs that still threw after every attempt (one line each); the rest still write. */
  errors: string[];
}

/** Learnings for one (arm, segment): the directives the copywriter sees and the ids they came from. */
export type NotesFor = (armId: string, segmentId: string) => { notes: string[]; learningIds: string[] };

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

/** The image line the sim shows (lib/adlab/sim-text.ts); exported for the tests. */
export const simVisual = feedImage;

export const pairKey = (pair: Pick<Pair, 'segmentId'> & { recipe: Pick<Recipe, 'arm_id'> }) => `${pair.recipe.arm_id}|${pair.segmentId}`;

interface GenerateParams {
  inputs: CreativeInputs;
  rows: BrandContextRow[];
  brandProfileId: string;
  pairs: Pair[];
  roundCreated: number;
  /** The run whose round this is; generated ids after round 0 carry it. */
  runId: string;
  variants: number;
  notesFor?: NotesFor;
}

/** One pass: pairs grouped by (segment, angle), each group one brief, each recipe's hook one copy variant. */
async function generatePass(params: GenerateParams): Promise<GenerateResult> {
  const { inputs, rows, roundCreated, runId, variants, notesFor } = params;
  const groups = new Map<string, Pair[]>();
  for (const pair of params.pairs) {
    const key = `${pair.segmentId}|${pair.recipe.angle}`;
    groups.set(key, [...(groups.get(key) ?? []), pair]);
  }

  const errors: string[] = [];
  const perGroup = await mapLimit([...groups], BRIEF_CONCURRENCY, async ([key, pairs]) => {
    const { segmentId, personaRef, recipe } = pairs[0];
    const angle = recipe.angle;
    const own = segmentRows(rows, personaRef);
    const persona = own.find((row) => row.rowType === 'persona')!;
    const keyFact = keyMessageFor(own, angle, personaRef);
    const recipeByHook = new Map<string, Recipe>(pairs.map((pair) => [pair.recipe.hook, pair.recipe]));
    const notes = (hook: string) => notesFor?.(recipeByHook.get(hook)!.arm_id, segmentId) ?? { notes: [], learningIds: [] };
    for (let attempt = 1; ; attempt++) {
      try {
        const run = await generateBrief({
          briefId: `brf_${segmentId.slice('seg_'.length)}_${angle}_g${roundCreated}`,
          rows,
          brandProfileId: params.brandProfileId,
          personaRef,
          angle,
          hooks: pairs.map((pair) => pair.recipe.hook),
          packHints: derivePackHints(own),
          context: {
            organizationId: ADLAB_ORG_ID,
            brandSummary: { brandName: inputs.brand.name, valuePropositions: valuePropositions(own) },
            audience: personaAudience(persona),
            ...(keyFact ? { keyMessage: String(keyFact.content.statement) } : {}),
            // The compliance facts reach the copywriter as the pack's Rules section.
            compliance: { prohibitedClaims: [], requiredDisclaimers: [] },
            source: 'agent',
          },
          variants,
          angleTheme: angle,
          ...(keyFact ? { keyMessageRef: keyFact.rowId } : {}),
          notesFor: (hook) => notes(hook).notes,
        });
        return run.creatives.map((creative): WrittenCreative => {
          const armId = recipeByHook.get(creative.arm.hookArchetype)!.arm_id;
          const row: CreativeRow = {
            creative_id: generatedCreativeId(roundCreated, runId, armId, segmentId, creative.variant),
            arm_id: armId,
            brand_id: inputs.brand.brand_id,
            origin: 'generated',
            // The sim reads what a feed shows before "… more"; the full copy stays in the run's log.
            headline: feedHeadline(creative.headline),
            primary_text: feedPrimary(creative.primaryText),
            cta: creative.cta,
            visual_description: simVisual(creative.visualDescription),
            image_url: '',
            landing_product_id: inputs.landingProductId,
            days_running: 0,
            round_created: roundCreated,
            learning_ids: JSON.stringify(notes(creative.arm.hookArchetype).learningIds),
            segment_id: segmentId,
            pack_fingerprint: creative.packFingerprint,
            status: creative.status,
          };
          // B's renderer throws on a state of 450 words or more, which fails the whole round.
          const length = adWords(row, inputs.brand.name);
          if (row.status === 'ranked' && length > MAX_AD_WORDS) {
            return { ...creative, status: 'gated_out', statusReason: `${length} words in the sim's feed (limit ${MAX_AD_WORDS})`, row: { ...row, status: 'gated_out' } };
          }
          return { ...creative, row };
        });
      } catch (error) {
        if (attempt < BRIEF_ATTEMPTS) continue;
        errors.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    }
  });
  return { creatives: perGroup.flat(), errors };
}

/**
 * Generates one creative per (pair, variant). A pair whose creatives all gated out
 * gets one more try, so a recipe isn't dropped from the sim by one bad draw; the
 * retry's creatives are kept only when they rank.
 */
export async function generateCreatives(params: GenerateParams): Promise<GenerateResult> {
  const first = await generatePass(params);
  const byPair = new Map<string, WrittenCreative[]>();
  for (const creative of first.creatives) {
    const key = pairKey({ recipe: { arm_id: creative.row.arm_id }, segmentId: creative.row.segment_id });
    byPair.set(key, [...(byPair.get(key) ?? []), creative]);
  }
  const gated = params.pairs.filter((pair) => (byPair.get(pairKey(pair)) ?? []).every((c) => c.status === 'gated_out') && byPair.has(pairKey(pair)));
  if (gated.length === 0) return first;
  const second = await generatePass({ ...params, pairs: gated });
  const retried = new Map<string, WrittenCreative[]>();
  for (const creative of second.creatives) {
    const key = pairKey({ recipe: { arm_id: creative.row.arm_id }, segmentId: creative.row.segment_id });
    retried.set(key, [...(retried.get(key) ?? []), creative]);
  }
  for (const [key, creatives] of retried) if (creatives.some((c) => c.status === 'ranked')) byPair.set(key, creatives);
  return { creatives: [...byPair.values()].flat(), errors: [...first.errors, ...second.errors] };
}

/** All rows in one upsert_creatives call: one transaction, so a batch lands whole or not at all. */
export async function writeCreatives(spacetime: Spacetime, rows: CreativeRow[]): Promise<void> {
  if (rows.length > 0) await spacetime.call('upsert_creatives', [rows]);
}

export const skipLine = (skip: Skip) => `skip ${skip.arm_id} hook=${skip.hook} ${skip.segment_id}: missing ${skip.missing}`;

const counts = (creatives: Array<{ status: string }>) => ({
  ranked: creatives.filter((creative) => creative.status === 'ranked').length,
  gatedOut: creatives.filter((creative) => creative.status === 'gated_out').length,
});

// ── Round 0 ─────────────────────────────────────────────────────────────────

export interface RoundZeroStatus {
  /** True when B can queue round 0: A4's rows pass, every pair has its creative and every recipe has a ranked one. */
  complete: boolean;
  /** Why not, when not. */
  problems: string[];
  expected: number;
  ranked: string[];
  gatedOut: string[];
  missing: string[];
  /** Recipes with no ranked round-0 creative: B's sim would drop them. */
  recipesWithoutRanked: string[];
}

/** Round 0's ids for the planned pairs (variant 1, shared by every run). */
const roundZeroId = (pair: Pair) => generatedCreativeId(0, '', pair.recipe.arm_id, pair.segmentId, 1);

export function roundZeroStatusOf(tables: A4Tables, rows: BrandContextRow[]): RoundZeroStatus {
  const check = checkA4Rows(tables, rows);
  const { pairs } = planPairs(check.recipes, check.segments.map((segment) => segment.segment_id), rows);
  const status = new Map(tables.creatives.filter((c) => c.origin === 'generated').map((c) => [c.creative_id, c.status]));
  const ranked: string[] = [];
  const gatedOut: string[] = [];
  const missing: string[] = [];
  const rankedArms = new Set<string>();
  for (const pair of pairs) {
    const id = roundZeroId(pair);
    const state = status.get(id);
    if (state === 'ranked') {
      ranked.push(id);
      rankedArms.add(pair.recipe.arm_id);
    } else if (state === 'gated_out') gatedOut.push(id);
    else missing.push(id);
  }
  const recipesWithoutRanked = check.recipes.map((recipe) => recipe.arm_id).filter((armId) => !rankedArms.has(armId));
  const problems = [
    ...check.failures.map((failure) => `A4's rows: ${failure}`),
    ...(missing.length ? [`${missing.length} round-0 creative(s) not written: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}`] : []),
    ...(recipesWithoutRanked.length ? [`recipes with no ranked round-0 creative: ${recipesWithoutRanked.join(', ')}`] : []),
  ];
  return { complete: problems.length === 0, problems, expected: pairs.length, ranked, gatedOut, missing, recipesWithoutRanked };
}

export async function roundZeroStatus(deps: RunDeps = {}): Promise<RoundZeroStatus> {
  const spacetime = deps.spacetime ?? (await connectSpacetime());
  const client = deps.client ?? (await loadClientRows(deps.db ?? serviceSupabase()));
  return roundZeroStatusOf(await readA4Tables(spacetime), client.rows);
}

export interface RoundZeroOptions extends RunDeps {
  /** Regenerate every pair, not only the missing and gated-out ones. */
  regenerate?: boolean;
  /** Write even though B has started a run (its round 0 then reads different copy than it simulated). */
  force?: boolean;
}

export interface RoundZeroReport {
  expected: number;
  /** Ranked round-0 creatives already in SpacetimeDB, left as they are. */
  kept: number;
  written: number;
  ranked: number;
  gatedOut: number;
  skips: Skip[];
  errors: string[];
  creatives: WrittenCreative[];
  status: RoundZeroStatus;
}

/**
 * Round 0: one creative per (recipe, segment), round_created 0, on A4's rows.
 * Writes only what's missing or gated out (`regenerate` for all), in one
 * transaction, and refuses once B has started a run unless forced: B has then
 * simulated the copy. Throws NotReadyError while the check fails. Doesn't queue
 * round 0's run_round or create the run; A6's Strategist or B does, once
 * roundZeroStatus is complete.
 */
export async function runRound0(opts: RoundZeroOptions = {}): Promise<RoundZeroReport> {
  const log = opts.log ?? console.log;
  const spacetime = opts.spacetime ?? (await connectSpacetime());
  const client = opts.client ?? (await loadClientRows(opts.db ?? serviceSupabase()));
  const inputs = await spacetimeInputs(spacetime, client.rows);
  for (const warning of inputs.warnings) log(`warning: ${warning}`);
  // Checked before generating and again before writing: generation takes minutes, and B may queue round 0 meanwhile.
  const refuseOnceStarted = async () => {
    if (opts.force) return;
    const [runs, runTasks] = await Promise.all([
      spacetime.sql<{ run_id: string }>('SELECT * FROM run'),
      spacetime.sql<{ task_id: string }>("SELECT * FROM task WHERE kind = 'run_round'"),
    ]);
    if (runs.length > 0 || runTasks.length > 0) {
      const started = [...runs.map((run) => run.run_id), ...runTasks.map((task) => task.task_id)].join(', ');
      throw new Error(`B has started (${started}): round 0 is what it simulated, so it isn't rewritten. Pass --force to rewrite it anyway`);
    }
  };
  await refuseOnceStarted();

  const segmentIds = inputs.segments.map((segment) => segment.segment_id);
  const { pairs, skips } = planPairs(inputs.recipes, segmentIds, client.rows);
  for (const skip of skips) log(skipLine(skip));
  const existing = new Map(
    (await spacetime.sql<CreativeRow>("SELECT * FROM creative WHERE origin = 'generated'"))
      .filter((row) => row.round_created === 0)
      .map((row) => [row.creative_id, row.status]),
  );
  const todo = opts.regenerate ? pairs : pairs.filter((pair) => existing.get(roundZeroId(pair)) !== 'ranked');
  const kept = pairs.length - todo.length;
  log(
    `round 0: ${pairs.length} creatives planned (${inputs.recipes.length} recipes × ${segmentIds.length} segments − ${skips.length} skips); ` +
      `${kept} already ranked, writing ${todo.length}`,
  );

  const { creatives, errors } = await generateCreatives({
    inputs,
    rows: client.rows,
    brandProfileId: client.brandProfileId,
    pairs: todo,
    roundCreated: 0,
    runId: '',
    variants: 1,
  });
  // --regenerate never replaces a ranked creative with one that gated out: B would drop the pair.
  const rows = creatives.map((creative) => creative.row).filter((row) => row.status === 'ranked' || existing.get(row.creative_id) !== 'ranked');
  await refuseOnceStarted();
  await writeCreatives(spacetime, rows);
  const status = roundZeroStatusOf(await readA4Tables(spacetime), client.rows);
  return { expected: pairs.length, kept, written: rows.length, ...counts(creatives), skips, errors, creatives, status };
}

// ── The task board ──────────────────────────────────────────────────────────

interface TaskRow {
  task_id: string;
  run_id: string;
  kind: string;
  payload: string;
  status: string;
  claimed_by: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
}

/** The generate_creatives payload B's bandit queues (docs/PLAN.md "The contract"). */
export interface GenerationPayload {
  run_id: string;
  round: number;
  arms: Array<{ arm_id: string; segment_ids: string[] }>;
  n_per_arm: number;
  learning_ids: string[];
}

/** Another worker or the Copywriter holds the task. */
export class ClaimLostError extends Error {
  constructor(taskId: string, reason: string) {
    super(`task ${taskId} was claimed elsewhere: ${reason}`);
    this.name = 'ClaimLostError';
  }
}

export interface TaskResult {
  round_created: number;
  written: number;
  /** Creatives a resumed task found already written and kept. */
  reused: number;
  ranked: number;
  gated_out: number;
  creative_ids: string[];
  skips: Skip[];
  errors: string[];
  next_task: string | null;
}

const isUint = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

export function parseGenerationPayload(raw: string): GenerationPayload {
  const payload = JSON.parse(raw) as Partial<GenerationPayload>;
  const ok =
    typeof payload.run_id === 'string' &&
    payload.run_id.length > 0 &&
    isUint(payload.round) &&
    isUint(payload.n_per_arm) &&
    isStrings(payload.learning_ids) &&
    Array.isArray(payload.arms) &&
    payload.arms.every((arm) => typeof arm?.arm_id === 'string' && isStrings(arm.segment_ids));
  if (!ok) throw new Error(`generate_creatives payload is malformed: ${raw.slice(0, 300)}`);
  return payload as GenerationPayload;
}

export async function readTask(spacetime: Spacetime, taskId: string): Promise<TaskRow | undefined> {
  return (await spacetime.sql<TaskRow>(`SELECT * FROM task WHERE task_id = ${sqlString(taskId)}`))[0];
}

interface LearningRow {
  learning_id: string;
  segment_id: string;
  arm_id: string | null;
  directive: string;
}

/**
 * The payload's learnings as notes: a learning applies to its segment's
 * creatives, and to one arm's when it names one. Only directives reach the
 * copywriter, and one that still holds a digit is dropped and logged.
 */
async function notesFromLearnings(spacetime: Spacetime, payload: GenerationPayload, log: (line: string) => void): Promise<NotesFor> {
  const wanted = new Set(payload.learning_ids);
  const rows = await spacetime.sql<LearningRow>(`SELECT * FROM learning WHERE run_id = ${sqlString(payload.run_id)}`);
  const learnings = rows.filter((row) => wanted.has(row.learning_id));
  for (const id of wanted) if (!learnings.some((row) => row.learning_id === id)) log(`warning: learning ${id} not found`);
  const usable = learnings.filter((row) => {
    if (!/\p{Nd}/u.test(row.directive) && row.directive.trim().length > 0) return true;
    log(`warning: learning ${row.learning_id} dropped: its directive is empty or has a number`);
    return false;
  });
  return (armId, segmentId) => {
    const applies = usable
      .filter((row) => row.segment_id === segmentId && (!row.arm_id || row.arm_id === armId))
      .sort((a, b) => (a.learning_id < b.learning_id ? -1 : 1));
    return { notes: applies.map((row) => row.directive), learningIds: applies.map((row) => row.learning_id) };
  };
}

export interface TaskOptions extends RunDeps {
  claimedBy?: string;
  /** Run a task someone else claimed and abandoned (the loop's stale-claim rule). */
  takeover?: boolean;
  /** 'skip' writes the creatives without queuing the next run_round (for an agent that ends the run). */
  nextRound?: 'queue' | 'skip';
}

/**
 * Turns one generate_creatives task into creative rows, queues the next
 * run_round and completes the task. Called by the worker loop and by A6's
 * Copywriter (app/api/agent/creatives), each under its own `claimedBy`.
 *
 * A queued task is claimed here; one this caller already holds is resumed; a done
 * task returns its stored result. Creatives already written for the task's ids are
 * kept, never regenerated, so copy B may have read stays as it was. Errors
 * propagate with the task still claimed: the caller retries or calls `failTask`.
 */
export async function runGenerateCreatives(taskId: string, opts: TaskOptions = {}): Promise<TaskResult> {
  const claimedBy = opts.claimedBy ?? CREATIVE_WORKER;
  const log = opts.log ?? ((line: string) => console.log(`[creatives ${taskId}] ${line}`));
  const spacetime = opts.spacetime ?? (await connectSpacetime());

  const task = await readTask(spacetime, taskId);
  if (!task) throw new Error(`task ${taskId} not found`);
  if (task.kind !== 'generate_creatives') throw new Error(`task ${taskId} is ${task.kind}, not generate_creatives`);
  if (task.status === 'done') return JSON.parse(task.result ?? '{}') as TaskResult;
  if (task.status === 'failed') throw new Error(`task ${taskId} already failed: ${task.result ?? ''}`);
  if (task.status === 'queued') {
    try {
      await spacetime.call('claim_task', [taskId, claimedBy]);
    } catch (error) {
      if (error instanceof SpacetimeError) throw new ClaimLostError(taskId, error.message);
      throw error;
    }
  } else if (task.claimed_by !== claimedBy) {
    if (!opts.takeover) throw new ClaimLostError(taskId, `held by ${task.claimed_by}`);
    log(`taking over from ${task.claimed_by} (claimed, untouched since ${task.updated_at})`);
  }

  const payload = parseGenerationPayload(task.payload);
  const roundCreated = payload.round + 1;
  const client = opts.client ?? (await loadClientRows(opts.db ?? serviceSupabase()));
  const inputs = await spacetimeInputs(spacetime, client.rows);
  const run = (await spacetime.sql<{ rounds_planned: number }>(`SELECT * FROM run WHERE run_id = ${sqlString(payload.run_id)}`))[0];
  if (!run) throw new Error(`run ${payload.run_id} not found`);
  const notesFor = await notesFromLearnings(spacetime, payload, log);

  // The payload names (arm, segments); unknown ids are logged skips like any unproducible pair.
  const recipes = new Map(inputs.recipes.map((recipe) => [recipe.arm_id, recipe]));
  const segments = new Set(inputs.segments.map((segment) => segment.segment_id));
  const pairs: Pair[] = [];
  const skips: Skip[] = [];
  for (const arm of payload.arms) {
    const recipe = recipes.get(arm.arm_id);
    for (const segmentId of arm.segment_ids) {
      if (!recipe || !segments.has(segmentId)) {
        skips.push({
          arm_id: arm.arm_id,
          hook: recipe?.hook ?? '',
          segment_id: segmentId,
          missing: !recipe ? (arm.arm_id === inputs.controlArmId ? 'control_arm' : 'unknown_arm') : 'unknown_segment',
        });
        continue;
      }
      const planned = planPairs([recipe], [segmentId], client.rows);
      pairs.push(...planned.pairs);
      skips.push(...planned.skips);
    }
  }
  for (const skip of skips) log(skipLine(skip));

  // A resumed task keeps the ranked creatives it already wrote (B may have read them); a gated-out one
  // was never shown, so it is regenerated.
  const ids = (pair: Pair) =>
    Array.from({ length: payload.n_per_arm }, (_, i) => generatedCreativeId(roundCreated, payload.run_id, pair.recipe.arm_id, pair.segmentId, i + 1));
  const written = new Map(
    (await spacetime.sql<CreativeRow>("SELECT * FROM creative WHERE origin = 'generated'"))
      .filter((row) => row.round_created === roundCreated && row.status === 'ranked')
      .map((row) => [row.creative_id, row]),
  );
  const reused = pairs.flatMap(ids).flatMap((id) => (written.has(id) ? [written.get(id)!] : []));
  const todo = pairs.filter((pair) => ids(pair).some((id) => !written.has(id)));

  const { creatives, errors } = await generateCreatives({
    inputs,
    rows: client.rows,
    brandProfileId: client.brandProfileId,
    pairs: todo,
    roundCreated,
    runId: payload.run_id,
    variants: payload.n_per_arm,
    notesFor,
  });
  for (const error of errors) log(`error: ${error}`);
  // The copywriter itself was unreachable (every call failed, or every brief threw): don't complete the task
  // with nothing to show; throw so the loop retries it once the API is back.
  const unreachable = creatives.filter((c) => c.copyError?.code === 'BRAND_COPY_GENERATION_FAILED').length;
  if (todo.length > 0 && !creatives.some((c) => c.status === 'ranked') && (creatives.length === 0 || unreachable === creatives.length)) {
    throw new Error(`copywriter unavailable: ${errors[0] ?? creatives[0]?.copyError?.reason ?? 'no creative generated'}`);
  }
  const fresh = creatives.map((creative) => creative.row).filter((row) => !written.has(row.creative_id));
  await writeCreatives(spacetime, fresh);

  let nextTask: string | null = null;
  if ((opts.nextRound ?? 'queue') === 'queue' && roundCreated <= run.rounds_planned) {
    nextTask = `tsk_run_${payload.run_id}_r${roundCreated}`;
    try {
      await spacetime.call('enqueue_task', [nextTask, 'run_round', JSON.stringify({ run_id: payload.run_id, round: roundCreated })]);
    } catch (error) {
      // enqueue_task isn't idempotent; a resumed task finds its run_round already queued.
      if (!(error instanceof SpacetimeError && /already exists/.test(error.message))) throw error;
    }
  }

  const all = [...reused, ...fresh];
  const { ranked, gatedOut } = counts(all);
  const result: TaskResult = {
    round_created: roundCreated,
    written: fresh.length,
    reused: reused.length,
    ranked,
    gated_out: gatedOut,
    creative_ids: all.map((row) => row.creative_id),
    skips,
    errors,
    next_task: nextTask,
  };
  try {
    await spacetime.call('complete_task', [taskId, JSON.stringify(result)]);
  } catch (error) {
    // Two callers raced (a takeover, or the Copywriter and the loop): the first to finish wins.
    const now = await readTask(spacetime, taskId);
    if (error instanceof SpacetimeError && now?.status === 'done') return JSON.parse(now.result ?? '{}') as TaskResult;
    throw error;
  }
  log(`done: ${ranked} ranked, ${gatedOut} gated out, ${skips.length} skipped${nextTask ? `, queued ${nextTask}` : ''}`);
  return result;
}

/**
 * Fails a task, but only while `holder` still has it claimed. B's fail_task has no
 * status check, so a late call would otherwise flip a task someone finished to failed.
 */
export async function failTask(spacetime: Spacetime, taskId: string, error: unknown, holder: string = CREATIVE_WORKER): Promise<boolean> {
  const task = await readTask(spacetime, taskId);
  if (task?.status !== 'claimed' || task.claimed_by !== holder) return false;
  const message = error instanceof Error ? error.message : String(error);
  await spacetime.call('fail_task', [taskId, message.slice(0, 2000)]);
  return true;
}
