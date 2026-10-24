/**
 * Deterministic compliance/quality gates for generated creatives.
 *
 * Gates KILL; ranking only ORDERS. All checks here are deterministic string
 * checks except `policy`, which runs through an INJECTED async seam
 * (`policyCheck`) so this module never imports platform/tool/DB code. When no
 * seam is injected the policy gate honestly reports `unverified`.
 */

import type {
  CreativeBrief,
  CreativeGenome,
  CreativeImageProvider,
  CreativePlatform,
  GateResult,
  JudgeItemVerdict,
} from './types';
import { assertGenomeComplete } from './genome';
import {
  activeDisclaimers,
  findLexiconHits,
  findMissingDisclaimers,
  findProhibitedClaims,
} from '../brand-check/matchers';

/**
 * Whether a product reference image actually grounded (or can ground) a
 * generation with this provider: the brief must supply product images AND the
 * provider must support reference-image inputs. Shared by the pipeline's gate
 * stage and the iterate route's re-gate so the `product_fidelity` signal never
 * drifts between the two.
 */
export function hasProductReferenceSignal(
  brief: CreativeBrief,
  provider: Pick<CreativeImageProvider, 'capabilities'>
): boolean {
  return (
    (brief.brandKit?.productImages?.length ?? 0) > 0 &&
    provider.capabilities.referenceImages > 0
  );
}

export interface PolicyCheckInput {
  copyText: string;
  inImageText?: string;
  platform: CreativePlatform;
  industry?: string;
  /**
   * Final composited image — a `data:` URL or public https URL (brand
   * judge-gate only; conditionally threaded, absent for legacy seams).
   */
  imageRef?: string;
}

export interface PolicyCheckOutcome {
  passed: boolean;
  /**
   * Legacy seam: opaque violation payloads. Judge seam: failing requirement
   * TEXTS (strings, with judge notes appended).
   */
  violations?: unknown[];
  /**
   * Per-checklist verdicts — presence discriminates the brand judge gate
   * (Phase 6) from a legacy policy seam and drives the shadow/enforce
   * GateResult mapping.
   */
  items?: JudgeItemVerdict[];
  /** Shadow mode: verdicts persist but the gate never blocks. */
  shadow?: boolean;
  judgeModel?: string;
  judgeGateVersion?: string;
}

export type PolicyCheckFn = (
  _input: PolicyCheckInput
) => Promise<PolicyCheckOutcome>;

export interface RunGatesInput {
  brief: CreativeBrief;
  /** The composed copy block (headline/primary/CTA + appended disclaimers). */
  copyText: string;
  /**
   * Brand-mode grounding corpus (the pack-rendered copy-prompt user text) —
   * enables the deterministic copy_grounding gate (ungrounded numerals /
   * banned ad-speak). Absent for legacy/copy-only candidates → gate skipped.
   */
  groundingText?: string;
  /** In-image text when known (model-rendered); scanned alongside the copy. */
  inImageText?: string;
  /** Whether required disclaimers were rendered into the composed output. */
  disclaimerRendered: boolean;
  /** Whether a product reference image grounded the generation. */
  hasProductReference: boolean;
  genome: CreativeGenome;
  policyCheck?: PolicyCheckFn;
  /**
   * Final composited image ref threaded to the policy seam (conditionally
   * spread — absent for copy-only candidates and legacy callers).
   */
  imageRef?: string;
}

/**
 * Map a policy-seam outcome to the persisted GateResult. The `items` field is
 * the discriminator: without it the legacy mapping is byte-identical to the
 * pre-Phase-6 behavior (plain fail with the JSON.stringify reason, never
 * repairable); with it the brand judge's shadow/enforce semantics apply.
 */
