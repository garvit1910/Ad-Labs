/**
 * Canonicalize the genome's freeform strategy prose into the closed label
 * taxonomies, so generated ads and imported ads accumulate in the SAME
 * `performance_memory` buckets (Workstream B — "one vocabulary").
 *
 * The problem this closes: `own_ad_labels` files every imported ad under
 * `angle_universal` / `persona_universal` enum members, while `genome.angle`
 * and `genome.persona` are free prose ('morning-routine time savings'). Two ads
 * making the same argument landed on two different shelves and neither
 * accumulated. `visual-style.ts` already solved exactly this for the `style`
 * dimension; this is the same move for angle and persona.
 *
 * STRICTLY ADDITIVE. The prose fields are the concept-attribution keys — the
 * composer applies a winning angle VERBATIM and rewording it forks the
 * dimension value (see brief-composer.ts). Nothing here rewrites them; the
 * canonical value is a SECOND field. One field for creativity, one for
 * accounting.
 *
 * TOTAL BY CONSTRUCTION. Both resolvers always return a legal enum member,
 * flooring to `'other'`. That totality is what makes it safe to add these to
 * `REQUIRED_GENOME_FIELDS`, since `genome_complete` is a hard, non-repairable
 * kill gate — a resolver that could return undefined would zero paid runs.
 *
 * PURE — no IO, no clock, no randomness, no LLM. v1 is a deterministic ladder;
 * every result carries the `rung` that produced it so the unresolved share is
 * MEASURABLE before anyone pays for a model call. `'llm'` is reserved in
 * `CanonicalRung` as the seam: when it lands it slots between `keyword` and
 * `other`, and nothing else in this module needs to change.
 */

import {
  ANGLES,
  PERSONAS,
  type Angle,
  type Persona,
} from '@/services/ad-library/label-taxonomy';
import {
  universalAngleFor,
  universalPersonaFor,
} from '@/lib/brand-identity/industry-taxonomy';

/**
 * Which rule produced a canonical value. Stamped as provenance so "how much of
 * the corpus did we actually resolve" is a query, not a guess.
 *
 * `llm` is declared but never produced in v1 (the fallback seam).
 */
export type CanonicalRung =
  | 'enum' // the prose was already a global taxonomy member
  | 'taxonomy' // a high-resolution industry token rolled up
  | 'directive' // matched deterministicAngleDirective's fixed template
  | 'blueprint' // matched a fixed composer blueprint string
  | 'keyword' // matched the keyword ladder
  | 'age_range' // persona only: read a stated age range/decade
  | 'llm' // RESERVED — not produced in v1
  | 'other'; // floor: genuinely unresolved

export interface CanonicalResult<T> {
  value: T;
  rung: CanonicalRung;
}

const ANGLE_SET = new Set<string>(ANGLES);
const PERSONA_SET = new Set<string>(PERSONAS);

