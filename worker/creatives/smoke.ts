import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ADLAB_ORG_ID } from '@/lib/adlab/org';
import type { UpstreamFact } from '@/lib/creative-engine/brand-context/ingest';
import { HOOK_PRODUCIBILITY } from '@/lib/creative-engine/generation/producibility';
import { generateBrief, type BriefContext } from './brief';
import { toRows } from './facts';
import { derivePackHints } from './pack-hints';
import type { GeneratedCreative } from './types';

/*
 * The fixture smoke test: run the orchestrator core on Adcero's
 * fixtures/creative-brief.json and diff it against creative-output.json,
 * with the OpenAI transport mocked. The fixture's arms use universal angles
 * and its spec has no key message or notes, so this replays Adcero's own
 * choices; the task path adds ours on the same core.
 */

const FIXTURES = join(import.meta.dirname, '../../docs/reuse-export/fixtures');

/**
 * The fixture generator's composeBrief inputs, which it didn't record: rebuilt
 * so the composed brief equals the recorded one (the diff checks that).
 */
const FIXTURE_CONTEXT: BriefContext = {
  organizationId: ADLAB_ORG_ID,
  brandSummary: {
    valuePropositions: ['Breakfast that keeps you full until lunch', 'Baked in small batches with whole rolled oats'],
  },
  audience: 'Busy professionals and commuters who track their protein',
  compliance: { prohibitedClaims: ['cures', 'clinically proven'], requiredDisclaimers: [] },
  source: 'manual',
};

/** The creative fields the diff compares. id, rank and intendedImagePrompt are out: A5 doesn't rank or render. */
const CREATIVE_FIELDS = [
  'segment',
  'arm',
  'format',
  'headline',
  'primaryText',
  'cta',
  'visualDescription',
  'visualDescriptionSource',
  'copySource',
  'copyText',
  'gateResults',
  'genome',
  'packFingerprint',
  'status',
] as const;

type Json = Record<string, any>;
type ChatBody = { messages: Array<{ role: string; content: string }> };

const readFixture = (name: string): Json => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));

/**
 * The model replies, which the fixture didn't record either. Each accepted
 * reply is its creative's copy. Two replies are rebuilt from CREATIVE_MANIFEST §5:
 * the statistic group's first attempt cites an invented "15g" (rejected, then
 * retried), and the problem_callout concept says "7 am" (a digit, so dropped).
 */
function mockReplies(creatives: Json[]) {
  const byHook = new Map<string, Json>(creatives.map((c) => [c.arm.hookArchetype, c]));
  const hookOf = (user: string) => {
    const directive = /^Hook archetype to execute: (.*)$/m.exec(user)?.[1];
    return Object.entries(HOOK_PRODUCIBILITY).find(([, entry]) => entry.hookDirective === directive)?.[0];
  };
  return (body: ChatBody): Json => {
    const user = body.messages[1].content;
    const hook = hookOf(user);
    const creative = hook ? byHook.get(hook) : undefined;
    if (!creative) throw new Error(`smoke: no fixture creative for the request's hook (${hook ?? 'none'})`);
    const accepted = {
      headline: creative.headline,
      primaryText: creative.primaryText,
      cta: creative.cta,
      visualConcept: creative.visualDescription,
    };
    if (hook === 'statistic' && !user.includes('## Previous attempt rejected')) {
      return { ...accepted, headline: '15g of protein that lasts until lunch' };
    }
    if (creative.visualDescriptionSource === 'variation_text') {
      return { ...accepted, visualConcept: 'A commuter grabs a bowl of oat clusters at 7 am before heading out the door.' };
    }
    return accepted;
  };
}

/** Swaps global fetch for an OpenAI chat mock while `run` runs; other URLs pass through. */
async function withMockedChat<T>(reply: (body: ChatBody) => Json, run: (calls: ChatBody[]) => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const hadKey = 'OPENAI_API_KEY' in process.env;
  process.env.OPENAI_API_KEY ??= 'smoke-test';
  const calls: ChatBody[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).endsWith('/chat/completions')) return realFetch(url, init);
    const body = JSON.parse(String(init?.body)) as ChatBody;
    calls.push(body);
    const content = JSON.stringify(reply(body));
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = realFetch;
    if (!hadKey) delete process.env.OPENAI_API_KEY;
  }
}

/** Request bodies in a fixed order: the parallel copy calls (and the retry) land in any order. */
const sortedBodies = (bodies: unknown[]) =>
  bodies.map((body) => ({ body, key: JSON.stringify((body as ChatBody).messages) })).sort((a, b) => (a.key < b.key ? -1 : 1)).map(({ body }) => body);

export interface SmokeResult {
  mismatches: string[];
  creatives: GeneratedCreative[];
  calls: number;
}

/** Runs the fixture through the core; every differing path is one mismatch line. */
export async function runFixtureSmoke(): Promise<SmokeResult> {
  const input = readFixture('creative-brief.json');
  const output = readFixture('creative-output.json');
  const mismatches: string[] = [];
  const check = (path: string, ours: unknown, theirs: unknown) => {
    if (!isDeepStrictEqual(ours, theirs)) mismatches.push(path);
  };

  const rows = toRows(input.brandFacts as UpstreamFact[]);
  check('brandContextRows', rows, input.brandContextRows);

  const creatives: GeneratedCreative[] = [];
  const calls = await withMockedChat(mockReplies(output.creatives), async (calls) => {
    for (const [i, fixture] of (input.briefs as Json[]).entries()) {
      const where = `briefs[${i}] (${fixture.key})`;
      const before = calls.length;
      const packHints = derivePackHints(rows);
      check(`${where}.packHints`, packHints, fixture.packHints);
      const run = await generateBrief({
        briefId: fixture.brief.briefId,
        rows,
        brandProfileId: fixture.pack.meta.brandProfileId,
        personaRef: fixture.compileSpec.personaRef,
        angle: fixture.chosenArms[0].angleUniversal,
        hooks: fixture.chosenArms.map((arm: Json) => arm.hookArchetype),
        packHints,
        context: FIXTURE_CONTEXT,
        vocabulary: 'universal',
      });
      check(`${where}.selectedStrategy`, run.selected, fixture.selectedStrategy);
      check(`${where}.brief`, run.brief, fixture.brief);
      check(`${where}.canonical`, run.canonical, fixture.canonical);
      check(`${where}.compileSpec`, run.spec, fixture.compileSpec);
      check(`${where}.pack`, run.pack, fixture.pack);
      check(`${where}.packFingerprint`, run.fingerprint, fixture.packFingerprint);
      check(`${where}.copyPrompt`, run.copyPrompt, fixture.copyPrompt);
      check(`${where}.variationPlan`, run.variationPlan, fixture.variationPlan);
      check(`${where}.copyRequests`, sortedBodies(calls.slice(before)), sortedBodies(fixture.copyRequests));
      creatives.push(...run.creatives);
    }
    return calls.length;
  });

  check('creatives.length', creatives.length, output.creatives.length);
  for (const [i, theirs] of (output.creatives as Json[]).entries()) {
    const ours = creatives.find((c) => c.arm.key === theirs.arm.key) as Json | undefined;
    if (!ours) {
      mismatches.push(`creatives[${i}] (${theirs.arm.key}): missing`);
      continue;
    }
    for (const field of CREATIVE_FIELDS) check(`creatives[${i}] (${theirs.arm.key}).${field}`, ours[field], theirs[field]);
  }
  return { mismatches, creatives, calls };
}
