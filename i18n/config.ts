/**
 * Locale registry — the single source of truth for which UI languages exist.
 *
 * `Locale` is the short app-level code stored in the `adcero-locale` cookie and
 * in `user_settings`. `LOCALE_INTL_TAGS` maps each one to the BCP 47 tag handed
 * to `Intl.*` / next-intl, chosen for the markets Adcero actually serves
 * (Latin-American Spanish, Canadian French, Brazilian Portuguese).
 *
 * Adding a locale: append here, add `messages/<locale>.json`, and keep
 * `tests/unit/i18n/messages.structural.test.ts` green.
 */
export const SUPPORTED_LOCALES = ['en', 'es', 'fr', 'de', 'pt', 'it'] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** Native-language display names for the language picker. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  pt: 'Português',
  it: 'Italiano',
};

/** BCP 47 tag used for `Intl` formatting and `<html lang>`. */
export const LOCALE_INTL_TAGS: Record<Locale, string> = {
  en: 'en-US',
  es: 'es-419',
  fr: 'fr-CA',
  de: 'de-DE',
  pt: 'pt-BR',
  it: 'it-IT',
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Resolve the Intl tag for a locale, falling back to the default locale's tag. */
export function toIntlTag(locale: string | null | undefined): string {
  return isLocale(locale) ? LOCALE_INTL_TAGS[locale] : LOCALE_INTL_TAGS[DEFAULT_LOCALE];
}
