/**
 * Persona-synthesis pack — PURE. The model may ONLY reference facts supplied
 * here (fact ids are validated on the way back) and may only quote verbatims
 * this pack carries (substring-verified on the way back). Fingerprint =
 * live-fact identity set, so personas re-synthesize only when the underlying
 * facts actually changed.
 */
import { createHash } from 'node:crypto';
import { isQuoteInMerchantLanguage } from '../quote-language';
import type { LiveFact } from '../types';

export interface PersonaPackFact {
  id: string;
  section: string;
  statement: string;
  frequency?: number;
  verbatims: string[];
}

export interface PersonaPack {
  system: string;
  user: string;
  fingerprint: string;
  factIds: Set<string>;
  /** Every verbatim the model is allowed to echo, for the return gate. */
  allowedVerbatims: string[];
  vocCount: number;
  identityCount: number;
}

export function buildPersonaPack(
  brand: { name: string; category: string | null },
  liveFacts: LiveFact[],
): PersonaPack {
  const packFacts: PersonaPackFact[] = liveFacts.map((fact) => ({
    id: fact.id,
    section: fact.section,
    statement: fact.statement,
    frequency: fact.metrics.frequency,
    // The model may only echo what a reader could be shown, so a quote in
    // another language never reaches the pack (nor, via the return gate, a
    // stored persona).
    verbatims: fact.evidence
      .map((ref) => ref.quote)
      .filter((quote): quote is string => Boolean(quote))
      .filter((quote) => isQuoteInMerchantLanguage(quote)),
  }));

  const vocCount = packFacts.filter((fact) =>
    fact.section.startsWith('voc_'),
  ).length;
  const identityCount = packFacts.filter((fact) =>
    ['positioning', 'value_prop', 'usp', 'proof_point', 'voice'].includes(
      fact.section,
    ),
  ).length;

  const system = [
    'You are a customer researcher synthesizing buyer personas from an',
    "evidence-backed brand model. Build 2-4 DISTINCT personas grounded ONLY in",
    'the supplied facts. Every pain/desire/objection you assign MUST reference',
    'the fact_id it came from (facts are the only evidence that exists).',
    'Verbatims may ONLY be copied character-for-character from the verbatims',
    'arrays in the facts — never invent or paraphrase a quote. Order each',
    "persona's verbatims best-first, where the best quote PORTRAYS THAT BUYER —",
    'their situation, need, or verdict in their own voice. Praise and criticism',
    'both qualify; what does not is a line aimed AT the brand rather than about',
    'the customer (shipping or stock questions, feature requests, warnings to',
    'other shoppers, shouted defect callouts). Assign each persona one Schwartz',
    'awareness stage: problem_aware | solution_aware | product_aware |',
    'most_aware — someone whose words were observed cannot be unaware, so',
    'never use unaware for these personas. Spread personas across DISTINCT',
    'stages wherever the evidence supports it: repeat buyers, loyal fans, and',
    'strong recommenders are most_aware — do not cluster every persona in one',
    'stage when the facts show buyers at different distances from purchase.',
    'SEPARATELY, build unaware_projection: ONE projected persona for the',
    'unaware stage — the same buyers BEFORE they recognized the problem,',
    'extrapolated backward from the same facts. Its pains reference the',
    'fact_ids of problems this person has NOT YET recognized (write each note',
    'in that latent framing, e.g. "eats sugary cereal daily without clocking',
    'the crash"); its desires are the surface-level desires that exist before',
    'problem awareness (taste, convenience, familiarity, price). Only include',
    "verbatims that narrate the buyer's life BEFORE discovery; most",
    'projections have none and an empty array is correct. Set',
    'unaware_projection to null only when the facts give no basis to project',
    'one.',
  ].join(' ');

  const user = JSON.stringify(
    {
      brand: { name: brand.name, category: brand.category },
      facts: packFacts,
    },
    null,
    2,
  );

  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify(
        liveFacts.map((fact) => [fact.id, fact.validFrom]).sort(),
      ),
    )
    .digest('hex');

  return {
    system,
    user,
    fingerprint,
    factIds: new Set(packFacts.map((fact) => fact.id)),
    allowedVerbatims: packFacts.flatMap((fact) => fact.verbatims),
    vocCount,
    identityCount,
  };
}
