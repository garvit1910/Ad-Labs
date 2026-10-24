import { useLocale } from 'next-intl';

import { isLocale, toIntlTag } from '@/i18n/config';

/**
 * The BCP 47 tag to format numbers/dates with, or `undefined` for English so
 * English output stays byte-identical to the pre-i18n formatters (which run
 * without a locale argument). Pass the result straight to helpers that treat
 * `undefined` as "legacy English" (`components/dashboard/format-locale.ts`,
 * `components/analytics/chart-components/ChartUtils.ts`).
 */
export function useFormatLocale(): string | undefined {
  const locale = useLocale();
  if (locale === 'en' || !isLocale(locale)) return undefined;
  return toIntlTag(locale);
}
