/**
 * Judge-ranked candidate selection.
 *
 * Rank is ADVISORY (gates KILL; ranking only ORDERS): an LLM judge scores gate
 * survivors when an OpenAI key is available, with an ALWAYS-available
 * deterministic heuristic fallback. Judge failure can never fail a run —
 * every path degrades to the heuristic. `judgeVersion` is stamped so rankings
 * stay comparable over time (rank↔performance calibration is Phase 4).
 *
 * TWO judge paths, selected by whether ANY candidate carries an `imageRef`
 * (M3.5, 2026-08-12):
 *  - NO imageRef (the Google RSA copy run, and any caller that has no pixels)
 *    → the historical TEXT judge, byte-identical: same `getLLMProvider` seam,
 *    same prompt, same `llm-judge-v1` stamp.
 *  - ≥1 imageRef (the image pipeline) → ONE batched MULTIMODAL call that
 *    actually SEES the rendered creatives, stamped `llm-judge-v2-multimodal`.
 * Distinct version stamps keep historical rank rows comparable — a Phase 4
 * calibration must never average a blind judge against a sighted one.
 *
 * Fallback is ONE layer deep in both directions: a multimodal failure goes
 * STRAIGHT to the deterministic heuristic, never to the text judge. A
 * text-judge second chance would make the ordering non-reproducible (which
 * judge scored a given run would depend on transient API weather).
 *
 * COST: the multimodal call is a SINGLE batched request at `detail:'low'`, so
 * it stays inside the flat per-run JUDGE_OVERHEAD_CENTS the estimator already
 * charges. Deliberately NO cost-model change (cost.ts untouched) — per-call
 * rank accounting only becomes worth it if this ever goes per-candidate.
 */

import { getLLMProvider } from '@/lib/ai/provider';
import { openAIChatCompletion } from '@/lib/llm/clients';
import { fetchImageAsDataUrl } from './judge-gate';
import { resolveRankJudgeModel, resolveRankJudgeVisionModel } from './model-resolvers';
import type { CandidateRank, CreativeBrief, CreativeGenome, GateResult } from './types';

// Text rank-judge model (CREATIVE_RANK_JUDGE_MODEL, default gpt-5.4-mini) and
// the vision rank-judge model (CREATIVE_RANK_JUDGE_VISION_MODEL, default
// gpt-4o-mini): resolvers + rationale live in ./model-resolvers. NOTE: the
// TEXT judge sees COPY + genome only, not the rendered image.
export { resolveRankJudgeModel, resolveRankJudgeVisionModel };

/**
 * JUDGE-FAMILY DEVIATION (deliberate, v1): the generation plan's rule is
 * judge family ≠ generator family, so a model can never grade its own
 * sibling's output. v1 violates it knowingly — the OpenAI judge scores
 * OpenAI-generated candidates — because a single API key is the only one
 * configured (single-key pragmatism). The judge PROVIDER is env-swappable via
 * CREATIVE_RANK_JUDGE_PROVIDER ('openai' default, passed to getLLMProvider),
 * so a second key restores the rule with zero code change.
 */
function resolveJudgeProviderId(): string {
  return (process.env.CREATIVE_RANK_JUDGE_PROVIDER || 'openai').trim().toLowerCase() || 'openai';
}


export const LLM_JUDGE_VERSION = 'llm-judge-v1';
export const MULTIMODAL_JUDGE_VERSION = 'llm-judge-v2-multimodal';
export const HEURISTIC_JUDGE_VERSION = 'heuristic-v1';

export interface RankCandidateInput {
  id: string;
  copyText: string;
  genome: CreativeGenome;
  gateResults: GateResult[];
  /**
   * The rendered creative, as a `data:` URL (fresh in-memory bytes) or an
   * https URL (rehydrated seed — base64-fetched before the call; a raw remote
   * URL 400s the whole request). OPTIONAL: copy-only callers (Google RSA)
   * omit it and keep the text judge verbatim.
   */
  imageRef?: string;
}

