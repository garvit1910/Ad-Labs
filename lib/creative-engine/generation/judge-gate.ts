/**
 * Brand judge gate (brand-context Phase 6) — a multimodal judge that executes
 * `renderJudgeChecklist(pack)`'s binary checklist against the FINAL COMPOSITED
 * ad image + copy, behind the existing `PolicyCheckFn` seam.
 *
 * One image per call as a base64 data URL at `detail:'low'` + strict
 * json_schema (the ad-library label-pipeline pattern — the proven vision
 * seam; `getLLMProvider().complete` is text-only and cannot be used).
 * Shadow-first: `CREATIVE_JUDGE_GATE_MODE` defaults to 'shadow' (verdicts
 * persist on gate_results, the gate reports 'unverified', nothing blocks);
 * flip to 'enforce' ONLY after scripts/eval-creative-judge-calibration.ts
 * exits 0 against a human-ratified gold set.
 *
 * The factory THROWS on every failure (missing image, dead link, LLM error,
 * incomplete checklist coverage) — gates.ts's existing try/catch maps every
 * throw to an honest 'unverified'; a judge that didn't cover the checklist
 * must never fail candidates it didn't judge (rank-judge discard posture).
 */

import { openAIChatCompletion } from '@/lib/llm/clients';
import { fetchCreativeImage } from './safe-image-fetch';
import type { JudgeChecklistItem } from '@/lib/creative-engine/brand-context/renderers';
import type { PolicyCheckFn, PolicyCheckOutcome } from './gates';
import type { JudgeItemVerdict } from './types';
import { resolveJudgeGateModel } from './model-resolvers';

/**
 * v3 (2026-08-13): fidelity semantics only — the prompt now says Image 2 pins
 * PRODUCT IDENTITY ONLY and that text findings must come from Image 1's
 * pixels. Version stamps persisted verdicts, so v2 shadow verdicts (judged
 * under the scene-match reading) stay distinguishable in the gold pool.
 */
export const JUDGE_GATE_VERSION = 'judge-gate-v3';

export type JudgeGateMode = 'shadow' | 'enforce' | 'enforce_structural' | 'off';

/**
 * CREATIVE_JUDGE_GATE_MODE: shadow (DEFAULT) | enforce_structural | enforce |
 * off. Unknown → shadow.
 *
 * shadow: verdicts persist as advisory badges + calibration data; NOTHING
 * blocks and no policy-fail self-repair spend happens. This is the default
 * BY INCIDENT EVIDENCE: the first live enforce_structural run (2026-08-04,
 * run 403ede09) gated out 4/4 candidates on a judge false positive — it read
 * the request's ad-copy block and flagged the platform copy as in-image text
 * (impossible: the image model never receives the copy). The judge must
 * never be able to zero a run; quality comes from the generation prompt.
 *
 * enforce_structural: pass/fail computed over the checklist's `enforced`
 * items only (no-added-text, product-fidelity); advisory items persist
 * without blocking. Env OPT-IN — flip only after
 * scripts/eval-creative-judge-calibration.ts exits 0 against a gold set that
 * includes the copy-conflation false-positive class. Full 'enforce'
 * (everything blocks) has the same calibration gate.
 */
export function resolveJudgeGateMode(): JudgeGateMode {
  const raw = (process.env.CREATIVE_JUDGE_GATE_MODE || '').trim().toLowerCase();
  return raw === 'enforce' || raw === 'off' || raw === 'enforce_structural'
    ? raw
    : 'shadow';
}

// Judge gate model (CREATIVE_JUDGE_GATE_MODEL, default gpt-4o): the resolver
// + its vision/Chat-Completions rationale live in ./model-resolvers.
export { resolveJudgeGateModel };

