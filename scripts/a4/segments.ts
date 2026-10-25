import type { InsightFact } from '@/lib/brand-object/insights';
import { compareVocRank } from '@/lib/brand-object/voc-rank';
import { scoreVocVerbatim } from '@/lib/brand-object/voc-verbatim';
import type { ChatMessage, Llm } from './llm';
import { OTHER_PRIOR_WEIGHT, WEIGHTED_CONCEPTS, segmentIdFor } from './vocabulary';

/*
 * Persona facts (A3) → segment rows (docs/PLAN.md "A4", segment builder table).
 * Deterministic except description and prior_weights: one strict-JSON call per persona.
 */

export interface SegmentRow {
  segment_id: string;
  name: string;
  description: string;
  share: number;
  prior_weights: string;
  quotes: string;
  budget_mean_usd: number;
  budget_sd_usd: number;
  in_market_rate: number;
}

export interface SegmentReport {
  row: SegmentRow;
  personaFactId: string;
  extrapolated: boolean;
  vocFrequency: number;
  quotes: string[];
  dropped: string[];
  weights: Record<string, number>;
}

const UNAWARE_SHARE = 0.1;
const QUOTE_TARGET = 12;
const QUOTE_MAX_CHARS = 300; // two quotes ride every Jev state, which must stay under 450 words
const BUDGET_MEAN_USD = 45;
const BUDGET_SD_USD = 15;
const IN_MARKET_RATE = 0.12;
const RESTOCKING_IN_MARKET_RATE = 0.18;
const RESTOCKING_RE = /\b(run(s|ning)? out|ran out|restock\w*|re-?order\w*|stock(ing)? up)\b/i;

/**
 * Words a life-context description must not use: each names a concept, or a routine
 * that implies one (B's D26). The sim renders the description and the prior weights
 * separately, so a preference here would count twice.
 */
const PREFERENCE_WORDS: RegExp[] = [
  /\bprotein\w*/i, /\bsugar\w*/i, /\bsweet\w*/i, /\bcarb\w*/i, /\bketo\w*/i, /\bmacros?\b/i, /\bcalori\w*/i,
  /\btast(e|es|y|ing)\b/i, /\bflavou?r\w*/i, /\bnostalg\w*/i, /\bchildhood\b/i, /\bcartoon\w*/i, /\bcrunch\w*/i,
  /\btexture\w*/i, /\bingredient\w*/i, /\bartificial\b/i, /\bgluten\w*/i, /\bgrain\w*/i, /\bdairy\b/i,
  /\ballerg\w*/i, /\bceliac\b/i, /\bintoleran\w*/i, /\bvegan\b/i, /\bfullness\b/i, /\bsatiet\w*/i,
  /\bfitness\b/i, /\bgym\w*/i, /\bwork(s|ing)? ?outs?\b/i, /\bexercis\w*/i, /\blifting\b/i, /\bathlet\w*/i,
  /\bweight\w*/i, /\bdiet\w*/i, /\bkids?\b/i, /\bchild(ren)?\b/i, /\bparents?\b/i, /\bconvenien\w*/i,
  /\bon[- ]the[- ]go\b/i, /\bpric\w*/i, /\bcheap\w*/i, /\bexpensive\b/i, /\bbudget\w*/i, /\bafford\w*/i,
  /\bvalue\b/i, /\bdeals?\b/i, /\bdiscount\w*/i, /\bcoupon\w*/i, /\bsubscri\w*/i, /\breviews?\b/i,
  /\bratings?\b/i, /\bhealth(y|ier|iest)?\b/i, /\bnutri\w*/i, /\blabels?\b/i, /\bmagic spoon\b/i,
  // What they look for when buying is a preference too (convenience, nostalgia, trust).
  /\blook(s|ing)? (for|over)\b/i, /\bprefer\w*/i, /\bfamiliar\b/i, /\beasy\b/i, /\bquick\w*/i, /\bsimple\b/i,
  /\bcompar\w*/i, /\bbusy\b/i, /\bproduct details\b/i,
];

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

interface PersonaRef {
  fact_id: string;
  note?: string;
}

function refsOf(persona: InsightFact, kind: 'pains' | 'desires' | 'objections'): PersonaRef[] {
  return ((persona.details[kind] ?? []) as PersonaRef[]).filter((ref) => ref && typeof ref.fact_id === 'string');
}

/** Each persona's distinct linked facts, in pains → desires → objections order. */
function linkedFacts(persona: InsightFact, byId: Map<string, InsightFact>) {
  const seen = new Set<string>();
  const out: Array<{ kind: 'pain' | 'desire' | 'objection'; fact: InsightFact; note: string }> = [];
  for (const [kind, key] of [['pain', 'pains'], ['desire', 'desires'], ['objection', 'objections']] as const) {
    for (const ref of refsOf(persona, key)) {
      const fact = byId.get(ref.fact_id);
      if (!fact || seen.has(fact.id)) continue;
      seen.add(fact.id);
      out.push({ kind, fact, note: ref.note ?? '' });
    }
  }
  return out;
}

