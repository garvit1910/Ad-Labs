/**
 * A7 route check: calls every Brand Identity and Competitor Analysis route on a
 * running Next server and asserts the live-Supabase invariants.
 *
 *   npx tsx scripts/a7-check-routes.ts --base http://localhost:3000 [--only competitor|brand] [--loose]
 *
 * Hard invariants (FAIL): 7 competitors without Magic Spoon; dashboard totalAds
 * equals the sum of adCount and provenWinners equals the sum of winnerCount; a
 * single competitor's dashboard equals its list row; no dashboard ad from
 * outside the list; facts count equals portfolio liveFactCount; synthesis is
 * ready; own-performance and the landscape are 404; brand-presence/status
 * passes its zod schema and counts.kept equals keptCounts. Tonight's exact
 * figures (194 ads, GHOST 50, 96 facts) FAIL too unless --loose makes them WARN.
 * WARN: provenWinners outside 45-57, own angles outside 40-50, active jobs or
 * sources (they keep the build card on the brand page). Reads only. Exit 1 on
 * any FAIL.
 */
import { brandPresenceStatusSchema } from '@/lib/brand-presence/client-schemas';

const ORG = '00000000-0000-4000-8000-000000000001';
const MAGIC_SPOON_PROFILE = 'e7252185-7867-4662-846b-71a57ded35a6';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const BASE = (flag('--base') ?? 'http://localhost:3000').replace(/\/$/, '');
const ONLY = flag('--only');
const LOOSE = args.includes('--loose');

let failures = 0;
const pass = (msg: string) => console.log(`PASS ${msg}`);
const warn = (msg: string) => console.log(`WARN ${msg}`);
const failMsg = (msg: string) => {
  failures++;
  console.log(`FAIL ${msg}`);
};
const check = (cond: boolean, msg: string) => (cond ? pass(msg) : failMsg(msg));
/** Tonight's exact figures: FAIL by default, WARN with --loose. */
const exact = (cond: boolean, msg: string) => (cond ? pass(msg) : LOOSE ? warn(msg) : failMsg(msg));

type Res = { status: number; body: any; source: string | null };

