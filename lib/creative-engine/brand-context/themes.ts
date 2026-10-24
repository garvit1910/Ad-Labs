/**
 * Deterministic THEME derivation for brand-context fact rows — PURE, zero
 * LLM, fixed vocabulary.
 *
 * WHY: pack fact selection was pure priority order, so a run angled at
 * `natural_ingredients` got the same three facts as a run angled at
 * `price_value`. Themes are derived ONCE at INGEST time (store-write time —
 * the compiler stays a pure function of its inputs) and ride `tagFilters`
 * as a fifth axis. The compiler uses a theme match as a RANKING TIER inside
 * `selectFacts`, never as a filter: `rowMatchesSpec` deliberately does not
 * enumerate the themes axis, because exclusionary semantics would HIDE a
 * themed fact from every run that does not share its theme — the exact
 * opposite of the goal.
 *
 * Vocabulary = the universal `ANGLES` (minus `other`) plus every
 * `INDUSTRY_ANGLES` value, so a theme key is always a taxonomy angle value
 * the strategy selector can produce. Keyword lists are built MECHANICALLY
 * from the angle slug tokens + its `ANGLE_LABELS` display tokens, then
 * corrected by a curated overlay: a stopword set removes bare tokens that
 * appear in ordinary marketing prose (`value`, `status`, `results`, …) and
 * per-theme synonyms fill in where the slug tokens are too narrow.
 *
 * Matching is biased toward FALSE NEGATIVES: an unmatched fact simply falls
 * back to priority order, while a false positive jumps the queue ahead of a
 * higher-priority fact.
 */
import { ANGLES } from '@/services/ad-library/label-taxonomy';
import {
  ANGLE_LABELS,
  INDUSTRY_ANGLES,
} from '@/lib/brand-identity/industry-vocabulary';
import { isKnownAngle } from '@/lib/brand-identity/industry-taxonomy';
import type { UpstreamFact } from './ingest';

/**
 * The ONLY upstream sections whose facts carry themes. Grounding-appropriate
 * copy sources only: `market_prior` / `competitor_intel` statements are
 * market-share prose (a theme boost would promote them into copy-grounding
 * slots), and `voc_objection` is a thing NOT to say. Voice/rule/asset/persona
 * rows are never themed at all (their slots ignore themes).
 */
export const THEMED_FACT_SECTIONS = [
  'positioning',
  'proof_point',
  'usp',
  'value_prop',
  'voc_desire',
  'voc_pain',
  'voc_praise',
] as const;

const THEMED_FACT_SECTION_SET = new Set<string>(THEMED_FACT_SECTIONS);

/**
 * Bare tokens the mechanical build would emit that are too common in ad
 * prose to carry signal. Multiword phrases are never stopworded — a phrase
 * is already specific. Dropping a token here is safe: the theme keeps its
 * phrase form plus whatever the curated overlay adds.
 */
const GENERIC_TOKEN_STOPWORDS = new Set<string>([
  // Structural filler produced by label tokenization.
  'and',
  'of',
  'on',
  'or',
  'the',
  'with',
  'your',
  // Generic marketing vocabulary — each is replaced by a phrase below.
  'anti',
  'care',
  'fast',
  'free',
  'other',
  'problem',
  'result',
  'results',
  'safety',
  'saving',
  'savings',
  'self',
  'speed',
  'status',
  'support',
  'time',
  'use',
  'value',
]);

/**
 * Per-theme synonym additions. Curated because slug/label tokens alone are
 * either too narrow (`natural_ingredients` never literally says "natural
 * ingredients" in a real fact) or were stopworded above.
 */
