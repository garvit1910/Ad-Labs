'use client';

import { useCallback } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toIntlTag } from '@/i18n/config';
import { formatRelativeTime } from '@/lib/brand-identity/relative-time';
import { createLocaleFormatter } from '@/lib/i18n/format';

/**
 * Compact green "syncing" pill shown beside the scope filters while a new
 * competitor/platform/industry scope is loading. Pairs with RefreshingOverlay:
 * the pill confirms the filter change registered, the overlay dims the stale
 * data underneath until the fresh scope arrives.
 */
export function RefreshingPill({ label }: { label?: string }) {
  const t = useTranslations('BrandIdentity.shared');
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      {label ?? t('updating')}
    </span>
  );
}

/**
 * Soft loading overlay laid over stale dashboard content while the next scope
 * loads. Keeps the previous data faintly visible (placeholderData) rather than
 * flashing a skeleton, with a centered green sync badge for the wait.
 */
export function RefreshingOverlay({
  label,
}: {
  label?: string;
}) {
  const t = useTranslations('BrandIdentity.shared');
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-start justify-center rounded-2xl bg-background/50">
      <div className="mt-10 inline-flex items-center gap-2 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-4 py-2 text-sm font-medium text-emerald-600 shadow-sm dark:text-emerald-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        {label ?? t('loadingScope')}
      </div>
    </div>
  );
}

/**
 * Designed failure state for a read query. Every data panel in the section
 * renders this on `isError` instead of a permanent skeleton or a misleading
 * "no results" empty state - a failed fetch and an empty scope are different
 * situations and must read differently.
 */
export function QueryErrorState({
  title,
  detail,
  onRetry,
}: {
  title?: string;
  detail?: string;
  onRetry?: () => void;
}) {
  const t = useTranslations('BrandIdentity.shared');
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-destructive/40 bg-destructive/5 p-8 text-center"
    >
      <AlertTriangle className="h-6 w-6 text-destructive" />
      <div>
        <p className="text-sm font-medium">{title ?? t('loadErrorTitle')}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {detail ?? t('loadErrorDetail')}
        </p>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t('tryAgain')}
        </Button>
      )}
    </div>
  );
}

/** Compact EU-reach formatting shared with AdCard (1.2M / 34k / 920). */
export function formatReach(reach: number): string {
  if (reach >= 1_000_000) return `${(reach / 1_000_000).toFixed(1)}M`;
  if (reach >= 1_000) return `${Math.round(reach / 1_000)}k`;
  return String(reach);
}

/**
 * Readable labels for taxonomy tokens whose underscore-stripped form is
 * meaningless - currently the duration_bucket dimension ('lt15' → '<15s'). These
 * tokens exist only in that dimension, so the override is checked before the
 * generic underscore replacement without affecting any other consumer.
 */
const LABEL_OVERRIDES: Record<string, string> = {
  lt15: '<15s',
  '15_30': '15–30s',
  '30_60': '30–60s',
  gt60: '>60s',
};

/** Taxonomy slug → human label: 'text_overlay_static' → 'text overlay static'. */
export function labelText(value: string): string {
  return LABEL_OVERRIDES[value] ?? value.replace(/_/g, ' ');
}

/** 0..1 fraction → '45%'. */
export function formatPct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/**
 * Locale-aware `formatRelativeTime`: English keeps the legacy compact form
 * ('3d ago'); other locales use Intl relative time ('il y a 3 jours').
 */
export function useRelativeTimeLabel(): (_iso: string | null) => string {
  const locale = useLocale();
  const t = useTranslations('BrandIdentity.shared');
  return useCallback(
    (iso: string | null) => {
      if (locale === 'en') return formatRelativeTime(iso);
      if (!iso) return t('never');
      if (Date.now() - new Date(iso).getTime() < 60_000) return t('justNow');
      return createLocaleFormatter(toIntlTag(locale)).relative(iso);
    },
    [locale, t],
  );
}

/**
 * Locale-aware `formatReach`/`formatPct` for React callers: English keeps the
 * legacy strings byte-identical ('1.2M', '45%'); other locales use Intl
 * (compact notation '1,2 M', percent '45 %').
 */
export function useBrandIdentityNumbers(): {
  reach: (_reach: number) => string;
  pct: (_fraction: number) => string;
} {
  const locale = useLocale();
  const format = useFormatter();
  const isEnglish = locale === 'en';
  const reach = useCallback(
    (value: number) =>
      isEnglish
        ? formatReach(value)
        : format.number(value, { notation: 'compact', maximumFractionDigits: 1 }),
    [isEnglish, format],
  );
  const pct = useCallback(
    (fraction: number) =>
      isEnglish
        ? formatPct(fraction)
        : format.number(Math.round(fraction * 100) / 100, { style: 'percent' }),
    [isEnglish, format],
  );
  return { reach, pct };
}

/**
 * Integer win-score label for ticks and copy, e.g. "58". Shared by the winners
 * matrix and the dimension bars so both render a median win score identically.
 */
export function scoreLabel(score: number): string {
  return `${Math.round(score)}`;
}

/**
 * A labeled horizontal meter bar. `value/max` drives the fill width; `display`
 * is the absolute value shown on the right. Used for the hero's per-creative
 * metrics, the over-index shares, and the breakdown win rates.
 */
export function StatBar({
  label,
  value,
  max,
  display,
  colorClass,
}: {
  label: string;
  value: number;
  max: number;
  display: string;
  colorClass: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.max(2, Math.round((value / max) * 100))) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn('absolute inset-y-0 left-0 rounded-full', colorClass)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-14 shrink-0 text-right text-xs font-medium tabular-nums">
        {display}
      </span>
    </div>
  );
}

/** Section header used across the dashboard panels: icon + title + hint. */
export function SectionHeader({
  icon,
  title,
  hint,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <span className="text-brand-primary">{icon}</span>
        <h2 className="text-lg font-semibold">{title}</h2>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      {action}
    </div>
  );
}
