/**
 * Client-safe error localization (server `{ code, reason, remediation }` →
 * catalog copy).
 *
 * Server routes answer failures with an English `reason` (`AfError`, see
 * `app/api/CLAUDE.md`). Client hooks keep that machine `code` on the thrown
 * error (`CodedError`, or any error class with a string `code`/numeric
 * `status`, e.g. `SpendControlsRequestError`, `SaveAccountError`,
 * `BrandPresenceRequestError`), and the render site turns it into copy with
 * `localizeError()` / `useLocalizeError()`:
 *
 *   - `locale === 'en'` → the error's own message, unchanged (English UX stays
 *     byte-identical), or the fallback key when there is no usable message.
 *   - any other locale → the first match of: the error's `code` in `codeKeys`
 *     (merged over `DEFAULT_ERROR_CODE_KEYS`), the generic code for its HTTP
 *     `status`, a network failure (`TypeError: Failed to fetch`), else the
 *     operation's translated `fallbackKey`. Server English never leaks.
 *
 * Never returns an empty string. No server-only imports (no `lib/db`,
 * `lib/audit`, `pg`) — this file is imported by client components.
 *
 * Key typing at catalog scale: nothing here may materialize the union of
 * every catalog key (`Parameters<RootTranslator>[0]`, `MessageKeys<…>` over
 * the whole catalog) — at ~5k keys that is TS2590 "union type too complex".
 * `MessageKey` is a plain `string`; literal keys passed to `localizeError` /
 * `useLocalizeError()` are checked one path at a time by `CatalogKey<K>`
 * (cost grows with key depth, not catalog size); the exported code → key maps
 * are checked by `tests/unit/i18n/error-code-keys-catalog.test.ts`; and a key
 * missing at runtime warns once in development and renders `Common.error`.
 */
import { useCallback } from 'react';
import { useLocale, useTranslations, type Messages } from 'next-intl';
import { DEFAULT_LOCALE } from '@/i18n/config';
import { BILLING_ERROR_KEYS } from './error-code-key-maps/billing';

/**
 * The root translator's TYPE. Only ever passed through by identity — never
 * call it with a key, take its `Parameters`, or assign it to a non-generic
 * function type: each of those makes TypeScript build the all-keys union.
 */
type RootTranslator = ReturnType<typeof useTranslations<never>>;

/** What `localizeError` actually calls at runtime (keys are plain strings). */
interface RuntimeTranslator {
  (_key: string): string;
  has?: (_key: string) => boolean;
}

/**
 * A full dotted catalog key (`'Common.errors.network'`, `'Settings.x.y'`).
 * Deliberately a plain string — see the module header.
 */
export type MessageKey = string;

/** `true` when dotted path `P` names a string leaf of `T`, else `false`. */
type IsStringLeaf<T, P extends string> = P extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? IsStringLeaf<T[Head], Rest>
    : false
  : P extends keyof T
    ? T[P] extends string
      ? true
      : false
    : false;

/** Readable compile error for a key that is not a string leaf of the catalog. */
interface NotACatalogKey<K extends string> {
  readonly 'is not a string key of messages/en.json': K;
}

/**
 * Per-literal key check: `K` when every member names a string leaf of
 * `messages/en.json`, else a `NotACatalogKey` brand (a compile error at the
 * call site). Walks one dotted path per member, so it never builds the
 * all-keys union. A widened `string` (a key already held in a `MessageKey`
 * variable or a code → key map) passes unchecked — those are covered by the
 * map test and the runtime fallback.
 */
export type CatalogKey<K extends string> = K extends string
  ? string extends K
    ? K
    : IsStringLeaf<Messages, K> extends true
      ? K
      : NotACatalogKey<K>
  : never;

/** Server/synthetic error code → full catalog key. */
export type ErrorCodeKeys = Readonly<Partial<Record<string, MessageKey>>>;

/** Shown when a key is missing from the catalog at runtime. */
export const MISSING_KEY_FALLBACK = 'Common.error' satisfies CatalogKey<'Common.error'>;

const warnedMissingKeys = new Set<string>();

/**
 * Translate a full key through the root translator. A key the catalog does
 * not have renders `Common.error` (never the raw key) and warns once per key
 * outside production.
 */
function translateKey(t: RootTranslator, key: string): string {
  const translator = t as unknown as RuntimeTranslator;
  if (typeof translator.has === 'function' && !translator.has(key)) {
    if (process.env.NODE_ENV !== 'production' && !warnedMissingKeys.has(key)) {
      warnedMissingKeys.add(key);
      console.warn(
        `[i18n] localizeError: "${key}" is not a key of messages/en.json; showing ${MISSING_KEY_FALLBACK}.`,
      );
    }
    return translator(MISSING_KEY_FALLBACK);
  }
  return translator(key);
}

/** Synthetic code `localizeError` assigns to a browser network failure. */
export const NETWORK_ERROR_CODE = 'NETWORK_ERROR';

