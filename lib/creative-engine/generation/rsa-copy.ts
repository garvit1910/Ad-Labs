/**
 * Copy-only (Google RSA) candidate generation — the text sibling of the image
 * pipeline (Phase 5 / G2).
 *
 * When a brief targets `platform: 'google'`, the creative engine produces
 * Responsive Search Ad COPY candidates instead of images: each candidate is a
 * full RSA set (12–15 headlines ≤30 chars, 4 descriptions ≤90 chars). This
 * module is PURE prompt-build + parse + deterministic enforcement — the LLM
 * call rides the same seam the ranking judge uses (`getLLMProvider`), and NO DB
 * code lives here. The processor wires persistence + budget; gates/rank are the
 * shared image-pipeline helpers (they operate on the joined copy text).
 *
 * Brand grounding: the prompt is built from the brief — the angle VERBATIM
 * (attribution key), persona, coreMessage, hooks, cta, required disclaimers,
 * prohibited claims, and brand-lexicon avoid words. Deterministic post-parse
 * enforcement (trim, char-limit drop, dedupe via the shared text-asset
 * validators) guarantees a spec-valid set or an honest failure.
 */

import { getLLMProvider } from '@/lib/ai/provider';
import type { CreativeBrief, RsaStructuredCopy, RsaTextAsset } from './types';
import { resolveRsaCopyModel } from './model-resolvers';
import {
  normalizeTextAssetKey,
} from '@/lib/google-ads/text-asset-validation';

// ── RSA spec (Google Ads: 3–15 headlines ≤30 chars, 2–4 descriptions ≤90) ────
export const RSA_HEADLINE_MAX_CHARS = 30;
export const RSA_DESCRIPTION_MAX_CHARS = 90;
export const RSA_MIN_HEADLINES = 3;
export const RSA_MAX_HEADLINES = 15;
export const RSA_MIN_DESCRIPTIONS = 2;
export const RSA_MAX_DESCRIPTIONS = 4;

/** House targets for a generated set — the high end of the valid RSA range. */
const TARGET_HEADLINES = 15;
const TARGET_DESCRIPTIONS = 4;

// RSA copywriter model (CREATIVE_RSA_COPY_MODEL, default gpt-4o-mini): the
// resolver + its Chat-Completions-only rationale live in ./model-resolvers
// (zero-import, shared with the generation-profile registry).
export { resolveRsaCopyModel };

function resolveRsaCopyProviderId(): string {
  return (
    process.env.CREATIVE_RSA_COPY_PROVIDER ||
    process.env.CREATIVE_RANK_JUDGE_PROVIDER ||
    'openai'
  )
    .trim()
    .toLowerCase() || 'openai';
}

/** House temperature: a touch of variety across the N variation sets, still on-brief. */
const RSA_COPY_TEMPERATURE = 0.8;

// ── Prompt build (pure) ──────────────────────────────────────────────────────

export function buildRsaCopyPrompt(
  brief: CreativeBrief
): { system: string; user: string } {
  const system = [
    'You are a Google Ads Responsive Search Ad (RSA) copywriter.',
    `Write ${TARGET_HEADLINES} distinct headlines (each STRICTLY <= ${RSA_HEADLINE_MAX_CHARS} characters, including spaces)`,
    `and ${TARGET_DESCRIPTIONS} distinct descriptions (each STRICTLY <= ${RSA_DESCRIPTION_MAX_CHARS} characters).`,
    'Headlines and descriptions must be unique (no near-duplicates).',
    'Ground every line in the brief: keep the strategic ANGLE, speak to the PERSONA, land the CORE MESSAGE, and echo the CTA.',
    'Do NOT use any prohibited claim or brand-lexicon avoid word. If required disclaimers are supplied, include each verbatim in at least one description.',
    'Respond with JSON only: {"headlines":["..."],"descriptions":["..."]}. No commentary.',
  ].join(' ');

  const user = JSON.stringify({
    angle: brief.angle,
    persona: brief.persona,
    coreMessage: brief.coreMessage,
    hooks: brief.hooks,
    cta: brief.cta,
    headline: brief.headline,
    primaryText: brief.primaryText,
    prohibitedClaims: brief.compliance?.prohibitedClaims ?? [],
    requiredDisclaimers: brief.compliance?.requiredDisclaimers ?? [],
    avoidWords: brief.brandLexicon?.avoid ?? [],
    charLimits: {
      headlineMax: RSA_HEADLINE_MAX_CHARS,
      descriptionMax: RSA_DESCRIPTION_MAX_CHARS,
    },
  });

  return { system, user };
}

// ── Deterministic parse + enforcement (pure) ─────────────────────────────────

interface RawRsaCopy {
  headlines?: unknown;
  descriptions?: unknown;
}

/**
 * Trim, drop over-limit lines, dedupe (trimmed-lowercase), and cap at `max`.
 * Preserves first-occurrence order and casing (mirrors existing-assets +
 * text-asset-validation dedupe semantics).
 */