async function call(path: string, body?: unknown, method = 'POST'): Promise<Res> {
  const res = await fetch(`${BASE}/api/${path}`, {
    method,
    headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json, source: res.headers.get('x-adlab-source') };
}

async function data(path: string, body?: unknown, method = 'POST'): Promise<any> {
  const res = await call(path, body, method);
  if (res.status !== 200) {
    failMsg(`${method} ${path} -> ${res.status} ${JSON.stringify(res.body)}`);
    return undefined;
  }
  if (res.source !== 'supabase') failMsg(`${path} x-adlab-source is ${res.source}`);
  return res.body?.data;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

async function checkCompetitor() {
  console.log('\n# Competitor Analysis');
  const list: any[] | undefined = await data('brand-identity/competitors/list', { organizationId: ORG });
  if (!list) return;
  const names = list.map((c) => c.name);
  check(list.length === 7, `competitors/list: ${list.length} competitors (${names.join(', ')})`);
  check(!names.some((n) => /magic\s*spoon/i.test(n)) && !list.some((c) => c.is_brand_self), 'competitors/list: no Magic Spoon / self row');
  const adSum = sum(list.map((c) => c.adCount));
  const winnerSum = sum(list.map((c) => c.winnerCount));
  const ids = new Set(list.map((c) => c.id));

  const dash = await data('brand-identity/dashboard', { organizationId: ORG, platform: 'all' });
  if (dash) {
    const { scope } = dash;
    console.log(`     dashboard scope ${JSON.stringify(scope)}`);
    check(scope.totalAds === adSum, `dashboard totalAds ${scope.totalAds} === sum(adCount) ${adSum}`);
    exact(adSum === 194, `sum(adCount) ${adSum} === 194`);
    check(scope.provenWinners === winnerSum, `dashboard provenWinners ${scope.provenWinners} === sum(winnerCount) ${winnerSum}`);
    if (scope.provenWinners < 45 || scope.provenWinners > 57) warn(`provenWinners ${scope.provenWinners} outside 45-57`);
    else pass(`provenWinners ${scope.provenWinners} within 45-57`);
    const ads = [
      ...dash.winners.map((w: any) => w.ad),
      ...dash.exampleAds,
      ...dash.angleClusters.flatMap((c: any) => c.members.map((m: any) => m.ad)),
    ];
    const outside = ads.filter((ad: any) => !ids.has(ad.competitor_id));
    check(outside.length === 0, `dashboard: ${ads.length} winner/example/cluster ads, ${outside.length} outside the list`);
    check(dash.winners.length <= 24 && dash.angleClusters.length <= 12, `dashboard: ${dash.winners.length} winners, ${dash.angleClusters.length} clusters`);
  }

  const ghost = list.find((c) => /ghost/i.test(c.name));
  if (!ghost) failMsg('GHOST not in the list');
  else {
    const g = await data('brand-identity/dashboard', { organizationId: ORG, competitorId: ghost.id, platform: 'all' });
    if (g) {
      check(g.scope.totalAds === ghost.adCount, `GHOST dashboard totalAds ${g.scope.totalAds} === adCount ${ghost.adCount}`);
      check(g.scope.provenWinners === ghost.winnerCount, `GHOST provenWinners ${g.scope.provenWinners} === winnerCount ${ghost.winnerCount}`);
      exact(g.scope.totalAds === 50, `GHOST totalAds ${g.scope.totalAds} === 50`);
    }
  }

  const collections = await data('brand-identity/collections/list', { organizationId: ORG });
  check(Array.isArray(collections) && collections.length === 0, 'collections/list -> []');
  const membership = await data('brand-identity/collections/membership', { organizationId: ORG });
  check(membership && typeof membership === 'object' && Object.keys(membership).length === 0, 'collections/membership -> {}');
  const create = await call('brand-identity/collections/create', { organizationId: ORG });
  check(create.status === 501, `collections/create -> ${create.status} (501)`);
  const summaries = await data('brand-identity/labels/summaries', { organizationId: ORG, locale: 'en' });
  check(summaries?.locale === 'en' && Object.keys(summaries?.summaries ?? {}).length === 0, 'labels/summaries -> {locale: en, summaries: {}}');
}

async function checkBrand() {
  console.log('\n# Brand Identity');
  const profiles = await data('brand-presence/profiles/list', { organizationId: ORG });
  if (!profiles) return;
  const profile = profiles.profiles[0]?.id as string | undefined;
  check(profile === MAGIC_SPOON_PROFILE, `profiles/list: newest profile ${profile} (${profiles.profiles.length} total)`);
  if (!profile) return;
  const kept = profiles.keptCounts[profile];
  check(typeof kept === 'number', `profiles/list: keptCounts ${kept}`);
  const body = { organizationId: ORG, brandProfileId: profile };

  const factsRes = await data('brand-object/facts', body);
  const facts: any[] = factsRes?.facts ?? [];
  const bySection: Record<string, number> = {};
  for (const f of facts) bySection[f.section] = (bySection[f.section] ?? 0) + 1;
  console.log(`     facts by section ${JSON.stringify(bySection)}`);
  check(facts.length > 0, `facts: ${facts.length}`);
  exact(facts.length === 96, `facts ${facts.length} === 96`);

  const portfolio = await data('brand-object/portfolio', { organizationId: ORG });
  const row = portfolio?.profiles?.find((p: any) => p.profileId === profile);
  check(row?.liveFactCount === facts.length, `portfolio liveFactCount ${row?.liveFactCount} === facts ${facts.length}`);
  if (row?.activeJobTypes?.length) warn(`portfolio activeJobTypes ${JSON.stringify(row.activeJobTypes)}`);

  const status = await data('brand-object/status', body);
  if (status) {
    console.log(`     brand-object/status state ${status.state?.status ?? null}, progress ${JSON.stringify(status.progress)}`);
    check(Array.isArray(status.activeJobs) && !!status.progress, 'brand-object/status shape');
    if (status.activeJobs.length) warn(`brand-object/status activeJobs ${JSON.stringify(status.activeJobs)}`);
    if (status.progress.listening.activeJobs || status.progress.listening.activeSources) {
      warn(`listening activeJobs ${status.progress.listening.activeJobs}, activeSources ${status.progress.listening.activeSources}: the build card shows`);
    }
  }

  const synth = await data(`organizations/${ORG}/brand-identity/synthesis?brandProfileId=${profile}`, undefined, 'GET');
  if (synth) {
    console.log(`     synthesis headline "${synth.synthesis?.headline}"`);
    console.log(`     strengths ${synth.synthesis?.strengths.length}, tensions ${synth.synthesis?.tensions.length}, staleness ${synth.staleness?.reason}`);
    check(typeof synth.synthesis?.headline === 'string' && synth.synthesis.headline.length > 0, 'synthesis GET: headline non-empty');
    check(synth.staleness?.reason === 'fresh', 'synthesis GET: staleness fresh');
  }
  const synthPost = await data(`organizations/${ORG}/brand-identity/synthesis`, { brandProfileId: profile });
  check(synthPost?.status === 'ready', `synthesis POST: status ${synthPost?.status}`);

  const angles = await data('brand-object/own-ad-angles', { organizationId: ORG });
  const labeled = angles?.mix?.totalLabeledAds;
  check(typeof labeled === 'number' && labeled > 0, `own-ad-angles: totalLabeledAds ${labeled}`);
  if (typeof labeled === 'number' && (labeled < 40 || labeled > 50)) warn(`own-ad-angles ${labeled} outside 40-50`);

  const ownPerf = await call('brand-object/own-performance', body);
  check(ownPerf.status === 404, `own-performance -> ${ownPerf.status} (404)`);
  const landscape = await call('brand-presence/insights/competitive-landscape', body);
  check(landscape.status === 404, `competitive-landscape -> ${landscape.status} (404)`);

  const sources = await data('brand-presence/sources/list', body);
  if (sources) {
    const sourceIds = new Set(sources.sources.map((s: any) => s.id));
    console.log(`     sources ${sources.sources.map((s: any) => `${s.source_type}:${s.status}`).join(', ')}`);
    check(Object.keys(sources.mentionCounts).every((id) => sourceIds.has(id)), `sources/list: ${sources.sources.length} sources, mentionCounts keyed by source id`);
  }

  for (const include of ['full', 'activity'] as const) {
    const presence = await data('brand-presence/status', { ...body, include });
    if (!presence) continue;
    const parsed = brandPresenceStatusSchema.safeParse(presence);
    check(parsed.success, `brand-presence/status (${include}) passes brandPresenceStatusSchema`);
    if (include === 'full') {
      console.log(`     presence counts total ${presence.counts?.total}, kept ${presence.counts?.kept}`);
      check(presence.counts?.kept === kept, `brand-presence/status counts.kept ${presence.counts?.kept} === keptCounts ${kept}`);
    } else check(presence.counts === null, 'brand-presence/status (activity) counts null');
    if (presence.activeJobs.length) warn(`brand-presence/status activeJobs ${presence.activeJobs.length}`);
    const active = presence.sources.filter((s: any) => (s.status === 'pending' || s.status === 'running') && !s.awaitingConfirm);
    if (active.length) warn(`brand-presence/status active sources ${active.map((s: any) => s.source_type).join(', ')}`);
  }
}

async function checkPages(paths: string[]) {
  console.log('\n# Pages');
  for (const path of paths) {
    const res = await fetch(`${BASE}${path}`);
    check(res.status === 200, `GET ${path} -> ${res.status}`);
  }
}

if (ONLY !== 'brand') await checkCompetitor();
if (ONLY !== 'competitor') await checkBrand();
await checkPages(
  ONLY === 'competitor'
    ? ['/brand-identity/competitor-analysis']
    : ONLY === 'brand'
      ? ['/brand-identity']
      : ['/', '/brand-identity', '/brand-identity/competitor-analysis']
);
console.log(failures ? `\n${failures} FAIL` : '\nall PASS');
process.exit(failures ? 1 : 0);
