/**
 * Currency exchange rate service (pure, synchronous — no DB / Node-only deps).
 *
 * This module is safe to import from client code (e.g. `stores/currencyStore.ts`).
 * The DB-backed snapshot loader (`loadExchangeRateTable`) lives in the separate
 * server-only `./exchange-rate-snapshot` module so that importing the pure
 * helpers here never pulls `pg` into a client/edge bundle.
 *
 * - Static `EXCHANGE_RATES_TO_USD` constant — the seed + offline fallback.
 *   `convertCurrency` / `getExchangeRate` operate synchronously over it
 *   (back-compat; kept identical to historical behavior).
 * - Pure `convertWithTable` / `getRateFromTable` helpers convert against an
 *   `ExchangeRateTable` snapshot resolved by the caller (see
 *   `./exchange-rate-snapshot`), so a whole request shares one rate set with no
 *   per-row DB hit.
 */

// Exchange rates relative to USD (base currency)
// These are approximate rates and should be updated periodically
// In production, consider using a live exchange rate API
// Last updated: 2026-06-10 (open.er-api.com daily reference rates)
export const EXCHANGE_RATES_TO_USD: Record<string, number> = {
  USD: 1,
  EUR: 1.1549,    // 1 EUR = 1.1549 USD
  GBP: 1.338,     // 1 GBP = 1.338 USD
  CAD: 0.7172,    // 1 CAD = 0.7172 USD
  AUD: 0.7032,    // 1 AUD = 0.7032 USD
  JPY: 0.00624,   // 1 JPY = 0.00624 USD
  CNY: 0.1474,    // 1 CNY = 0.1474 USD
  INR: 0.01048,   // 1 INR = 0.01048 USD
  BRL: 0.1933,    // 1 BRL = 0.1933 USD
  MXN: 0.0574,    // 1 MXN = 0.0574 USD
  KRW: 0.000656,  // 1 KRW = 0.000656 USD
  SGD: 0.7772,    // 1 SGD = 0.7772 USD
  HKD: 0.1276,    // 1 HKD = 0.1276 USD
  NZD: 0.5816,    // 1 NZD = 0.5816 USD
  SEK: 0.1058,    // 1 SEK = 0.1058 USD
  NOK: 0.1054,    // 1 NOK = 0.1054 USD
  DKK: 0.1548,    // 1 DKK = 0.1548 USD
  CHF: 1.253,     // 1 CHF = 1.253 USD
  PLN: 0.2724,    // 1 PLN = 0.2724 USD
  PHP: 0.01625,   // 1 PHP = 0.01625 USD
  THB: 0.03041,   // 1 THB = 0.03041 USD
  MYR: 0.2462,    // 1 MYR = 0.2462 USD
  IDR: 0.0000556, // 1 IDR = 0.0000556 USD
  ZAR: 0.06059,   // 1 ZAR = 0.06059 USD
  AED: 0.2723,    // 1 AED = 0.2723 USD
  SAR: 0.2667,    // 1 SAR = 0.2667 USD
  ILS: 0.3385,    // 1 ILS = 0.3385 USD
  TRY: 0.02168,   // 1 TRY = 0.02168 USD
  RUB: 0.01388,   // 1 RUB = 0.01388 USD
  COP: 0.000278,  // 1 COP = 0.000278 USD
  ARS: 0.000691,  // 1 ARS = 0.000691 USD
  CLP: 0.001084,  // 1 CLP = 0.001084 USD
  PEN: 0.2914,    // 1 PEN = 0.2914 USD
};

/**
 * Convert an amount from one currency to another
 * @param amount - The amount to convert
 * @param fromCurrency - Source currency code (e.g., 'USD')
 * @param toCurrency - Target currency code (e.g., 'EUR')
 * @returns Converted amount
 */
export function convertCurrency(
  amount: number,
  fromCurrency: string,
  toCurrency: string
): number {
  // If same currency, no conversion needed
  if (fromCurrency === toCurrency) {
    return amount;
  }

  // Get exchange rates (to USD)
  const fromRate = EXCHANGE_RATES_TO_USD[fromCurrency];
  const toRate = EXCHANGE_RATES_TO_USD[toCurrency];

  // If we don't have rates for either currency, return original amount
  if (!fromRate || !toRate) {
    console.warn(`Exchange rate not found for ${fromCurrency} or ${toCurrency}`);
    return amount;
  }

  // Convert: source -> USD -> target
  const amountInUSD = amount * fromRate;
  const convertedAmount = amountInUSD / toRate;

  return convertedAmount;
}

/**
 * Get the exchange rate between two currencies
 * @param fromCurrency - Source currency code
 * @param toCurrency - Target currency code
 * @returns Exchange rate (multiply source amount by this to get target amount)
 */
export function getExchangeRate(
  fromCurrency: string,
  toCurrency: string
): number {
  if (fromCurrency === toCurrency) {
    return 1;
  }

  const fromRate = EXCHANGE_RATES_TO_USD[fromCurrency];
  const toRate = EXCHANGE_RATES_TO_USD[toCurrency];

  if (!fromRate || !toRate) {
    return 1;
  }

  return fromRate / toRate;
}

/**
 * Check if a currency code is supported
 */
export function isCurrencySupported(currencyCode: string): boolean {
  return currencyCode in EXCHANGE_RATES_TO_USD;
}

/**
 * Get all supported currency codes
 */
export function getSupportedCurrencyCodes(): string[] {
  return Object.keys(EXCHANGE_RATES_TO_USD);
}

// ---------------------------------------------------------------------------
// Snapshot-based (pure) rate resolution
// ---------------------------------------------------------------------------

/**
 * A point-in-time snapshot of quote-currency -> base (USD) rates, identical in
 * shape to EXCHANGE_RATES_TO_USD. Resolved by `loadExchangeRateTable()` in the
 * server-only `./exchange-rate-snapshot` module; reporting code passes one in
 * per request and converts synchronously against it via the helpers below.
 */
export type ExchangeRateTable = Record<string, number>;

/**
 * Pure conversion against a passed snapshot. Missing source/target code →
 * pass-through (returns the original amount) + warn, preserving the behavior of
 * the synchronous `convertCurrency`.
 */
export function convertWithTable(
  amount: number,
  fromCurrency: string,
  toCurrency: string,
  table: ExchangeRateTable
): number {
  if (fromCurrency === toCurrency) {
    return amount;
  }

  const fromRate = table[fromCurrency];
  const toRate = table[toCurrency];

  if (!fromRate || !toRate) {
    console.warn(`Exchange rate not found for ${fromCurrency} or ${toCurrency}`);
    return amount;
  }

  return (amount * fromRate) / toRate;
}

/**
 * Pure rate lookup against a passed snapshot. Missing code → 1 (pass-through),
 * matching `getExchangeRate`.
 */
export function getRateFromTable(
  fromCurrency: string,
  toCurrency: string,
  table: ExchangeRateTable
): number {
  if (fromCurrency === toCurrency) {
    return 1;
  }

  const fromRate = table[fromCurrency];
  const toRate = table[toCurrency];

  if (!fromRate || !toRate) {
    console.warn(`Exchange rate not found for ${fromCurrency} or ${toCurrency}`);
    return 1;
  }

  return fromRate / toRate;
}

