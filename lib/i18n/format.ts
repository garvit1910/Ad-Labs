/**
 * Locale-aware formatting primitives (plan D5).
 *
 * The USER locale drives separators, symbol placement and date order; the
 * currency code only picks the symbol/code. Pure — zero React, zero store
 * imports — so server jobs, emails and PDFs can use it directly. Currency
 * CONVERSION is not done here (that lives in `stores/currencyStore`); every
 * method formats the value it is given.
 *
 * Missing values (`null`/`undefined`, `NaN`, invalid dates) render as `—`.
 */

import { isLocale, toIntlTag, type Locale } from '@/i18n/config';

/** Placeholder rendered for missing or unparseable values. */
export const EMPTY_VALUE = '—';

const CACHE_LIMIT = 200;
const DEFAULT_INTL_TAG = toIntlTag(undefined);

const numberFormatCache = new Map<string, Intl.NumberFormat>();
const dateTimeFormatCache = new Map<string, Intl.DateTimeFormat>();
const relativeTimeFormatCache = new Map<string, Intl.RelativeTimeFormat>();
const listFormatCache = new Map<string, Intl.ListFormat>();

function optionsKey(options: object): string {
  return JSON.stringify(
    Object.entries(options)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

function cached<T>(cache: Map<string, T>, key: string, make: () => T): T {
  const hit = cache.get(key);
  if (hit) return hit;
  // Bounded: a pathological caller cycling options can't grow this forever.
  if (cache.size >= CACHE_LIMIT) cache.clear();
  const created = make();
  cache.set(key, created);
  return created;
}

/** Cached `Intl.NumberFormat` per (locale, options). */
export function getNumberFormat(
  locale: string,
  options: Intl.NumberFormatOptions = {},
): Intl.NumberFormat {
  return cached(numberFormatCache, `${locale}|${optionsKey(options)}`, () => new Intl.NumberFormat(locale, options));
}

/** Cached `Intl.DateTimeFormat` per (locale, options). */
export function getDateTimeFormat(
  locale: string,
  options: Intl.DateTimeFormatOptions = {},
): Intl.DateTimeFormat {
  return cached(dateTimeFormatCache, `${locale}|${optionsKey(options)}`, () => new Intl.DateTimeFormat(locale, options));
}

function getRelativeTimeFormat(locale: string): Intl.RelativeTimeFormat {
  return cached(relativeTimeFormatCache, locale, () => new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }));
}

/** Cached `Intl.ListFormat` per (locale, type, style). */
export function getListFormat(
  locale: string,
  options: Intl.ListFormatOptions = {},
): Intl.ListFormat {
  return cached(listFormatCache, `${locale}|${optionsKey(options)}`, () => new Intl.ListFormat(locale, options));
}

/**
 * Resolve an app `Locale` (`'fr'`) or a full BCP 47 tag (`'fr-FR'`) to the tag
 * handed to `Intl`. Short app locales map through `toIntlTag`; anything else is
 * used as-is (canonicalised). An invalid tag falls back to the default locale's
 * tag rather than throwing a `RangeError` mid-render.
 */
export function resolveIntlTag(locale: Locale | string | null | undefined): string {
  if (isLocale(locale)) return toIntlTag(locale);
  if (typeof locale !== 'string' || locale.length === 0) return DEFAULT_INTL_TAG;
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? DEFAULT_INTL_TAG;
  } catch {
    return DEFAULT_INTL_TAG;
  }
}

type NumericInput = number | null | undefined;
type DateInput = Date | string | number | null | undefined;
export type DateStyle = 'short' | 'medium' | 'long';

export interface LocaleCurrencyOptions {
  /** Compact notation (`1,2 k $`) for |value| >= 1000. */
  compact?: boolean;
  /** Two fraction digits when true (default), none when false. */
  showCents?: boolean;
}

export interface LocaleListOptions {
  /**
   * `conjunction` (default): "A, B, and C" / "A, B et C".
   * `unit`: a plain enumeration — "A, B, C" in English (the legacy `", "` join,
   * byte-identical), the locale's own enumeration elsewhere ("A, B et C").
   * `disjunction`: "A, B, or C".
   */
  type?: Intl.ListFormatType;
  /** Defaults to `long`, or `short` for `unit` (the style whose English is `", "`). */
  style?: Intl.ListFormatStyle;
}