function policyGateResult(outcome: PolicyCheckOutcome): GateResult {
  if (!outcome.items) {
    return outcome.passed
      ? { gate: 'policy', status: 'pass' }
      : {
          gate: 'policy',
          status: 'fail',
          reason: `Platform policy violation(s): ${JSON.stringify(outcome.violations ?? []).slice(0, 300)}`,
        };
  }
  const judged: Pick<GateResult, 'items' | 'judge'> = {
    items: outcome.items,
    judge: {
      ...(outcome.judgeModel ? { model: outcome.judgeModel } : {}),
      ...(outcome.judgeGateVersion ? { version: outcome.judgeGateVersion } : {}),
    },
  };
  const passedCount = outcome.items.filter((item) => item.passed).length;
  if (outcome.shadow) {
    // Shadow: verdicts persist for calibration; the gate never blocks.
    return {
      gate: 'policy',
      status: 'unverified',
      reason: `judge shadow: ${passedCount}/${outcome.items.length} checklist items passed`,
      ...judged,
    };
  }
  if (outcome.passed) {
    return { gate: 'policy', status: 'pass', ...judged };
  }
  // Enforce fail is REPAIRABLE — the one-shot edit() self-repair builds its
  // instruction from this reason, so it names the failing requirements
  // (human-readable, wider cap than the legacy JSON slice; full detail
  // always survives in `items`).
  return {
    gate: 'policy',
    status: 'fail',
    repairable: true,
    reason: `Brand rule violation(s): ${(outcome.violations ?? []).map(String).join('; ')}`.slice(0, 500),
    ...judged,
  };
}

