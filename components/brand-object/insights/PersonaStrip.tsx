'use client';

/**
 * Chapter 06 — "Who you're talking to": the grounded personas (Layer-3
 * synthesis: every pain/desire traces to a real fact, verbatims
 * substring-verified).
 *
 * Laid out as an AWARENESS LADDER. Awareness stage is the only ordinal field
 * on a persona, so it becomes the page's spine: the full Schwartz spectrum
 * runs top to bottom as a cold-to-warm timeline and each persona hangs off its
 * stage. Stages with nobody in them still render as dimmed rungs — the gap
 * ("no loyalist persona yet") is an insight the old flat card grid could not
 * express. Personas whose stage never resolved get their own trailing rung
 * rather than being dropped.
 *
 * Cards are voice-first: the substring-verified verbatim is the hero, set in
 * serif under an oversized quote mark, and pains/desires compress into chips
 * that reveal their full sentence on hover, tap, or focus. The stage is NOT
 * repeated on the card — the rung already says it.
 *
 * Single-column by construction, so nothing escapes a 375px viewport. The
 * whole chapter unmounts when no personas exist; the chapter header is owned
 * by the dashboard, which renders `PersonaLadderHeadline` (below) between the
 * header and the ladder the way chapter 04 renders its formula headline.
 */
import { useTranslations } from 'next-intl';
import {
  type PersonaCard,
  type ReportTreatment,
} from '@/lib/brand-object/insights';
import { AWARENESS_STAGES, type AwarenessStage } from '@/lib/brand-object/types';
import { BI_TYPE } from '@/components/brand-identity/typography';
import { cn } from '@/lib/utils';

import { AwarenessFrameworkLink } from './AwarenessFrameworkDialog';
import { PersonaSignalChip } from './PersonaSignalChip';
import {
  AWARENESS_STAGE_META,
  UNSTAGED_META,
  awarenessSpread,
  isAwarenessStage,
  type AwarenessStageMeta,
} from './persona-signal';
import { useAwarenessCopy } from './report-copy';

/** Stage name, in its own rung color — the headline and the ladder below it
 * must be readable as the same object. The name arrives as rich-text chunks. */
function stageTag(stage: AwarenessStage) {
  function StageTag(chunks: React.ReactNode) {
    return (
      <b className={cn('font-semibold', AWARENESS_STAGE_META[stage].text)}>
        {chunks}
      </b>
    );
  }
  return StageTag;
}

function muted(chunks: React.ReactNode) {
  return <span className="font-normal text-muted-foreground">{chunks}</span>;
}

/**
 * Chapter 06's headline: where the personas actually cluster on the spectrum,
 * plus the link to the framework that spectrum comes from. Arithmetic over the
 * same cards the ladder renders — no second read, no model judgment.
 *
 * The link renders even when no stage resolved, because the framework explains
 * the chapter whether or not this brand's personas landed on it yet.
 */
export function PersonaLadderHeadline({
  personas,
}: {
  personas: PersonaCard[];
}) {
  const t = useTranslations('BrandReport.awareness.headline');
  const awareness = useAwarenessCopy();
  if (personas.length === 0) return null;

  const spread = awarenessSpread(personas);

  return (
    <div className="space-y-1.5">
      {spread && (
        <p
          className={cn(
            BI_TYPE.panelTitle,
            'text-balance leading-snug sm:text-xl',
          )}
        >
          {t.rich('cluster', {
            modal: awareness.label(spread.modal),
            clause:
              spread.modalCount === spread.staged
                ? spread.staged === 1
                  ? t('onlyPersona')
                  : t('allPersonas', { count: spread.staged })
                : t('somePersonas', {
                    modalCount: spread.modalCount,
                    staged: spread.staged,
                  }),
            stage: stageTag(spread.modal),
            muted,
          })}
          {spread.coldest !== spread.warmest &&
            t.rich('span', {
              coldest: awareness.label(spread.coldest),
              warmest: awareness.label(spread.warmest),
              cold: stageTag(spread.coldest),
              warm: stageTag(spread.warmest),
              muted,
            })}
          {t.rich('tail', { note: awareness.gapNote(spread), muted })}
        </p>
      )}
      <AwarenessFrameworkLink />
    </div>
  );
}

