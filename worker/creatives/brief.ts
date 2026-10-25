import { compile } from '@/lib/creative-engine/brand-context/compile';
import { renderCopyPrompt, type CopyRender } from '@/lib/creative-engine/brand-context/renderers';
import { resolveSpecAngleTheme } from '@/lib/creative-engine/brand-context/themes';
import type { BrandContextPack, BrandContextRow, CompileSpec } from '@/lib/creative-engine/brand-context/types';
import { generateBrandCopy, resolveBrandCopyModel } from '@/lib/creative-engine/generation/brand-copy';
import { composeBrief, type ComposeBriefInput } from '@/lib/creative-engine/generation/brief-composer';
import {
  canonicalAngleUniversal,
  canonicalPersonaUniversal,
  type CanonicalResult,
} from '@/lib/creative-engine/generation/canonicalize';
import { runGates } from '@/lib/creative-engine/generation/gates';
import { buildGenome } from '@/lib/creative-engine/generation/genome';
import {
  buildVariationPlan,
  composeCopyBlock,
  selectStrategyGroups,
  type VariationSpec,
} from '@/lib/creative-engine/generation/pipeline-stages';
import type { SelectedStrategy, StrategyPackHints } from '@/lib/creative-engine/generation/strategy';
import type { CreativeBrief } from '@/lib/creative-engine/generation/types';
import type { Angle } from '@/services/ad-library/label-taxonomy';
import { strategyFromArms, type AngleVocabulary } from './strategy-from-arms';
import type { GeneratedCreative } from './types';

const GOAL = 'conversions';
const PLATFORM = 'meta';

/** What composeBrief takes from the caller; the strategy comes from the arms. */
export type BriefContext = Pick<
  ComposeBriefInput,
  'organizationId' | 'brandSummary' | 'audience' | 'keyMessage' | 'compliance' | 'source'
>;

export interface GenerateBriefInput {
  /** Not persisted (packs are recompiled every run), so any stable string. */
  briefId: string;
  rows: BrandContextRow[];
  brandProfileId: string;
  /** The compiler persona row id, `persona_<slug>`. */
  personaRef: string;
  /** The one angle every hook in this brief shares. */
  angle: string;
  /** One strategy group (one copy variant) per hook, in order. */
  hooks: string[];
  packHints: StrategyPackHints;
  context: BriefContext;
  vocabulary?: AngleVocabulary;
  /** Copy calls per hook. Default 1. */
  variants?: number;
  /** Omitted: Adcero's `resolveSpecAngleTheme`. A5 sets the recipe's food token directly. */
  angleTheme?: string;
  /** A fact row id the pack pins first, the key claim the copywriter leads with. */
  keyMessageRef?: string;
  /** Number-free directives for one hook's variants, rendered as "Notes from testing". */
  notesFor?: (hook: string) => string[];
}

export interface BriefRun {
  selected: SelectedStrategy;
  brief: CreativeBrief;
  canonical: CanonicalResult<Angle>;
  spec: CompileSpec;
  pack: BrandContextPack;
  fingerprint: string;
  copyPrompt: CopyRender;
  variationPlan: VariationSpec[];
  creatives: GeneratedCreative[];
}

/**
 * One brief, CREATIVE_MANIFEST "Text-only mode" steps 5–17: strategy from the
 * arms → composeBrief → canonicalize → compile → renderCopyPrompt → one
 * generateBrandCopy call per (hook, variant), in parallel → copy block →
 * genome → gates. No image, no judge, no ranking: the sim ranks.
 */
