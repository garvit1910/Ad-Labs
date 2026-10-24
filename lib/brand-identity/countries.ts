/**
 * Country options for the competitor keyword search. The Apify Ad Library
 * scraper accepts an ISO country code in the search URL (`country=<CC>`); this
 * is the curated set of common advertising markets surfaced in the selector.
 * Default is US (what the keyword search starts with).
 */

export const DEFAULT_AD_LIBRARY_COUNTRY = 'US';

export interface CountryOption {
  /** ISO 3166-1 alpha-2 code, uppercase. */
  code: string;
  name: string;
}

export const AD_LIBRARY_COUNTRIES: CountryOption[] = [
  { code: 'US', name: 'United States' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' },
  { code: 'NZ', name: 'New Zealand' },
  { code: 'IE', name: 'Ireland' },
  { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' },
  { code: 'ES', name: 'Spain' },
  { code: 'IT', name: 'Italy' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'BE', name: 'Belgium' },
  { code: 'SE', name: 'Sweden' },
  { code: 'NO', name: 'Norway' },
  { code: 'DK', name: 'Denmark' },
  { code: 'FI', name: 'Finland' },
  { code: 'PL', name: 'Poland' },
  { code: 'PT', name: 'Portugal' },
  { code: 'AT', name: 'Austria' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'BR', name: 'Brazil' },
  { code: 'MX', name: 'Mexico' },
  { code: 'AR', name: 'Argentina' },
  { code: 'IN', name: 'India' },
  { code: 'SG', name: 'Singapore' },
  { code: 'AE', name: 'United Arab Emirates' },
  { code: 'ZA', name: 'South Africa' },
  { code: 'JP', name: 'Japan' },
  { code: 'KR', name: 'South Korea' },
];

const VALID_CODES = new Set(AD_LIBRARY_COUNTRIES.map((c) => c.code));

/** True when `code` is one of the supported uppercase ISO country codes. */
export function isSupportedCountry(code: string): boolean {
  return VALID_CODES.has(code.toUpperCase());
}