function clampScore(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Rank candidates for a brief. Returns a Map keyed by candidate id — every
 * input candidate is guaranteed an entry. Never throws.
 */
export async function rankCandidates(
  candidates: RankCandidateInput[],
  brief: CreativeBrief
): Promise<Map<string, CandidateRank>> {
  if (candidates.length === 0) return new Map();

  // ONE candidate with pixels routes the WHOLE batch through the multimodal
  // judge — a mixed text/vision ordering would not be comparable (same
  // reasoning as the incomplete-coverage discard below). Candidates without a
  // usable image degrade to a copy-only text part INSIDE that call.
  if (candidates.some((candidate) => hasImageRef(candidate))) {
    // Vision goes straight at OpenAI's Chat Completions endpoint (the proven
    // seam), so the key check is unconditional here — unlike the text path,
    // there is no provider indirection to honor.
    if (process.env.OPENAI_API_KEY) {
      try {
        const judged = await judgeWithVision(candidates, brief);
        if (judged) return judged;
      } catch (error) {
        console.warn(
          '[CreativeRanking] multimodal judge failed; falling back to heuristic:',
          error instanceof Error ? error.message : error
        );
      }
    }
    return rankHeuristically(candidates, brief);
  }

  const judgeProviderId = resolveJudgeProviderId();
  // For the default OpenAI judge, skip silently without a key (the common
  // keyless/local case). A non-default judge provider always attempts —
  // getLLMProvider's missing-key error lands in the heuristic fallback below.
  const judgeAvailable = judgeProviderId !== 'openai' || Boolean(process.env.OPENAI_API_KEY);
  if (judgeAvailable) {
    try {
      const judged = await judgeWithLLM(candidates, brief, judgeProviderId);
      if (judged) return judged;
    } catch (error) {
      console.warn(
        '[CreativeRanking] LLM judge failed; falling back to heuristic:',
        error instanceof Error ? error.message : error
      );
    }
  }

  return rankHeuristically(candidates, brief);
}

interface JudgeRankingEntry {
  id?: string;
  score?: number;
  rationale?: string;
}

/** Returns null (→ heuristic fallback) on any malformed/incomplete judge output. */
async function judgeWithLLM(
  candidates: RankCandidateInput[],
  brief: CreativeBrief,
  judgeProviderId: string
): Promise<Map<string, CandidateRank> | null> {
  const provider = getLLMProvider(judgeProviderId);
  const model = resolveRankJudgeModel();

  const system =
    'You are an ad-creative judge. Score each candidate 0-100 on brand alignment, ' +
    'concept fidelity to the brief, and predicted thumb-stop. Respond with JSON only: ' +
    '{"rankings":[{"id":"<candidate id>","score":<0-100>,"rationale":"<one sentence>"}]} ' +
    'covering EVERY candidate id exactly once.';
  const user = JSON.stringify({
    brief: {
      angle: brief.angle,
      persona: brief.persona,
      coreMessage: brief.coreMessage,
      hooks: brief.hooks,
      style: brief.styleDirection ?? brief.style,
      platform: brief.platform,
    },
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      copyText: candidate.copyText,
      genome: { angle: candidate.genome.angle, style: candidate.genome.style },
      unverifiedGates: candidate.gateResults
        .filter((gate) => gate.status === 'unverified')
        .map((gate) => gate.gate),
    })),
  });

  const raw = await provider.complete(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { model, jsonMode: true, temperature: 0, maxTokens: 2048 }
  );

  const parsed = JSON.parse(raw) as { rankings?: JudgeRankingEntry[] };
  if (!Array.isArray(parsed.rankings)) return null;

  const byId = new Map<string, JudgeRankingEntry>();
  for (const entry of parsed.rankings) {
    if (typeof entry?.id === 'string') byId.set(entry.id, entry);
  }

  return collectRanks(candidates, byId, LLM_JUDGE_VERSION);
}

/**
 * Coverage gate shared by both judge paths: EVERY candidate must carry a
 * finite score, or the whole judged set is discarded (null → heuristic). A
 * mixed judge/heuristic ordering would not be comparable.
 */
function collectRanks(
  candidates: RankCandidateInput[],
  byId: Map<string, JudgeRankingEntry>,
  judgeVersion: string
): Map<string, CandidateRank> | null {
  const ranks = new Map<string, CandidateRank>();
  for (const candidate of candidates) {
    const entry = byId.get(candidate.id);
    if (!entry || typeof entry.score !== 'number' || !Number.isFinite(entry.score)) {
      return null;
    }
    ranks.set(candidate.id, {
      score: clampScore(entry.score),
      judgeVersion,
      rationale:
        typeof entry.rationale === 'string' && entry.rationale.trim().length > 0
          ? entry.rationale
          : 'LLM judge score.',
    });
  }
  return ranks;
}

function hasImageRef(candidate: RankCandidateInput): boolean {
  return typeof candidate.imageRef === 'string' && candidate.imageRef.length > 0;
}