export interface LocaleFormatter {
  /** The resolved BCP 47 tag every method formats with. */
  locale: string;
  number(_value: NumericInput, _options?: Intl.NumberFormatOptions): string;
  integer(_value: NumericInput): string;
  /** Exactly `digits` fraction digits (default 2). */
  decimal(_value: NumericInput, _digits?: number): string;
  /**
   * `value` is a decimal ratio (0.25 → 25 %). With `digits`, exactly that many
   * fraction digits; without, up to one.
   */
  percent(_value: NumericInput, _digits?: number): string;
  /** Locale compact notation, up to one fraction digit (`1.2M`, `1,2 Mio.`). */
  compact(_value: NumericInput): string;
  currency(_value: NumericInput, _currencyCode: string, _options?: LocaleCurrencyOptions): string;
  date(_value: DateInput, _style?: DateStyle): string;
  time(_value: DateInput): string;
  dateTime(_value: DateInput): string;
  /** Relative to `now` (`5 minutes ago`, `il y a 5 minutes`, `yesterday`). */
  relative(_value: DateInput, _now?: Date): string;
  /** A locale list of already-translated items (`Intl.ListFormat`). */
  list(_items: readonly string[], _options?: LocaleListOptions): string;
}

function isMissingNumber(value: NumericInput): value is null | undefined {
  return value === null || value === undefined || Number.isNaN(value);
}

function toValidDate(value: DateInput): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const SECOND = 1;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** Pick the largest unit whose rounded magnitude stays under its rollover. */
function pickRelativeUnit(diffSeconds: number): [number, Intl.RelativeTimeFormatUnit] {
  const steps: Array<[number, number, Intl.RelativeTimeFormatUnit]> = [
    [SECOND, 60, 'second'],
    [MINUTE, 60, 'minute'],
    [HOUR, 24, 'hour'],
    [DAY, 30, 'day'],
    [MONTH, 12, 'month'],
  ];
  for (const [size, limit, unit] of steps) {
    const rounded = Math.round(diffSeconds / size);
    if (Math.abs(rounded) < limit) return [rounded, unit];
  }
  return [Math.round(diffSeconds / YEAR), 'year'];
}

/**
 * Build a formatter bound to one locale. Accepts a short app `Locale`
 * (`'fr'` → `fr-CA`) or a full BCP 47 tag (used as-is).
 */
export function createLocaleFormatter(locale: Locale | string): LocaleFormatter {
  const tag = resolveIntlTag(locale);

  const number = (value: NumericInput, options: Intl.NumberFormatOptions = {}): string =>
    isMissingNumber(value) ? EMPTY_VALUE : getNumberFormat(tag, options).format(value);

  const formatDate = (value: DateInput, options: Intl.DateTimeFormatOptions): string => {
    const date = toValidDate(value);
    return date ? getDateTimeFormat(tag, options).format(date) : EMPTY_VALUE;
  };

  return {
    locale: tag,
    number,
    integer: (value) => number(value, { maximumFractionDigits: 0 }),
    decimal: (value, digits = 2) =>
      number(value, { minimumFractionDigits: digits, maximumFractionDigits: digits }),
    percent: (value, digits) =>
      number(
        value,
        digits === undefined
          ? { style: 'percent', minimumFractionDigits: 0, maximumFractionDigits: 1 }
          : { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits },
      ),
    compact: (value) => number(value, { notation: 'compact', maximumFractionDigits: 1 }),
    currency: (value, currencyCode, options = {}) => {
      if (isMissingNumber(value)) return EMPTY_VALUE;
      const { compact = false, showCents = true } = options;
      const formatOptions: Intl.NumberFormatOptions =
        compact && Math.abs(value) >= 1000
          ? {
              style: 'currency',
              currency: currencyCode,
              notation: 'compact',
              compactDisplay: 'short',
              minimumFractionDigits: 0,
              maximumFractionDigits: 1,
            }
          : {
              style: 'currency',
              currency: currencyCode,
              minimumFractionDigits: showCents ? 2 : 0,
              maximumFractionDigits: showCents ? 2 : 0,
            };
      try {
        return getNumberFormat(tag, formatOptions).format(value);
      } catch {
        // Malformed ISO code from upstream config: show the amount, not a crash.
        const { minimumFractionDigits, maximumFractionDigits } = formatOptions;
        return `${number(value, { minimumFractionDigits, maximumFractionDigits })} ${currencyCode}`;
      }
    },
    date: (value, style = 'medium') => formatDate(value, { dateStyle: style }),
    time: (value) => formatDate(value, { timeStyle: 'short' }),
    dateTime: (value) => formatDate(value, { dateStyle: 'medium', timeStyle: 'short' }),
    relative: (value, now = new Date()) => {
      const date = toValidDate(value);
      if (!date || Number.isNaN(now.getTime())) return EMPTY_VALUE;
      const [amount, unit] = pickRelativeUnit((date.getTime() - now.getTime()) / 1000);
      return getRelativeTimeFormat(tag).format(amount, unit);
    },
    list: (items, options = {}) => {
      const type = options.type ?? 'conjunction';
      const style = options.style ?? (type === 'unit' ? 'short' : 'long');
      return getListFormat(tag, { type, style }).format(items);
    },
  };
}