function PersonaVoiceCard({
  persona,
  meta,
}: {
  persona: PersonaCard;
  meta: AwarenessStageMeta;
}) {
  const t = useTranslations('BrandReport.awareness');
  const signals = [
    ...persona.pains.map((text) => ({ kind: 'pain' as const, text })),
    ...persona.desires.map((text) => ({ kind: 'desire' as const, text })),
  ];

  return (
    <article
      className={cn(
        'glass-surface space-y-3 p-4 sm:p-5',
        persona.extrapolated && 'border-dashed',
      )}
    >
      {persona.extrapolated && (
        <p className={cn(BI_TYPE.eyebrow, 'text-muted-foreground')}>
          {t('projected')}
        </p>
      )}
      {persona.verbatim && (
        <div className="space-y-1">
          <span
            aria-hidden="true"
            className={cn('block font-serif text-3xl leading-none', meta.text)}
          >
            &ldquo;
          </span>
          <blockquote
            className={cn(
              BI_TYPE.body,
              'break-words font-serif italic leading-relaxed sm:text-base',
            )}
          >
            {persona.verbatim}
          </blockquote>
        </div>
      )}

      <div className="space-y-1.5">
        <p
          className={cn(
            BI_TYPE.cardTitle,
            persona.verbatim && 'text-muted-foreground',
          )}
        >
          {persona.name}
        </p>
        {persona.description && (
          <p className={cn(BI_TYPE.meta, 'leading-relaxed text-muted-foreground')}>
            {persona.description}
          </p>
        )}
      </div>

      {signals.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-border pt-3">
          {signals.map((signal, index) => (
            <PersonaSignalChip
              key={`${signal.kind}-${index}`}
              kind={signal.kind}
              text={signal.text}
            />
          ))}
        </div>
      )}
    </article>
  );
}

function LadderRung({
  stage,
  meta,
  personas,
  isLast,
}: {
  stage: AwarenessStage | 'unstaged';
  meta: AwarenessStageMeta;
  personas: PersonaCard[];
  isLast: boolean;
}) {
  const t = useTranslations('BrandReport.awareness');
  const awareness = useAwarenessCopy();
  const isEmpty = personas.length === 0;

  return (
    <div className={cn('relative pl-6 sm:pl-7', !isLast && 'pb-6')}>
      {!isLast && (
        <span
          aria-hidden="true"
          className={cn(
            'absolute bottom-0 left-[5px] top-4 w-0.5 rounded-full',
            meta.rail,
            isEmpty && 'opacity-50',
          )}
        />
      )}
      <span
        aria-hidden="true"
        className={cn(
          'absolute left-0 top-1 h-3 w-3 rounded-full border-2 bg-background',
          meta.node,
          isEmpty && 'opacity-60',
        )}
      />

      <p className={cn(BI_TYPE.eyebrow, meta.text, isEmpty && 'opacity-70')}>
        {awareness.label(stage)}
      </p>
      <p
        className={cn(
          BI_TYPE.meta,
          'mt-0.5 text-muted-foreground',
          isEmpty && 'italic opacity-80',
        )}
      >
        {isEmpty ? t('emptyRung') : awareness.blurb(stage)}
      </p>

      {!isEmpty && (
        <div className="mt-3 grid gap-3">
          {personas.map((persona) => (
            <PersonaVoiceCard
              key={persona.factId}
              persona={persona}
              meta={meta}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function PersonaStrip({
  personas,
  treatment = 'classic',
}: {
  personas: PersonaCard[];
  treatment?: ReportTreatment;
}) {
  if (personas.length === 0) return null;

  // Both treatments share the ladder; `treatment` is kept for parity with the
  // other chapters and future divergence.
  void treatment;

  const byStage = new Map<AwarenessStage, PersonaCard[]>();
  const unstaged: PersonaCard[] = [];
  for (const persona of personas) {
    if (isAwarenessStage(persona.awarenessStage)) {
      const bucket = byStage.get(persona.awarenessStage);
      if (bucket) bucket.push(persona);
      else byStage.set(persona.awarenessStage, [persona]);
    } else {
      unstaged.push(persona);
    }
  }

  const rungs: {
    key: AwarenessStage | 'unstaged';
    meta: AwarenessStageMeta;
    personas: PersonaCard[];
  }[] =
    AWARENESS_STAGES.map((stage) => ({
      key: stage,
      meta: AWARENESS_STAGE_META[stage],
      personas: byStage.get(stage) ?? [],
    }));
  if (unstaged.length > 0) {
    rungs.push({ key: 'unstaged', meta: UNSTAGED_META, personas: unstaged });
  }

  return (
    <div>
      {rungs.map((rung, index) => (
        <LadderRung
          key={rung.key}
          stage={rung.key}
          meta={rung.meta}
          personas={rung.personas}
          isLast={index === rungs.length - 1}
        />
      ))}
    </div>
  );
}
