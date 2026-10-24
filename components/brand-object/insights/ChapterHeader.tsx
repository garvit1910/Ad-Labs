'use client';

/**
 * Editorial chapter header for the Brand Identity report (Mock A "Brand
 * Book" layout): numbered eyebrow · hairline rule · optional right-side
 * action (deep-link or chip). The numbering encodes the report's reading
 * order — identity → narrative → customers → market → personas → guardrails.
 */
import { useTranslations } from 'next-intl';
import { BI_TYPE } from '@/components/brand-identity/typography';
import { cn } from '@/lib/utils';

export function ChapterHeader({
  number,
  title,
  action,
  className,
}: {
  number: string;
  title: string;
  action?: React.ReactNode;
  className?: string;
}) {
  const t = useTranslations('BrandReport');
  return (
    <div className={cn('flex flex-wrap items-baseline gap-3', className)}>
      <p className={cn(BI_TYPE.eyebrow, 'text-muted-foreground')}>
        {t('chapterHeader', { number, title })}
      </p>
      <span
        aria-hidden="true"
        className="h-px min-w-10 flex-1 self-center bg-brand-soft"
      />
      {action && <span className="shrink-0">{action}</span>}
    </div>
  );
}
