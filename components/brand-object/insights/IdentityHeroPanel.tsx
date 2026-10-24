'use client';

/**
 * Chapter 01 — "Who you are". The chapter body renders the value-prop, USP,
 * and proof pillars as cards with inline verified evidence drill-ins.
 * Positioning and voice live in the companion identity rail. REPORT-ONLY: no
 * approval controls.
 */
import { useTranslations } from 'next-intl';
import {
  claimHeadline,
  type IdentityClaimRow,
  type ReportTreatment,
} from '@/lib/brand-object/insights';
import { BI_TYPE } from '@/components/brand-identity/typography';
import { cn } from '@/lib/utils';
import { EvidenceBody, EvidenceDisclosure } from './EvidenceDisclosure';

/** Disclosure "collapse" glyph (U+2212), not a word. */
const MINUS_SIGN = '−';

/** Pillar section → `BrandReport.sections` key. */
const PILLAR_KEYS = {
  value_prop: 'valueProp',
  usp: 'usp',
  proof_point: 'proofPoint',
} as const;

export function IdentityHeroPanel({
  pillars,
  treatment = 'classic',
}: {
  pillars: IdentityClaimRow[];
  treatment?: ReportTreatment;
}) {
  const t = useTranslations('BrandReport');
  const tSection = useTranslations('BrandReport.sections');
  return (
    <section id="identity" className="scroll-mt-24 space-y-6">
      {pillars.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {pillars.map((claim) => (
            // Flex column + a bottom-pinned disclosure: the grid already
            // equalizes card heights per row, so pinning keeps every card's
            // "Full claim · source" line on the same baseline no matter how
            // many lines its headline wraps to.
            <div
              key={claim.factId}
              className="glass-surface flex h-full flex-col gap-2 p-4"
            >
              <p className={cn(BI_TYPE.eyebrow, 'text-muted-foreground')}>
                {claim.section in PILLAR_KEYS
                  ? tSection(
                      PILLAR_KEYS[claim.section as keyof typeof PILLAR_KEYS],
                    )
                  : claim.section.replace(/_/g, ' ')}
              </p>
              {treatment === 'distilled' ? (
                <>
                  {/* Uncapped: the card wraps, so the headline runs to the end
                      of its clause instead of ending in a mid-sentence "…". */}
                  <p
                    className={cn(
                      BI_TYPE.heroClaim,
                      'text-pretty leading-snug break-words',
                    )}
                  >
                    {claimHeadline(claim.statement, { maxLength: null })}
                  </p>
                  <details className="group mt-auto">
                    <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[11px] font-semibold text-brand-text [&::-webkit-details-marker]:hidden">
                      {t('evidence.fullClaim')}
                      <span aria-hidden="true" className="group-open:hidden">
                        +
                      </span>
                      <span
                        aria-hidden="true"
                        className="hidden group-open:inline"
                      >
                        {MINUS_SIGN}
                      </span>
                    </summary>
                    <EvidenceBody claim={claim} statement={claim.statement} />
                  </details>
                </>
              ) : (
                <>
                  <p className={cn(BI_TYPE.body, 'leading-relaxed')}>
                    {claim.statement}
                  </p>
                  <EvidenceDisclosure claim={claim} />
                </>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border/70 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            {t('identity.empty')}
          </p>
        </div>
      )}
    </section>
  );
}