/**
 * The persona's verbatims, then round-robin over its linked VOC facts (best-ranked
 * fact first), each giving its best remaining quote. Every quote must be an exact
 * substring of a brand mention.
 */
function pickQuotes(persona: InsightFact, voc: InsightFact[], corpus: string[]): { quotes: string[]; dropped: string[] } {
  const quotes: string[] = [];
  const dropped: string[] = [];
  const taken = new Set<string>();
  const offer = (quote: string, source: string): void => {
    const key = normalize(quote);
    if (!key || taken.has(key)) return;
    if (quote.length > QUOTE_MAX_CHARS) {
      dropped.push(`${source}: over ${QUOTE_MAX_CHARS} chars: "${quote.slice(0, 60)}…"`);
      return;
    }
    if (!corpus.some((text) => text.includes(quote))) {
      dropped.push(`${source}: not an exact substring of any mention: "${quote.slice(0, 80)}"`);
      return;
    }
    taken.add(key);
    quotes.push(quote);
  };

  for (const quote of (persona.details.verbatims ?? []) as string[]) {
    if (quotes.length >= QUOTE_TARGET) break;
    if (typeof quote === 'string') offer(quote, 'persona verbatim');
  }

  const pools = [...voc]
    .sort((a, b) => compareVocRank({ metrics: a.metrics, rankLabel: a.statement }, { metrics: b.metrics, rankLabel: b.statement }))
    .map((fact) => {
      const label = String(fact.details.label ?? fact.statement);
      const ranked = fact.evidence
        .filter((ref) => ref.type === 'phrase' && typeof ref.quote === 'string')
        .map((ref) => ({ quote: ref.quote!, score: scoreVocVerbatim(ref.quote!, label) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score);
      return { source: `${fact.section} ${fact.fact_key}`, ranked };
    });
  for (let round = 0; quotes.length < QUOTE_TARGET && pools.some((pool) => pool.ranked.length > round); round++) {
    for (const pool of pools) {
      if (quotes.length >= QUOTE_TARGET) break;
      const entry = pool.ranked[round];
      if (entry) offer(entry.quote, pool.source);
    }
  }
  return { quotes, dropped };
}

function systemPrompt(): string {
  const concepts = WEIGHTED_CONCEPTS.map((concept) => `- ${concept.key}: ${concept.label}`).join('\n');
  return [
    'You turn one customer persona of a cereal brand into a shopper segment for an ad simulation.',
    'The simulation shows a judge model the description and the concept weights separately, so any preference written into the description would be counted twice. Keep them apart.',
    '',
    'Return two fields.',
    '',
    'description: one or two plain sentences of life context only: who they are and their routine (work, household, when and where they eat breakfast, how they buy groceries).',
    'Never state or imply a food preference, a goal, a diet, a health condition, a feeling about food, or an opinion of any brand. Never mention any concept below, nor a routine that implies one:',
    'no gym, workouts or sports (fitness), no childhood or cartoons (childhood flavors), no children or parenting (kid-friendly), no dietary rules, allergies or intolerances, no counting calories or macros, no reading nutrition labels, no prices, budgets or deals, no reviews. Name no brand.',
    "Describe circumstances, never wants: don't say what they look for, compare, prefer or find easy, and don't call their mornings busy or rushed (that is convenience).",
    '',
    'prior_weights: for every concept key, how much this persona weighs it when choosing a cereal, from 0 (never thinks about it) to 1 (decides on it).',
    "Read it from the persona's pains, desires and objections. A desire, or a pain the product would fix, raises the concept it is about; an objection raises the concept it is about too (a price objection raises value_price).",
    'Use the range: most personas care a lot (0.75-0.95) about 2-4 concepts, somewhat (0.45-0.7) about a few, and little (0.05-0.3) about the rest. Do not put every weight in the middle.',
    '',
    'Concepts:',
    concepts,
  ].join('\n');
}

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['description', 'prior_weights'],
  properties: {
    description: { type: 'string' },
    prior_weights: {
      type: 'object',
      additionalProperties: false,
      required: WEIGHTED_CONCEPTS.map((concept) => concept.key),
      properties: Object.fromEntries(WEIGHTED_CONCEPTS.map((concept) => [concept.key, { type: 'number' }])),
    },
  },
} as const;

interface SegmentAnswer {
  description: string;
  weights: Record<string, number>;
}

function parseAnswer(value: unknown): SegmentAnswer {
  const answer = value as { description?: unknown; prior_weights?: Record<string, unknown> };
  const description = typeof answer?.description === 'string' ? answer.description.replace(/\s+/g, ' ').trim() : '';
  if (!description) throw new Error('segment answer has no description');
  const weights: Record<string, number> = {};
  for (const { key } of WEIGHTED_CONCEPTS) {
    const weight = answer.prior_weights?.[key];
    if (typeof weight !== 'number' || !Number.isFinite(weight)) throw new Error(`segment answer has no number for ${key}`);
    weights[key] = Math.round(Math.min(1, Math.max(0, weight)) * 100) / 100;
  }
  return { description, weights };
}

function preferenceWords(description: string): string[] {
  return [...new Set(PREFERENCE_WORDS.flatMap((re) => description.match(re)?.[0] ?? []))];
}

async function askSegment(llm: Llm, persona: InsightFact, linked: ReturnType<typeof linkedFacts>): Promise<SegmentAnswer> {
  const input = {
    name: String(persona.details.name ?? persona.fact_key),
    awareness_stage: String(persona.details.awarenessStage ?? ''),
    persona_description: String(persona.details.description ?? ''),
    linked_facts: linked.map(({ kind, fact, note }) => ({ kind, section: fact.section, statement: fact.statement, note })),
    verbatims: (persona.details.verbatims ?? []) as string[],
  };
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: JSON.stringify(input, null, 2) },
  ];
  const first = await llm.strictJson('adlab_segment', RESPONSE_SCHEMA, messages, parseAnswer);
  const words = preferenceWords(first.description);
  if (words.length === 0) return first;

  const retry = await llm.strictJson(
    'adlab_segment',
    RESPONSE_SCHEMA,
    [
      ...messages,
      {
        role: 'user',
        content: `Your description was: "${first.description}". It uses ${words.map((word) => `"${word}"`).join(', ')}, which states or implies a preference. Rewrite the description as life context only, without those words or anything they imply. Keep the same prior_weights unless they were wrong.`,
      },
    ],
    parseAnswer,
  );
  const still = preferenceWords(retry.description);
  if (still.length > 0) {
    throw new Error(`${persona.fact_key}: description still names a preference after one retry (${still.join(', ')}): "${retry.description}"`);
  }
  return retry;
}

