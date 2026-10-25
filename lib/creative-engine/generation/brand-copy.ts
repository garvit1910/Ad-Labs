/**
 * Brand-mode image-run copywriter (brand-context Phase 5) — the pack-grounded
 * sibling of rsa-copy.ts.
 *
 * ONE LLM call per copy set produces headline/primaryText/CTA delivered as
 * STRUCTURED PLATFORM AD FIELDS (the overlay bands were deleted 2026-08-04 —
 * Meta renders the real CTA button). The prompt's brand grounding comes
 * VERBATIM from `renderCopyPrompt(pack)` — this module only appends a
 * deterministic OUTPUT-FORMAT wrapper (+ optional per-strategy-group hook
 * directive) to the user message (the wrapper lives here, outside the pack
 * contract, mirroring how the per-candidate variation modifier stays outside
 * the pack). NEVER throws: any LLM/parse/enforcement failure falls back to
 * the brief's own copy with `source: 'brief_fallback'` — a cheap LLM blip
 * must not fail a multi-dollar image run.
 *
 * Quality guards (2026-08-04): deterministic post-generation checks reject
 * UNGROUNDED NUMERALS (every digit sequence in the copy must appear in the
 * pack-rendered grounding text — no invented protein grams) and BANNED
 * AD-SPEAK (the generic retail phrases the renderer forbids). One retry with
 * explicit violation feedback, then the whole set falls back.
 *
 * Visual concept (2026-09-22): the copywriter ALSO writes an optional
 * `visualConcept` — one camera-only scene that makes THIS headline's claim
 * visible — because the image model never sees the copy and otherwise renders
 * the same generic scene for every headline. The concept is IMAGE DIRECTION,
 * never an ad field: it is validated deterministically and DROPPED (never
 * retried, never a fallback trigger) when unusable, so the copy set's
 * acceptance rules and binary provenance are exactly what they were.
 */

import { getLLMProvider } from '@/lib/ai/provider';
import {
  BANNED_AD_SPEAK,
  type CopyRender,
} from '@/lib/creative-engine/brand-context/renderers';
import type { CreativeBrief } from './types';
import { stripCodeFence } from './rsa-copy';
import { resolveBrandCopyModel } from './model-resolvers';

export const BRAND_COPY_HEADLINE_MAX_CHARS = 60;
export const BRAND_COPY_PRIMARY_TEXT_MAX_CHARS = 500;
export const BRAND_COPY_CTA_MAX_CHARS = 30;
/** Hard cap on the copywriter's image direction (prompt asks for <= ~40 words). */
export const BRAND_COPY_VISUAL_CONCEPT_MAX_CHARS = 300;

// Brand copywriter model (CREATIVE_BRAND_COPY_MODEL, default gpt-4o): the
// resolver + its Chat-Completions-only rationale live in ./model-resolvers
// (zero-import, shared with the generation-profile registry).
export { resolveBrandCopyModel };

function resolveBrandCopyProviderId(): string {
  return (
    (process.env.CREATIVE_BRAND_COPY_PROVIDER || 'openai')
      .trim()
      .toLowerCase() || 'openai'
  );
}

/**
 * One copy per set (not per-candidate variety like RSA's 0.8) — 0.6 favors
 * pack/brief adherence and concrete specificity over florid variation.
 */
const BRAND_COPY_TEMPERATURE = 0.6;

/**
 * Allowed CTA labels — 1:1 with the publishable Meta CTA enum
 * (publish/meta-publish.ts PUBLISH_CTA_TYPES, minus BOOK_TRAVEL). The CTA is
 * a PLATFORM BUTTON label, never invented marketing copy ("Shop Now for
 * Exclusive Deals!" is exactly the failure this closes).
 */
export const PLATFORM_CTA_LABELS = [
  'Shop Now',
  'Learn More',
  'Sign Up',
  'Subscribe',
  'Get Offer',
  'Contact Us',
  'Download',
  'Order Now',
] as const;