const CURATED_THEME_KEYWORDS: Record<string, readonly string[]> = {
  // ── Universal ─────────────────────────────────────────────────────────
  pain_relief: ['relieve', 'relieves', 'soothe', 'soothes', 'ache', 'aches'],
  convenience: ['convenient', 'effortless', 'hassle', 'no fuss', 'on the go'],
  price_value: ['affordable', 'cheap', 'save money', 'budget', 'worth every'],
  status: ['status symbol', 'turn heads', 'prestige', 'luxury'],
  health: ['healthy', 'wellness', 'nutrition'],
  time_saving: [
    'saves time',
    'save time',
    'in minutes',
    'in seconds',
    'minutes a day',
  ],
  trust_safety: ['trusted', 'guarantee', 'certified', 'money back'],
  // ── Accessories / jewelry / clothing / shoes ──────────────────────────
  everyday_versatility: ['every day', 'goes with everything'],
  style_upgrade: ['elevate', 'upgrade your'],
  organization: ['organize', 'organized', 'clutter', 'tidy'],
  gifting: ['gift', 'gifts', 'gift ready'],
  durability: ['durable', 'built to last', 'lasts', 'wear and tear'],
  self_expression: ['express yourself', 'personality', 'individuality'],
  milestone_occasion: ['anniversary', 'birthday', 'wedding', 'engagement'],
  heirloom: ['generations', 'pass down', 'lifetime'],
  craftsmanship: ['handcrafted', 'hand crafted', 'artisan', 'crafted'],
  ethics_provenance: ['ethically sourced', 'conflict free', 'traceable'],
  self_reward: ['treat yourself', 'deserve'],
  everyday_luxury: ['everyday luxury', 'affordable luxury'],
  personalization: ['personalized', 'custom', 'engraved', 'monogram'],
  comfort: ['comfortable', 'all day comfort'],
  style_statement: ['statement piece', 'stand out'],
  versatility: ['versatile', 'mix and match'],
  support_health: ['arch support', 'foot pain', 'plantar', 'posture'],
  fit_flattering: ['flatters', 'true to size', 'perfect fit'],
  style_trend: ['trending', 'trendy', 'on trend'],
  sustainability: ['sustainable', 'eco friendly', 'recycled', 'compostable'],
  occasion_dressing: ['dress up', 'wedding guest', 'night out'],
  // ── Beauty / health ───────────────────────────────────────────────────
  transformation: ['before and after', 'transform', 'transformed'],
  anti_aging: ['wrinkle', 'wrinkles', 'fine lines', 'youthful'],
  natural_ingredients: [
    'organic',
    'clean',
    'plant based',
    'no artificial',
    'non gmo',
    'botanical',
  ],
  glow_radiance: ['glowing', 'glowy', 'dewy', 'luminous', 'radiant'],
  problem_skin: ['acne', 'breakout', 'breakouts', 'blemish', 'blemishes'],
  self_care: ['self care', 'ritual', 'me time', 'pamper'],
  cruelty_free: ['vegan', 'not tested on animals'],
  results_speed: [
    'fast results',
    'visible results',
    'in just days',
    'overnight',
  ],
  symptom_relief: ['symptoms', 'flare up'],
  prevention: ['prevent', 'prevents', 'preventive'],
  energy_vitality: ['energized', 'fatigue', 'sluggish'],
  clinically_backed: [
    'clinical',
    'clinically',
    'clinically proven',
    'peer reviewed',
    'randomized',
  ],
  // ── Electronics / gaming / software ───────────────────────────────────
  performance_power: ['powerful', 'horsepower', 'throughput'],
  innovation: ['innovative', 'breakthrough', 'next generation'],
  reliability: ['reliable', 'never fails', 'uptime'],
  ecosystem: ['works with', 'ecosystem'],
  portability: ['portable', 'pocket', 'travel ready', 'lightweight'],
  immersion: ['immersive'],
  competition: ['competitive', 'leaderboard', 'ranked'],
  social_play: ['multiplayer', 'with friends'],
  exclusivity: ['exclusive', 'limited edition', 'members only'],
  nostalgia: ['nostalgic', 'retro', 'throwback'],
  productivity: ['productive', 'get more done', 'output'],
  automation: ['automate', 'automated', 'automatic', 'manual work'],
  cost_saving: ['save money', 'cut costs', 'lower cost', 'cheaper'],
  ease_of_use: ['easy', 'simple', 'intuitive', 'no setup', 'learning curve'],
  scalability: ['scale', 'scales', 'grows with'],
  security: ['secure', 'encrypted', 'compliance'],
  integration: ['integrates', 'integrations', 'connects with'],
  // ── Automotive / home / pets / sport / food ───────────────────────────
  performance: ['high performance', 'outperforms'],
  safety: ['safe', 'protects', 'peace of mind', 'accident'],
  protection: ['protect', 'protects', 'shields', 'scratch'],
  tech_innovation: ['smart', 'connected'],
  value_retention: ['resale', 'holds its value', 'depreciation'],
  lifestyle: ['lifestyle'],
  motivation: ['motivated', 'motivating', 'keeps you going'],
  recovery: ['recover', 'sore', 'soreness', 'rest day'],
  community: ['community', 'members'],
  results_transformation: ['body transformation', 'lost weight', 'gains'],
  comfort_coziness: ['cozy', 'snug', 'warm'],
  aesthetics_decor: ['aesthetic', 'decorate', 'interior'],
  space_saving: ['compact', 'small spaces', 'fits anywhere', 'foldable'],
  pet_health: ['vet', 'veterinarian', 'coat and skin'],
  pet_happiness: ['tail wag', 'happy pup', 'playtime'],
  bonding: ['bond', 'bonds', 'together'],
  taste_indulgence: ['delicious', 'tastes', 'flavor', 'indulgent', 'craveable'],
  health_nutrition: ['protein', 'fiber', 'vitamins', 'macros'],
  natural_clean: [
    'clean',
    'grass fed',
    'no artificial',
    'no fillers',
    'real ingredients',
    'whole food',
  ],
  craving: ['cravings', 'crave', 'snack attack'],
  dietary_fit: [
    'gluten free',
    'keto',
    'paleo',
    'vegan',
    'dairy free',
    'whole30',
    'allergen',
  ],
  // ── Books / services ──────────────────────────────────────────────────
  knowledge_growth: ['learn', 'master'],
  escapism: ['escape', 'another world'],
  inspiration: ['inspiring', 'inspired'],
  self_improvement: ['better habits', 'level up'],
  entertainment: ['entertaining', 'binge'],
  expertise: ['expert', 'experts', 'years of experience'],
  results_outcome: ['outcomes', 'proven results'],
  trust_credibility: ['trusted', 'reviews', 'rated', 'testimonials'],
};