/** Providers/judges address images by URL; in-memory buffers travel as data: URLs. */
export function bufferToDataUrl(buffer: Buffer, contentType: string): string {
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * Fetch a remote image into a base64 data URL (null on any failure). A raw
 * remote URL must NEVER be sent to OpenAI — a dead link 400s the whole call.
 * Local mirror of the ad-library `fetchPoster` guards (services/job-processor/
 * ad-library/label/media.ts) — kept local because lib/creative-engine must
 * not import services/.
 */
export async function fetchImageAsDataUrl(
  url: string,
  timeoutMs = 10_000
): Promise<string | null> {
  try {
    // Through the creative-image SSRF guard (Adcero asset hosts only).
    const { buffer, contentType } = await fetchCreativeImage(url, {
      signal: AbortSignal.timeout(timeoutMs),
      maxBytes: MAX_IMAGE_BYTES,
      label: 'judge image',
    });
    if (buffer.length === 0) return null;
    return bufferToDataUrl(buffer, contentType);
  } catch {
    return null;
  }
}

const SYSTEM_PROMPT = [
  'You are a strict brand-compliance and quality judge for paid-social ad creatives.',
  'Image 1 is the FINAL ad creative to judge; when Image 2 is provided it is the REAL product reference photo — compare the creative\'s product against it for fidelity checks.',
  // Fidelity semantics, 2026-08-13 incident class: a live dev candidate
  // (AutologiQ) failed the fidelity item on "different background and
  // presentation", and the SAME verdict attributed reference-image text
  // ('NEW', 'Wheels & Tires', 'All Brands', 'Shop Now') to the candidate.
  // The pipeline DELIBERATELY restages the product per strategy group /
  // execution directive — scene differentiation is the feature, never a
  // defect — and the judge must read text off Image 1's pixels only.
  'Image 2 pins PRODUCT IDENTITY ONLY: judge whether the product depicted in Image 1 is the SAME physical product — same packaging, label text and logo, physical shape, and colorway.',
  'Image 1 is EXPECTED to show that product in a DIFFERENT scene, background, setting, staging, props, lighting, and composition than Image 2 — the ad pipeline deliberately restages the product for every candidate. Differences in scene, background, props, lighting, composition, or overall presentation are NEVER evidence of a fidelity failure. A fidelity check fails ONLY when the depicted product is not the same physical product (wrong packaging, altered or missing label/logo, wrong shape or colorway, or a different product category).',
  // The platform ad fields are metadata, NOT pixels. The first live run's
  // false-positive class: the judge cited the headline/CTA from the copy
  // block as "added image text" — text the image model never even received.
  'The "Platform ad fields" section lists the headline, primary text, and CTA that the ad platform renders OUTSIDE the image (around the creative, as real UI). They are NEVER painted into the image. Their text is NOT evidence of in-image text — a no-added-text check can only fail on text you can LITERALLY SEE rendered in Image 1\'s pixels.',
  // v2 clean-image doctrine: text on the product's own packaging is expected;
  // ADDED text/bands/buttons are the violation. The thin bottom disclaimer
  // strip is the one sanctioned overlay.
  // Second conflation source, same class as the copy block: text that lives in
  // the REFERENCE photo (which is often itself a marketing image carrying
  // badges and CTAs) read as if it were painted into the candidate.
  'Image 2 is evidence about the PRODUCT, never about what text Image 1 contains. Any "added text" finding must quote text you can LITERALLY SEE rendered in Image 1\'s pixels; text visible only in Image 2 must NEVER be attributed to Image 1.',
  "Text printed on the product's own packaging or label is expected and NEVER a violation. A thin bottom compliance-disclaimer strip is a sanctioned overlay and allowed. Any OTHER text visibly rendered in the image — headline bands, captions, CTA buttons, watermarks, invented brand names, fake disclaimers — IS a violation of the no-added-text check.",
  'Judge the creative against EVERY checklist item independently. Each item is BINARY — no partial credit.',
  // Live-smoke lesson: non-applicability is compliance, not violation —
  // without this clause the judge fails every rule whose subject matter the
  // creative simply does not touch.
  "A rule is VIOLATED only when the creative makes a claim, shows content, or triggers a disclosure requirement that it then breaches. If the rule's subject matter does not appear in the creative at all, the creative complies — mark passed=true.",
  // Structural visual checks need POSITIVE visual evidence to fail; the
  // cannot-verify-strict default applies to rule items only.
  'For structural checks about what is VISIBLE in the image (added text, scene contents), mark passed=false only on positive visual evidence in Image 1. For brand-rule items, mark passed=false when the creative clearly violates the requirement, or when it DOES trigger the requirement and you cannot verify compliance; explain why in note.',
  "Echo each item's id EXACTLY as given. Return one entry per checklist item, in the same order, never skipping or adding items.",
  'note: one short sentence; REQUIRED for every failed item, null for passing items.',
].join(' ');

/**
 * Build the Chat Completions body: system prompt + ONE user message holding a
 * text part (checklist + copy) followed by the low-detail creative image and
 * — when supplied — the real product reference image (fidelity comparison).
 * temperature 0 — the calibration script re-runs this exact body.
 */
export function buildJudgeGateRequestBody(
  checklist: JudgeChecklistItem[],
  copyText: string,
  imageDataUrl: string,
  model: string,
  referenceImageDataUrl?: string
): Record<string, unknown> {
  const checklistLines = checklist
    .map((item, index) => `${index + 1}. ${item.id} — ${item.requirement}`)
    .join('\n');
  // The per-request twin of the SYSTEM_PROMPT fidelity clauses (2026-08-13
  // incident: the judge cited "different background and presentation" as
  // wrong-product evidence and attributed reference-image text to the
  // candidate). Restated here because the checklist text sits in this part.
  const imagesNote = referenceImageDataUrl
    ? [
        'Image 1 = the ad creative to judge. Image 2 = the real product reference.',
        'Image 2 pins PRODUCT IDENTITY ONLY — packaging, label text and logo, physical shape, colorway. Image 1 is EXPECTED to stage that product in a different scene, background, and presentation; scene/staging/lighting/composition differences are NEVER a fidelity failure.',
        "Text findings must cite text literally visible in Image 1's pixels — never text read off Image 2.",
      ].join('\n')
    : 'Image 1 = the ad creative to judge (no product reference supplied).';
  const text = `## Checklist\n${checklistLines}\n\n## Images\n${imagesNote}\n\n## Platform ad fields (rendered OUTSIDE the image by the ad platform — NEVER painted into the image; not in-image text)\n${copyText}`;
  return {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text },
          { type: 'image_url', image_url: { url: imageDataUrl, detail: 'low' } },
          ...(referenceImageDataUrl
            ? [
                {
                  type: 'image_url',
                  image_url: { url: referenceImageDataUrl, detail: 'low' },
                },
              ]
            : []),
        ],
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'judge_gate_verdicts',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['items'],
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                // OpenAI strict mode: EVERY property must be in `required`;
                // optionality is expressed as a nullable type, never omission.
                required: ['id', 'passed', 'note'],
                properties: {
                  id: { type: 'string', enum: checklist.map((item) => item.id) },
                  passed: { type: 'boolean' },
                  note: { type: ['string', 'null'] },
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
 * Parse + coverage-gate the model output: every checklist id must appear
 * exactly once with a boolean verdict — anything else THROWS (a judge that
 * didn't cover the checklist must not fail candidates it didn't judge).
 * Output is re-sorted to checklist order.
 */
export function parseJudgeGateResponse(
  raw: Record<string, unknown>,
  checklist: JudgeChecklistItem[]
): JudgeItemVerdict[] {
  const content = (
    raw as { choices?: Array<{ message?: { content?: unknown } }> }
  ).choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('JUDGE_INCOMPLETE_COVERAGE: model returned no content');
  }
  let parsed: { items?: unknown };
  try {
    parsed = JSON.parse(content) as { items?: unknown };
  } catch {
    throw new Error('JUDGE_INCOMPLETE_COVERAGE: model did not return valid JSON');
  }
  if (!Array.isArray(parsed.items)) {
    throw new Error('JUDGE_INCOMPLETE_COVERAGE: missing items array');
  }
  const byId = new Map<string, JudgeItemVerdict>();
  for (const entry of parsed.items) {
    const item = entry as { id?: unknown; passed?: unknown; note?: unknown };
    if (typeof item.id !== 'string' || typeof item.passed !== 'boolean') {
      throw new Error('JUDGE_INCOMPLETE_COVERAGE: malformed verdict entry');
    }
    if (byId.has(item.id)) {
      throw new Error(`JUDGE_INCOMPLETE_COVERAGE: duplicate verdict for ${item.id}`);
    }
    byId.set(item.id, {
      id: item.id,
      passed: item.passed,
      ...(typeof item.note === 'string' && item.note.length > 0
        ? { note: item.note }
        : {}),
    });
  }
  return checklist.map((item) => {
    const verdict = byId.get(item.id);
    if (!verdict) {
      throw new Error(`JUDGE_INCOMPLETE_COVERAGE: no verdict for ${item.id}`);
    }
    byId.delete(item.id);
    return verdict;
  });
}

export interface CreateJudgeGateOptions {
  checklist: JudgeChecklistItem[];
  mode: 'shadow' | 'enforce' | 'enforce_structural';
  model?: string;
  signal?: AbortSignal;
  /**
   * The real product reference image (primary pack product_image URL) — the
   * judge compares the creative's product against it for the fidelity item.
   * Fetched once per run (lazily, memoized) and attached as a second image
   * part. Best-effort: an unfetchable reference judges creative-only.
   */
  referenceImageUrl?: string;
  /** Test seam; default = bounded local fetch → base64 data URL. */
  fetchImage?: (_url: string) => Promise<string | null>;
}

/**
 * Build the PolicyCheckFn the pipeline/routes inject. Closes over the pack's
 * checklist (run-wide constant); receives the per-candidate image via
 * `input.imageRef`.
 */
export function createJudgeGatePolicyCheck(
  opts: CreateJudgeGateOptions
): PolicyCheckFn {
  const model = opts.model ?? resolveJudgeGateModel();
  const fetchImage = opts.fetchImage ?? fetchImageAsDataUrl;
  const itemById = new Map(opts.checklist.map((item) => [item.id, item]));
  const enforcedIds = new Set(
    opts.checklist.filter((item) => item.enforced).map((item) => item.id)
  );
  // The reference image is a run-wide constant — fetch once, share across
  // every candidate's judge call. Best-effort (null = judge creative-only).
  let referencePromise: Promise<string | null> | undefined;
  const resolveReference = (): Promise<string | null> => {
    if (!opts.referenceImageUrl) return Promise.resolve(null);
    referencePromise ??= fetchImage(opts.referenceImageUrl).catch(() => null);
    return referencePromise;
  };
  return async (input): Promise<PolicyCheckOutcome> => {
    if (!input.imageRef) {
      throw new Error('JUDGE_IMAGE_MISSING: no image ref supplied to the brand judge');
    }
    let imageDataUrl = input.imageRef;
    if (!imageDataUrl.startsWith('data:')) {
      const fetched = await fetchImage(imageDataUrl);
      if (!fetched) {
        throw new Error(
          `JUDGE_IMAGE_UNAVAILABLE: could not fetch image for judging (${imageDataUrl.slice(0, 120)})`
        );
      }
      imageDataUrl = fetched;
    }
    const referenceImageDataUrl = await resolveReference();
    const body = buildJudgeGateRequestBody(
      opts.checklist,
      input.copyText,
      imageDataUrl,
      model,
      referenceImageDataUrl ?? undefined
    );
    const completion = await openAIChatCompletion({
      body,
      retryProfile: 'background',
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const items = parseJudgeGateResponse(completion, opts.checklist);
    const failing = items.filter((item) => !item.passed);
    // enforce_structural: only `enforced` checklist items decide pass/fail;
    // advisory failures persist as verdicts but never block.
    const blockingFailing =
      opts.mode === 'enforce_structural'
        ? failing.filter((item) => enforcedIds.has(item.id))
        : failing;
    const violations = blockingFailing.map((item) => {
      const requirement = itemById.get(item.id)?.requirement ?? item.id;
      return item.note ? `${requirement} (${item.note})` : requirement;
    });
    return {
      passed: blockingFailing.length === 0,
      ...(violations.length > 0 ? { violations } : {}),
      items,
      ...(opts.mode === 'shadow' ? { shadow: true } : {}),
      judgeModel: model,
      judgeGateVersion: JUDGE_GATE_VERSION,
    };
  };
}

/**
 * Degrade path for the edit routes: a seam that always throws its reason —
 * gates.ts maps the throw to `unverified` with `Policy check errored: …`.
 * A route must never hard-fail a human's edit of an already-paid asset on
 * judge infrastructure problems.
 */
export function judgeUnavailablePolicyCheck(reason: string): PolicyCheckFn {
  return async () => {
    throw new Error(reason);
  };
}
