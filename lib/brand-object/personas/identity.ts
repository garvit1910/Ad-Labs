/**
 * Persona fact identity across re-synthesis — PURE (callers supply vectors).
 *
 * A grounded persona's fact key was `slugifyLabel(persona.name)`, and the
 * model re-authors that name every run ("Value-Seeking Trial Buyer" →
 * "Value-Wary Trial Buyer", "Keto-Conscious Label Checker" → "Keto/Low-Carb
 * Rule Follower"), so the SAME buyer landed on a new identity each time: the
 * reconciler saw an unrelated key and inserted a parallel row instead of
 * superseding. Candidate rows only stopped accreting because `retireFacts`
 * sweeps unclaimed CANDIDATES — a founder-confirmed persona is never retired,
 * so it accretes a duplicate on every rename, permanently.
 *
 * Persona candidates carry no phrase embeddings (unlike VOC facts, which are
 * built from clustered phrases), which is why they never reached the
 * centroid matcher. Identity here rides the embedding of the persona
 * STATEMENT — `"<name>: <description>"`, the exact text stored on the fact —
 * through the same `assignFactKeys` primitive VOC promotion uses. The name
 * slug survives only as `assignFactKeys`'s missing-vector fallback.
 *
 * Calibrated 2026-07-22 against two real Magic Spoon generations (dev):
 * statement embeddings put every same-buyer rename at 0.79/0.79/0.92 and the
 * closest genuinely different pair at 0.64. Name-only embeddings do NOT
 * separate (one real rename scored 0.61) — the description has to ride along.
 */
import type { CandidateFact, LiveFact } from '../types';
import { assignFactKeys, type ExistingKey } from '../fact-key';
import { UNAWARE_PROJECTION_FACT_KEY } from './prompt';

/**
 * The unaware projection owns a fixed slot key and is matched by neither
 * side: it must never claim a grounded persona's identity, and a grounded
 * persona must never claim the projection slot.
 */
function isProjection(fact: {
  factKey: string;
  details: Record<string, unknown>;
}): boolean {
  return (
    fact.details.extrapolated === true ||
    fact.factKey === UNAWARE_PROJECTION_FACT_KEY
  );
}

/** The stored statement IS the identity text — no separate derivation. */
function identityText(fact: { statement: string }): string {
  return fact.statement;
}

/** Free-text label handed to the slug fallback (the model-authored name). */
function fallbackLabel(candidate: CandidateFact): string {
  const name = candidate.details.name;
  return typeof name === 'string' && name.trim() ? name : candidate.statement;
}

/**
 * Every text whose vector `assignPersonaFactKeys` needs, de-duplicated and in
 * a stable order. The IO layer embeds exactly this list.
 */
export function personaIdentityTexts(
  candidates: CandidateFact[],
  liveFacts: LiveFact[],
): string[] {
  const texts: string[] = [];
  const seen = new Set<string>();
  const add = (text: string) => {
    if (!text || seen.has(text)) return;
    seen.add(text);
    texts.push(text);
  };
  for (const candidate of candidates) {
    if (isProjection(candidate)) continue;
    add(identityText(candidate));
  }
  for (const fact of liveFacts) {
    if (fact.section !== 'persona' || isProjection(fact)) continue;
    add(identityText(fact));
  }
  return texts;
}

/**
 * Re-key grounded persona candidates against the live persona facts. Returns
 * candidates in input order; the projection is passed through untouched. A
 * candidate with no vector (or an existing fact with no vector) degrades to
 * the exact-slug fallback inside `assignFactKeys`, i.e. the pre-matching
 * behavior.
 */
export function assignPersonaFactKeys(params: {
  candidates: CandidateFact[];
  liveFacts: LiveFact[];
  vectorByText: ReadonlyMap<string, number[]>;
  matchCosine: number;
}): CandidateFact[] {
  const { candidates, liveFacts, vectorByText, matchCosine } = params;
  const out = [...candidates];
  const grounded: CandidateFact[] = [];
  const positions: number[] = [];
  candidates.forEach((candidate, index) => {
    if (isProjection(candidate)) return;
    grounded.push(candidate);
    positions.push(index);
  });
  if (grounded.length === 0) return out;

  const existing: ExistingKey[] = liveFacts
    .filter((fact) => fact.section === 'persona' && !isProjection(fact))
    .map((fact) => ({
      factKey: fact.factKey,
      centroid: vectorByText.get(identityText(fact)),
    }));

  const assigned = assignFactKeys(
    grounded.map((candidate) => ({
      label: fallbackLabel(candidate),
      centroid: vectorByText.get(identityText(candidate)),
    })),
    existing,
    { matchCosine },
  );

  assigned.forEach((result, i) => {
    out[positions[i]] = { ...grounded[i], factKey: result.factKey };
  });
  return out;
}
