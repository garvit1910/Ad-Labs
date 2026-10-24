/**
 * next-intl type augmentation: typed locales and message keys across the app.
 * `Messages` follows `messages/en.json` (the source catalog).
 */
import type { Locale } from './i18n/config';
import type en from './messages/en.json';

declare module 'next-intl' {
  interface AppConfig {
    Locale: Locale;
    Messages: typeof en;
  }
}
