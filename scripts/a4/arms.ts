import type { InsightFact } from '@/lib/brand-object/insights';
import { compareVocRank } from '@/lib/brand-object/voc-rank';
import { pickVocVerbatim } from '@/lib/brand-object/voc-verbatim';
import { buildWinnerEvaluator, type WinnerEvalRow } from '@/lib/brand-identity/dashboard';
import { buildOverIndexBy } from '@/lib/brand-identity/media-quadrants';
import type { EnrichedAdRow, OverIndexRow } from '@/lib/brand-identity/types';
import type { LabelledAd, LiveCreatives, Page } from './live-ads';
import type { ChatMessage, Llm } from './llm';
import { ANGLES, CONTROL_ARM_ID, armIdFor, type FactHints, allowedHooks, hookRequirement } from './vocabulary';

/*
 * The recipes: steal, double_down and gap arms plus the control (docs/PLAN.md
 * "A4", arm builder rules). Steal and double_down are deterministic picks over the
 * labelled ads; one strict-JSON LLM call writes every rationale and picks the gaps.
 */

export interface ArmRow {
  arm_id: string;
  angle: string;
  hook: string;
  strategy: string;
  rationale: string;
  evidence: string;
}

export interface ArmReport {
  row: ArmRow;
  /** One line of the numbers behind the pick. */
  basis: string;
  /** The fact that met the hook's HOOK_PRODUCIBILITY requirement, if it has one. */
  requirement: string;
  evidenceIds: string[];
}

const STEAL_TARGET = 5;
const STEAL_MIN_WINNERS = 2;
const DOUBLE_DOWN_TARGET = 3;
const GAP_TARGET = 3;
const GAP_MIN = 2;
const GAP_ASK = 4;
const MIN_RECIPES = 10;
const MAX_RECIPES = 12;
const MIN_WINNERS_FOR_PAIRS = 5;
const EVIDENCE_CAP = 10;
const CONTROL_RATIONALE = "Magic Spoon's own live Meta ads, unchanged: the baseline every recipe has to beat.";

const pairKey = (angle: string, hook: string) => `${angle}|${hook}`;
const splitPair = (pair: string) => pair.split('|') as [string, string];

interface Candidate {
  angle: string;
  hook: string;
  strategy: 'steal' | 'double_down' | 'gap';
  basis: string;
  evidenceIds: string[];
  /** Short evidence the LLM writes the rationale from. */
  brief: Record<string, unknown>;
}

