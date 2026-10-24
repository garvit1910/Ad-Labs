'use client';

/**
 * The "Five Stages of Customer Awareness" explainer — the framework chapter 06
 * is built on (Eugene Schwartz, Breakthrough Advertising, 1966). It sits under
 * the chapter headline as a plain text link because the ladder has to read
 * without it; the modal is for the reader who wants to know why the rungs are
 * ordered the way they are and what an ad has to DO at each one.
 *
 * Copy only — no props, no facts, no IO — so it renders identically for every
 * brand and can never blank or block the chapter. The stage labels, blurbs and
 * colors come from the same meta the ladder rungs use, so the explainer and
 * the chapter can never drift apart.
 */
import { useState } from 'react';
import { BookOpen } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AWARENESS_STAGES } from '@/lib/brand-object/types';
import { BI_TYPE } from '@/components/brand-identity/typography';
import { cn } from '@/lib/utils';

import { AWARENESS_STAGE_META } from './persona-signal';
import { useAwarenessCopy } from './report-copy';

export function AwarenessFrameworkLink() {
  const t = useTranslations('BrandReport.awareness.framework');
  const awareness = useAwarenessCopy();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          BI_TYPE.meta,
          'inline-flex items-center gap-1.5 font-semibold text-brand-text hover:underline',
        )}
      >
        <BookOpen aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        {t('title')}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        {/* `sm:max-w-2xl` rather than `max-w-2xl`: the base content keeps its
            `max-w-[calc(100%-2rem)]` clamp, so the modal still holds a margin
            at 375px instead of running edge to edge. */}
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-base">{t('title')}</DialogTitle>
            <DialogDescription className={BI_TYPE.meta}>
              {t('source')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <p className={cn(BI_TYPE.body, 'leading-relaxed text-muted-foreground')}>
              {t('intro')}
            </p>

            <ol className="space-y-4">
              {AWARENESS_STAGES.map((stage, index) => {
                const meta = AWARENESS_STAGE_META[stage];
                return (
                  <li key={stage} className="relative pl-6">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'absolute left-0 top-1 h-3 w-3 rounded-full border-2 bg-background',
                        meta.node,
                      )}
                    />
                    {index < AWARENESS_STAGES.length - 1 && (
                      <span
                        aria-hidden="true"
                        className={cn(
                          'absolute bottom-[-1rem] left-[5px] top-4 w-0.5 rounded-full',
                          meta.rail,
                        )}
                      />
                    )}
                    <p className={cn(BI_TYPE.eyebrow, meta.text)}>
                      {awareness.label(stage)}
                    </p>
                    <p className={cn(BI_TYPE.meta, 'mt-0.5 text-muted-foreground')}>
                      {awareness.blurb(stage)}
                    </p>
                    <p className={cn(BI_TYPE.body, 'mt-1.5 leading-relaxed')}>
                      {awareness.job(stage)}
                    </p>
                  </li>
                );
              })}
            </ol>

            <div className="space-y-1.5 border-t border-border pt-4">
              <p className={cn(BI_TYPE.eyebrow, 'text-muted-foreground')}>
                {t('whyTitle')}
              </p>
              <p className={cn(BI_TYPE.body, 'leading-relaxed text-muted-foreground')}>
                {t('why')}
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
