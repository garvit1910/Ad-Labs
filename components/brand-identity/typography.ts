/**
 * Canonical type scale for the Brand Identity surface. Every text element in
 * the /brand-identity report tree must size through one of these tokens, so
 * the page reads as one system instead of a dozen ad-hoc `text-[Npx]` sizes.
 *
 * The SIZE is the locked decision; weight/tracking follow the role's dominant
 * existing usage so tokenizing is a size-unification, not a redesign. Compose
 * with `cn()` when a call site needs a different weight or color, e.g.
 * `cn(BI_TYPE.eyebrow, 'text-brand-text')` — tailwind-merge keeps the
 * token's size and lets the override win on the property it names.
 */
export const BI_TYPE = {
  /** Uppercase kicker / section label / eyebrow. */
  eyebrow: 'text-[11px] font-semibold uppercase tracking-wider',
  /** Panel & section headings (compose `sm:text-xl` where a bump already exists). */
  panelTitle: 'text-lg font-semibold tracking-tight',
  /** The distilled hero claim — one notch above a card title. */
  heroClaim: 'text-base font-semibold',
  /** Card / sub-headings (persona name, brand name, card h3). */
  cardTitle: 'text-sm font-semibold',
  /** Body copy — paragraphs, statements, verbatim quotes. */
  body: 'text-sm',
  /** Secondary / muted meta — captions, stat rows, dense grid rows, chapter links. */
  meta: 'text-xs',
} as const;
