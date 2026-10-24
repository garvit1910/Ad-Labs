/**
 * True when a Radix "outside" interaction started on a Sonner toast.
 *
 * While the Google create modal is open, the toaster takes pointer events
 * above it (`useToastLayerAboveModal`, W2-F11). A click on a toast (its ×
 * in particular) is then OUTSIDE every open Radix dialog, so a dismissable
 * dialog closed with it: closing the failure toast also dismissed the
 * "Continue where you left off?" prompt and left a blank step 0 (W3-F5).
 * The shared `DialogContent` ignores these; a toast is never a choice about
 * the dialog under it.
 */
export function isToastInteraction(event: Event): boolean {
  const detail = (event as CustomEvent<{ originalEvent?: Event }>).detail;
  const target = (detail?.originalEvent?.target ?? event.target) as Node | null;
  const element =
    target && target.nodeType === 1 ? (target as Element) : (target?.parentElement ?? null);
  return !!element?.closest('[data-sonner-toaster], [data-sonner-toast]');
}
