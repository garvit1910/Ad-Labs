/**
 * Pure stage helpers for the generation pipeline: candidate spec building,
 * resume-seed rehydration, one wide-generation wave, and the shared
 * working-candidate → persistence-record mapping.
 *
 * Everything here is param-in/result-out — NO shared mutable state. The
 * orchestrator in `pipeline.ts` owns the run summary, the cancel latch, and
 * the time-budget flags, and applies each helper's returned deltas itself
 * (e.g. `spentCents`). Keep it that way: a helper that reaches back into the
 * summary reintroduces exactly the closure coupling this split removed.
 */

import type {
  AspectRatio,
  CandidateRank,
  ComposedStructuredCopy,
  CreativeBrief,
  CreativeGenome,
  CreativeImageProvider,
  CreativeStatus,
  EditLineageStep,
  GateResult,
  GenerationRequest,
  GenerationResult,
  GenerationRunSummary,
  StructuredCopy,
  StructuredError,
} from './types';
import type { PolicyCheckFn } from './gates';
// Type-only imports from the PURE brand-context submodules — keeps this
// module's "no DB imports" claim true (the mixed brand-context barrel is
// routes-only).
import type { BrandContextPack } from '@/lib/creative-engine/brand-context/types';
import type {
  ImageReferenceAsset,
  ImageRenderSegments,
} from '@/lib/creative-engine/brand-context/renderers';
import { buildGenome } from './genome';
import { resolveWideQuality } from './cost';
import { isTransientImageProviderError } from './providers/shared';
import { EXECUTION_NOTES_PREFIX } from './execution-directives';

/** Max concurrent provider calls per Promise.allSettled wave. */
export const GENERATION_CONCURRENCY = 4;

/**
 * The 4 wide-generation variation prompt modifiers (round-robined per
 * candidate). PRODUCT-GROUNDED since the 2026-08-04 quality rework: every
 * variation keeps the product as the hero in a usage-motivated scene — the
 * old abstract modifiers ("energetic real-world environment") produced
 * irrelevant crowds/venues with no connection to the product.
 */
export const VARIATION_MODIFIERS = [
  {
    key: 'product-hero-studio',
    text: 'Product hero on a clean seamless studio background, soft directional lighting, gentle shadow, label facing camera.',
  },
  {
    key: 'in-use-moment',
    text: 'Product in a realistic in-use scene: the exact moment a customer uses it, natural light, candid framing.',
  },
  {
    key: 'label-closeup',
    text: 'Close-up on the product surface and label detail, shallow depth of field, tactile texture.',
  },
  {
    key: 'natural-props-staging',
    text: 'Product staged with only the props that naturally accompany its use, overhead or three-quarter view, editorial styling.',
  },
] as const;

/**
 * A previously-persisted candidate row, rehydrated into the pipeline on a
 * resumed invocation. Seeds are matched to specs by deterministic candidate
 * id (`${runId}-cN`), so a resumed run regenerates NOTHING that already has a
 * persisted outcome — including failed attempts, which are never blind-retried
 * (they spent real dollars).
 */
export interface PersistedCandidateSeed {
  id: string;
  status: CreativeStatus;
  /** Public URL of the stored asset — absent when generation itself failed. */
  assetUrl?: string;
  costCents: number;
  editLineage: EditLineageStep[];
  gateResults: GateResult[];
  genome?: CreativeGenome;
  copyText?: string;
  model?: string;
  /** Stored structured copy — the brand-mode resume-determinism seed. */
  structuredCopy?: StructuredCopy;
  error?: StructuredError;
}

/** The full per-candidate record handed to the injected persistence seam. */
export interface PipelineCandidate {
  id: string;
  status: CreativeStatus;
  /**
   * Present only when this invocation holds fresh image bytes that still need
   * uploading. Absent for candidates whose asset is already stored (the
   * persistence seam must then PRESERVE the existing asset columns) and for
   * failed generations.
   */
  imageBuffer?: Buffer;
  contentType?: string;
  aspectRatio: AspectRatio;
  variationIndex: number;
  genome: CreativeGenome;
  gateResults: GateResult[];
  rank?: CandidateRank;
  costCents: number;
  editLineage: EditLineageStep[];
  provider: string;
  model: string;
  copyText: string;
  /**
   * Brand-mode run-wide composed copy — stamped on EVERY brand-mode record
   * (failed and rehydrated included: the copy exists independent of image
   * success and must never be nulled over a stored value). Absent on legacy
   * candidates.
   */
  structuredCopy?: ComposedStructuredCopy;
  /**
   * Agentic tags slot payload (brand mode: `{ brandContext: {...lineage} }`).
   * Absent on legacy candidates — the persistence seam must OMIT the column
   * when absent so the legacy insert shape stays byte-compatible.
   */
  tags?: Record<string, unknown>;
  error?: StructuredError;
}

