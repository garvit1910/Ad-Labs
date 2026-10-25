import { ADLAB_ORG_ID } from '@/lib/adlab/org';
import { getBrandObjectMonthlyLlmCallCap } from '@/lib/brand-object/config';
import { loadLiveBrandFacts } from '@/lib/brand-object/live-facts';
import { enqueueBrandObjectCrawl, enqueueBrandObjectPromote } from '@/services/job-processor/brand-object/queue';
import { getBrandObjectState, monthKey, type BrandObjectStateRow } from '@/services/job-processor/brand-object/state';
import { BRAND_OBJECT_JOB_TYPES } from '@/services/job-processor/brand-object/types';
import { createPhase, errorMessage, loadBrandProfile, table } from './phase';

/*
 * Ad Lab A3: distill Magic Spoon's brand context through Adcero's brand-object
 * jobs and the job_queue worker (run in-process here, worker/loop.ts).
 *
 *   npm run a3:distill [-- --force | --from=promote]
 *
 * One crawl job with chain: true runs crawl -> identity -> promote -> market ->
 * personas, and identity, promote, market and personas each queue chunks too.
 * Only identity and personas call an LLM. Then: npm run a3:report.
 *
 * --from=promote starts the chain at promote instead (no LLM call: promote and
 * market make none, and personas skips while its input is unchanged), the way
 * Adcero's post-cluster hook refreshes VOC facts. --force bypasses the crawl's
 * 7-day cooldown. Identity (7 days) and personas
 * (24 hours) keep theirs and skip when their input is unchanged. To rerun one,
 * clear cursors.identity or cursors.personas in brand_object_state, and raise
 * BRAND_OBJECT_MONTHLY_LLM_CALL_CAP if the month's 60 calls are spent. Never
 * delete facts to force a rerun.
 */

// One lane: the chain is sequential anyway, and with a second lane a stage's chunks
// enqueue can dedupe onto a chunks job that is already running and miss its facts.
const POOLS = [{ types: BRAND_OBJECT_JOB_TYPES, concurrency: 1 }];
// The identity sections the ads are built from (voice and compliance aside).
const IDENTITY_SECTIONS = new Set(['positioning', 'value_prop', 'usp', 'proof_point']);
const FORCE = process.argv.slice(2).includes('--force');
const FROM_PROMOTE = process.argv.slice(2).includes('--from=promote');

const { db, log, drainUntilIdle } = createPhase('a3');

function printState(state: BrandObjectStateRow): void {
  const cursors = state.cursors ?? {};
  const crawl = cursors.crawl as (typeof cursors.crawl & { pageRefs?: Record<string, string> }) | undefined;
  const cost = state.cost?.[monthKey()] ?? {};
  console.log(`\nbrand_object_state: ${state.status}, LLM calls this month ${cost.llmCalls ?? 0}/${getBrandObjectMonthlyLlmCallCap()}`);
  table([
    { stage: 'crawl', last_run: crawl?.lastCrawledAt, detail: `${Object.keys(crawl?.pageRefs ?? {}).length} pages` },
    { stage: 'identity', last_run: cursors.identity?.lastRunAt, detail: '' },
    { stage: 'promote', last_run: cursors.promotion?.lastRunAt, detail: cursors.promotion?.clusterRunId ? `cluster run ${cursors.promotion.clusterRunId.slice(0, 8)}` : '' },
    { stage: 'market', last_run: cursors.market?.lastRunAt, detail: '' },
    { stage: 'personas', last_run: cursors.personas?.lastRunAt, detail: '' },
  ]);
  console.log(
    `cost ${monthKey()}: ${cost.llmCalls ?? 0} LLM calls, ${cost.inputTokens ?? 0} in / ${cost.outputTokens ?? 0} out tokens, ${cost.apifyRuns ?? 0} Apify runs`,
  );
}