/** Normalized-match a raw model CTA onto the allowed labels; null = no match. */
export function coerceCtaLabel(raw: string): string | null {
  const normalized = raw.trim().toLowerCase().replace(/[.!]+$/u, '');
  for (const label of PLATFORM_CTA_LABELS) {
    if (label.toLowerCase() === normalized) return label;
  }
  return null;
}

/**
 * Deterministic OUTPUT-FORMAT wrapper appended AFTER the pack-rendered user
 * message. Lives HERE, outside the pack contract — renderer templates and
 * their snapshots stay byte-identical.
 */
export const BRAND_COPY_FORMAT_INSTRUCTION = [
  '## Output format',
  'Respond with JSON only, no commentary:',
  `{"headline": "<ONE concrete, fact-grounded headline, STRICTLY <= ${BRAND_COPY_HEADLINE_MAX_CHARS} characters including spaces>",`,
  ` "primaryText": "<1-3 sentences of primary ad text, STRICTLY <= ${BRAND_COPY_PRIMARY_TEXT_MAX_CHARS} characters>",`,
  ` "cta": "<EXACTLY one of: ${PLATFORM_CTA_LABELS.join(' | ')}>",`,
  ' "visualConcept": "<ONE concrete scene, about 40 words at most, that makes THIS headline\'s specific claim or moment visible in a single static photo>"}',
  'The cta is a platform button label — pick from the list verbatim, never write your own.',
  'The visualConcept directs the ad image, which never shows the ad copy: describe only what the camera sees — people, setting, props, action, mood. Never describe added text, words, numbers, logos beyond the product\'s own packaging, fabricated interfaces or readable on-screen text, or split before/after panels; show a screen only when the product itself is software, and only as the product in use.',
].join('\n');

// ── Deterministic post-generation guards ────────────────────────────────────
// The bodies moved to `copy-guards.ts` (Workstream H) so a caller needing only
// the guards does not pull `@/lib/ai/provider` in with them — the report card's
// response parser reuses the ungrounded-numeral scan. Re-exported here so every
// existing import path keeps working.
export { findBannedPhrases, findUngroundedNumerals } from './copy-guards';
import { findBannedPhrases, findUngroundedNumerals } from './copy-guards';

/** brief-composer's truncate rule — ellipsis, never a mid-word hard cut. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Deterministic visual-concept guard. Returns the usable concept or undefined
 * — NEVER a failure: an unusable concept is dropped, the copy set survives.
 * Whitespace collapses (a newline must not reach the single-line image
 * prompt). Dropped when empty, when it carries ANY digit (numbers in an image
 * direction become invented in-image text), or a double quote (straight or
 * curly — quoted words read as a request to render them). Over-length is cut
 * at the last word boundary within the cap; only a boundary-free overflow is
 * dropped.
 */
