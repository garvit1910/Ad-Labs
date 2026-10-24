import { useMemo } from 'react';
import { useLocale } from 'next-intl';
import { toIntlTag } from '@/i18n/config';
import {
  createLocaleFormatter,
  EMPTY_VALUE,
  type LocaleCurrencyOptions,
  type LocaleFormatter,
} from '@/lib/i18n/format';
import { convertToDisplayCurrency, useCurrencyStore } from '@/stores/currencyStore';

export interface MoneyOptions extends LocaleCurrencyOptions {
  /** Skip source→display conversion (value is already in the display currency). */
  skipConversion?: boolean;
}

export interface LocaleFormatters extends LocaleFormatter {
  /** The org display currency code the `money` helper formats in. */
  currencyCode: string;
  /**
   * Convert from the ad-account source currency to the display currency (as
   * `formatCurrency` does) and format it in the user's locale.
   */
  money(_value: number | null | undefined, _options?: MoneyOptions): string;
}

/**
 * Locale-bound formatters for client components (plan D5): the user's
 * next-intl locale drives separators and date order; the org display currency
 * drives the symbol. Re-renders when the locale or either currency changes, and
 * returns a referentially stable object otherwise.
 */
export function useLocaleFormatters(): LocaleFormatters {
  const tag = toIntlTag(useLocale());
  // Same source as `getCurrentCurrency().code` used by the legacy formatters.
  const currencyCode = useCurrencyStore((state) => state.displayCurrency.code);
  // Conversion reads the source currency at call time; subscribing here makes
  // consumers re-render (and get a fresh `money`) when it changes.
  // The page-scoped override (dashboard `?view=`) wins over the sidebar account.
  const sourceCurrencyCode = useCurrencyStore(
    (state) => state.sourceCurrencyOverrideCode ?? state.sourceCurrencyCode,
  );

  return useMemo(() => {
    const formatter = createLocaleFormatter(tag);
    return {
      ...formatter,
      currencyCode,
      money: (value, options = {}) => {
        if (value === null || value === undefined || Number.isNaN(value)) return EMPTY_VALUE;
        const { skipConversion = false, ...currencyOptions } = options;
        const amount = skipConversion ? value : convertToDisplayCurrency(value);
        return formatter.currency(amount, currencyCode, currencyOptions);
      },
    };
    // sourceCurrencyCode is read indirectly through convertToDisplayCurrency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tag, currencyCode, sourceCurrencyCode]);
}
