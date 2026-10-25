import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UpstreamFact } from '@/lib/creative-engine/brand-context/ingest';
import { toRows } from '@/worker/creatives/facts';
import { CONCEPTS } from '@/lib/adlab/contract';
import { SpacetimeError, type SqlRow, type Spacetime, type SpacetimeTarget } from '@/lib/adlab/spacetime-http';

const FIXTURES = join(import.meta.dirname, '../../../../docs/reuse-export/fixtures');
export const briefFixture = JSON.parse(readFileSync(join(FIXTURES, 'creative-brief.json'), 'utf8'));

/**
 * The creative fixture's 9 brand facts, plus an unaware-style persona with no
 * verbatims (like A3's unaware projection), so testimonial has a segment to skip.
 */
export function testFacts(): UpstreamFact[] {
  return [
    ...(briefFixture.brandFacts as UpstreamFact[]),
    {
      id: '00000000-0000-4000-f000-000000000010',
      section: 'persona',
      fact_key: 'unaware-projection',
      statement: 'Convenience-First Cereal Eater: wants an easy breakfast and has not thought about protein.',
      details: {
        name: 'Convenience-First Cereal Eater',
        description: 'Wants an easy, familiar breakfast and has not thought about protein yet.',
        awarenessStage: 'unaware',
        extrapolated: true,
        pains: [{ fact_id: '00000000-0000-4000-f000-000000000008', note: 'Hungry again before lunch' }],
        desires: [],
        objections: [],
        verbatims: [],
      },
      confidence: 0.5,
      status: 'candidate',
    },
  ];
}

export const testRows = () => toRows(testFacts());

export const SEG_TRACKER = 'seg_the_macro_tracker';
export const SEG_UNAWARE = 'seg_unaware_projection';

type ChatBody = { model: string; messages: Array<{ role: string; content: string }> };

/** Replaces global fetch with an OpenAI chat mock for the test's duration; returns the recorded request bodies. */
export function mockChat(reply: (body: ChatBody, index: number) => Record<string, unknown>): {
  calls: ChatBody[];
  restore: () => void;
} {
  const realFetch = globalThis.fetch;
  const hadKey = 'OPENAI_API_KEY' in process.env;
  process.env.OPENAI_API_KEY ??= 'test';
  const calls: ChatBody[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).endsWith('/chat/completions')) throw new Error(`unexpected fetch ${String(url)}`);
    const body = JSON.parse(String(init?.body)) as ChatBody;
    calls.push(body);
    const content = JSON.stringify(reply(body, calls.length - 1));
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = realFetch;
      if (!hadKey) delete process.env.OPENAI_API_KEY;
    },
  };
}

export const CLEAN_COPY = {
  headline: 'Oat clusters that keep you full until lunch',
  primaryText: 'Baked in small batches with whole rolled oats, so breakfast holds you all morning.',
  cta: 'Shop Now',
  visualConcept: 'A bowl of oat clusters with milk on a sunny kitchen counter.',
};

/** Upserts rows into a fake table by their key column. */
function upsertBy(table: SqlRow[], key: string, rows: SqlRow[]): void {
  for (const row of rows) {
    const existing = table.findIndex((old) => old[key] === row[key]);
    if (existing >= 0) table[existing] = { ...row };
    else table.push({ ...row });
  }
}

// One condition of `WHERE a = 'x' AND b = 1`: a quoted string, a number or a boolean.
const CONDITION = /^(\w+) = ('(?:[^']|'')*'|-?\d+(?:\.\d+)?|true|false)$/;