/** Lowercase + collapse whitespace. Never mutates the caller's prose. */
function normalize(input: string | null | undefined): string {
  return (input ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Snake-case a humanized token back to its taxonomy form. */
function tokenize(input: string): string {
  return input.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/* ── Angle ───────────────────────────────────────────────────────────────── */

/**
 * The exact template `deterministicAngleDirective` emits. Kept as a prefix +
 * suffix pair rather than a regex over the whole sentence so an edit to that
 * template breaks the pinned test loudly instead of silently degrading every
 * strategy-driven angle to the `other` floor.
 */
const ANGLE_DIRECTIVE_PREFIX = 'lead with the ';
const ANGLE_DIRECTIVE_SUFFIX = ' angle proven by winning ads in this market';

/**
 * The composer's brand-summary rung: `Lead with the edge: {competitiveAdvantage}`.
 * The advantage itself is free prose, so the prefix is stripped and the
 * REMAINDER goes through the keyword ladder — the prefix carries no meaning of
 * its own and would otherwise block every such angle from matching a keyword.
 */
const ANGLE_EDGE_PREFIX = 'lead with the edge: ';

/** The four fixed `GOAL_STRATEGIES[goal].angle` strings (brief-composer.ts). */
const ANGLE_BLUEPRINTS: Record<string, Angle> = {
  'introduce the brand with a memorable, identity-forward first impression':
    'status',
  'drive immediate action with concrete value and a clear offer': 'price_value',
  'spark a reaction with a relatable, conversation-starting moment': 'other',
  'create curiosity that only a click resolves': 'other',
};

/**
 * High-precision cues only. A wrong universal pools two unrelated arms, which
 * is strictly worse than leaving an ad unpooled — so this ladder is
 * deliberately shy. Order matters: the first match wins.
 */
const ANGLE_KEYWORDS: Array<[Angle, readonly string[]]> = [
  ['time_saving', ['saves time', 'time saving', 'time-saving', 'in minutes', 'faster than', 'skip the']],
  ['price_value', ['discount', 'cheaper', 'affordab', 'save money', 'price', 'value for', 'worth it', 'pays for itself']],
  ['pain_relief', ['pain', 'relief', 'stop suffering', 'struggle with', 'frustrat', 'fix the', 'no more']],
  ['health', ['health', 'nutrition', 'wellness', 'energy', 'immune', 'sleep better', 'clinically']],
  ['trust_safety', ['safe', 'safety', 'trusted', 'guarantee', 'certified', 'dermatologist', 'non-toxic', 'sustainab']],
  ['status', ['luxur', 'premium', 'status', 'stand out', 'look good', 'style', 'gift']],
  ['convenience', ['convenien', 'effortless', 'one step', 'hassle', 'easy to', 'on the go']],
];

export interface CanonicalAngleInput {
  /** The genome/brief angle prose. */
  angle: string | null | undefined;
  /**
   * `SelectedStrategy.angleKey` when the run had one — the strongest signal
   * available, because it is the STRUCTURED key the directive was rendered
   * from. Ignored unless it is a real taxonomy token ('explicit', 'own_prior'
   * and 'goal_blueprint' are control values, not vocabulary).
   */
  angleKey?: string | null;
}

const ANGLE_KEY_CONTROL_VALUES = new Set(['explicit', 'own_prior', 'goal_blueprint']);

/** Resolve the genome's angle prose to a global `ANGLES` member. Total. */
export function canonicalAngleUniversal(
  input: CanonicalAngleInput
): CanonicalResult<Angle> {
  const prose = normalize(input.angle);

  // 1. Already a global member (idempotent — re-runs and the backfill).
  if (ANGLE_SET.has(tokenize(prose))) {
    return { value: tokenize(prose) as Angle, rung: 'enum' };
  }

  // 2. Structured provenance: the strategy layer's own key. Strongest signal,
  //    and free — no string parsing involved.
  const key = (input.angleKey ?? '').trim().toLowerCase();
  if (key.length > 0 && !ANGLE_KEY_CONTROL_VALUES.has(key)) {
    const fromKey = universalAngleFor(key);
    if (fromKey) return { value: fromKey, rung: 'taxonomy' };
  }

  // 3. The prose IS the deterministic directive — recover the token it was
  //    rendered from. Covers runs whose angleKey did not travel with the prose.
  if (prose.startsWith(ANGLE_DIRECTIVE_PREFIX) && prose.endsWith(ANGLE_DIRECTIVE_SUFFIX)) {
    const humanized = prose.slice(
      ANGLE_DIRECTIVE_PREFIX.length,
      prose.length - ANGLE_DIRECTIVE_SUFFIX.length
    );
    const fromDirective = universalAngleFor(tokenize(humanized));
    if (fromDirective) return { value: fromDirective, rung: 'directive' };
  }

  // 4. A fixed goal-blueprint string (the no-evidence fallback path).
  const blueprint = ANGLE_BLUEPRINTS[prose];
  if (blueprint) return { value: blueprint, rung: 'blueprint' };

  // 5. Keyword ladder over human-typed prose. The brand-summary template's
  //    fixed prefix is stripped first so the advantage text itself can match.
  const keywordText = prose.startsWith(ANGLE_EDGE_PREFIX)
    ? prose.slice(ANGLE_EDGE_PREFIX.length)
    : prose;
  for (const [value, needles] of ANGLE_KEYWORDS) {
    if (needles.some((needle) => keywordText.includes(needle))) {
      return { value, rung: 'keyword' };
    }
  }

  // 6. Floor. `other` is a legal member and an honest answer.
  return { value: 'other', rung: 'other' };
}

/* ── Persona ─────────────────────────────────────────────────────────────── */

/**
 * The composer's own no-audience fallback (`People shopping for {category}`).
 * It carries no demographic claim at all, so `general_broad` is exact rather
 * than a guess.
 */
const PERSONA_BLUEPRINT_PREFIX = 'people shopping for ';

/**
 * Demographic cues. The global persona vocabulary is age/life-stage based while
 * brand-object personas are written as buyer archetypes, so this reads the FULL
 * `"{name}: {description}"` text — the description is where the age language
 * lives. Order matters: parents outrank age bands (a "busy mom in her 30s" is
 * shopping as a parent), and the explicit-breadth cues run last so they cannot
 * swallow a more specific match.
 */
const PERSONA_KEYWORDS: Array<[Persona, readonly string[]]> = [
  ['parents_family', ['parent', 'mom', 'mum', 'dad', 'mother', 'father', 'family', 'kids', 'children', 'toddler', 'newborn', 'caregiver']],
  ['seniors', ['senior', 'retire', 'elderly', 'older adult', '65+', 'over 65', 'golden years']],
  ['midlife_adults', ['midlife', 'mid-life', 'middle-aged', 'middle aged', 'in their 40s', 'in their 50s', '40s and 50s', 'perimenopaus', 'menopaus', 'empty nest']],
  ['young_adults', ['gen z', 'genz', 'college', 'student', 'young adult', 'in their 20s', 'twenty-somethin', 'teen', 'young women', 'young men']],
  ['professionals', ['professional', 'career', 'office worker', 'founder', 'entrepreneur', 'freelance', 'executive', 'manager', 'commuter', 'nine-to-five', '9-to-5', 'desk job', 'remote worker']],
  ['general_broad', ['everyone', 'anyone', 'general audience', 'broad audience', 'all ages', 'shoppers', 'consumers']],
];

/**
 * Brand-object persona descriptions state ages numerically far more often than
 * they use the words this ladder's keywords look for — "A 20–34 skincare-obsessed
 * woman", "A 28–45-year-old who tracks protein", "Adults 25–45". Reading those
 * is a cheap, high-precision rung; without it every such persona floored to
 * `'other'` on real data.
 *
 * Deliberately placed AFTER the keyword ladder: explicit demographic language
 * ("busy parents", "founders") is a stronger claim about who the ad speaks to
 * than an inferred age band, so it must win.
 */
const AGE_BAND_BOUNDS: Array<[Persona, number, number]> = [
  ['young_adults', 0, 29],
  ['midlife_adults', 30, 59],
  ['seniors', 60, 200],
];

function bandForAge(age: number): Persona | null {
  return AGE_BAND_BOUNDS.find(([, lo, hi]) => age >= lo && age <= hi)?.[0] ?? null;
}

/**
 * Read an age claim out of persona prose. A range whose endpoints fall in
 * DIFFERENT bands resolves to `general_broad` rather than picking one — an ad
 * written for 25-to-45-year-olds genuinely does address a broad adult audience,
 * and inventing a band there would be a fabricated demographic claim.
 * Handles hyphen, en-dash and em-dash ranges plus bare decade mentions.
 */
function ageBandFor(prose: string): Persona | null {
  const range = prose.match(/\b(\d{2})\s*[-–—]\s*(\d{2})\b/);
  if (range) {
    const low = bandForAge(Number(range[1]));
    const high = bandForAge(Number(range[2]));
    if (low && high) return low === high ? low : 'general_broad';
  }
  const decade = prose.match(/\b(\d0)s\b/);
  if (decade) return bandForAge(Number(decade[1]));
  return null;
}

export interface CanonicalPersonaInput {
  /**
   * The genome/brief persona prose. In brand mode this is
   * `"{persona.name}: {persona.description}"` — pass the WHOLE string; the
   * description carries the demographic language the name usually omits.
   */
  persona: string | null | undefined;
}

/** Resolve the genome's persona prose to a global `PERSONAS` member. Total. */
export function canonicalPersonaUniversal(
  input: CanonicalPersonaInput
): CanonicalResult<Persona> {
  const prose = normalize(input.persona);

  // 1. Already a global member.
  if (PERSONA_SET.has(tokenize(prose))) {
    return { value: tokenize(prose) as Persona, rung: 'enum' };
  }

  // 2. A high-resolution industry persona token.
  const fromToken = universalPersonaFor(tokenize(prose));
  if (fromToken) return { value: fromToken, rung: 'taxonomy' };

  // 3. The composer's own fallback template — no demographic claim made.
  if (prose.startsWith(PERSONA_BLUEPRINT_PREFIX)) {
    return { value: 'general_broad', rung: 'blueprint' };
  }

  // 4. Demographic keyword ladder over the full persona text.
  for (const [value, needles] of PERSONA_KEYWORDS) {
    if (needles.some((needle) => prose.includes(needle))) {
      return { value, rung: 'keyword' };
    }
  }

  // 5. A stated age range or decade, when no stronger cue was present.
  const band = ageBandFor(prose);
  if (band) return { value: band, rung: 'age_range' };

  // 6. Floor.
  return { value: 'other', rung: 'other' };
}
