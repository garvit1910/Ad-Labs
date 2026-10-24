import { create } from 'zustand';
import { DEFAULT_CURRENCY_CODE, getCurrencyByCode, getDefaultCurrency, type Currency } from '@/lib/currency/currencies';
import { convertCurrency } from '@/lib/currency/exchange-rates';

interface CurrencyState {
  /** The display currency code selected by the user */
  displayCurrencyCode: string;
  /** The display currency object */
  displayCurrency: Currency;
  /** The source currency code from the ad account data */
  sourceCurrencyCode: string;
  /**
   * Source currency of the account a page is actually showing, when that page
   * scopes its account itself instead of using the sidebar account (the
   * dashboard's `?view=` scope). Wins over `sourceCurrencyCode` while set.
   */
  sourceCurrencyOverrideCode: string | null;
  /** Whether conversion is needed (effective source != display) */
  needsConversion: boolean;
  /** Set the display currency (user preference) */
  setDisplayCurrency: (_code: string) => void;
  /** Set the source currency (from ad account) */
  setSourceCurrency: (_code: string) => void;
  /** Set or clear (null) the page-scoped source currency override */
  setSourceCurrencyOverride: (_code: string | null) => void;
  /** Convert an amount from source to display currency */
  convert: (_amount: number) => number;
}

/**
 * Global currency store for accessing organization currency outside of React components
 * Tracks both the source currency (from ad account) and display currency (user preference)
 * Provides conversion when they differ
 */
export const useCurrencyStore = create<CurrencyState>((set, get) => ({
  displayCurrencyCode: DEFAULT_CURRENCY_CODE,
  displayCurrency: getDefaultCurrency(),
  sourceCurrencyCode: DEFAULT_CURRENCY_CODE,
  sourceCurrencyOverrideCode: null,
  needsConversion: false,
  
  setDisplayCurrency: (code: string) => {
    const displayCurrency = getCurrencyByCode(code) || getDefaultCurrency();
    const { sourceCurrencyCode, sourceCurrencyOverrideCode } = get();
    set({ 
      displayCurrencyCode: code, 
      displayCurrency,
      needsConversion: code !== (sourceCurrencyOverrideCode ?? sourceCurrencyCode),
    });
  },
  
  setSourceCurrency: (code: string) => {
    const { displayCurrencyCode, sourceCurrencyOverrideCode } = get();
    set({ 
      sourceCurrencyCode: code,
      needsConversion: (sourceCurrencyOverrideCode ?? code) !== displayCurrencyCode,
    });
  },

  setSourceCurrencyOverride: (code: string | null) => {
    const { displayCurrencyCode, sourceCurrencyCode } = get();
    set({
      sourceCurrencyOverrideCode: code,
      needsConversion: (code ?? sourceCurrencyCode) !== displayCurrencyCode,
    });
  },
  
  convert: (amount: number) => {
    const { displayCurrencyCode, needsConversion } = get();
    if (!needsConversion) return amount;
    return convertCurrency(amount, getEffectiveSourceCurrencyCode(), displayCurrencyCode);
  },
}));

// Legacy aliases for backward compatibility
/** @deprecated Use displayCurrency instead */
export function getCurrentCurrency(): Currency {
  return useCurrencyStore.getState().displayCurrency;
}

/** @deprecated Use displayCurrencyCode instead */
export function getCurrentCurrencyCode(): string {
  return useCurrencyStore.getState().displayCurrencyCode;
}

/**
 * Get the source currency code (from ad account data)
 */
export function getSourceCurrencyCode(): string {
  return useCurrencyStore.getState().sourceCurrencyCode;
}

/**
 * The currency amounts are converted FROM: the page-scoped override when one
 * is set, otherwise the sidebar account's currency.
 */
export function getEffectiveSourceCurrencyCode(): string {
  const { sourceCurrencyOverrideCode, sourceCurrencyCode } =
    useCurrencyStore.getState();
  return sourceCurrencyOverrideCode ?? sourceCurrencyCode;
}

/**
 * Convert an amount from source currency to display currency
 * Use this in formatters to display converted values
 */
export function convertToDisplayCurrency(amount: number): number {
  return useCurrencyStore.getState().convert(amount);
}