/**
 * One resolved brand copy set (brand-context Phase 5; per-group since 2026-08).
 * A run holds one entry per strategy group that will actually receive
 * candidates, plus a default entry for legacy/no-strategy runs.
 */
export interface BrandCopyEntry {
  headline: string;
  primaryText: string;
  cta: string;
  source: 'llm' | 'brief_fallback';
  /** Strategy group this set executes (rides structured_copy + seed reuse). */
  strategyKey?: string;
  /**
   * The copywriter's image direction for this set (see
   * `ComposedStructuredCopy.visualConcept`) — joins every candidate's brand
   * image prompt (`VISUAL_CONCEPT_PROMPT_PREFIX`). Absent → prompt unchanged.
   */
  visualConcept?: string;
  /**
   * Cents spent on THIS invocation's copy LLM call for THIS entry (0 when
   * seed-reused or brief-fallback). Charged durably, once, on the first
   * candidate of the entry's group (round-robin ⇒ global index = group index).
   */
  copyCostCents: number;
}

export interface GenerationPipelineDeps {
  providers: CreativeImageProvider[];
  persistCandidate: (_candidate: PipelineCandidate) => Promise<void>;
  updateRun: (_patch: Partial<GenerationRunSummary>) => Promise<void>;
  policyCheck?: PolicyCheckFn;
  /**
   * M3.1 hybrid-text overlay seam (composition.ts wired by the processor):
   * renders the brief's required disclaimers onto fresh generation bytes
   * before first persist. Best-effort — an overlay failure keeps the original
   * bytes (the disclaimers still ride the copy block, which is what the
   * disclaimer gate verifies), and genome.generationParams.disclaimerOverlay
   * records whether the strip was actually applied.
   */
  composeOverlay?: (_input: {
    imageBuffer: Buffer;
    contentType: string;
    brief: CreativeBrief;
  }) => Promise<{ imageBuffer: Buffer; contentType: string; overlayApplied: boolean }>;
  /** Candidate id factory; defaults to `${runId}-c${index}`. */
  candidateId?: (_index: number) => string;
  /** Caller abort signal threaded into every provider call. */
  signal?: AbortSignal;
  /**
   * Soft function-time-budget hook (e.g. Vercel maxDuration headroom). Checked
   * between generation waves, before each self-repair, and between stage
   * transitions. When it trips: with `pauseOnTimeBudget` the run PAUSES
   * (throws FunctionTimeoutError → executor requeues → a later invocation
   * resumes from `existingCandidates`); without it the pipeline stops
   * generating NEW candidates but still gates/ranks/persists everything
   * generated so far, then marks the run 'failed' with a structured
   * RUN_TIME_BUDGET_EXCEEDED error.
   */
  shouldStop?: () => boolean;
  /**
   * When true, a tripped time budget pauses the run (resumable) instead of
   * failing it. The processor bounds this with a resume cap so a pathological
   * run cannot pause forever.
   */
  pauseOnTimeBudget?: boolean;
  /**
   * Already-persisted candidates for this run (resume seeds). Specs whose id
   * matches a seed are rehydrated — no provider call, no double spend.
   */
  existingCandidates?: PersistedCandidateSeed[];
  /**
   * Cooperative user-cancel check (DB-backed), polled at the same checkpoints
   * as `shouldStop`. When it reports true the run stops all new provider
   * spend, finalizes existing candidates, and returns status 'cancelled'.
   */
  isCancelled?: () => boolean | Promise<boolean>;
  /**
   * Brand-mode generation (brand-context Phase 5): the compiled pack + the
   * resolved copy. Present iff the brief carries tags.brandContext — the
   * processor loads the immutable pack by fingerprint and resolves copy
   * (composed-seed reuse → LLM → brief fallback) BEFORE the pipeline runs;
   * the pipeline consumes renderImagePrompt(pack) + this copy. Absent →
   * legacy path byte-identical.
   */
  brandContext?: {
    pack: BrandContextPack;
    fingerprint: string;
    /**
     * The DEFAULT copy entry: the only entry for a legacy (no strategy stamp)
     * brand run, the first group's entry for a strategy run, and the resolver
     * fallback for any candidate whose group has no entry of its own.
     */
    copy: BrandCopyEntry;
    /**
     * Per-strategy-group copy (one `generateBrandCopy` call per group, 2026-08)
     * keyed by `StrategyGroup.key`. A candidate resolves
     * `copyByStrategy[spec.variation.strategyKey] ?? copy`, so absent = the
     * legacy single-copy run.
     */
    copyByStrategy?: Record<string, BrandCopyEntry>;
    /**
     * The pack-rendered copy-prompt user text — the grounding corpus for the
     * deterministic copy_grounding gate. Run-wide (pack-level): it is NOT
     * forked per group. Optional (older callers omit it).
     */
    groundingText?: string;
  };
  /**
   * Evidence-driven strategy stamp (tags.strategy, read by the processor):
   * the groups drive the per-candidate variation plan. Absent → default
   * product-grounded modifiers.
   */
  strategy?: {
    /**
     * `tags.strategy.angleKey` — the selector's/sampler's own picked angle
     * token. Rides to `buildGenome` as the STRONGEST completeness rung, so the
     * stamped `angleUniversal` names the arm the engine actually pulled instead
     * of whatever the prose ladder can recover (genome-completeness.ts).
     */
    angleKey?: string;
    /**
     * Brand mode only. Absent → `buildVariationPlan` returns the default
     * product-grounded modifiers, byte-identically to having no stamp at all,
     * so a legacy brief may still ride `angleKey` here for the genome without
     * changing a single image prompt.
     */
    groups?: Array<{
      key: string;
      hookArchetype: string;
      format: string;
      sceneDirective: string;
      hookDirective: string;
      /** Market execution cues — absent on legacy stamps. */
      executionDirective?: string;
      /** Sanitized winning-ad staging notes — absent on legacy stamps. */
      executionNotes?: string;
    }>;
  };
  /**
   * Flat per-judged-candidate brand judge-gate LLM cost (cents) — set by the
   * processor iff `policyCheck` is the brand judge (Phase 6). The pipeline
   * charges it per candidate whose policy gate actually returned verdicts.
   */
  judgeCostCents?: number;
}

