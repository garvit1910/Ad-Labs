/**
 * Recursive merge for message catalogs (plan decision D4).
 *
 * `deepMerge(en, es)` returns a NEW object holding every key of `base`, with
 * `override` winning wherever it supplies a value. Nested plain objects merge
 * key by key, so a locale that translates only part of a namespace still falls
 * back to English for the rest. Neither input is mutated.
 *
 * Keys that could pollute `Object.prototype` (`__proto__`, `constructor`,
 * `prototype`) are skipped: catalogs are JSON and a crafted key must never reach
 * a prototype chain.
 */
type PlainObject = Record<string, unknown>;

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function mergeInto(target: PlainObject, source: PlainObject): void {
  for (const key of Object.keys(source)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const incoming = source[key];
    if (incoming === undefined) continue;
    const existing = target[key];
    if (isPlainObject(existing) && isPlainObject(incoming)) {
      const nested: PlainObject = {};
      mergeInto(nested, existing);
      mergeInto(nested, incoming);
      target[key] = nested;
    } else if (isPlainObject(incoming)) {
      const nested: PlainObject = {};
      mergeInto(nested, incoming);
      target[key] = nested;
    } else {
      target[key] = incoming;
    }
  }
}

export function deepMerge<T extends object>(
  base: T,
  override: object | null | undefined
): T {
  const result: PlainObject = {};
  mergeInto(result, base as PlainObject);
  if (override) mergeInto(result, override as PlainObject);
  return result as T;
}
