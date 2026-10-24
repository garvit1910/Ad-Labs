'use client';

/**
 * Role tagging for Brand Presence's connected brands.
 *
 * Every connected brand carries its `presence_role` visibly: a coloured tag
 * ("My brand" / "Competitor") plus a matching accent bar down the card's left
 * edge, so a portfolio of brands is scannable by role at a glance. Extracted
 * here because the tile grid (`BrandsOverview`) and the switcher strip
 * (`BrandPresenceManageStrip`) render identical badges over the same data.
 *
 * Palette is deliberately disjoint from the status pills that sit on the same
 * card — emerald "Listening" and amber "Draft" (`StatusPill` tones) carry
 * lifecycle, accent/sky carry role. The tag also has a colour dot so the
 * two roles stay distinguishable without relying on hue alone.
 *
 * A NULL role (legacy/agency profile predating the role model) renders nothing
 * in either slot — those cards keep their untagged look.
 */
import { Radar, Store } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { PresenceRole } from '@/lib/brand-presence/types';
import { cn } from '@/lib/utils';
import { usePresenceRoleLabel } from './presence-copy';

const ROLE_TAG_CLASSES: Record<PresenceRole, string> = {
  self: 'bg-brand-soft text-brand-text border-border',
  competitor:
    'bg-sky-50/80 text-sky-700 border-sky-200/70 dark:bg-sky-950/30 dark:text-sky-300 dark:border-sky-500/30',
};

const ROLE_DOT_CLASSES: Record<PresenceRole, string> = {
  self: 'bg-brand',
  competitor: 'bg-sky-500',
};

const ROLE_ACCENT_CLASSES: Record<PresenceRole, string> = {
  self: 'bg-brand',
  competitor: 'bg-sky-400 dark:bg-sky-500',
};

/**
 * The role tag. `sm` (default) is sized down from `StatusPill` so it can sit
 * inline next to a brand name in the compact switcher tiles; `md` is the more
 * legible variant for the active-brand dashboard header.
 */
export function PresenceRoleBadge({
  role,
  size = 'sm',
  className,
}: {
  role: PresenceRole | null;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const roleLabel = usePresenceRoleLabel();
  if (!role) return null;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border font-semibold uppercase tracking-wide',
        size === 'md'
          ? 'gap-1.5 px-2.5 py-1 text-[11px]'
          : 'px-2 py-0.5 text-[9px]',
        ROLE_TAG_CLASSES[role],
        className,
      )}
    >
      <span
        className={cn(
          'rounded-full',
          size === 'md' ? 'h-2 w-2' : 'h-1.5 w-1.5',
          ROLE_DOT_CLASSES[role],
        )}
      />
      {roleLabel(role)}
    </span>
  );
}

/**
 * The card's left-edge colour code. Absolutely positioned, so the host card
 * must be `relative` (both call sites are) — this rides on top of
 * `.section-frost-closed`'s own border instead of fighting its `@apply`d
 * border colour from the components layer.
 */
export function PresenceRoleAccent({ role }: { role: PresenceRole | null }) {
  if (!role) return null;
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-y-0 left-0 w-1',
        ROLE_ACCENT_CLASSES[role],
      )}
    />
  );
}

const ROLE_HEADER_CLASSES: Record<PresenceRole, string> = {
  self: 'border-border bg-brand-soft',
  competitor:
    'border-sky-200/70 bg-sky-50/60 dark:border-sky-500/30 dark:bg-sky-950/20',
};

const ROLE_HEADER_ICON = {
  self: Store,
  competitor: Radar,
} as const;

const ROLE_HEADER_ICON_CLASSES: Record<PresenceRole, string> = {
  self: 'text-brand-text',
  competitor: 'text-sky-500 dark:text-sky-400',
};

/**
 * Which listening dashboard am I looking at — my own brand or a competitor?
 * The switcher strip's per-tile role tags scroll out of view once you're deep
 * in a brand's feed, so the confirmed dashboard leads with this persistent,
 * role-coloured identity banner. A NULL role (legacy/agency profile) still gets
 * a neutral banner with the brand name so the header always orients the user.
 */
export function PresenceActiveBrandHeader({
  name,
  role,
}: {
  name: string;
  role: PresenceRole | null;
}) {
  const t = useTranslations('BrandPresence.roleHeader');
  const Icon = role ? ROLE_HEADER_ICON[role] : null;
  const caption =
    role === 'self'
      ? t('self')
      : role === 'competitor'
        ? t('competitor')
        : null;
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-2xl border px-4 py-3',
        role ? ROLE_HEADER_CLASSES[role] : 'border-border bg-muted/30',
      )}
    >
      {Icon && role && (
        <span
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-card',
            ROLE_HEADER_ICON_CLASSES[role],
          )}
        >
          <Icon className="h-4.5 w-4.5" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-base font-semibold text-foreground">
          {name}
        </h2>
        {caption && (
          <p className="truncate text-xs text-muted-foreground">{caption}</p>
        )}
      </div>
      <PresenceRoleBadge role={role} size="md" />
    </div>
  );
}