/**
 * Coerce one raw list entry to its text. Accepts a plain string OR an
 * `{ text: string }` object — models in JSON mode return `["..."]` per the
 * prompt, but some emit `[{ "text": "..." }]`; both are valid RSA copy and must
 * not be silently dropped (that empties the whole set → the candidate fails).
 */
function entryToText(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (raw && typeof raw === 'object' && 'text' in raw) {
    const t = (raw as { text?: unknown }).text;
    if (typeof t === 'string') return t.trim();
  }
  return '';
}

export function enforceTextAssets(
  values: unknown,
  maxChars: number,
  max: number
): RsaTextAsset[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: RsaTextAsset[] = [];
  for (const raw of values) {
    const text = entryToText(raw);
    if (!text) continue;
    if (text.length > maxChars) continue;
    const key = normalizeTextAssetKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ text });
    if (out.length >= max) break;
  }
  return out;
}

export interface RsaCopyParseResult {
  copy?: RsaStructuredCopy;
  /** Present when the parsed set does not satisfy the RSA minimums. */
  error?: { code: string; reason: string };
}

/**
 * Parse the raw model output into a spec-valid RSA copy set. Fails (returns an
 * `error`, no `copy`) when fewer than the RSA minimums survive enforcement.
 */
/**
 * Strip a ```json … ``` (or bare ```) markdown code fence if the model wrapped
 * its JSON in one — jsonMode usually suppresses fences, but a fenced response
 * would otherwise fail `JSON.parse` and drop the whole set. Exported for the
 * brand-copy sibling (`brand-copy.ts`), which parses the same seam's output.
 */
export function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

export function parseRsaCopy(raw: string): RsaCopyParseResult {
  let parsed: RawRsaCopy;
  try {
    parsed = JSON.parse(stripCodeFence(raw)) as RawRsaCopy;
  } catch {
    return {
      error: {
        code: 'RSA_COPY_PARSE_FAILED',
        reason: 'Model did not return valid JSON for the RSA copy set.',
      },
    };
  }

  const headlines = enforceTextAssets(
    parsed.headlines,
    RSA_HEADLINE_MAX_CHARS,
    RSA_MAX_HEADLINES
  );
  const descriptions = enforceTextAssets(
    parsed.descriptions,
    RSA_DESCRIPTION_MAX_CHARS,
    RSA_MAX_DESCRIPTIONS
  );

  if (headlines.length < RSA_MIN_HEADLINES) {
    return {
      error: {
        code: 'RSA_COPY_INSUFFICIENT_HEADLINES',
        reason: `Only ${headlines.length} valid headline(s) survived enforcement (need >= ${RSA_MIN_HEADLINES}, each <= ${RSA_HEADLINE_MAX_CHARS} chars, unique).`,
      },
    };
  }
  if (descriptions.length < RSA_MIN_DESCRIPTIONS) {
    return {
      error: {
        code: 'RSA_COPY_INSUFFICIENT_DESCRIPTIONS',
        reason: `Only ${descriptions.length} valid description(s) survived enforcement (need >= ${RSA_MIN_DESCRIPTIONS}, each <= ${RSA_DESCRIPTION_MAX_CHARS} chars, unique).`,
      },
    };
  }

  return { copy: { kind: 'rsa', headlines, descriptions } };
}

/** The joined preview / gate-input text for an RSA copy set. */
export function joinRsaCopyText(copy: RsaStructuredCopy): string {
  return [
    ...copy.headlines.map((h) => h.text),
    ...copy.descriptions.map((d) => d.text),
  ].join('\n');
}

// ── Generation (impure — one LLM call per candidate set) ─────────────────────

export interface GenerateRsaCopyResult {
  copy?: RsaStructuredCopy;
  copyText?: string;
  error?: { code: string; reason: string };
}

/**
 * Generate ONE RSA copy candidate set for the brief. Never throws — an LLM /
 * key / parse failure resolves to an `error` (the processor lands that
 * candidate as 'failed'). The `signal` aborts the underlying provider call.
 */
export async function generateRsaCopyCandidate(
  brief: CreativeBrief,
  options?: { signal?: AbortSignal; model?: string; providerId?: string }
): Promise<GenerateRsaCopyResult> {
  const { system, user } = buildRsaCopyPrompt(brief);
  const providerId = options?.providerId ?? resolveRsaCopyProviderId();
  const model = options?.model ?? resolveRsaCopyModel();

  let raw: string;
  try {
    const provider = getLLMProvider(providerId);
    raw = await provider.complete(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      {
        model,
        jsonMode: true,
        temperature: RSA_COPY_TEMPERATURE,
        maxTokens: 1024,
        ...(options?.signal ? { abortSignal: options.signal } : {}),
      }
    );
  } catch (error) {
    return {
      error: {
        code: 'RSA_COPY_GENERATION_FAILED',
        reason: `RSA copy generation failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }

  const result = parseRsaCopy(raw);
  if (!result.copy) return { error: result.error };
  return { copy: result.copy, copyText: joinRsaCopyText(result.copy) };
}