export function sanitizeVisualConcept(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const concept = raw.replace(/\s+/gu, ' ').trim();
  if (!concept) return undefined;
  if (/\p{Nd}/u.test(concept)) return undefined;
  if (/["“”„‟]/u.test(concept)) return undefined;
  if (concept.length <= BRAND_COPY_VISUAL_CONCEPT_MAX_CHARS) return concept;
  const cut = concept
    .slice(0, BRAND_COPY_VISUAL_CONCEPT_MAX_CHARS + 1)
    .lastIndexOf(' ');
  if (cut <= 0) return undefined;
  const truncated = concept.slice(0, cut).replace(/[\s,;:]+$/u, '');
  return truncated || undefined;
}

export interface GenerateBrandCopyInput {
  /**
   * renderCopyPrompt(pack) output — `system` passes through UNMODIFIED; the
   * format instruction is appended to `user`. The `user` text doubles as the
   * GROUNDING corpus for the ungrounded-numeral guard.
   */
  copyPrompt: CopyRender;
  /** Fallback source — guarantees the never-fails contract. */
  brief: Pick<CreativeBrief, 'headline' | 'primaryText' | 'cta' | 'coreMessage'>;
  /**
   * Per-strategy-group execution directive (strategy selection, 2026-08).
   * Rides the deterministic wrapper — one copy call per group, each with its
   * own hook archetype to execute; the pack template stays group-agnostic.
   */
  strategy?: {
    key: string;
    hookDirective: string;
    /**
     * The group's image shot direction (`StrategyGroup.sceneDirective`). When
     * present the visualConcept must fit it — a studio product-hero format
     * wants a staged still life, not a person in a kitchen.
     */
    sceneDirective?: string;
    /**
     * Ad Lab (A5): number-free directives from simulated learnings, rendered as
     * "Notes from testing". They ride this wrapper, never `copyPrompt.user`, so
     * a number in a note can never ground a number in the copy.
     */
    notes?: string[];
  };
  options?: { signal?: AbortSignal; model?: string; providerId?: string };
}

/** One accepted copy set; `visualConcept` only when the concept guard kept it. */
export interface BrandCopySet {
  headline: string;
  primaryText: string;
  cta: string;
  visualConcept?: string;
}

export interface BrandCopyResult {
  copy: BrandCopySet;
  source: 'llm' | 'brief_fallback';
  /** Echo of input.strategy?.key — threads into ComposedStructuredCopy. */
  strategyKey?: string;
  /** Present only on the fallback path — why the LLM copy was rejected. */
  error?: { code: string; reason: string };
}

function briefFallback(
  input: GenerateBrandCopyInput,
  error: { code: string; reason: string },
): BrandCopyResult {
  const { brief } = input;
  return {
    copy: {
      headline:
        brief.headline ?? truncate(brief.coreMessage, BRAND_COPY_HEADLINE_MAX_CHARS),
      primaryText: brief.primaryText ?? brief.coreMessage,
      // Even the fallback CTA snaps to a platform label when it can.
      cta: coerceCtaLabel(brief.cta) ?? brief.cta,
    },
    source: 'brief_fallback',
    ...(input.strategy ? { strategyKey: input.strategy.key } : {}),
    error,
  };
}

function coerceField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

type AttemptFailure = { code: string; reason: string };

type AttemptOutcome =
  | { ok: true; copy: BrandCopySet }
  | { ok: false; failure: AttemptFailure };

async function attemptOnce(
  input: GenerateBrandCopyInput,
  userMessage: string,
  providerId: string,
  model: string,
): Promise<AttemptOutcome> {
  const { system } = input.copyPrompt;
  let raw: string;
  try {
    const provider = getLLMProvider(providerId);
    raw = await provider.complete(
      [
        { role: 'system', content: system },
        { role: 'user', content: userMessage },
      ],
      {
        model,
        jsonMode: true,
        temperature: BRAND_COPY_TEMPERATURE,
        // 512 still covers the visualConcept field: at the stated caps the
        // whole set is ~900 chars (60 + 500 + 30 + 300) ≈ 250 tokens + keys.
        maxTokens: 512,
        ...(input.options?.signal ? { abortSignal: input.options.signal } : {}),
      },
    );
  } catch (error) {
    return {
      ok: false,
      failure: {
        code: 'BRAND_COPY_GENERATION_FAILED',
        reason: `Brand copy generation failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripCodeFence(raw)) as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      failure: {
        code: 'BRAND_COPY_PARSE_FAILED',
        reason: 'Model did not return valid JSON for the brand copy set.',
      },
    };
  }

  const headline = coerceField(parsed.headline);
  const primaryText = coerceField(parsed.primaryText);
  const rawCta = coerceField(parsed.cta);
  if (!headline || !primaryText || !rawCta) {
    return {
      ok: false,
      failure: {
        code: 'BRAND_COPY_INCOMPLETE',
        reason: 'Model output was missing headline, primaryText, or cta.',
      },
    };
  }

  const copy = {
    headline: truncate(headline, BRAND_COPY_HEADLINE_MAX_CHARS),
    primaryText: truncate(primaryText, BRAND_COPY_PRIMARY_TEXT_MAX_CHARS),
    cta: coerceCtaLabel(rawCta) ?? '',
  };
  if (!copy.cta) {
    return {
      ok: false,
      failure: {
        code: 'BRAND_COPY_INVALID_CTA',
        reason: `CTA "${truncate(rawCta, BRAND_COPY_CTA_MAX_CHARS)}" is not an allowed platform label (${PLATFORM_CTA_LABELS.join(', ')}).`,
      },
    };
  }
  const ungrounded = findUngroundedNumerals(copy, input.copyPrompt.user);
  if (ungrounded.length > 0) {
    return {
      ok: false,
      failure: {
        code: 'BRAND_COPY_UNGROUNDED_NUMERAL',
        reason: `Copy contains number(s) not present in any brand fact: ${ungrounded.join(', ')}. Never invent quantities — write the line without a number instead.`,
      },
    };
  }
  const banned = findBannedPhrases(copy);
  if (banned.length > 0) {
    return {
      ok: false,
      failure: {
        code: 'BRAND_COPY_BANNED_PHRASE',
        reason: `Copy contains banned generic ad-speak: ${banned.map((phrase) => `"${phrase}"`).join(', ')}.`,
      },
    };
  }
  // The concept rides ONLY an otherwise-accepted set, and its problems never
  // fail the attempt — it is image direction, not an ad field.
  const visualConcept = sanitizeVisualConcept(parsed.visualConcept);
  return { ok: true, copy: visualConcept ? { ...copy, visualConcept } : copy };
}

function buildStrategyBlock(
  strategy: NonNullable<GenerateBrandCopyInput['strategy']>,
): string {
  const hook = strategy.hookDirective;
  const scene = strategy.sceneDirective?.replace(/\s+/gu, ' ').trim() ?? '';
  const notes = (strategy.notes ?? [])
    .map((note) => note.replace(/\s+/gu, ' ').trim())
    .filter((note) => note.length > 0);
  const lines = [
    ...(hook.trim() ? [`Hook archetype to execute: ${hook}`] : []),
    ...(scene
      ? [
          `Image shot direction for this variant: ${scene}`,
          'The visualConcept must fit this shot direction — keep its shot type, framing and setting (a studio product-hero direction means a staged still life of the product, not a person in a kitchen).',
        ]
      : []),
    ...(notes.length > 0
      ? ['Notes from testing:', ...notes.map((note) => `- ${note}`)]
      : []),
  ];
  return lines.length > 0
    ? `\n\n## Strategy for this variant\n${lines.join('\n')}`
    : '';
}

/**
 * Generate one brand copy set. Never throws; never mixes fields — either the
 * whole LLM set survives enforcement or the whole set falls back to the brief
 * (binary provenance). Guard violations get ONE retry carrying explicit
 * violation feedback; a second violation falls back.
 */
export async function generateBrandCopy(
  input: GenerateBrandCopyInput,
): Promise<BrandCopyResult> {
  const providerId = input.options?.providerId ?? resolveBrandCopyProviderId();
  const model = input.options?.model ?? resolveBrandCopyModel();
  const strategyBlock = input.strategy
    ? buildStrategyBlock(input.strategy)
    : '';
  const baseUser = `${input.copyPrompt.user}${strategyBlock}\n\n${BRAND_COPY_FORMAT_INSTRUCTION}`;

  const first = await attemptOnce(input, baseUser, providerId, model);
  if (first.ok) {
    return {
      copy: first.copy,
      source: 'llm',
      ...(input.strategy ? { strategyKey: input.strategy.key } : {}),
    };
  }
  // Infra failures don't retry (the provider client owns its retries) —
  // only content-guard violations get the feedback retry.
  const RETRYABLE = new Set([
    'BRAND_COPY_UNGROUNDED_NUMERAL',
    'BRAND_COPY_BANNED_PHRASE',
    'BRAND_COPY_INVALID_CTA',
    'BRAND_COPY_INCOMPLETE',
  ]);
  if (!RETRYABLE.has(first.failure.code)) {
    return briefFallback(input, first.failure);
  }
  const retryUser = `${baseUser}\n\n## Previous attempt rejected\n${first.failure.reason}\nRegenerate the full set without this problem.`;
  const second = await attemptOnce(input, retryUser, providerId, model);
  if (second.ok) {
    return {
      copy: second.copy,
      source: 'llm',
      ...(input.strategy ? { strategyKey: input.strategy.key } : {}),
    };
  }
  return briefFallback(input, second.failure);
}
