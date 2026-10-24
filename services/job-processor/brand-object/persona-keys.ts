/**
 * The ONE IO step behind persona fact identity: embed the persona statements
 * (candidates + live persona facts) so `assignPersonaFactKeys` can match a
 * re-synthesized persona to the identity it already owns instead of minting a
 * new key from the model's re-authored name.
 *
 * Cost: one embeddings request over ≤ ~10 short statements per persona run
 * (text-embedding-3-small, well under $0.001) — deliberately NOT counted on
 * the monthly LLM call meter, which exists to cap chat completions. It runs
 * only AFTER the budget-gated persona call, so it can never fire on a run the
 * budget already refused.
 *
 * FAILS OPEN: an embeddings outage must not fail an otherwise-complete
 * synthesis, so a failure degrades to the model-authored name slug — the
 * pre-matching behavior — and the next successful run re-converges.
 */
import {
  assignPersonaFactKeys,
  personaIdentityTexts,
} from '@/lib/brand-object/personas/identity';
import type { CandidateFact, LiveFact } from '@/lib/brand-object/types';
import { embedTexts } from '@/services/ad-library/embeddings';

export async function keyPersonaCandidates(params: {
  candidates: CandidateFact[];
  /** Live facts of section 'persona' for this brand. */
  liveFacts: LiveFact[];
  matchCosine: number;
  signal?: AbortSignal;
  /** Log prefix from the calling processor. */
  label: string;
  embed?: typeof embedTexts;
}): Promise<CandidateFact[]> {
  const texts = personaIdentityTexts(params.candidates, params.liveFacts);
  if (texts.length === 0) return params.candidates;

  const embed = params.embed ?? embedTexts;
  let vectors: number[][];
  try {
    vectors = await embed(texts, {
      signal: params.signal,
      retryProfile: 'background',
    });
  } catch (error) {
    console.warn(
      `${params.label}: persona identity embedding failed — falling back to ` +
        `name-slug keys (a renamed persona may insert a new identity)`,
      error,
    );
    return params.candidates;
  }

  const vectorByText = new Map<string, number[]>();
  texts.forEach((text, i) => {
    const vector = vectors[i];
    if (vector?.length) vectorByText.set(text, vector);
  });

  return assignPersonaFactKeys({
    candidates: params.candidates,
    liveFacts: params.liveFacts,
    vectorByText,
    matchCosine: params.matchCosine,
  });
}