/** One per-candidate variation treatment (strategy group or default modifier). */
export interface VariationSpec {
  key: string;
  text: string;
  /** Strategy-group provenance — stamped into the genome when present. */
  hookArchetype?: string;
  format?: string;
  strategyKey?: string;
  /** Which market-execution components ride `text` — genome observability. */
  execution?: { directive: boolean; notes: boolean };
}

/**
 * The strategy groups that actually reach the variation plan, IN PLAN ORDER —
 * a group with no scene directive can direct no image and is dropped. THE
 * single predicate: the processor calls this to decide which groups get their
 * own copy call, so a group can never have copy without candidates (or
 * candidates without their own copy).
 */
export function selectStrategyGroups<T extends { sceneDirective: string }>(
  groups: T[],
): T[] {
  return groups.filter((group) => group.sceneDirective.length > 0);
}

/**
 * Build the run's variation plan: one spec per strategy group when the brief
 * carries an evidence-driven strategy stamp; the product-grounded defaults
 * otherwise. The variation text composes sceneDirective → market execution
 * cues → prefixed winning-ad staging notes (each part optional past the
 * first); the renderer's constraints segment still joins AFTER the whole
 * variation text, so the anti-slop templates always have the last word.
 * Round-robined deterministically (`index % plan.length`) — resume-safe.
 */
