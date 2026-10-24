'use client';

/**
 * Shared slot so the Competitor Analysis Overview page can render its
 * scope filters (platform + competitor dropdowns) INTO the section tab row
 * that the `/brand-identity` layout owns - putting the dropdowns on the same
 * horizontal row as the Overview | Competitors | Ad Library | Collections
 * tabs, without lifting the page's filter state out of the page.
 *
 * The layout renders `<CompetitorFilterSlotTarget />` on the tab row and wraps
 * everything in `<CompetitorFilterSlotProvider>`. The Overview page reads the
 * live slot element via `useCompetitorFilterSlot()` and portals its dropdowns
 * into it; when the slot is absent (initial mount, other tabs) it falls back to
 * rendering inline.
 */

import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from 'react';

const SlotElementContext = createContext<HTMLElement | null>(null);
const SlotSetterContext = createContext<
  ((_el: HTMLElement | null) => void) | null
>(null);

export function CompetitorFilterSlotProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <SlotSetterContext.Provider value={setSlot}>
      <SlotElementContext.Provider value={slot}>
        {children}
      </SlotElementContext.Provider>
    </SlotSetterContext.Provider>
  );
}

/** Renders the destination div for the filters on the tab row. */
export function CompetitorFilterSlotTarget({
  className,
}: {
  className?: string;
}) {
  const setSlot = useContext(SlotSetterContext);
  return <div ref={setSlot} className={className} />;
}

/** The live slot element to portal into, or null before it mounts. */
export function useCompetitorFilterSlot(): HTMLElement | null {
  return useContext(SlotElementContext);
}