const VISION_SYSTEM_PROMPT = [
  'You are an ad-creative judge scoring rendered paid-social creatives.',
  'Each candidate is presented as a text block followed by its rendered image (when available).',
  'Score each candidate 0-100 on brand alignment, concept fidelity to the brief, and predicted thumb-stop — now judging the IMAGE you can actually see, not only the copy.',
  // Same false-positive class the brand judge gate was hardened against
  // (2026-08-04, run 403ede09): the headline/primary text/CTA are platform ad
  // fields the ad platform renders OUTSIDE the image. The image model never
  // receives them, so they can never be evidence of in-image text.
  "A candidate's copy (headline, primary text, CTA) is rendered by the ad platform OUTSIDE the image and is NEVER painted into the image. Do not treat copy text as in-image text, and do not reward or penalize a candidate for text you did not LITERALLY SEE in its pixels.",
  'A candidate marked "image unavailable" must be judged on its copy and genome alone — never scored down merely for the missing image.',
  'Return one entry per candidate id, exactly once, covering EVERY candidate.',
  'rationale: one short sentence.',
].join(' ');

/** Text part that labels a candidate for the image part that follows it. */
function renderVisionCandidateText(
  candidate: RankCandidateInput,
  imageAvailable: boolean
): string {
  const unverified = candidate.gateResults
    .filter((gate) => gate.status === 'unverified')
    .map((gate) => gate.gate);
  return [
    `Candidate ${candidate.id}`,
    `copy: ${candidate.copyText}`,
    `angle: ${candidate.genome.angle}`,
    `style: ${candidate.genome.style}`,
    `unverified gates: ${unverified.length > 0 ? unverified.join(', ') : 'none'}`,
    imageAvailable
      ? 'The next image is this candidate.'
      : 'image unavailable — judge on copy only.',
  ].join('\n');
}

/**
 * ONE batched Chat Completions body: an intro text part carrying the brief
 * framing (mirrors the text judge's brief block), then per candidate a
 * labeling text part followed by its low-detail image part. temperature 0.
 */
export function buildRankVisionRequestBody(
  candidates: Array<{ candidate: RankCandidateInput; imageDataUrl: string | null }>,
  brief: CreativeBrief,
  model: string
): Record<string, unknown> {
  const intro = [
    '## Brief',
    JSON.stringify({
      angle: brief.angle,
      persona: brief.persona,
      coreMessage: brief.coreMessage,
      hooks: brief.hooks,
      style: brief.styleDirection ?? brief.style,
      platform: brief.platform,
    }),
    '',
    `## Candidates (${candidates.length})`,
  ].join('\n');
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: intro }];
  for (const { candidate, imageDataUrl } of candidates) {
    content.push({
      type: 'text',
      text: renderVisionCandidateText(candidate, Boolean(imageDataUrl)),
    });
    if (imageDataUrl) {
      content.push({
        type: 'image_url',
        image_url: { url: imageDataUrl, detail: 'low' },
      });
    }
  }
  return {
    model,
    messages: [
      { role: 'system', content: VISION_SYSTEM_PROMPT },
      { role: 'user', content },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'creative_rankings',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['rankings'],
          properties: {
            rankings: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                // OpenAI strict mode: EVERY property must be in `required`.
                required: ['id', 'score', 'rationale'],
                properties: {
                  id: { type: 'string', enum: candidates.map((c) => c.candidate.id) },
                  score: { type: 'number' },
                  rationale: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    temperature: 0,
  };
}

/**
 * Payload budgets for the ONE batched vision request.
 *
 * The batch degrades per-candidate by design (a dead image → copy-only text
 * part), but SIZE was the one failure mode that still took the whole batch
 * down: a request too large fails outright, the catch in rankCandidates fires,
 * and EVERY candidate silently loses sighted ranking to the heuristic. Fresh
 * candidates arrive as `bufferToDataUrl` output, which has no cap of its own
 * (fetchImageAsDataUrl's 4MB cap guards only the https path), and a run can
 * carry up to 40 composited creatives at 1–2MB each. So: images are admitted
 * in candidate order until the budget is spent, and the overflow reuses the
 * existing "image unavailable" path — the prompt already forbids punishing a
 * candidate for a missing image. No env var: this is a transport limit, not a
 * tuning knob.
 */
const RANK_VISION_PAYLOAD_BUDGET_BYTES = 24 * 1024 * 1024;
/** Per-image cap, decoded — identical to what fetchImageAsDataUrl enforces. */
const RANK_VISION_MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Base64 payload length of a data: URL (≈ the bytes it costs on the wire). */
function encodedLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.length - comma - 1 : dataUrl.length;
}

/**
 * Drop images that bust the per-image cap or the running total, in candidate
 * order. Mutates nothing — returns the admitted list.
 */
function applyVisionPayloadBudget(
  resolved: Array<{ candidate: RankCandidateInput; imageDataUrl: string | null }>
): Array<{ candidate: RankCandidateInput; imageDataUrl: string | null }> {
  let usedBytes = 0;
  return resolved.map((entry) => {
    if (!entry.imageDataUrl) return entry;
    const encoded = encodedLength(entry.imageDataUrl);
    // base64 encodes 3 bytes per 4 chars.
    const decoded = Math.floor((encoded * 3) / 4);
    if (
      decoded > RANK_VISION_MAX_IMAGE_BYTES ||
      usedBytes + encoded > RANK_VISION_PAYLOAD_BUDGET_BYTES
    ) {
      return { candidate: entry.candidate, imageDataUrl: null };
    }
    usedBytes += encoded;
    return entry;
  });
}

/**
 * Multimodal judge: ONE batched vision call over the whole survivor set.
 * Returns null (→ heuristic) on any HTTP/parse/coverage failure. Image
 * resolution is fail-soft PER CANDIDATE — a dead R2 link degrades that one
 * candidate to a copy-only text part instead of failing the batch.
 */
async function judgeWithVision(
  candidates: RankCandidateInput[],
  brief: CreativeBrief
): Promise<Map<string, CandidateRank> | null> {
  const resolved = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      imageDataUrl: await resolveVisionImage(candidate),
    }))
  );

  const completion = await openAIChatCompletion({
    body: buildRankVisionRequestBody(
      applyVisionPayloadBudget(resolved),
      brief,
      resolveRankJudgeVisionModel()
    ),
    retryProfile: 'background',
  });

  const content = (
    completion as { choices?: Array<{ message?: { content?: unknown } }> }
  ).choices?.[0]?.message?.content;
  if (typeof content !== 'string') return null;
  let parsed: { rankings?: JudgeRankingEntry[] };
  try {
    parsed = JSON.parse(content) as { rankings?: JudgeRankingEntry[] };
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.rankings)) return null;

  const byId = new Map<string, JudgeRankingEntry>();
  for (const entry of parsed.rankings) {
    if (typeof entry?.id === 'string') byId.set(entry.id, entry);
  }
  return collectRanks(candidates, byId, MULTIMODAL_JUDGE_VERSION);
}

