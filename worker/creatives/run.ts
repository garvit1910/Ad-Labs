import type { SupabaseClient } from '@supabase/supabase-js';
import { ADLAB_ORG_ID } from '@/lib/adlab/org';
import { serviceSupabase } from '@/lib/adlab/supabase';
import type { BrandContextRow } from '@/lib/creative-engine/brand-context/types';
import { generateBrief } from './brief';
import { keyMessageFor, loadClientRows, personaAudience, valuePropositions, type ClientRows } from './facts';
import { spacetimeInputs, type CreativeInputs } from './inputs';
import { derivePackHints, segmentRows } from './pack-hints';
import { planPairs } from './pairs';
import { connectStdb, sqlString, StdbError, type Stdb } from './spacetime';
import type { CreativeRow, GeneratedCreative, Pair, Recipe, Skip } from './types';

/** Who the worker loop claims tasks as. Stable across restarts, so a restarted worker resumes its own claims. */
export const CREATIVE_WORKER = 'creative_worker';

const BRIEF_CONCURRENCY = 6;
const WRITE_CHUNK = 20;
const CREATIVE_ID = /^cr_[a-z0-9_]+$/;

export interface RunDeps {
  stdb?: Stdb;
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
  /** Briefs that threw (one line each); the rest still write. */
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

/** `cr_g<round_created>_<arm minus arm_>_<segment minus seg_>_<variant>`: a rerun updates rows instead of adding them. */
export function creativeId(roundCreated: number, armId: string, segmentId: string, variant: number): string {
  const id = `cr_g${roundCreated}_${armId.slice('arm_'.length)}_${segmentId.slice('seg_'.length)}_${variant}`;
  if (!CREATIVE_ID.test(id)) throw new Error(`creative id "${id}" is not lowercase letters, digits and _`);
  return id;
}

/**
 * Generates one creative per (pair, variant). Pairs are grouped by (segment,
 * angle): each group is one brief, and each recipe's hook one copy variant.
 */
export async function generateCreatives(params: {
  inputs: CreativeInputs;
  rows: BrandContextRow[];
  brandProfileId: string;
  pairs: Pair[];
  roundCreated: number;
  variants: number;
  notesFor?: NotesFor;
}): Promise<GenerateResult> {
  const { inputs, rows, roundCreated, variants, notesFor } = params;
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
        return {
          ...creative,
          row: {
            creative_id: creativeId(roundCreated, armId, segmentId, creative.variant),
            arm_id: armId,
            brand_id: inputs.brand.brand_id,
            origin: 'generated',
            headline: creative.headline,
            primary_text: creative.primaryText,
            cta: creative.cta,
            visual_description: creative.visualDescription,
            image_url: '',
            landing_product_id: inputs.landingProductId,
            days_running: 0,
            round_created: roundCreated,
            learning_ids: JSON.stringify(notes(creative.arm.hookArchetype).learningIds),
            segment_id: segmentId,
            pack_fingerprint: creative.packFingerprint,
            status: creative.status,
          },
        };
      });
    } catch (error) {
      errors.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  });
  return { creatives: perGroup.flat(), errors };
}

/** One upsert_creatives call per chunk; each call is one transaction on the database side. */
export async function writeCreatives(stdb: Stdb, rows: CreativeRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    await stdb.call('upsert_creatives', [rows.slice(i, i + WRITE_CHUNK)]);
  }
}

export const skipLine = (skip: Skip) => `skip ${skip.arm_id} hook=${skip.hook} ${skip.segment_id}: missing ${skip.missing}`;

export interface RoundZeroReport {
  expected: number;
  written: number;
  ranked: number;
  gatedOut: number;
  skips: Skip[];
  errors: string[];
  creatives: WrittenCreative[];
}

const counts = (creatives: WrittenCreative[]) => ({
  written: creatives.length,
  ranked: creatives.filter((creative) => creative.status === 'ranked').length,
  gatedOut: creatives.filter((creative) => creative.status === 'gated_out').length,
});

/**
 * Round 0: one creative per (recipe, segment), round_created 0, on A4's rows.
 * Throws NotReadyError while the check fails. Doesn't queue round 0's
 * run_round or create the run; A6's Strategist or B does.
 */
export async function runRound0(deps: RunDeps = {}): Promise<RoundZeroReport> {
  const log = deps.log ?? console.log;
  const stdb = deps.stdb ?? (await connectStdb());
  const client = deps.client ?? (await loadClientRows(deps.db ?? serviceSupabase()));
  const inputs = await spacetimeInputs(stdb, client.rows);
  for (const warning of inputs.warnings) log(`warning: ${warning}`);
  const segmentIds = inputs.segments.map((segment) => segment.segment_id);
  const { pairs, skips } = planPairs(inputs.recipes, segmentIds, client.rows);
  for (const skip of skips) log(skipLine(skip));
  const expected = inputs.recipes.length * segmentIds.length - skips.length;
  log(`round 0: ${pairs.length} creatives to write (${inputs.recipes.length} recipes × ${segmentIds.length} segments − ${skips.length} skips)`);

  const { creatives, errors } = await generateCreatives({
    inputs,
    rows: client.rows,
    brandProfileId: client.brandProfileId,
    pairs,
    roundCreated: 0,
    variants: 1,
  });
  await writeCreatives(stdb, creatives.map((creative) => creative.row));
  return { expected, ...counts(creatives), skips, errors, creatives };
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
}