export async function buildSegments(opts: {
  facts: InsightFact[];
  mentions: Map<string, string>;
  llm: Llm;
}): Promise<SegmentReport[]> {
  const byId = new Map(opts.facts.map((fact) => [fact.id, fact]));
  const corpus = [...opts.mentions.values()];
  const personas = opts.facts
    .filter((fact) => fact.section === 'persona')
    .sort((a, b) => a.fact_key.localeCompare(b.fact_key));
  if (personas.length === 0) throw new Error('no live persona facts: run npm run a3:distill first');

  const drafts = await Promise.all(
    personas.map(async (persona) => {
      const linked = linkedFacts(persona, byId);
      const voc = linked.map((entry) => entry.fact).filter((fact) => fact.section.startsWith('voc_'));
      const vocFrequency = voc.reduce((sum, fact) => sum + (fact.metrics.frequency ?? 0), 0);
      const { quotes, dropped } = pickQuotes(persona, voc, corpus);
      const answer = await askSegment(opts.llm, persona, linked);
      const pains = linked.filter((entry) => entry.kind === 'pain').map((entry) => `${entry.fact.statement} ${entry.note}`);
      return {
        persona,
        extrapolated: persona.details.extrapolated === true,
        vocFrequency,
        quotes,
        dropped,
        answer,
        inMarketRate: pains.some((text) => RESTOCKING_RE.test(text)) ? RESTOCKING_IN_MARKET_RATE : IN_MARKET_RATE,
      };
    }),
  );

  // Only VOC facts carry a frequency (A3 "For A4"). Grounded personas split what the
  // unaware projection leaves, in proportion; equally if none links a VOC fact.
  const grounded = drafts.filter((draft) => !draft.extrapolated);
  const projected = drafts.filter((draft) => draft.extrapolated);
  const projectedShare = grounded.length === 0 ? 1 / projected.length : projected.length > 0 ? UNAWARE_SHARE / projected.length : 0;
  const groundedPool = 1 - projectedShare * projected.length;
  const totalFrequency = grounded.reduce((sum, draft) => sum + draft.vocFrequency, 0);
  const shareOf = (draft: (typeof drafts)[number]) =>
    draft.extrapolated
      ? projectedShare
      : totalFrequency > 0
        ? (groundedPool * draft.vocFrequency) / totalFrequency
        : groundedPool / grounded.length;

  return drafts.map((draft) => {
    const weights = { ...draft.answer.weights, other: OTHER_PRIOR_WEIGHT };
    const row: SegmentRow = {
      segment_id: segmentIdFor(draft.persona.fact_key),
      name: String(draft.persona.details.name ?? draft.persona.fact_key),
      description: draft.answer.description,
      share: shareOf(draft),
      prior_weights: JSON.stringify(weights),
      quotes: JSON.stringify(draft.quotes),
      budget_mean_usd: BUDGET_MEAN_USD,
      budget_sd_usd: BUDGET_SD_USD,
      in_market_rate: draft.inMarketRate,
    };
    return {
      row,
      personaFactId: draft.persona.id,
      extrapolated: draft.extrapolated,
      vocFrequency: draft.vocFrequency,
      quotes: draft.quotes,
      dropped: draft.dropped,
      weights,
    };
  });
}
