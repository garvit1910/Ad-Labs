import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UpstreamFact } from '@/lib/creative-engine/brand-context/ingest';
import { toRows } from '@/worker/creatives/facts';
import type { SqlRow, Stdb } from '@/worker/creatives/spacetime';
import { StdbError } from '@/worker/creatives/spacetime';

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

/**
 * An in-memory SpacetimeDB for A's and B's tables: `SELECT * FROM t [WHERE col = 'v']`,
 * plus the task reducers and upsert_creatives with the published rules that matter here.
 */
export class FakeStdb implements Stdb {
  tables: Record<string, SqlRow[]> = {};
  reducerCalls: Array<{ reducer: string; args: unknown[] }> = [];

  constructor(tables: Record<string, SqlRow[]>) {
    for (const [name, rows] of Object.entries(tables)) this.tables[name] = rows.map((row) => ({ ...row }));
  }

  async sql(query: string): Promise<SqlRow[]> {
    const match = /^SELECT \* FROM (\w+)(?: WHERE (\w+) = '((?:[^']|'')*)')?$/.exec(query.trim());
    if (!match) throw new Error(`FakeStdb can't run: ${query}`);
    const [, table, column, value] = match;
    const rows = this.tables[table] ?? [];
    return rows.filter((row) => !column || row[column] === value.replaceAll("''", "'")).map((row) => ({ ...row }));
  }

  private task(taskId: string): SqlRow {
    const task = (this.tables.task ?? []).find((row) => row.task_id === taskId);
    if (!task) throw new StdbError(`task ${taskId} not found`, 530);
    return task;
  }

  async call(reducer: string, args: unknown[]): Promise<void> {
    this.reducerCalls.push({ reducer, args });
    const now = new Date().toISOString();
    switch (reducer) {
      case 'claim_task': {
        const [taskId, claimedBy] = args as [string, string];
        const task = this.task(taskId);
        if (task.status !== 'queued') throw new StdbError(`task ${taskId} is ${String(task.status)}`, 530);
        Object.assign(task, { status: 'claimed', claimed_by: claimedBy, updated_at: now });
        return;
      }
      case 'complete_task': {
        const [taskId, result] = args as [string, string];
        const task = this.task(taskId);
        if (task.status !== 'claimed') throw new StdbError(`task ${taskId} is ${String(task.status)}, not claimed`, 530);
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
        if (this.tables.task.some((row) => row.task_id === taskId)) throw new StdbError(`task ${taskId} already exists`, 530);
        const runId = (JSON.parse(payload) as { run_id: string }).run_id;
        this.tables.task.push({ task_id: taskId, run_id: runId, kind, payload, status: 'queued', claimed_by: null, result: null, created_at: now, updated_at: now });
        return;
      }
      case 'upsert_creatives': {
        const [rows] = args as [SqlRow[]];
        this.tables.creative ??= [];
        for (const row of rows) {
          for (const [field, ok] of [
            ['brand', this.tables.brand?.some((brand) => brand.brand_id === row.brand_id)],
            ['segment', this.tables.segment?.some((segment) => segment.segment_id === row.segment_id)],
            ['arm', this.tables.arm?.some((arm) => arm.arm_id === row.arm_id)],
          ] as const) {
            if (!ok) throw new StdbError(`creative ${String(row.creative_id)}: unknown ${field}`, 530);
          }
          const existing = this.tables.creative.findIndex((creative) => creative.creative_id === row.creative_id);
          if (existing >= 0) this.tables.creative[existing] = { ...row };
          else this.tables.creative.push({ ...row });
        }
        return;
      }
      default:
        throw new StdbError(`FakeStdb has no reducer ${reducer}`, 530);
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

/** A4's rows as they'll land: one client, two segments, 10 recipes plus the control, live ads, B's product. */
export function a4Tables(): Record<string, SqlRow[]> {
  return {
    brand: [
      { brand_id: 'br_halden_oat_co', name: 'Halden Oat Co.', is_client: true },
      { brand_id: 'br_rival_crunch', name: 'Rival Crunch', is_client: false },
    ],
    segment: [
      { segment_id: SEG_TRACKER, name: 'The Macro Tracker', share: 0.7 },
      { segment_id: SEG_UNAWARE, name: 'Convenience-First Cereal Eater', share: 0.3 },
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
    creative: [{ creative_id: 'cr_live_halden_1', arm_id: 'arm_control', origin: 'brand_live' }],
    product: [{ product_id: 'prd_halden_box', brand_id: 'br_halden_oat_co', name: 'Halden Oat Clusters' }],
  };
}