function uniqueIds(ids: Array<string | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

/** Steal candidates: (angle, hook) pairs by winner lift across competitor ads, with ≥ 2 winners each. */
function stealCandidates(competitorAds: LabelledAd[], pages: Page[], live: LiveCreatives, allowed: Set<string>, log: (message: string) => void) {
  const pageOf = new Map(pages.map((page) => [page.id, page]));
  const evaluator = buildWinnerEvaluator(
    competitorAds as unknown as WinnerEvalRow[],
    new Map(pages.map((page) => [page.id, page.brandType])),
  );
  const isWinner = (ad: LabelledAd) => evaluator.isWinner(ad as unknown as WinnerEvalRow);
  const winners = competitorAds.filter(isWinner);
  const rows = competitorAds as unknown as EnrichedAdRow[];
  const usable = (angle: string | null, hook: string | null) => Boolean(angle && hook && ANGLES.includes(angle) && allowed.has(hook));
  const winnersOf = (match: (ad: LabelledAd) => boolean) =>
    winners.filter(match).sort((a, b) => b.longevity_days - a.longevity_days || a.id.localeCompare(b.id));

  const toCandidate = (angle: string, hook: string, row: OverIndexRow | null, adsBehind: LabelledAd[]): Candidate => {
    const brands = [...new Set(adsBehind.map((ad) => pageOf.get(ad.competitor_id)?.name ?? '?'))];
    const lift = row ? row.lift.toFixed(2) : 'n/a';
    return {
      angle,
      hook,
      strategy: 'steal',
      basis: `${adsBehind.length} winning competitor ads (${brands.join(', ')}), lift ${lift}${row ? `, ${row.winnerCount}/${row.totalCount} of the pair's ads win` : ''}`,
      evidenceIds: uniqueIds(adsBehind.map((ad) => live.creativeIdForAd.get(ad.id))).slice(0, EVIDENCE_CAP),
      brief: {
        winning_ads: adsBehind.length,
        ads_with_this_pair: row?.totalCount ?? null,
        winner_lift: row ? Number(row.lift.toFixed(2)) : null,
        brands,
        example_hooks: adsBehind.slice(0, 2).map((ad) => ad.hook_text ?? '').filter(Boolean),
      },
    };
  };

  // Lift over every labelled competitor ad; the hook filter applies after ranking.
  const pairs = buildOverIndexBy(rows, 'hook_archetype', (row) => (row.angle && row.hook_archetype ? pairKey(row.angle, row.hook_archetype) : null), evaluator);
  const winningPairs = pairs.rows.filter((row) => row.winnerCount > 0);
  log(`steal: ${winners.length} winners among ${competitorAds.length} competitor ads, ${winningPairs.length} winning (angle, hook) pairs`);

  if (winners.length >= MIN_WINNERS_FOR_PAIRS) {
    const candidates = pairs.rows
      .filter((row) => row.winnerCount >= STEAL_MIN_WINNERS)
      .filter((row) => {
        const [angle, hook] = splitPair(row.label);
        if (usable(angle, hook)) return true;
        log(`steal: skip ${row.label} (${row.winnerCount} winners): ${ANGLES.includes(angle) ? 'hook not producible or unbacked' : 'angle not a food token'}`);
        return false;
      })
      .map((row) => {
        const [angle, hook] = splitPair(row.label);
        return toCandidate(angle, hook, row, winnersOf((ad) => ad.angle === angle && ad.hook_archetype === hook));
      });
    return { candidates, winningPairs };
  }

  // Too few winners for pairs: pair the dashboard's top over-index angles and hooks instead.
  log(`steal: fewer than ${MIN_WINNERS_FOR_PAIRS} winners, using the single-dimension over-index rows`);
  const angleRows = buildOverIndexBy(rows, 'angle', (row) => (row.angle && ANGLES.includes(row.angle) ? row.angle : null), evaluator).rows;
  const hookRows = buildOverIndexBy(rows, 'hook_archetype', (row) => (row.hook_archetype && allowed.has(row.hook_archetype) ? row.hook_archetype : null), evaluator).rows;
  const combos = angleRows.flatMap((angle, i) => hookRows.map((hook, j) => ({ angle: angle.label, hook: hook.label, rank: i + j })));
  const candidates = combos
    .sort((a, b) => a.rank - b.rank)
    .map(({ angle, hook }) => toCandidate(angle, hook, null, winnersOf((ad) => ad.angle === angle || ad.hook_archetype === hook)));
  return { candidates, winningPairs };
}

/** double_down candidates: Magic Spoon's own pairs, longest-running first. */
function doubleDownCandidates(selfAds: LabelledAd[], live: LiveCreatives, allowed: Set<string>): Candidate[] {
  const groups = new Map<string, LabelledAd[]>();
  for (const ad of selfAds) {
    if (!ad.angle || !ad.hook_archetype || !ANGLES.includes(ad.angle) || !allowed.has(ad.hook_archetype)) continue;
    const key = pairKey(ad.angle, ad.hook_archetype);
    groups.set(key, [...(groups.get(key) ?? []), ad]);
  }
  return [...groups]
    .map(([key, ads]) => {
      const sorted = [...ads].sort((a, b) => b.longevity_days - a.longevity_days || a.id.localeCompare(b.id));
      return { key, ads: sorted, longest: sorted[0].longevity_days, active: ads.filter((ad) => ad.is_active).length };
    })
    .sort((a, b) => b.longest - a.longest || b.ads.length - a.ads.length || b.active - a.active || a.key.localeCompare(b.key))
    .map(({ key, ads, longest, active }) => {
      const [angle, hook] = splitPair(key);
      return {
        angle,
        hook,
        strategy: 'double_down' as const,
        basis: `Magic Spoon's longest run ${longest} days, ${ads.length} of its ads (${active} active)`,
        evidenceIds: uniqueIds(ads.map((ad) => live.creativeIdForAd.get(ad.id))).slice(0, EVIDENCE_CAP),
        brief: {
          longest_running_days: longest,
          magic_spoon_ads: ads.length,
          active,
          example_headlines: ads.slice(0, 2).map((ad) => ad.creative_link_titles?.[0] ?? ad.hook_text ?? '').filter(Boolean),
        },
      };
    });
}

function systemPrompt(): string {
  return [
    "You help plan an ad test for Magic Spoon, a high-protein, low-sugar cereal brand. Each recipe is an angle (the food-industry message token) times a hook (the ad's opening move).",
    '',
    'Do two things.',
    '',
    '1. rationales: for every recipe given, one or two sentences (at most 240 characters) on why it is worth testing for Magic Spoon, citing its evidence: the competitors and counts for steal recipes, Magic Spoon\'s own long-running ads for double_down recipes. Plain words, no hype.',
    '',
    '2. gaps: up to 4 new recipes, best first, each answering one customer pain or objection from gap_candidates that none of the competitor_winning_pairs addresses.',
    "Pick only problems an ad can credibly answer with one of Magic Spoon's brand_facts (taste, texture, ingredients, sweeteners, diet fit, price or value, trust in the claims). Skip service failures an ad can't fix, such as delivery, billing, refunds or customer support.",
    'Choose an angle from allowed_angles and a hook from allowed_hooks, and do not reuse a pair already in the recipes or another gap. The rationale names the customer problem it answers and the brand fact the ad would lean on.',
  ].join('\n');
}

interface ArmAnswer {
  rationales: Record<string, string>;
  gaps: Array<{ fact_id: string; angle: string; hook: string; rationale: string }>;
}

export async function buildArms(opts: {
  pages: Page[];
  ads: LabelledAd[];
  facts: InsightFact[];
  live: LiveCreatives;
  hints: FactHints;
  llm: Llm;
  log: (message: string) => void;
}): Promise<ArmReport[]> {
  const { pages, ads, facts, live, hints, llm, log } = opts;
  const allowed = new Set<string>(allowedHooks(hints.hints));
  const selfPages = new Set(pages.filter((page) => page.isSelf).map((page) => page.id));
  const competitorAds = ads.filter((ad) => !selfPages.has(ad.competitor_id));
  const selfAds = ads.filter((ad) => selfPages.has(ad.competitor_id));
  log(`hooks the facts back: ${[...allowed].join(', ')}`);

  const { candidates: steals, winningPairs } = stealCandidates(competitorAds, pages, live, allowed, log);
  const doubles = doubleDownCandidates(selfAds, live, allowed);

  // Precedence steal → double_down → gap: a pair already taken moves on to the next candidate.
  const picked: Candidate[] = [];
  const taken = new Set<string>();
  const take = (pool: Candidate[], target: number) => {
    let n = 0;
    for (const candidate of pool) {
      if (n >= target) break;
      const key = pairKey(candidate.angle, candidate.hook);
      if (taken.has(key)) continue;
      taken.add(key);
      picked.push(candidate);
      n++;
    }
    return n;
  };
  const stealCount = take(steals, STEAL_TARGET);
  const doubleCount = take(doubles, DOUBLE_DOWN_TARGET);
  log(`picked ${stealCount} steal (of ${steals.length} candidates) and ${doubleCount} double_down (of ${doubles.length})`);
  // Reserves fill a shortfall if steal or double_down ran short; they get a rationale in the same call.
  const reserveKeys = new Set<string>();
  const reserves = [...steals, ...doubles].filter((candidate) => {
    const key = pairKey(candidate.angle, candidate.hook);
    if (taken.has(key) || reserveKeys.has(key)) return false;
    reserveKeys.add(key);
    return true;
  }).slice(0, Math.max(0, MIN_RECIPES - picked.length - GAP_MIN));

  const vocById = new Map(facts.filter((fact) => fact.section === 'voc_pain' || fact.section === 'voc_objection').map((fact) => [fact.id, fact]));
  const gapCandidates = [...vocById.values()].sort((a, b) =>
    compareVocRank({ metrics: a.metrics, rankLabel: a.statement }, { metrics: b.metrics, rankLabel: b.statement }),
  );
  const brandFacts = facts.filter((fact) => ['positioning', 'value_prop', 'usp', 'proof_point'].includes(fact.section));
  const recipeIds = [...picked, ...reserves].map((candidate) => armIdFor(candidate.angle, candidate.hook));

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['rationales', 'gaps'],
    properties: {
      rationales: {
        type: 'object',
        additionalProperties: false,
        required: recipeIds,
        properties: Object.fromEntries(recipeIds.map((id) => [id, { type: 'string' }])),
      },
      gaps: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['fact_id', 'angle', 'hook', 'rationale'],
          properties: {
            fact_id: { type: 'string', enum: gapCandidates.map((fact) => fact.id) },
            angle: { type: 'string', enum: [...ANGLES] },
            hook: { type: 'string', enum: [...allowed] },
            rationale: { type: 'string' },
          },
        },
      },
    },
  };
  const input = {
    recipes: [...picked, ...reserves].map((candidate) => ({
      arm_id: armIdFor(candidate.angle, candidate.hook),
      strategy: candidate.strategy,
      angle: candidate.angle,
      hook: candidate.hook,
      evidence: candidate.brief,
    })),
    competitor_winning_pairs: winningPairs.map((row) => {
      const [angle, hook] = splitPair(row.label);
      return { angle, hook, winning_ads: row.winnerCount };
    }),
    gap_candidates: gapCandidates.map((fact) => ({
      fact_id: fact.id,
      section: fact.section,
      label: String(fact.details.label ?? fact.fact_key),
      statement: fact.statement,
      frequency: fact.metrics.frequency ?? 0,
      quote: pickVocVerbatim(fact.evidence.map((ref) => ref.quote), String(fact.details.label ?? '')) ?? '',
    })),
    brand_facts: brandFacts.map((fact) => `[${fact.section}] ${fact.statement}`),
    allowed_angles: ANGLES,
    allowed_hooks: [...allowed],
    gaps_wanted: GAP_ASK,
  };
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: JSON.stringify(input, null, 2) },
  ];
  const answer = await llm.strictJson<ArmAnswer>('adlab_recipes', schema, messages, (value) => {
    const parsed = value as ArmAnswer;
    for (const id of recipeIds) {
      if (typeof parsed?.rationales?.[id] !== 'string' || !parsed.rationales[id].trim()) throw new Error(`no rationale for ${id}`);
    }
    if (!Array.isArray(parsed.gaps)) throw new Error('no gaps array');
    return parsed;
  });

  // Validate the gap picks in order; keep the first GAP_TARGET that hold.
  const usedFacts = new Set<string>();
  let gapCount = 0;
  for (const gap of answer.gaps) {
    if (gapCount >= GAP_TARGET) break;
    const fact = vocById.get(gap.fact_id);
    const key = pairKey(gap.angle, gap.hook);
    const problem = !fact
      ? 'unknown fact'
      : usedFacts.has(gap.fact_id)
        ? 'fact already answered by another gap'
        : !ANGLES.includes(gap.angle)
          ? 'angle not a food token'
          : !allowed.has(gap.hook)
            ? 'hook not producible or unbacked'
            : taken.has(key)
              ? 'pair already a recipe'
              : !gap.rationale.trim()
                ? 'empty rationale'
                : null;
    if (problem) {
      log(`gap: reject ${key} for ${fact?.fact_key ?? gap.fact_id}: ${problem}`);
      continue;
    }
    taken.add(key);
    usedFacts.add(gap.fact_id);
    picked.push({
      angle: gap.angle,
      hook: gap.hook,
      strategy: 'gap',
      basis: `${fact!.section} "${fact!.fact_key}" (frequency ${fact!.metrics.frequency ?? 0}); no winning competitor pair answers it`,
      evidenceIds: [fact!.id],
      brief: { rationale: gap.rationale.trim() },
    });
    gapCount++;
  }
  if (gapCount < GAP_MIN) throw new Error(`only ${gapCount} valid gap recipe(s); need ${GAP_MIN}`);

  if (picked.length < MIN_RECIPES) take(reserves, MIN_RECIPES - picked.length);
  if (picked.length < MIN_RECIPES || picked.length > MAX_RECIPES) {
    throw new Error(`${picked.length} recipes; the contract needs ${MIN_RECIPES}-${MAX_RECIPES}`);
  }

  const reports: ArmReport[] = picked.map((candidate) => {
    const armId = armIdFor(candidate.angle, candidate.hook);
    const requirement = hookRequirement(candidate.hook);
    const rationale = candidate.strategy === 'gap' ? String(candidate.brief.rationale) : answer.rationales[armId]?.trim();
    if (!rationale) throw new Error(`${armId}: no rationale`);
    return {
      row: {
        arm_id: armId,
        angle: candidate.angle,
        hook: candidate.hook,
        strategy: candidate.strategy,
        rationale,
        evidence: JSON.stringify(candidate.evidenceIds),
      },
      basis: candidate.basis,
      requirement: requirement ? `${requirement}: ${hints.metBy[requirement] ?? '?'}` : '',
      evidenceIds: candidate.evidenceIds,
    };
  });

  const controlEvidence = live.rows.filter((row) => row.origin === 'brand_live').map((row) => row.creative_id);
  reports.push({
    row: {
      arm_id: CONTROL_ARM_ID,
      angle: '',
      hook: '',
      strategy: 'control',
      rationale: CONTROL_RATIONALE,
      evidence: JSON.stringify(controlEvidence),
    },
    basis: `${controlEvidence.length} brand_live creatives`,
    requirement: '',
    evidenceIds: controlEvidence,
  });
  return reports;
}
