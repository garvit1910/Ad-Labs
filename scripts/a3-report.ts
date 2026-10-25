import { ADLAB_ORG_ID } from '@/lib/adlab/org';
import { getBrandObjectMonthlyLlmCallCap } from '@/lib/brand-object/config';
import type { InsightFact } from '@/lib/brand-object/insights';
import { loadLiveBrandFacts } from '@/lib/brand-object/live-facts';
import { retrieveBrandSlice } from '@/lib/brand-object/retrieval/service';
import { EMBEDDING_MODEL } from '@/services/ad-library/embeddings';
import { getBrandObjectState, monthKey } from '@/services/job-processor/brand-object/state';
import { createPhase, errorMessage, loadBrandProfile, table } from './phase';

/*
 * Ad Lab A3 report: what the distillation wrote, read-only.
 *
 *   npm run a3:report
 *
 * Facts per section, 10 random VOC facts with their quotes checked against the
 * mentions they came from, the market_prior facts and their competitors, the
 * personas, and retrieveBrandSlice for "protein", "taste" and "price" (one
 * embedding call each). Exits 1 unless A3's done-when holds; whether the quotes
 * are sensible is Person A's read of the output.
 */

const RETRIEVAL_QUERIES = ['protein', 'taste', 'price'];
const VOC_SAMPLE = 10;
const IN_CHUNK = 150;

const { db } = createPhase('a3');

const clip = (text: string, max = 140) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

/** Where a quote occurs in a mention's text: verbatim, only after case/whitespace folding, or not at all. */
function matchQuote(quote: string, text: string | undefined): 'exact' | 'folded' | 'MISSING' {
  if (!text) return 'MISSING';
  if (text.includes(quote)) return 'exact';
  return normalize(text).includes(normalize(quote)) ? 'folded' : 'MISSING';
}

async function selectIn<T>(tableName: string, columns: string, ids: string[]): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await db.from(tableName).select(columns).in('id', ids.slice(i, i + IN_CHUNK));
    if (error) throw error;
    rows.push(...((data ?? []) as T[]));
  }
  return rows;
}

/** Every mention's title + body for the brand, by mention id. */
async function loadMentionText(brandProfileId: string): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('brand_mentions')
      .select('id, title, body')
      .eq('organization_id', ADLAB_ORG_ID)
      .eq('brand_profile_id', brandProfileId)
      .order('id')
      .range(from, from + 999);
    if (error) throw error;
    for (const row of data ?? []) texts.set(String(row.id), [row.title, row.body].filter(Boolean).join('\n'));
    if ((data ?? []).length < 1000) return texts;
  }
}