export async function generateBrief(input: GenerateBriefInput): Promise<BriefRun> {
  const selected = strategyFromArms(
    input.hooks.map((hook) => ({ angle: input.angle, hookArchetype: hook })),
    { signals: [], packHints: input.packHints, goal: GOAL, platform: PLATFORM },
    input.vocabulary,
  );
  const composed = composeBrief({
    ...input.context,
    goal: GOAL,
    platform: PLATFORM,
    aspectRatios: ['1:1'],
    selectedStrategy: selected,
  });
  const canonical = canonicalAngleUniversal({ angle: composed.angle, angleKey: selected.angleKey });
  const persona = canonicalPersonaUniversal({ persona: composed.persona });
  const brief: CreativeBrief = {
    ...composed,
    briefId: input.briefId,
    angleUniversal: canonical.value,
    // A persona with no demographic words floors to 'other', which makes buildGenome throw outside
    // production. general_broad is the composer's own "no demographic claim" value.
    personaUniversal: persona.value === 'other' ? 'general_broad' : persona.value,
  };
  const angleTheme =
    input.angleTheme ??
    resolveSpecAngleTheme({
      fallbackTier: selected.fallbackTier,
      angleKey: selected.angleKey,
      angleDirective: selected.angleDirective,
      composedAngle: brief.angle,
    });
  const variants = input.variants ?? 1;
  const groups = selectStrategyGroups(selected.groups);
  const spec: CompileSpec = {
    platform: PLATFORM,
    aspectRatio: '1:1',
    goal: GOAL,
    personaRef: input.personaRef,
    angle: brief.angle,
    candidates: groups.length * variants,
    ...(input.keyMessageRef ? { keyMessageRef: input.keyMessageRef } : {}),
    ...(angleTheme ? { angleTheme } : {}),
  };
  const { pack, fingerprint } = compile(spec, input.rows, { brandProfileId: input.brandProfileId });
  const copyPrompt = renderCopyPrompt(pack);
  const variationPlan = buildVariationPlan(selected.groups);
  const model = resolveBrandCopyModel();

  const jobs = groups.flatMap((group) => Array.from({ length: variants }, (_, i) => ({ group, variant: i + 1 })));
  const creatives = await Promise.all(
    jobs.map(async ({ group, variant }): Promise<GeneratedCreative> => {
      const notes = input.notesFor?.(group.hookArchetype) ?? [];
      const result = await generateBrandCopy({
        copyPrompt,
        brief,
        strategy: {
          key: group.key,
          hookDirective: group.hookDirective,
          sceneDirective: group.sceneDirective,
          ...(notes.length > 0 ? { notes } : {}),
        },
      });
      const variation = variationPlan.find((v) => v.key === group.key)!;
      const copyText = composeCopyBlock({
        ...brief,
        headline: result.copy.headline,
        primaryText: result.copy.primaryText,
        cta: result.copy.cta,
      });
      const genome = buildGenome(
        brief,
        'text-only',
        model,
        {
          variation: variation.key,
          strategyKey: group.key,
          format: group.format,
          prompt: variation.text,
          packFingerprint: fingerprint,
          copySource: result.source,
          visualConcept: Boolean(result.copy.visualConcept),
          textOnly: true,
        },
        { hookArchetype: group.hookArchetype, format: group.format },
        { angleKey: selected.angleKey },
      );
      const gateResults = await runGates({
        brief,
        copyText,
        groundingText: copyPrompt.user,
        disclaimerRendered: false,
        hasProductReference: false,
        genome,
      });
      const failed = gateResults.filter((gate) => gate.status === 'fail');
      // A fallback set is the brief's own copy, not this hook's execution: ranking it would credit the
      // recipe with copy it never produced.
      const statusReason =
        failed.length > 0
          ? failed.map((gate) => `${gate.gate}: ${gate.reason ?? 'fail'}`).join('; ')
          : result.source === 'brief_fallback'
            ? `copy fell back to the brief: ${result.error?.reason ?? 'unknown'}`
            : undefined;
      return {
        briefId: brief.briefId,
        segment: input.personaRef,
        arm: { angleUniversal: selected.angleKey, hookArchetype: group.hookArchetype, key: `${selected.angleKey}|${group.hookArchetype}` },
        format: group.format,
        variant,
        headline: result.copy.headline,
        primaryText: result.copy.primaryText,
        cta: result.copy.cta,
        visualDescription: result.copy.visualConcept ?? variation.text,
        visualDescriptionSource: result.copy.visualConcept ? 'visual_concept' : 'variation_text',
        copySource: result.source,
        ...(result.error ? { copyError: result.error } : {}),
        copyText,
        gateResults,
        genome,
        packFingerprint: fingerprint,
        status: statusReason ? 'gated_out' : 'ranked',
        ...(statusReason ? { statusReason } : {}),
      };
    }),
  );
  return { selected, brief, canonical, spec, pack, fingerprint, copyPrompt, variationPlan, creatives };
}