function literal(text: string): unknown {
  if (text.startsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  if (text === 'true' || text === 'false') return text === 'true';
  return Number(text);
}

/**
 * An in-memory SpacetimeDB for A's and B's tables: `SELECT * FROM t [WHERE a = 'x' AND b = 1]`,
 * plus the task reducers, A's upserts, upsert_products and upsert_run, with the published rules
 * that matter here.
 */
export class FakeStdb implements Spacetime {
  readonly label: string;
  readonly target?: SpacetimeTarget;
  tables: Record<string, SqlRow[]> = {};
  reducerCalls: Array<{ reducer: string; args: unknown[] }> = [];

  constructor(tables: Record<string, SqlRow[]>, opts: { target?: SpacetimeTarget } = {}) {
    for (const [name, rows] of Object.entries(tables)) this.tables[name] = rows.map((row) => ({ ...row }));
    this.target = opts.target;
    this.label = opts.target?.label ?? 'fake / adlab-test (LOCAL)';
  }

  async sql<T = SqlRow>(query: string): Promise<T[]> {
    const match = /^SELECT \* FROM (\w+)(?: WHERE (.+))?$/.exec(query.trim());
    if (!match) throw new Error(`FakeStdb can't run: ${query}`);
    const [, table, where] = match;
    const conditions = (where ? where.split(/ AND /) : []).map((part) => {
      const condition = CONDITION.exec(part.trim());
      if (!condition) throw new Error(`FakeStdb can't run: ${query}`);
      return [condition[1], literal(condition[2])] as const;
    });
    const rows = this.tables[table] ?? [];
    return rows.filter((row) => conditions.every(([column, value]) => row[column] === value)).map((row) => ({ ...row }) as T);
  }

  private task(taskId: string): SqlRow {
    const task = (this.tables.task ?? []).find((row) => row.task_id === taskId);
    if (!task) throw new SpacetimeError(`task ${taskId} not found`, 530);
    return task;
  }

  async call(reducer: string, args: unknown[]): Promise<void> {
    this.reducerCalls.push({ reducer, args });
    const now = new Date().toISOString();
    switch (reducer) {
      case 'claim_task': {
        const [taskId, claimedBy] = args as [string, string];
        const task = this.task(taskId);
        if (task.status !== 'queued') throw new SpacetimeError(`task ${taskId} is ${String(task.status)}`, 530);
        Object.assign(task, { status: 'claimed', claimed_by: claimedBy, updated_at: now });
        return;
      }
      case 'complete_task': {
        const [taskId, result] = args as [string, string];
        const task = this.task(taskId);
        if (task.status !== 'claimed') throw new SpacetimeError(`task ${taskId} is ${String(task.status)}, not claimed`, 530);
        Object.assign(task, { status: 'done', result, updated_at: now });
        return;
      }
      case 'fail_task': {
        const [taskId, error] = args as [string, string];
        Object.assign(this.task(taskId), { status: 'failed', result: JSON.stringify({ error }), updated_at: now });
        return;
      }
      case 'enqueue_task': {
        const [taskId, kind, payload] = args as [string, string, string];
        this.tables.task ??= [];
        if (this.tables.task.some((row) => row.task_id === taskId)) throw new SpacetimeError(`task ${taskId} already exists`, 530);
        const runId = (JSON.parse(payload) as { run_id: string }).run_id;
        this.tables.task.push({ task_id: taskId, run_id: runId, kind, payload, status: 'queued', claimed_by: null, result: null, created_at: now, updated_at: now });
        return;
      }
      case 'upsert_creatives': {
        const [rows] = args as [SqlRow[]];
        this.tables.creative ??= [];
        for (const row of rows) {
          // Like checkCreative (spacetime/src/reducers_a.ts): "" means no segment or no arm.
          for (const [field, ok] of [
            ['brand', this.tables.brand?.some((brand) => brand.brand_id === row.brand_id)],
            ['segment', row.segment_id === '' || this.tables.segment?.some((segment) => segment.segment_id === row.segment_id)],
            ['arm', row.arm_id === '' || this.tables.arm?.some((arm) => arm.arm_id === row.arm_id)],
          ] as const) {
            if (!ok) throw new SpacetimeError(`creative ${String(row.creative_id)}: unknown ${field}`, 530);
          }
          upsertBy(this.tables.creative, 'creative_id', [row]);
        }
        return;
      }
      case 'upsert_brands':
      case 'upsert_concepts':
      case 'upsert_segments':
      case 'upsert_arms': {
        const table = reducer.slice('upsert_'.length, -1);
        const [rows] = args as [SqlRow[]];
        upsertBy((this.tables[table] ??= []), `${table}_id`, rows);
        return;
      }
      case 'upsert_products': {
        const [rowsJson] = args as [string];
        upsertBy((this.tables.product ??= []), 'product_id', JSON.parse(rowsJson) as SqlRow[]);
        return;
      }
      case 'upsert_run': {
        const [rowJson] = args as [string];
        const row = JSON.parse(rowJson) as SqlRow;
        const old = (this.tables.run ??= []).find((run) => run.run_id === row.run_id);
        upsertBy(this.tables.run, 'run_id', [{ ...row, created_at: old?.created_at ?? now }]);
        return;
      }
      default:
        throw new SpacetimeError(`FakeStdb has no reducer ${reducer}`, 530);
    }
  }
}

const RECIPES: Array<[string, string, string]> = [
  ['health_nutrition', 'statistic', 'steal'],
  ['health_nutrition', 'social_proof', 'steal'],
  ['health_nutrition', 'bold_claim', 'steal'],
  ['taste_indulgence', 'testimonial', 'gap'],
  ['taste_indulgence', 'question', 'steal'],
  ['convenience', 'problem_callout', 'double_down'],
  ['convenience', 'pov_relatable', 'double_down'],
  ['natural_clean', 'curiosity', 'gap'],
  ['dietary_fit', 'question', 'gap'],
  ['price_value', 'bold_claim', 'steal'],
];

const WEIGHTS = JSON.stringify(Object.fromEntries(CONCEPTS.map((concept) => [concept.key, 0.5])));
const QUOTES = JSON.stringify(['I want my protein in the morning.', 'Other cereals leave me hungry by ten.']);

const liveAd = (creative_id: string, brand_id: string, extra: SqlRow): SqlRow => ({
  creative_id,
  brand_id,
  headline: 'Oat clusters that keep you full',
  primary_text: 'Baked in small batches with whole rolled oats.',
  cta: 'Shop Now',
  visual_description: 'A bowl of oat clusters on a kitchen counter.',
  image_url: '',
  days_running: 30,
  round_created: 0,
  learning_ids: '[]',
  segment_id: '',
  pack_fingerprint: '',
  status: 'ranked',
  ...extra,
});

/** A4's rows as they'll land: one client, two segments, 10 recipes plus the control, live ads, B's product. */
export function a4Tables(): Record<string, SqlRow[]> {
  return {
    brand: [
      { brand_id: 'br_halden_oat_co', name: 'Halden Oat Co.', is_client: true },
      { brand_id: 'br_rival_crunch', name: 'Rival Crunch', is_client: false },
    ],
    concept: CONCEPTS.map((concept) => ({ concept_id: `cpt_${concept.key}`, ...concept })),
    segment: [
      { segment_id: SEG_TRACKER, name: 'The Macro Tracker', description: 'Trains before work most weekdays.', share: 0.7, prior_weights: WEIGHTS, quotes: QUOTES },
      { segment_id: SEG_UNAWARE, name: 'Convenience-First Cereal Eater', description: 'Eats breakfast at home before work.', share: 0.3, prior_weights: WEIGHTS, quotes: QUOTES },
    ],
    arm: [
      ...RECIPES.map(([angle, hook, strategy]) => ({
        arm_id: `arm_${angle}_${hook}`,
        angle,
        hook,
        strategy,
        rationale: 'test recipe',
        evidence: '[]',
      })),
      { arm_id: 'arm_control', angle: '', hook: '', strategy: 'control', rationale: 'live ads', evidence: '[]' },
    ],
    creative: [
      liveAd('cr_live_halden_1', 'br_halden_oat_co', { arm_id: 'arm_control', origin: 'brand_live', landing_product_id: 'prd_halden_box' }),
      liveAd('cr_live_rival_1', 'br_rival_crunch', { arm_id: '', origin: 'competitor_live', landing_product_id: '' }),
    ],
    product: [{ product_id: 'prd_halden_box', brand_id: 'br_halden_oat_co', name: 'Halden Oat Clusters' }],
  };
}
