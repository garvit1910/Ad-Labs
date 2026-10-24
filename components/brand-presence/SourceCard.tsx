'use client';

import { useTranslations } from 'next-intl';
import { StatusPill, type StatusPillTone } from '@/components/ui/status-pill';
import { useLocaleFormatters } from '@/hooks/useLocaleFormatters';
import { getAwaitingConfirm } from '@/lib/brand-presence/awaiting-confirm';
import { SOURCE_REGISTRY } from '@/lib/brand-presence/source-registry';
import type {
  BrandPresenceSource,
  BrandPresenceSourceStatus,
} from '@/lib/brand-presence/types';
import { cn } from '@/lib/utils';
import {
  useSourceDisplayLabel,
  useSourceStatusLabel,
  useSourceTypeCopy,
} from './presence-copy';
import { SourceLogoTile } from './SourceLogoTile';

/**
 * Display status = the raw DB status plus the meta-derived
 * `awaiting_confirm` overlay (a resolved card parked on the founder-confirm
 * gate — `status` stays 'pending' in the DB; no new status value, the
 * trustpilot-notOnPlatform precedent).
 */
export type SourceDisplayStatus =
  | BrandPresenceSourceStatus
  | 'awaiting_confirm';

export function getSourceDisplayStatus(
  source: Pick<BrandPresenceSource, 'source_type' | 'status' | 'meta'>,
): SourceDisplayStatus {
  if (
    source.status === 'pending' &&
    getAwaitingConfirm(source.source_type, source.meta)
  ) {
    return 'awaiting_confirm';
  }
  return source.status;
}

/** Canonical keys are `SourceDisplayStatus`; string-keyed so panels can index
 * with the zod-validated `status` strings from the status route. */
export const STATUS_TONE: Record<string, StatusPillTone> = {
  available: 'not_set',
  coming_soon: 'not_set',
  pending: 'queued',
  awaiting_confirm: 'paused',
  running: 'active',
  synced: 'connected',
  error: 'failed',
};

export const STATUS_LABEL: Record<string, string> = {
  synced: 'Synced',
  running: 'Scraping',
  pending: 'Queued',
  awaiting_confirm: 'Needs confirmation',
  error: 'Failed',
  available: 'Available',
};

interface SourceCardProps {
  source: BrandPresenceSource;
  mentionCount?: number;
}

/**
 * One card in the source grid — section-frost surface (brand-book §12b) with
 * the platform's real logo in a white tile. Rendered entirely from the
 * source registry: live Reddit sources show status/count/last-synced;
 * future source types render the closed-frost coming-soon variant with zero
 * page rework.
 */
export function SourceCard({
  source,
  mentionCount,
}: SourceCardProps) {
  const t = useTranslations('BrandPresence');
  const statusLabel = useSourceStatusLabel();
  const sourceCopy = useSourceTypeCopy();
  const displayLabel = useSourceDisplayLabel();
  const formatters = useLocaleFormatters();
  const entry = SOURCE_REGISTRY[source.source_type];
  if (!entry) return null;
  const comingSoon =
    entry.availability === 'coming_soon' || source.status === 'coming_soon';
  const displayStatus = getSourceDisplayStatus(source);

  return (
    <div
      className={cn(
        'flex h-full flex-col gap-3 p-4',
        comingSoon ? 'section-frost-closed' : 'section-frost',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <SourceLogoTile sourceType={source.source_type} muted={comingSoon} />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">
              {displayLabel(source)}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {sourceCopy.description(source.source_type)}
            </p>
          </div>
        </div>
        {comingSoon ? (
          <span className="glass-pill flex-none px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-brand-text">
            {t('sourceStatus.comingSoon')}
          </span>
        ) : (
          <StatusPill tone={STATUS_TONE[displayStatus]}>
            {statusLabel(displayStatus)}
          </StatusPill>
        )}
      </div>

      {displayStatus === 'awaiting_confirm' && (
        <p className="text-xs text-muted-foreground">
          {t('sourceCard.awaitingConfirm')}
        </p>
      )}

      {!comingSoon && (
        <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-2.5">
          <span className="text-xs text-muted-foreground">
            <b className="font-semibold text-brand-text">
              {mentionCount ?? 0}
            </b>{' '}
            {t('common.mentionCount', { count: mentionCount ?? 0 })}
            {source.last_synced_at && (
              <>
                {' · '}
                {new Date(source.last_synced_at).toLocaleDateString(formatters.locale)}
              </>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