export async function runGates(input: RunGatesInput): Promise<GateResult[]> {
  const {
    brief,
    copyText,
    inImageText,
    disclaimerRendered,
    hasProductReference,
    genome,
    policyCheck,
    imageRef,
  } = input;

  const haystack = inImageText ? `${copyText}\n${inImageText}` : copyText;
  const results: GateResult[] = [];

  // The rule matchers live in `brand-check/matchers.ts` — ONE implementation
  // shared with the stateless brand check, so the two can never disagree.

  // prohibited_claims — case-insensitive substring over copy + in-image text.
  const foundClaims = findProhibitedClaims(haystack, brief.compliance.prohibitedClaims);
  results.push(
    foundClaims.length > 0
      ? {
          gate: 'prohibited_claims',
          status: 'fail',
          reason: `Prohibited claim(s) present: ${foundClaims.join('; ')}`,
          repairable: true,
        }
      : { gate: 'prohibited_claims', status: 'pass' }
  );

  // disclaimer — verbatim STRING check. v1 has no overlay compositor: the
  // pipeline appends required disclaimers to the copy block, and this gate
  // verifies each exact string is present in that composed output.
  const requiredDisclaimers = activeDisclaimers(brief.compliance.requiredDisclaimers);
  if (requiredDisclaimers.length === 0) {
    results.push({ gate: 'disclaimer', status: 'pass' });
  } else if (!disclaimerRendered) {
    results.push({
      gate: 'disclaimer',
      status: 'fail',
      reason: 'Required disclaimers were not rendered into the composed output.',
      repairable: true,
    });
  } else {
    const missing = findMissingDisclaimers(haystack, requiredDisclaimers);
    results.push(
      missing.length > 0
        ? {
            gate: 'disclaimer',
            status: 'fail',
            reason: `Required disclaimer(s) missing verbatim: ${missing.join(' | ')}`,
            repairable: true,
          }
        : { gate: 'disclaimer', status: 'pass' }
    );
  }

  // lexicon — word-boundary match against brandLexicon.avoid.
  const lexiconHits = findLexiconHits(haystack, brief.brandLexicon?.avoid ?? []);
  results.push(
    lexiconHits.length > 0
      ? {
          gate: 'lexicon',
          status: 'fail',
          reason: `Brand-lexicon avoid word(s) present: ${lexiconHits.join(', ')}`,
          repairable: true,
        }
      : { gate: 'lexicon', status: 'pass' }
  );

  // copy_grounding — deterministic copy-quality scan (brand mode only):
  // ungrounded numerals (every digit sequence must appear in the pack
  // grounding text) + banned generic ad-speak. Defense in depth behind
  // brand-copy's generation-time guards — v1 reports 'unverified' on
  // violations (never blocks); flip to fail after shadow observation.
  if (input.groundingText !== undefined) {
    const { findBannedPhrases, findUngroundedNumerals } = await import(
      './brand-copy'
    );
    // Scan the GENERATED copy only. `copyText` is the composed block, whose
    // trailing lines are the brief's required disclaimers appended VERBATIM
    // by composeCopyBlock — brand-supplied legal text, not model output. Their
    // digits ("Results vary. 30-day trial.") are not ungrounded numerals, and
    // letting them fail the gate poisons the shadow calibration signal the
    // whole gate exists to collect. Drop those exact appended lines; every
    // other line (headline / primary text / CTA) is generated copy and is
    // still scanned, so pass/fail semantics are otherwise unchanged.
    const appendedDisclaimers = new Set(
      brief.compliance.requiredDisclaimers
        .map((disclaimer) => disclaimer.trim())
        .filter((disclaimer) => disclaimer.length > 0)
    );
    const generatedCopy =
      appendedDisclaimers.size === 0
        ? copyText
        : copyText
            .split('\n')
            .filter((line) => !appendedDisclaimers.has(line.trim()))
            .join('\n');
    const copyForScan = { headline: generatedCopy, primaryText: '' };
    const ungrounded = findUngroundedNumerals(copyForScan, input.groundingText);
    const banned = findBannedPhrases(copyForScan);
    const violations = [
      ...ungrounded.map((token) => `ungrounded numeral ${token}`),
      ...banned.map((phrase) => `banned phrase "${phrase}"`),
    ];
    results.push(
      violations.length > 0
        ? {
            gate: 'copy_grounding',
            status: 'unverified',
            reason: `Copy grounding violations (shadow): ${violations.join('; ')}`.slice(0, 300),
          }
        : { gate: 'copy_grounding', status: 'pass' }
    );
  }

  // genome_complete — hard, non-repairable (a missing genome cannot be fixed
  // by an image edit; it is a pipeline bug).
  const { complete, missing: missingFields } = assertGenomeComplete(genome);
  results.push(
    complete
      ? { gate: 'genome_complete', status: 'pass' }
      : {
          gate: 'genome_complete',
          status: 'fail',
          reason: `Genome missing required field(s): ${missingFields.join(', ')}`,
        }
  );

  // product_fidelity — 'pass' when a product reference image grounded the
  // generation, else honestly 'unverified'. Never 'fail' in v1 (no visual
  // verifier exists yet).
  results.push(
    hasProductReference
      ? { gate: 'product_fidelity', status: 'pass' }
      : {
          gate: 'product_fidelity',
          status: 'unverified',
          reason: 'No product reference image supplied; visual fidelity unverified.',
        }
  );

  // policy — injected seam; honest 'unverified' when absent or erroring.
  if (!policyCheck) {
    results.push({
      gate: 'policy',
      status: 'unverified',
      reason: 'No policy-check seam injected.',
    });
  } else {
    try {
      const outcome = await policyCheck({
        copyText,
        ...(inImageText ? { inImageText } : {}),
        platform: brief.platform,
        ...(brief.compliance.industry ? { industry: brief.compliance.industry } : {}),
        ...(imageRef ? { imageRef } : {}),
      });
      results.push(policyGateResult(outcome));
    } catch (error) {
      results.push({
        gate: 'policy',
        status: 'unverified',
        reason: `Policy check errored: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return results;
}

/**
 * True when the candidate failed at least one gate AND every failed gate is
 * marked repairable — i.e. one `edit()` self-repair attempt is worth making.
 */
export function isRepairable(results: GateResult[]): boolean {
  const failed = results.filter((result) => result.status === 'fail');
  return failed.length > 0 && failed.every((result) => result.repairable === true);
}