/** The generate_creatives payload B's bandit queues (docs/PLAN.md "The contract"). */
export interface GenerationPayload {
  run_id: string;
  round: number;
  arms: Array<{ arm_id: string; segment_ids: string[] }>;
  n_per_arm: number;
  learning_ids: string[];
}

/** Another worker or the Copywriter claimed the task first. */
export class ClaimLostError extends Error {
  constructor(taskId: string, reason: string) {
    super(`task ${taskId} was claimed elsewhere: ${reason}`);
    this.name = 'ClaimLostError';
  }
}

export interface TaskResult {
  round_created: number;
  written: number;
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

export async function readTask(stdb: Stdb, taskId: string): Promise<TaskRow | undefined> {
  return (await stdb.sql(`SELECT * FROM task WHERE task_id = ${sqlString(taskId)}`))[0] as unknown as TaskRow | undefined;
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
async function notesFromLearnings(stdb: Stdb, payload: GenerationPayload, log: (line: string) => void): Promise<NotesFor> {
  const wanted = new Set(payload.learning_ids);
  const rows = (await stdb.sql(`SELECT * FROM learning WHERE run_id = ${sqlString(payload.run_id)}`)) as unknown as LearningRow[];
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

/**
 * Turns one generate_creatives task into creative rows, queues the next
 * run_round and completes the task. Called by the worker loop and by A6's
 * Copywriter (app/api/agent/creatives), each under its own `claimedBy`.
 *
 * A queued task is claimed here; one this caller already holds is resumed
 * (its creative ids are deterministic, so a rerun overwrites); a done task
 * returns its stored result. Errors propagate with the task still claimed:
 * the caller retries or calls `failTask`.
 */
export async function runGenerateCreatives(
  taskId: string,
  opts: RunDeps & { claimedBy?: string } = {},
): Promise<TaskResult> {
  const claimedBy = opts.claimedBy ?? CREATIVE_WORKER;
  const log = opts.log ?? ((line: string) => console.log(`[creatives ${taskId}] ${line}`));
  const stdb = opts.stdb ?? (await connectStdb());

  const task = await readTask(stdb, taskId);
  if (!task) throw new Error(`task ${taskId} not found`);
  if (task.kind !== 'generate_creatives') throw new Error(`task ${taskId} is ${task.kind}, not generate_creatives`);
  if (task.status === 'done') return JSON.parse(task.result ?? '{}') as TaskResult;
  if (task.status === 'failed') throw new Error(`task ${taskId} already failed: ${task.result ?? ''}`);
  if (task.status === 'queued') {
    try {
      await stdb.call('claim_task', [taskId, claimedBy]);
    } catch (error) {
      if (error instanceof StdbError) throw new ClaimLostError(taskId, error.message);
      throw error;
    }
  } else if (task.claimed_by !== claimedBy) {
    throw new ClaimLostError(taskId, `held by ${task.claimed_by}`);
  }

  const payload = parseGenerationPayload(task.payload);
  const roundCreated = payload.round + 1;
  const client = opts.client ?? (await loadClientRows(opts.db ?? serviceSupabase()));
  const inputs = await spacetimeInputs(stdb, client.rows);
  const run = (await stdb.sql(`SELECT * FROM run WHERE run_id = ${sqlString(payload.run_id)}`))[0] as
    | { rounds_planned: number }
    | undefined;
  if (!run) throw new Error(`run ${payload.run_id} not found`);
  const notesFor = await notesFromLearnings(stdb, payload, log);

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

  const { creatives, errors } = await generateCreatives({
    inputs,
    rows: client.rows,
    brandProfileId: client.brandProfileId,
    pairs,
    roundCreated,
    variants: payload.n_per_arm,
    notesFor,
  });
  for (const error of errors) log(`error: ${error}`);
  await writeCreatives(stdb, creatives.map((creative) => creative.row));

  let nextTask: string | null = null;
  if (roundCreated <= run.rounds_planned) {
    nextTask = `tsk_run_${payload.run_id}_r${roundCreated}`;
    try {
      await stdb.call('enqueue_task', [nextTask, 'run_round', JSON.stringify({ run_id: payload.run_id, round: roundCreated })]);
    } catch (error) {
      // enqueue_task isn't idempotent; a resumed task finds its run_round already queued.
      if (!(error instanceof StdbError && /already exists/.test(error.message))) throw error;
    }
  }

  const { written, ranked, gatedOut } = counts(creatives);
  const result: TaskResult = {
    round_created: roundCreated,
    written,
    ranked,
    gated_out: gatedOut,
    creative_ids: creatives.map((creative) => creative.row.creative_id),
    skips,
    errors,
    next_task: nextTask,
  };
  await stdb.call('complete_task', [taskId, JSON.stringify(result)]);
  log(`done: ${ranked} ranked, ${gatedOut} gated out, ${skips.length} skipped${nextTask ? `, queued ${nextTask}` : ''}`);
  return result;
}

export async function failTask(stdb: Stdb, taskId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await stdb.call('fail_task', [taskId, message.slice(0, 2000)]);
}
