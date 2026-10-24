/**
 * CLIENT-SAFE merge of an AI Summary GET's `{ localized, translated }` over the
 * English row it came with (plan `tasks/i18n-ai-output-translations-plan.md` WS4).
 * Pure, ZERO imports — hooks and `'use client'` components import this file
 * directly; the server half lives in `ai-summary-translations.server.ts`.
 *
 * `localized` holds only the row's prose fields (same keys as the row), so the merge
 * is a shallow spread. Anything other than a real translation returns the English
 * row untouched with `translated: false`.
 */

export interface LocalizedSynthesisPayload<Prose> {
  localized?: Prose | null;
  translated?: boolean;
}

export function applyLocalizedProse<Row extends object>(
  row: Row | null,
  payload: LocalizedSynthesisPayload<Partial<Row>> | null | undefined,
): { row: Row | null; translated: boolean } {
  const localized = payload?.localized;
  if (
    !row ||
    payload?.translated !== true ||
    !localized ||
    typeof localized !== 'object' ||
    Array.isArray(localized)
  ) {
    return { row, translated: false };
  }
  return { row: { ...row, ...localized }, translated: true };
}