/** `data:` passes through untouched; https is base64-fetched (null on failure). */
async function resolveVisionImage(
  candidate: RankCandidateInput
): Promise<string | null> {
  if (!hasImageRef(candidate)) return null;
  const ref = candidate.imageRef as string;
  if (ref.startsWith('data:')) return ref;
  return fetchImageAsDataUrl(ref).catch(() => null);
}

function tokenize(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 3)
    ),
  ];
}

/**
 * Deterministic heuristic ranking (judgeVersion 'heuristic-v1'): brief-keyword
 * overlap in the copy + hook presence − a penalty per unverified gate. Stable:
 * identical inputs always yield identical scores and insertion order (score
 * desc, then original input order).
 */
export function rankHeuristically(
  candidates: RankCandidateInput[],
  brief: CreativeBrief
): Map<string, CandidateRank> {
  const keywords = tokenize(
    [brief.coreMessage, brief.angle, brief.persona, brief.styleDirection ?? brief.style].join(' ')
  );

  const scored = candidates.map((candidate, index) => {
    const copyLower = candidate.copyText.toLowerCase();
    const matched = keywords.filter((keyword) => copyLower.includes(keyword));
    const overlapRatio = keywords.length > 0 ? matched.length / keywords.length : 0;
    const hookPresent = brief.hooks.some(
      (hook) => hook.trim().length > 0 && copyLower.includes(hook.toLowerCase())
    );
    const unverifiedCount = candidate.gateResults.filter(
      (gate) => gate.status === 'unverified'
    ).length;
    const score = clampScore(10 + 60 * overlapRatio + (hookPresent ? 20 : 0) - 5 * unverifiedCount);
    return {
      candidate,
      index,
      score,
      rationale: `Heuristic: ${matched.length}/${keywords.length} brief keywords in copy, hook ${hookPresent ? 'present' : 'absent'}, ${unverifiedCount} unverified gate(s).`,
    };
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);

  const ranks = new Map<string, CandidateRank>();
  for (const entry of scored) {
    ranks.set(entry.candidate.id, {
      score: entry.score,
      judgeVersion: HEURISTIC_JUDGE_VERSION,
      rationale: entry.rationale,
    });
  }
  return ranks;
}