export function buildVariationPlan(
  groups?: Array<{
    key: string;
    hookArchetype: string;
    format: string;
    sceneDirective: string;
    executionDirective?: string;
    executionNotes?: string;
  }>,
): VariationSpec[] {
  if (!groups || groups.length === 0) {
    return VARIATION_MODIFIERS.map((modifier) => ({ ...modifier }));
  }
  return selectStrategyGroups(groups)
    .map((group) => {
      const hasDirective = Boolean(
        group.executionDirective && group.executionDirective.length > 0,
      );
      const hasNotes = Boolean(
        group.executionNotes && group.executionNotes.length > 0,
      );
      const text = [
        group.sceneDirective,
        ...(hasDirective ? [group.executionDirective as string] : []),
        ...(hasNotes
          ? [`${EXECUTION_NOTES_PREFIX}${group.executionNotes as string}`]
          : []),
      ].join(' ');
      return {
        key: group.key,
        text,
        hookArchetype: group.hookArchetype,
        format: group.format,
        strategyKey: group.key,
        ...(hasDirective || hasNotes
          ? { execution: { directive: hasDirective, notes: hasNotes } }
          : {}),
      };
    });
}

export interface CandidateSpec {
  index: number;
  id: string;
  provider: CreativeImageProvider;
  variation: VariationSpec;
  variationIndex: number;
}

export interface WorkingCandidate {
  spec: CandidateSpec;
  generation: GenerationResult | null;
  /** Stored-asset URL for candidates persisted by an earlier invocation. */
  assetUrl?: string;
  /** True while this invocation holds image bytes not yet successfully persisted. */
  assetDirty: boolean;
  /** Model recorded at generation time (rides seeds across invocations). */
  model?: string;
  copyText: string;
  costCents: number;
  editLineage: EditLineageStep[];
  genome: CreativeGenome;
  gateResults: GateResult[];
  error?: StructuredError;
}

/** A candidate that produced (or previously persisted) an image asset. */
export function hasAsset(candidate: WorkingCandidate): boolean {
  return candidate.generation !== null || !!candidate.assetUrl;
}