/** Every taxonomy angle value we tag with — `other` is deliberately absent. */
function themeKeys(): string[] {
  const values = new Set<string>([
    ...ANGLES,
    ...Object.values(INDUSTRY_ANGLES).flat(),
  ]);
  values.delete('other');
  return [...values].sort();
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * Mechanical keyword build for ONE theme: slug tokens + label tokens (both
 * stopword-filtered) + the humanized slug/label as multiword phrases +
 * the curated overlay. Deduped and sorted so the vocabulary is stable.
 */
function keywordsFor(theme: string): string[] {
  const slugTokens = tokenize(theme);
  const labelTokens = tokenize(ANGLE_LABELS[theme] ?? '');
  const keywords = new Set<string>();
  for (const token of [...slugTokens, ...labelTokens]) {
    if (!GENERIC_TOKEN_STOPWORDS.has(token)) keywords.add(token);
  }
  // Multiword phrases: specific by construction, never stopworded.
  if (slugTokens.length > 1) keywords.add(slugTokens.join(' '));
  if (labelTokens.length > 1) keywords.add(labelTokens.join(' '));
  for (const extra of CURATED_THEME_KEYWORDS[theme] ?? []) {
    const normalized = tokenize(extra).join(' ');
    if (normalized.length > 0) keywords.add(normalized);
  }
  return [...keywords].sort();
}

/**
 * theme value → the keyword list that tags a fact with it. Frozen: this IS
 * the vocabulary contract, and a change re-mints the affected rows' content
 * hashes on the next ingest (supersede + insert, self-healing).
 */
export const THEME_VOCABULARY: Record<string, readonly string[]> =
  Object.freeze(
    Object.fromEntries(
      themeKeys().map((theme) => [theme, Object.freeze(keywordsFor(theme))]),
    ),
  );

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Word-boundary matchers, compiled once. The haystack is lowercased and
 * punctuation-normalized before matching, so a phrase's internal spaces are
 * literal and `anti-aging` in prose matches the `anti aging` phrase.
 */
const THEME_MATCHERS: Array<{ theme: string; patterns: RegExp[] }> =
  Object.entries(THEME_VOCABULARY).map(([theme, keywords]) => ({
    theme,
    patterns: keywords.map(
      (keyword) => new RegExp(`\\b${escapeRegExp(keyword)}\\b`),
    ),
  }));

/** Lowercase, non-alphanumeric runs → single space (underscores included). */
function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The themes a fact row carries, sorted asc. Empty for every non-grounding
 * section (see THEMED_FACT_SECTIONS) and for any statement that matches no
 * vocabulary keyword — an unthemed fact is ranked purely on priority, which
 * is exactly the pre-theme behavior.
 */
export function deriveFactThemes(
  fact: Pick<UpstreamFact, 'section' | 'fact_key' | 'statement'>,
): string[] {
  if (!THEMED_FACT_SECTION_SET.has(fact.section)) return [];
  const haystack = normalizeText(`${fact.statement} ${fact.fact_key}`);
  if (haystack.length === 0) return [];
  const themes: string[] = [];
  for (const { theme, patterns } of THEME_MATCHERS) {
    if (patterns.some((pattern) => pattern.test(haystack))) themes.push(theme);
  }
  return themes.sort();
}

/**
 * The briefs route's spec-side predicate: which taxonomy theme (if any) the
 * run's CompileSpec may carry.
 *
 * Fail-closed on purpose — a theme is stamped ONLY when the composed angle
 * demonstrably came from the strategy selector's taxonomy pick:
 * evidence-tier selection, a real taxonomy angle value (never `explicit` /
 * `own_prior` / `other`), and the composed brief angle equal to the
 * strategy's own directive. An explicit user angle or a verbatim own-prior
 * angle must never be theme-tagged with a value it did not come from.
 */
export function resolveSpecAngleTheme(input: {
  fallbackTier: 'evidence' | 'goal_blueprint';
  angleKey: string;
  angleDirective: string;
  composedAngle: string;
}): string | undefined {
  if (input.fallbackTier !== 'evidence') return undefined;
  const { angleKey } = input;
  if (angleKey === 'other' || !isKnownAngle(angleKey)) return undefined;
  if (!(angleKey in THEME_VOCABULARY)) return undefined;
  if (input.angleDirective.length === 0) return undefined;
  if (input.composedAngle !== input.angleDirective) return undefined;
  return angleKey;
}