async function preflight(brandProfileId: string): Promise<void> {
  for (const key of ['APIFY_TOKEN', 'OPENAI_API_KEY']) {
    if (!process.env[key]?.trim()) throw new Error(`${key} must be set in .env.local`);
  }
  if (process.env.LLM_FLEX_TIER !== '0') log('warning: LLM_FLEX_TIER is not 0, so identity and personas queue on the flex tier');

  // Promote reads only brand-scope, non-catch-all themes; with none, the chain stops there.
  const { count: themes, error: themesError } = await db
    .from('brand_presence_themes')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', ADLAB_ORG_ID)
    .eq('brand_profile_id', brandProfileId)
    .eq('scope', 'brand')
    .eq('is_catchall', false);
  if (themesError) throw themesError;
  if (!themes) throw new Error('No brand-scope themes: promote would write no VOC facts. Finish A2 listening first');
  log(`${themes} brand-scope themes for promote`);

  // A deduped enqueue returns the existing row, whose payload wins: an old crawl with
  // chain: false would swallow this one's chain.
  const { data: active, error: activeError } = await db
    .from('job_queue')
    .select('id, type, status')
    .in('type', [...BRAND_OBJECT_JOB_TYPES])
    .in('status', ['pending', 'processing']);
  if (activeError) throw activeError;
  if (active?.length) {
    table(active.map((job) => ({ job: String(job.id).slice(0, 8), type: job.type, status: job.status })));
    throw new Error(`${active.length} brand_object job(s) already pending or processing: drain them with npm run worker first`);
  }

  const state = await getBrandObjectState(db, ADLAB_ORG_ID, brandProfileId);
  if (state) printState(state);
  else log('no brand_object_state yet: first distillation for this brand');
}

async function distill(): Promise<void> {
  const profile = await loadBrandProfile(db);
  if (profile.status !== 'confirmed') throw new Error(`Profile ${profile.id} is ${profile.status}, not confirmed`);
  log(`${profile.brand_name} (${profile.id})`);
  await preflight(profile.id);

  const failures = await drainUntilIdle('distill', POOLS, async () => {
    const scope = { organizationId: ADLAB_ORG_ID, brandProfileId: profile.id, chain: true };
    const { jobId, deduped } = FROM_PROMOTE
      ? await enqueueBrandObjectPromote(db, scope)
      : await enqueueBrandObjectCrawl(db, { ...scope, force: FORCE });
    const first = FROM_PROMOTE ? 'brand_object_promote' : 'brand_object_crawl';
    log(`${first} ${deduped ? 'already queued' : 'queued'} (${jobId}), chain on${FORCE && !FROM_PROMOTE ? ', force' : ''}`);
  });

  const state = await getBrandObjectState(db, ADLAB_ORG_ID, profile.id);
  if (!state) throw new Error('No brand_object_state after the chain: the crawl never ran');
  printState(state);

  const facts = await loadLiveBrandFacts(db, { organizationId: ADLAB_ORG_ID, brandProfileId: profile.id });
  const bySection = new Map<string, number>();
  for (const fact of facts) bySection.set(fact.section, (bySection.get(fact.section) ?? 0) + 1);
  console.log('\nlive brand_facts per section');
  table([...bySection].sort().map(([section, n]) => ({ section, facts: n })));

  const count = (test: (section: string) => boolean) => [...bySection].filter(([section]) => test(section)).reduce((n, [, c]) => n + c, 0);
  const crawl = state.cursors?.crawl as { pageRefs?: Record<string, string> } | undefined;
  const grounded = facts.filter((fact) => fact.section === 'persona' && fact.details?.extrapolated !== true).length;
  const problems = [
    failures.length > 0 && `${failures.length} job(s) failed; see the FAILED lines above`,
    Object.keys(crawl?.pageRefs ?? {}).length === 0 && 'the crawl archived no pages (the browser tier came back empty too), so identity had nothing to verify against',
    count((section) => IDENTITY_SECTIONS.has(section)) === 0 && 'identity wrote no positioning, value_prop, usp or proof_point facts',
    count((section) => section.startsWith('voc_')) === 0 && 'promote wrote no voc_* facts',
    count((section) => section === 'market_prior') === 0 &&
      'market wrote no market_prior facts. Its "[BrandObject] Market" log line above gives the winner count. The winner gate stays as is: tell Person A before going on',
    grounded < 2 && `personas wrote ${grounded} grounded persona(s), need 2-4`,
  ].filter((problem): problem is string => Boolean(problem));
  if (problems.length) {
    console.log('\nA3 distill stopped short');
    for (const problem of problems) console.log(`STOP  ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nEvery stage wrote facts. Next: npm run a3:report');
}

try {
  await distill();
} catch (error) {
  console.error(`[a3] distill failed: ${errorMessage(error)}`);
  process.exitCode = 1;
}