export function toStructuredError(
  reason: unknown,
  code = 'GENERATION_FAILED'
): StructuredError {
  return {
    code,
    reason: reason instanceof Error ? reason.message : String(reason),
    remediation:
      'Retry the run, or pin a different provider via CREATIVE_IMAGE_PROVIDER if this provider keeps failing.',
  };
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Compose the copy block: headline / primary text / CTA from the brief, with
 * required disclaimers APPENDED VERBATIM (v1 has no overlay compositor — the
 * disclaimer gate verifies these exact strings in this composed output).
 */
export function composeCopyBlock(brief: CreativeBrief): string {
  const lines: string[] = [];
  if (brief.headline) lines.push(brief.headline);
  if (brief.primaryText) lines.push(brief.primaryText);
  lines.push(`CTA: ${brief.cta}`);
  for (const disclaimer of brief.compliance.requiredDisclaimers) {
    if (disclaimer.trim().length > 0) lines.push(disclaimer);
  }
  return lines.join('\n');
}

// LEGACY-MODE-REMOVAL: delete with the packless full-brief generation path.
export function buildGenerationPrompt(
  brief: CreativeBrief,
  variation: VariationSpec,
  aspectRatio: AspectRatio
): string {
  return [
    `Create a ${brief.platform} ad creative image.`,
    `Concept angle: ${brief.angle}.`,
    `Audience: ${brief.persona}.`,
    `Core message: ${brief.coreMessage}.`,
    `Visual direction: ${brief.visualDirection}`,
    `Style: ${brief.styleDirection ?? brief.style}.`,
    `Composition variation: ${variation.text}`,
    `Target aspect ratio: ${aspectRatio}.`,
    // The clean-image guarantee holds for EVERY run, not just brand mode:
    // no fake bands/buttons, faithful packaging, usage-motivated scenes.
    'Constraints: do not ADD any text, headlines, captions, banner bands, buttons, CTA pills, watermarks, or floating logos to the image; never render invented brand names, slogans, disclaimers, or legal text; the only text allowed is text physically printed on the product itself, reproduced faithfully.',
    'Every prop, person, and setting must be naturally motivated by how the product is actually used — no unrelated crowds, devices, screens, or venues.',
  ].join(' ');
}

/** One self-repair attempt per candidate, across ALL invocations of a run. */
export function hasPriorSelfRepair(lineage: EditLineageStep[]): boolean {
  return lineage.some((step) => step.actor === 'self_repair');
}

/** Stage-1 fan-out plan: providers round-robin × the 4 variation modifiers. */
export function buildCandidateSpecs(input: {
  candidateCount: number;
  providers: CreativeImageProvider[];
  runId: string;
  candidateId?: (_index: number) => string;
  /** Strategy-driven plan (buildVariationPlan); defaults to the modifiers. */
  variationPlan?: VariationSpec[];
}): CandidateSpec[] {
  const plan =
    input.variationPlan && input.variationPlan.length > 0
      ? input.variationPlan
      : VARIATION_MODIFIERS.map((modifier) => ({ ...modifier }));
  return Array.from({ length: input.candidateCount }, (_, index) => ({
    index,
    id: input.candidateId?.(index) ?? `${input.runId}-c${index}`,
    provider: input.providers[index % input.providers.length],
    variation: plan[index % plan.length],
    variationIndex: index % plan.length,
  }));
}

/**
 * Rehydrate seeded specs (already persisted by an earlier invocation) into
 * working candidates — a resumed run pays nothing for them. Returns the
 * seeded candidates plus the specs still pending generation.
 */
export function rehydrateSeededCandidates(input: {
  specs: CandidateSpec[];
  seedById: Map<string, PersistedCandidateSeed>;
  brief: CreativeBrief;
  aspectRatio: AspectRatio;
  dims: { width: number; height: number };
  /** Per-candidate composed copy block (brand mode resolves it per group). */
  copyTextFor: (_spec: CandidateSpec) => string;
  /** The run's strategy angle pick — see `PipelineInput.strategy.angleKey`. */
  strategyAngleKey?: string;
}): { working: WorkingCandidate[]; pendingSpecs: CandidateSpec[] } {
  const working: WorkingCandidate[] = [];
  const pendingSpecs: CandidateSpec[] = [];
  for (const spec of input.specs) {
    const seed = input.seedById.get(spec.id);
    if (!seed) {
      pendingSpecs.push(spec);
      continue;
    }
    working.push({
      spec,
      generation: null,
      ...(seed.assetUrl && seed.status !== 'failed' ? { assetUrl: seed.assetUrl } : {}),
      assetDirty: false,
      ...(seed.model ? { model: seed.model } : {}),
      copyText: seed.copyText ?? input.copyTextFor(spec),
      costCents: seed.costCents || 0,
      editLineage: seed.editLineage ?? [],
      genome:
        seed.genome ??
        buildGenome(
          input.brief,
          spec.provider.name,
          seed.model ?? 'unknown',
          {
            variation: spec.variation.key,
            variationIndex: spec.variationIndex,
            aspectRatio: input.aspectRatio,
            width: input.dims.width,
            height: input.dims.height,
          },
          {
            ...(spec.variation.hookArchetype
              ? { hookArchetype: spec.variation.hookArchetype }
              : {}),
            ...(spec.variation.format
              ? { format: spec.variation.format as CreativeGenome['format'] }
              : {}),
          },
          input.strategyAngleKey
            ? { angleKey: input.strategyAngleKey }
            : undefined
        ),
      gateResults: seed.gateResults ?? [],
      ...(seed.error ? { error: seed.error } : {}),
    });
  }
  return { working, pendingSpecs };
}

/** Fixed backoff between the two wide-pass generate attempts. */
export const IMAGE_RETRY_BACKOFF_MS = 2_000;

/**
 * ONE bounded retry for TRANSIENT image-provider failures — 2 attempts max,
 * hard-coded, no env knob. A single 5xx/timeout used to fail a candidate
 * permanently (the rejection persists as `status:'failed'` and resume skips
 * any spec id already seeded, regardless of status).
 *
 * Cost model is UNCHANGED: retry-then-succeed is ONE billed image (the wave
 * charges `estimateCostCents` once on the fulfilled result); retry-then-fail
 * stays at `copyCents` only. Nothing is persisted — the retry is
 * within-invocation, so resume semantics are untouched. This is a DIFFERENT
 * mechanism from the one-paid-attempt self-repair invariant (post-gate
 * `edit()` calls in pipeline-repair.ts); it never touches `editLineage`.
 *
 * No AbortSignal is reused across attempts — each provider call builds its own
 * fresh `buildTimeoutSignal` internally, so re-calling `generate` is correct.
 */
async function generateWithTransientRetry(
  spec: CandidateSpec,
  args: GenerationRequest
): Promise<GenerationResult> {
  try {
    return await spec.provider.generate(args);
  } catch (error) {
    if (!isTransientImageProviderError(error)) throw error;
    console.warn(
      `[CreativePipeline] transient provider error for ${spec.id}, retrying once:`,
      error instanceof Error ? error.message : error
    );
    await new Promise((resolve) => setTimeout(resolve, IMAGE_RETRY_BACKOFF_MS));
    // The retry's own rejection propagates as the LAST error, so the existing
    // failure handling (toStructuredError → status:'failed') is byte-identical.
    return spec.provider.generate(args);
  }
}

/**
 * Lead-in for the copywriter's per-set visual concept in a brand image prompt.
 * The concept is RUN STATE (it varies per strategy group), so like the
 * variation text it rides outside the pack contract, before constraints.
 */
export const VISUAL_CONCEPT_PROMPT_PREFIX =
  "Ad-specific scene for this creative (it must visibly express this ad's message):";

/**
 * Run ONE wide-generation wave (a concurrency chunk of specs) through the
 * providers, applying the best-effort disclaimer overlay to fresh bytes.
 * Per-candidate failures degrade to status-less error candidates — the wave
 * itself never throws. Returns the wave's candidates plus the provider spend
 * for the caller to fold into the run summary.
 */
export async function generateWave(input: {
  chunk: CandidateSpec[];
  brief: CreativeBrief;
  aspectRatio: AspectRatio;
  dims: { width: number; height: number };
  /** Per-candidate composed copy block (brand mode resolves it per group). */
  copyTextFor: (_spec: CandidateSpec) => string;
  composeOverlay?: (_overlayInput: {
    imageBuffer: Buffer;
    contentType: string;
    brief: CreativeBrief;
  }) => Promise<{ imageBuffer: Buffer; contentType: string; overlayApplied: boolean }>;
  signal?: AbortSignal;
  /** Brand mode: pack-rendered prompt segments + reference assets. */
  brandContext?: {
    segments: ImageRenderSegments;
    referenceAssets: ImageReferenceAsset[];
    packFingerprint: string;
    /** The candidate's own group copy (falls back to the default entry). */
    copyFor: (_spec: CandidateSpec) => BrandCopyEntry;
    /**
     * How many leading candidate indexes carry a group's copy charge. Under
     * round-robin the FIRST candidate of group g is global index g, so
     * `spec.index < copyGroupCount` selects exactly one candidate per group.
     */
    copyGroupCount: number;
  };
  /** The run's strategy angle pick — see `PipelineInput.strategy.angleKey`. */
  strategyAngleKey?: string;
}): Promise<{ candidates: WorkingCandidate[]; spentCents: number }> {
  const { chunk, brief, aspectRatio, dims } = input;
  // Brand mode: the pack-rendered segments with the per-candidate variation
  // inserted BETWEEN style and constraints — the contract-test-pinned Phase-5
  // insertion point (constraints ALWAYS last; bare variation text, no
  // "Composition variation:" prefix). The candidate's own group's visual
  // concept (the copywriter's image direction) follows the variation, still
  // before constraints. This is the ONE brand prompt composition: it is
  // stamped into genome.generationParams.prompt, which is what fidelity
  // self-repair regenerates from, so repair inherits the concept verbatim.
  const promptForSpec = (spec: CandidateSpec): string => {
    if (!input.brandContext) {
      return buildGenerationPrompt(brief, spec.variation, aspectRatio);
    }
    const concept = input.brandContext.copyFor(spec).visualConcept;
    return [
      input.brandContext.segments.scene,
      input.brandContext.segments.subject,
      input.brandContext.segments.style,
      // v3 quality segment rides between style and the per-candidate
      // variation; constraints stay LAST (the pinned contract).
      input.brandContext.segments.quality,
      spec.variation.text,
      ...(concept ? [`${VISUAL_CONCEPT_PROMPT_PREFIX} ${concept}`] : []),
      input.brandContext.segments.constraints,
    ].join(' ');
  };
  const results = await Promise.allSettled(
    chunk.map(async (spec) => {
      const referenceImages = (
        input.brandContext
          ? input.brandContext.referenceAssets.map((asset) => asset.url)
          : brief.brandKit.productImages.map((image) => image.url)
      ).slice(0, spec.provider.capabilities.referenceImages);
      const generation = await generateWithTransientRetry(spec, {
        prompt: promptForSpec(spec),
        width: dims.width,
        height: dims.height,
        style: brief.styleDirection ?? brief.style,
        // Wide-pass quality tier (CREATIVE_GEN_WIDE_QUALITY, default
        // 'medium'); tiered-pricing providers honor it, others ignore it.
        quality: resolveWideQuality(),
        ...(referenceImages.length > 0 ? { referenceImages } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      // Hybrid-text overlay on fresh bytes, before first persist.
      // Best-effort: a compositor failure keeps the generated bytes.
      if (!input.composeOverlay) return { generation, overlayApplied: false };
      try {
        const overlaid = await input.composeOverlay({
          imageBuffer: generation.imageBuffer,
          contentType: generation.contentType,
          brief,
        });
        return {
          generation: {
            ...generation,
            imageBuffer: overlaid.imageBuffer,
            contentType: overlaid.contentType,
          },
          overlayApplied: overlaid.overlayApplied,
        };
      } catch (overlayError) {
        console.warn(
          `[CreativePipeline] disclaimer overlay failed for ${spec.id}:`,
          overlayError instanceof Error ? overlayError.message : overlayError
        );
        return { generation, overlayApplied: false };
      }
    })
  );

  // Map each settled result back to its candidate by index (chunk[i]).
  const candidates: WorkingCandidate[] = [];
  let spentCents = 0;
  results.forEach((result, i) => {
    const spec = chunk[i];
    // Stamp the final prompt into the genome params (fixes the always-NULL
    // generated_creatives.prompt — the processor persists
    // genome.generationParams.prompt); brand runs add lineage provenance.
    // The candidate's own group copy — `copySource` is per-group provenance
    // (one group can fall back to the brief while its siblings keep LLM copy).
    const copyEntry = input.brandContext?.copyFor(spec);
    const brandParams =
      input.brandContext && copyEntry
        ? {
            packFingerprint: input.brandContext.packFingerprint,
            copySource: copyEntry.source,
            // Boolean provenance only — the text itself rides structured_copy
            // and the stamped prompt; the genome stays small.
            visualConcept: Boolean(copyEntry.visualConcept),
          }
        : {};
    // Each group's brand-copy LLM cent is charged ONCE, durably, on the FIRST
    // candidate of that group (index g under round-robin; the monthly budget
    // sums candidate rows, and a seed-reused or fallback copy arrives with
    // copyCostCents 0). Charged even when that candidate's image fails — the
    // LLM call was real spend and the copy still rides the row as
    // structured_copy, which is what makes seed-reuse work.
    const copyCents =
      copyEntry && spec.index < (input.brandContext?.copyGroupCount ?? 0)
        ? copyEntry.copyCostCents
        : 0;
    // Strategy-group genome fields, defined ONCE and spread into both stamp
    // points below. They used to be inlined at the base stamp only, so the
    // fulfilled stamp — which REPLACES `genome` rather than merging it — silently
    // dropped `hookArchetype` on every successful candidate. Failed candidates
    // kept it and are never published, so the `hook_archetype` genome dimension
    // was structurally unreachable in `performance_memory`. Keep this shared.
    const strategyGenomeFields: Partial<
      Pick<CreativeGenome, 'hookArchetype' | 'format'>
    > = {
      ...(spec.variation.hookArchetype
        ? { hookArchetype: spec.variation.hookArchetype }
        : {}),
      ...(spec.variation.format
        ? { format: spec.variation.format as CreativeGenome['format'] }
        : {}),
    };
    // The angle half of the same lineage. Defined once beside the hook/format
    // fields so BOTH stamp points below feed the completeness pass the same
    // structured sources (the fulfilled stamp REPLACES `genome` — see below).
    const strategySources = input.strategyAngleKey
      ? { angleKey: input.strategyAngleKey }
      : undefined;
    // The INTENDED model (the provider's own resolved model) — so a candidate
    // whose provider call fails persists what it tried to call, never the
    // 'unknown' sentinel. The fulfilled restamp below overwrites it with the
    // model the call actually RETURNED.
    const base: WorkingCandidate = {
      spec,
      generation: null,
      assetDirty: false,
      model: spec.provider.model,
      copyText: input.copyTextFor(spec),
      costCents: 0,
      editLineage: [],
      genome: buildGenome(
        brief,
        spec.provider.name,
        spec.provider.model,
        {
          variation: spec.variation.key,
          variationIndex: spec.variationIndex,
          aspectRatio,
          width: dims.width,
          height: dims.height,
          prompt: promptForSpec(spec),
          // Strategy-group provenance (evidence-driven runs only).
          ...(spec.variation.strategyKey
            ? { strategyKey: spec.variation.strategyKey }
            : {}),
          ...(spec.variation.format ? { format: spec.variation.format } : {}),
          ...(spec.variation.execution
            ? { execution: spec.variation.execution }
            : {}),
          ...brandParams,
        },
        strategyGenomeFields,
        strategySources,
      ),
      gateResults: [],
    };
    if (result.status === 'fulfilled') {
      const costCents = spec.provider.estimateCostCents(dims) + copyCents;
      spentCents += costCents;
      candidates.push({
        ...base,
        generation: result.value.generation,
        // The model the call RETURNED wins over the intended one.
        model: result.value.generation.model,
        assetDirty: true,
        costCents,
        genome: buildGenome(
          brief,
          spec.provider.name,
          result.value.generation.model,
          {
            variation: spec.variation.key,
            variationIndex: spec.variationIndex,
            aspectRatio,
            width: dims.width,
            height: dims.height,
            prompt: promptForSpec(spec),
            // Strategy-group provenance (evidence-driven runs only) — the
            // fulfilled stamp previously dropped these while the base stamp
            // carried them, so successful candidates lost strategy lineage.
            ...(spec.variation.strategyKey
              ? { strategyKey: spec.variation.strategyKey }
              : {}),
            ...(spec.variation.format ? { format: spec.variation.format } : {}),
            ...(spec.variation.execution
              ? { execution: spec.variation.execution }
              : {}),
            ...brandParams,
            // Overlay provenance: whether the disclaimer strip was
            // actually composited onto this candidate's bytes.
            disclaimerOverlay: result.value.overlayApplied,
          },
          // Deterministic `text_overlay` genome dimension — TRUE only when
          // the compositor actually applied a strip (mirrors the
          // disclaimerOverlay provenance above). A brief with no disclaimers
          // or a best-effort overlay failure keeps un-stripped bytes → false.
          // Iterate/self-repair/versions paths inherit this value verbatim
          // (they spread the parent genome and never re-apply overlay, so the
          // derived asset keeps the parent's strip state).
          {
            ...strategyGenomeFields,
            textOverlay: result.value.overlayApplied,
          },
          strategySources
        ),
      });
    } else {
      spentCents += copyCents;
      candidates.push({
        ...base,
        costCents: copyCents,
        error: toStructuredError(result.reason),
      });
    }
  });
  return { candidates, spentCents };
}

/**
 * Map a working candidate to the persistence-seam record. Image bytes travel
 * ONLY while this invocation holds an un-persisted buffer (`assetDirty`) —
 * otherwise the persistence seam preserves the already-stored asset columns.
 */
export function toPipelineRecord(
  candidate: WorkingCandidate,
  status: CreativeStatus,
  aspectRatio: AspectRatio,
  rank?: CandidateRank,
  brand?: {
    structuredCopy: ComposedStructuredCopy;
    tags: Record<string, unknown>;
  }
): PipelineCandidate {
  return {
    id: candidate.spec.id,
    status,
    ...(candidate.assetDirty && candidate.generation
      ? {
          imageBuffer: candidate.generation.imageBuffer,
          contentType: candidate.generation.contentType,
        }
      : {}),
    aspectRatio,
    variationIndex: candidate.spec.variationIndex,
    genome: candidate.genome,
    gateResults: candidate.gateResults,
    ...(rank ? { rank } : {}),
    costCents: candidate.costCents,
    editLineage: candidate.editLineage,
    provider: candidate.spec.provider.name,
    model: candidate.generation?.model ?? candidate.model ?? 'unknown',
    copyText: candidate.copyText,
    // Stamped on EVERY brand-mode record — fresh, failed, AND rehydrated —
    // so a stage-4 finalization upsert can never null a stored copy/tags.
    ...(brand ? { structuredCopy: brand.structuredCopy, tags: brand.tags } : {}),
    ...(candidate.error ? { error: candidate.error } : {}),
  };
}
