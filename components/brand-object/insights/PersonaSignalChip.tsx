'use client';

/**
 * One pain/desire signal as a tinted chip that reveals its full sentence.
 *
 * Built on Popover rather than Tooltip/HoverCard on purpose: Radix's hover
 * primitives never open on touch, and this report has to work at 375px. The
 * popover opens on hover and focus for pointer/keyboard users and on tap for
 * everyone else; the full sentence is also the chip's accessible name, so
 * screen readers get the detail without opening anything.
 */
import {
  useCallback,
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
} from 'react';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useTranslations } from 'next-intl';
import { BI_TYPE } from '@/components/brand-identity/typography';
import { cn } from '@/lib/utils';

import { shortenSignal, signalHasDetail } from './persona-signal';

const KIND_STYLES = {
  pain: {
    noun: 'Pain',
    chip: 'border-rose-200/80 bg-rose-50/80 text-rose-700 hover:border-rose-300 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300 dark:hover:border-rose-500/60',
    dot: 'bg-rose-500',
    heading: 'text-rose-600 dark:text-rose-300',
  },
  desire: {
    noun: 'Desire',
    chip: 'border-emerald-200/80 bg-emerald-50/80 text-emerald-700 hover:border-emerald-300 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:border-emerald-500/60',
    dot: 'bg-emerald-500',
    heading: 'text-emerald-600 dark:text-emerald-300',
  },
} as const;

/**
 * Only ONE chip popover may be open at a time, page-wide.
 *
 * With per-chip state, a chip opened by focus (click or Tab) stays open —
 * hovering a sibling never blurs it — so the two floating cards stack on top of
 * each other. A single shared "which chip is open" value makes opening one chip
 * close every other. Module scope rather than context: chips render across
 * cards and rungs, and there is no wrapper that owns them all.
 */
let openChipId: string | null = null;
const openChipListeners = new Set<() => void>();

function subscribeOpenChip(listener: () => void) {
  openChipListeners.add(listener);
  return () => openChipListeners.delete(listener);
}

function setOpenChip(id: string | null) {
  if (openChipId === id) return;
  openChipId = id;
  for (const listener of openChipListeners) listener();
}

function useIsOpenChip(id: string): boolean {
  const isOpen = useSyncExternalStore(
    subscribeOpenChip,
    () => openChipId === id,
    () => false,
  );
  // An unmounting chip must not leave the page believing it is still open.
  useEffect(() => () => {
    if (openChipId === id) setOpenChip(null);
  }, [id]);
  return isOpen;
}

/**
 * Touch browsers synthesize `mouseenter` on tap. Left ungated, the hover
 * handlers would open the popover a beat before the trigger's own click
 * handler toggled it straight back shut — the chip would flash and stay
 * closed on exactly the devices the popover exists to serve. Resolve after
 * mount so SSR renders the touch-safe branch.
 */
function useHoverCapable(): boolean {
  const [hoverCapable, setHoverCapable] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(hover: hover) and (pointer: fine)');
    setHoverCapable(query.matches);
    const onChange = (event: MediaQueryListEvent) => setHoverCapable(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return hoverCapable;
}

export function PersonaSignalChip({
  kind,
  text,
}: {
  kind: 'pain' | 'desire';
  text: string;
}) {
  const chipId = useId();
  const open = useIsOpenChip(chipId);
  const setOpen = useCallback(
    (next: boolean) => {
      if (next) setOpenChip(chipId);
      // A close only belongs to the chip that is actually open. Radix fires a
      // dismiss on the OUTGOING popover when the pointer lands on the next
      // chip, and that late close must not shut the one just opened.
      else if (openChipId === chipId) setOpenChip(null);
    },
    [chipId],
  );
  const hoverCapable = useHoverCapable();
  const t = useTranslations('BrandReport.sections');
  const style = KIND_STYLES[kind];
  const noun = kind === 'pain' ? t('vocPain') : t('vocDesire');
  const label = shortenSignal(text);
  if (!label) return null;

  const chipClasses = cn(
    'inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-left transition-colors',
    BI_TYPE.meta,
    style.chip,
  );
  const dot = (
    <span
      aria-hidden="true"
      className={cn('h-1.5 w-1.5 shrink-0 rounded-full', style.dot)}
    />
  );

  // Nothing extra to reveal — render a plain chip rather than an empty popover.
  if (!signalHasDetail(text)) {
    return (
      <span className={chipClasses}>
        {dot}
        <span className="min-w-0 break-words">{label}</span>
      </span>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${noun}: ${text}`}
          onMouseEnter={hoverCapable ? () => setOpen(true) : undefined}
          onMouseLeave={hoverCapable ? () => setOpen(false) : undefined}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          className={cn(
            chipClasses,
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
            hoverCapable ? 'cursor-help' : 'cursor-pointer',
          )}
        >
          {dot}
          <span className="min-w-0 break-words">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        // The popover is a description, not a destination: taking focus would
        // fire the trigger's blur handler and close it immediately.
        onOpenAutoFocus={(event) => event.preventDefault()}
        // ...and because focus never entered the content, there is nothing to
        // give back. Left alone, Radix's non-modal content calls
        // `trigger.focus()` on close, which our onFocus reads as a real focus
        // and reopens the chip the pointer just LEFT — it then outlives the
        // chip being hovered, so the wrong sentence shows.
        onCloseAutoFocus={(event) => event.preventDefault()}
        className="w-auto max-w-60 space-y-1 p-3"
      >
        <p className={cn(BI_TYPE.eyebrow, style.heading)}>{noun}</p>
        <p className={cn(BI_TYPE.meta, 'leading-relaxed text-muted-foreground')}>
          {text}
        </p>
      </PopoverContent>
    </Popover>
  );
}
