'use client';

/**
 * The small "AI-translated" marker an AI Summary shows when its prose is a cached
 * AI translation of the English original (plan `tasks/i18n-ai-output-translations-plan.md`
 * WS4). Render it only when the GET said `translated: true` — never for English or
 * for a legacy summary that was generated in the viewer's language.
 */
import { Languages } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

export function AiTranslatedBadge({ className }: { className?: string }) {
  const t = useTranslations('Common.aiTranslated');
  return (
    <span
      className={cn('inline-flex items-center gap-1 text-[11px] text-muted-foreground', className)}
      title={t('tooltip')}
      data-testid="ai-translated-badge"
    >
      <Languages aria-hidden="true" className="h-3 w-3 shrink-0" />
      {t('badge')}
    </span>
  );
}