function sample<T>(items: T[], n: number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

interface PhraseRow {
  id: string;
  mention_id: string;
  phrase: string;
  theme_id: string | null;
}

/**
 * Prints sampled VOC facts with each quote checked twice: it occurs in its mention,
 * and it contains (or sits inside) one of the theme's own phrases from that mention. Promote quotes a
 * member mention's first quote, so a long review can lend a quote about something
 * else (lib/brand-object/promotion.ts buildVocEvidence).
 */
async function printVoc(voc: InsightFact[], mentions: Map<string, string>): Promise<void> {
  const quotesOf = (fact: InsightFact) => fact.evidence.filter((ref) => ref.type === 'phrase' && ref.quote && ref.id);
  const themeOf = (fact: InsightFact) => fact.evidence.find((ref) => ref.type === 'theme_snapshot')?.id;
  const quotePhrases = await selectIn<PhraseRow>('brand_presence_phrases', 'id, mention_id, phrase, theme_id', voc.flatMap(quotesOf).map((ref) => ref.id!));
  const mentionOf = new Map(quotePhrases.map((row) => [String(row.id), String(row.mention_id)]));
  const themeIds = [...new Set(voc.map(themeOf).filter((id): id is string => Boolean(id)))];
  const { data: members, error } = await db
    .from('brand_presence_phrases')
    .select('id, mention_id, phrase, theme_id')
    .in('theme_id', themeIds)
    .neq('kind', 'quote');
  if (error) throw error;
  const check = (fact: InsightFact, quote: string, phraseId: string) => {
    const mentionId = mentionOf.get(phraseId);
    const onTopic = ((members ?? []) as PhraseRow[]).some((member) => {
      if (member.mention_id !== mentionId || member.theme_id !== themeOf(fact)) return false;
      const [a, b] = [normalize(quote), normalize(member.phrase)];
      return a.includes(b) || b.includes(a);
    });
    return { match: matchQuote(quote, mentions.get(mentionId ?? '')), onTopic };
  };

  const picked = sample(voc, VOC_SAMPLE);
  console.log(`\n${picked.length} random VOC facts (of ${voc.length}), quotes checked against their own mention and theme`);
  for (const fact of picked) {
    console.log(`\n[${fact.section}] ${fact.fact_key} (${String(fact.details.label ?? '')})`);
    console.log(`  ${fact.statement}`);
    const quotes = quotesOf(fact);
    if (quotes.length === 0) console.log('  (no quote in evidence)');
    for (const ref of quotes) {
      const { match, onTopic } = check(fact, ref.quote!, ref.id!);
      console.log(`  ${match.padEnd(7)} ${(onTopic ? 'theme' : 'UNLINKED').padEnd(8)} "${clip(ref.quote!, 200)}" (${ref.platform ?? '?'}${ref.url ? `, ${ref.url}` : ''})`);
    }
  }

  const all = voc.flatMap((fact) => quotesOf(fact).map((ref) => check(fact, ref.quote!, ref.id!)));
  console.log(`\nall ${voc.length} VOC facts: ${all.length} quotes, ${all.filter((q) => q.match !== 'MISSING').length} found in their mention ("folded" = only after case/whitespace folding)`);
  console.log(
    `${all.filter((q) => q.onTopic).length}/${all.length} contain one of their theme's phrases; UNLINKED = they don't, often the mention's first quote about something else (lib/brand-object/promotion.ts buildVocEvidence)`,
  );
}

async function printMarket(market: InsightFact[]): Promise<void> {
  const adIds = [...new Set(market.flatMap((fact) => fact.evidence.filter((ref) => ref.type === 'ad_label_agg' && ref.id).map((ref) => ref.id!)))];
  const ads = await selectIn<{ id: string; competitor_id: string }>('library_ads', 'id, competitor_id', adIds);
  const { data: pages, error } = await db.from('tracked_competitors').select('id, name').eq('organization_id', ADLAB_ORG_ID);
  if (error) throw error;
  const pageName = new Map((pages ?? []).map((row) => [String(row.id), String(row.name)]));
  const brandOf = new Map(ads.map((ad) => [String(ad.id), pageName.get(String(ad.competitor_id)) ?? '?']));

  console.log(`\n${market.length} market_prior facts (competitors = the ≤3 sampled ads in each fact's evidence, not the whole winner set)`);
  table(
    [...market]
      .sort((a, b) => Number(b.details.share ?? 0) - Number(a.details.share ?? 0))
      .map((fact) => ({
        key: fact.fact_key,
        share: `${Number(fact.details.share ?? 0)}%`,
        winners: fact.metrics.winnerCount ?? '',
        competitors: [
          ...new Set(fact.evidence.filter((ref) => ref.type === 'ad_label_agg' && ref.id).map((ref) => brandOf.get(ref.id!) ?? '?')),
        ].join(', '),
        statement: clip(fact.statement, 90),
      })),
  );
}

interface PersonaRef {
  fact_id: string;
  note?: string;
}

function printPersonas(personas: InsightFact[], factKey: Map<string, string>, corpus: string[]): void {
  const inCorpus = (quote: string) => {
    const folded = normalize(quote);
    return corpus.some((text) => text.includes(quote)) ? 'exact' : corpus.some((text) => normalize(text).includes(folded)) ? 'folded' : 'NOT A MENTION';
  };
  const refs = (value: unknown) => ((value ?? []) as PersonaRef[]).map((ref) => factKey.get(ref.fact_id) ?? `?${ref.fact_id.slice(0, 8)}`);
  for (const fact of personas) {
    const details = fact.details;
    const projection = details.extrapolated === true;
    console.log(`\n${String(details.name)} [${fact.fact_key}] stage ${String(details.awarenessStage)}${projection ? ', unaware projection (extrapolated, not a segment)' : ''}`);
    console.log(`  ${clip(String(details.description ?? ''), 400)}`);
    for (const kind of ['pains', 'desires', 'objections'] as const) {
      const keys = refs(details[kind]);
      console.log(`  ${kind} (${keys.length}): ${keys.join(', ')}`);
    }
    const verbatims = (details.verbatims ?? []) as string[];
    console.log(`  verbatims (${verbatims.length}):`);
    for (const quote of verbatims) console.log(`    ${inCorpus(quote).padEnd(13)} "${clip(quote, 200)}"`);
  }
  console.log('\nNOT A MENTION = a verbatim found in no brand mention (e.g. a market fact\'s execution note); A4 must not use it as a segment quote');
}

async function report(): Promise<void> {
  const profile = await loadBrandProfile(db);
  const scope = { organizationId: ADLAB_ORG_ID, brandProfileId: profile.id };
  const state = await getBrandObjectState(db, ADLAB_ORG_ID, profile.id);
  if (!state) throw new Error('No brand_object_state: run npm run a3:distill first');
  const completeness = 'overall' in state.completeness ? state.completeness.overall.toFixed(2) : '?';
  console.log(`A3 report for ${profile.brand_name} (${profile.id})`);
  console.log(
    `brand_object_state ${state.status}, completeness ${completeness}, LLM calls this month ${state.cost?.[monthKey()]?.llmCalls ?? 0}/${getBrandObjectMonthlyLlmCallCap()}`,
  );

  const facts = await loadLiveBrandFacts(db, scope);
  const bySection = new Map<string, InsightFact[]>();
  for (const fact of facts) bySection.set(fact.section, [...(bySection.get(fact.section) ?? []), fact]);
  const section = (name: string) => bySection.get(name) ?? [];

  const embedded = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('brand_chunks')
      .select('fact_id')
      .eq('organization_id', ADLAB_ORG_ID)
      .eq('brand_profile_id', profile.id)
      .eq('embedding_model', EMBEDDING_MODEL)
      .not('embedding', 'is', null)
      .order('id')
      .range(from, from + 999);
    if (error) throw error;
    for (const row of data ?? []) embedded.add(String(row.fact_id));
    if ((data ?? []).length < 1000) break;
  }
  const unchunked = facts.filter((fact) => !embedded.has(fact.id));

  console.log('\nlive brand_facts per section');
  table(
    [...bySection].sort(([a], [b]) => a.localeCompare(b)).map(([name, rows]) => ({
      section: name,
      facts: rows.length,
      mean_confidence: (rows.reduce((n, fact) => n + fact.confidence, 0) / rows.length).toFixed(2),
      embedded_chunks: rows.filter((fact) => embedded.has(fact.id)).length,
    })),
  );

  console.log('\nidentity facts');
  for (const name of ['positioning', 'value_prop', 'usp', 'proof_point']) {
    for (const fact of section(name)) console.log(`  [${name}] ${clip(fact.statement, 200)}`);
  }

  const mentions = await loadMentionText(profile.id);
  const voc = facts.filter((fact) => fact.section.startsWith('voc_'));
  await printVoc(voc, mentions);
  await printMarket(section('market_prior'));

  const personas = section('persona');
  const grounded = personas.filter((fact) => fact.details.extrapolated !== true);
  console.log(`\n${grounded.length} grounded persona(s)${personas.length > grounded.length ? ' + the unaware projection' : ''}`);
  printPersonas(personas, new Map(facts.map((fact) => [fact.id, fact.fact_key])), [...mentions.values()]);

  // Identity facts are grounded in a verified sentence from the brand's own site
  // (sourceSentence), not a customer quote, so retrieval's bestVerbatim skips them.
  const grounding = (fact: { bestVerbatim?: string; evidence: InsightFact['evidence'] }) =>
    fact.bestVerbatim
      ? `"${clip(fact.bestVerbatim, 160)}"`
      : (() => {
          const page = fact.evidence.find((ref) => ref.sourceSentence);
          return page ? `page: "${clip(page.sourceSentence!.replace(/\s+/g, ' '), 140)}" (${page.url ?? '?'})` : null;
        })();
  const groundedHits = new Map<string, number>();
  for (const query of RETRIEVAL_QUERIES) {
    const slice = await retrieveBrandSlice(db, { ...scope, query, k: 5 });
    console.log(`\nretrieveBrandSlice "${query}": ${slice.facts.length} facts, ${slice.complianceFacts.length} compliance, ${slice.provenanceFactIds.length} provenance ids`);
    for (const fact of slice.facts) {
      console.log(`  ${fact.score.toFixed(3)} [${fact.section}] ${fact.factKey}: ${clip(fact.statement, 110)}`);
      const line = grounding(fact);
      if (line) console.log(`        ${line}`);
    }
    groundedHits.set(query, slice.facts.filter((fact) => grounding(fact)).length);
  }

  const identity = ['usp', 'value_prop', 'proof_point'].reduce((n, name) => n + section(name).length, 0);
  const checks: Array<[string, boolean]> = [
    [`${section('positioning').length} positioning and ${identity} usp/value_prop/proof_point facts (need 1 each)`, section('positioning').length >= 1 && identity >= 1],
    [`${voc.length} voc_* facts (need 5)`, voc.length >= 5],
    [`${section('market_prior').length} market_prior facts (need 1)`, section('market_prior').length >= 1],
    [`${grounded.length} grounded personas (need 2-4)`, grounded.length >= 2 && grounded.length <= 4],
    [
      `every query returns a fact with a quote or page sentence (${RETRIEVAL_QUERIES.map((query) => `${query} ${groundedHits.get(query)}`).join(', ')})`,
      RETRIEVAL_QUERIES.every((query) => (groundedHits.get(query) ?? 0) > 0),
    ],
    [`every live fact has an embedded chunk${unchunked.length ? ` (missing: ${unchunked.length})` : ''}`, unchunked.length === 0],
  ];
  console.log('\nA3 done-when');
  for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
}

try {
  await report();
} catch (error) {
  console.error(`[a3] report failed: ${errorMessage(error)}`);
  process.exitCode = 1;
}