/**
 * Codes every surface understands. Per-surface `codeKeys` are merged over
 * these, so a surface can re-point a generic code at more specific copy.
 */
export const DEFAULT_ERROR_CODE_KEYS = {
  [NETWORK_ERROR_CODE]: 'Common.errors.network',
  PERMISSION_DENIED: 'Common.errors.permissionDenied',
  FORBIDDEN: 'Common.errors.permissionDenied',
  CROSS_ORG_ACCESS_DENIED: 'Common.errors.permissionDenied',
  INSUFFICIENT_ROLE: 'Common.errors.permissionDenied',
  UNAUTHORIZED: 'Common.errors.sessionExpired',
  MISSING_AUTH: 'Common.errors.sessionExpired',
  NOT_FOUND: 'Common.errors.notFound',
  ORG_NOT_FOUND: 'Common.errors.notFound',
  CONFLICT: 'Common.errors.conflict',
  VALIDATION_ERROR: 'Common.errors.validation',
  INVALID_INPUT: 'Common.errors.validation',
  MISSING_FIELD: 'Common.errors.validation',
  RATE_LIMITED: 'Common.errors.rateLimited',
  META_RATE_LIMITED: 'Common.errors.rateLimited',
  TOKEN_EXPIRED: 'Common.errors.platformConnectionExpired',
  TOKEN_NOT_FOUND: 'Common.errors.platformConnectionExpired',
  TOKEN_REFRESH_FAILED: 'Common.errors.platformConnectionExpired',
  // A request naming a disconnected / unconnected ad account
  // (`lib/accounts/connected-scope.ts`, `POST /api/jobs/sync`). Without this
  // the 409 read as "conflicts with a recent change".
  AD_ACCOUNT_NOT_CONNECTED: 'Common.errors.adAccountNotConnected',
  // A Meta ad account that can't create ads (`lib/meta/account-status.ts`
  // `META_ACCOUNT_BLOCK_CODES`): Bulk Uploader, create modal, Creative Studio.
  META_ACCOUNT_UNPAID: 'Common.errors.metaAccount.unpaid',
  META_ACCOUNT_DISABLED: 'Common.errors.metaAccount.disabled',
  META_ACCOUNT_UNDER_REVIEW: 'Common.errors.metaAccount.underReview',
  META_ACCOUNT_CLOSED: 'Common.errors.metaAccount.closed',
  META_ACCOUNT_CANNOT_CREATE_ADS: 'Common.errors.metaAccount.cannotCreateAds',
  // Plan limits / expired trial / inactive subscription (HTTP 402) can come
  // back from any enforced route (competitors, Brand Presence, Creative
  // Studio, Ask Adcero, org create), so every surface localizes them.
  ...BILLING_ERROR_KEYS,
} as const satisfies ErrorCodeKeys;

/** HTTP status → generic code, used when the error's own code is unmapped. */
const STATUS_CODES: Readonly<Record<number, string>> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'VALIDATION_ERROR',
  429: 'RATE_LIMITED',
};

/**
 * An `Error` that keeps the server's machine `code` and HTTP `status`. The
 * message is whatever English text the caller already showed, so English UX
 * is unchanged.
 */
export class CodedError extends Error {
  readonly code: string | null;
  readonly status: number | null;
  readonly remediation: string | null;
  /**
   * The body's optional engineering `details` object (`app/api/CLAUDE.md`), e.g.
   * a billing 402's `feature`/`limit`/`used`. Never rendered as text.
   */
  readonly details: Readonly<Record<string, unknown>> | null;

  constructor(
    message: string,
    details: {
      code?: string | null;
      status?: number | null;
      remediation?: string | null;
      details?: Readonly<Record<string, unknown>> | null;
    } = {},
  ) {
    super(message);
    this.name = 'CodedError';
    this.code = details.code ?? null;
    this.status = details.status ?? null;
    this.remediation = details.remediation ?? null;
    this.details = details.details ?? null;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Parse a response body as JSON; `null` on an empty/non-JSON body. Never throws. */
async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** `code` from a `{ code }` or `{ error: { code } }` response body. */
export function errorCodeFromBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const direct = nonEmptyString(record.code);
  if (direct) return direct;
  const nested = record.error;
  return nested && typeof nested === 'object'
    ? nonEmptyString((nested as Record<string, unknown>).code)
    : null;
}

/** Body fields a `CodedError` message may be taken from, in order. */
export type ErrorMessageField = 'reason' | 'error';

/**
 * Build a `CodedError` from a non-OK response without throwing while reading
 * it. The message is the first non-empty string among `messageFields` —
 * default `['reason', 'error']`, the routes' documented parse order — else
 * `fallbackMessage`. Pass the fields a call site already showed so its
 * English copy stays byte-identical (`['error']` for a site that never read
 * `reason`, `[]` for a site that always showed its own message).
 */
export async function codedErrorFromResponse(
  response: Response,
  fallbackMessage: string,
  messageFields: readonly ErrorMessageField[] = ['reason', 'error'],
): Promise<CodedError> {
  const body = await readJsonBody(response);
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const message = messageFields
    .map((field) => nonEmptyString(record[field]))
    .find((value): value is string => value !== null);
  const details = record.details;
  return new CodedError(message ?? fallbackMessage, {
    code: errorCodeFromBody(body),
    status: response.status,
    remediation: nonEmptyString(record.remediation),
    details:
      details && typeof details === 'object' && !Array.isArray(details)
        ? (details as Record<string, unknown>)
        : null,
  });
}

/** `fetch()` rejects with a `TypeError` when the request never reached a server. */
export function isNetworkError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    /failed to fetch|networkerror|network request failed|load failed/i.test(error.message)
  );
}

function readCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  return nonEmptyString((error as { code?: unknown }).code);
}

/**
 * The catalog key `codeKeys` maps the error's `code` to, or null. For codes
 * whose copy must render in every locale INCLUDING English (the copy carries
 * remediation the server `reason` lacks); translate the result with
 * `useCatalogTranslator()`. Everything else goes through `localizeError`.
 */
export function catalogKeyForCode(error: unknown, codeKeys: ErrorCodeKeys): MessageKey | null {
  const code = readCode(error);
  if (!code || !Object.prototype.hasOwnProperty.call(codeKeys, code)) return null;
  return codeKeys[code] ?? null;
}

function readStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

export interface LocalizeErrorCallOptions<K extends string = MessageKey> {
  /** Full key of the operation's translated "…failed" copy (checked by `CatalogKey`). */
  fallbackKey: K & CatalogKey<K>;
  /** Surface-specific code → key map, merged over `DEFAULT_ERROR_CODE_KEYS`. */
  codeKeys?: ErrorCodeKeys;
}

export interface LocalizeErrorOptions<K extends string = MessageKey>
  extends LocalizeErrorCallOptions<K> {
  /** Root translator (`useTranslations()` with no namespace). */
  t: RootTranslator;
  /** Active UI locale (`useLocale()`). */
  locale: string;
}

/**
 * Turn a thrown value into user-facing copy. See the module header for the
 * resolution order. Pure: no React, safe in tests and non-hook code.
 */
export function localizeError<K extends string>(
  error: unknown,
  options: LocalizeErrorOptions<K>,
): string {
  const { locale, codeKeys } = options;
  const fallbackKey: string = options.fallbackKey;
  const translate = (key: string) => translateKey(options.t, key);
  const fallback = () => translate(fallbackKey);

  if (locale === DEFAULT_LOCALE) {
    return error instanceof Error && error.message ? error.message : fallback();
  }

  const keys: Readonly<Partial<Record<string, string>>> = {
    ...DEFAULT_ERROR_CODE_KEYS,
    ...codeKeys,
  };
  const lookup = (code: string | null | undefined): string | null => {
    if (!code || !Object.prototype.hasOwnProperty.call(keys, code)) return null;
    return keys[code] ?? null;
  };

  const status = readStatus(error);
  const key =
    lookup(readCode(error)) ??
    lookup(status === null ? null : STATUS_CODES[status]) ??
    lookup(isNetworkError(error) ? NETWORK_ERROR_CODE : null);

  const message = key ? translate(key) : fallback();
  return message || fallback() || translate(MISSING_KEY_FALLBACK);
}

/** The function `useCatalogTranslator()` returns. */
export type CatalogTranslateFn = <K extends string>(_key: K & CatalogKey<K>) => string;

/**
 * Translate a FULL catalog key held in data (a code → key map value), the
 * scale-safe replacement for calling the root `useTranslations()` translator
 * with a dynamic key: the key is checked per literal by `CatalogKey`, and a
 * key missing at runtime renders `Common.error` (with a one-time dev warning)
 * instead of the raw key. Prefer a narrow-namespace `useTranslations('A.b')`
 * with a typed `Record<Id, LeafKey>` whenever the keys share a namespace.
 */
export function useCatalogTranslator(): CatalogTranslateFn {
  const t = useTranslations();
  // Implemented over plain strings: the generic signature only checks callers.
  return useCallback<CatalogTranslateFn>((key: string) => translateKey(t, key), [t]);
}

/** The function `useLocalizeError()` returns. */
export type LocalizeErrorFn = <K extends string>(
  _error: unknown,
  _options: LocalizeErrorCallOptions<K>,
) => string;

/**
 * Hook form of `localizeError` bound to the current locale and catalog:
 * `const localize = useLocalizeError(); localize(error, { fallbackKey })`.
 * The returned function is stable while the locale is unchanged.
 */
export function useLocalizeError(): LocalizeErrorFn {
  const t = useTranslations();
  const locale = useLocale();
  return useCallback(
    <K extends string>(error: unknown, options: LocalizeErrorCallOptions<K>) =>
      localizeError<K>(error, { ...options, t, locale }),
    [t, locale],
  );
}
