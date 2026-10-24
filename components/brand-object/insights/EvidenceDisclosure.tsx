'use client';

import { ExternalLink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { IdentityClaimRow } from '@/lib/brand-object/insights';
import { BI_TYPE } from '@/components/brand-identity/typography';
import { cn } from '@/lib/utils';

/** Disclosure "collapse" glyph (U+2212), not a word. */
const MINUS_SIGN = '−';

/** Shared verified-evidence body; `statement` is the distilled hero's lead-in. */
export function EvidenceBody({
  claim,
  statement,
}: {
  claim: IdentityClaimRow;
  statement?: string;
}) {
  return (
    <div className={cn(BI_TYPE.meta, 'mt-2 space-y-1.5 rounded-lg bg-muted/40 p-3 text-muted-foreground')}>
      {statement && <p className="break-words">{statement}</p>}
      {claim.sourceSentence && (
        <p className="break-words italic">“{claim.sourceSentence}”</p>
      )}
      {claim.sourceUrl && (
        <a
          href={claim.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 break-all text-brand-text hover:underline"
        >
          {claim.sourceUrl}
          <ExternalLink className="h-3 w-3 shrink-0" />
        </a>
      )}
    </div>
  );
}

/** Native disclosure — verified source sentence + link, rendered verbatim. */
export function EvidenceDisclosure({ claim }: { claim: IdentityClaimRow }) {
  const t = useTranslations('BrandReport.evidence');
  if (!claim.sourceSentence && !claim.sourceUrl) return null;
  return (
    <details className="group">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[11px] font-semibold text-brand-text [&::-webkit-details-marker]:hidden">
        {t('verifiedSource')}
        <span aria-hidden="true" className="group-open:hidden">
          +
        </span>
        <span aria-hidden="true" className="hidden group-open:inline">
          {MINUS_SIGN}
        </span>
      </summary>
      <EvidenceBody claim={claim} />
    </details>
  );
}
