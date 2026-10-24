/**
 * Canonical JSON serialization (RFC 8785-style) — the byte-stable input to
 * the pack fingerprint and the row content hash.
 *
 * Rules:
 * - Object keys sorted by UTF-16 code unit at every level (this IS the
 *   RFC 8785 key order; never `localeCompare`, which is locale-dependent).
 * - Array element order preserved.
 * - Strings/numbers serialized via `JSON.stringify` (minimal escapes, raw
 *   non-ASCII code points, ES shortest-round-trip numbers). `-0` → `"0"`.
 * - NO unicode normalization: NFC and NFD spellings ARE different content
 *   and fingerprint differently — content flows verbatim from the DB.
 * - Throws on anything without a canonical form: NaN/±Infinity, undefined
 *   (anywhere, including object values — callers omit optional fields, they
 *   never set them undefined), bigint, function, symbol, and non-plain
 *   objects (Date/Map/Set/class instances are programmer errors, not `{}`).
 * - Zero whitespace.
 */
export function canonicalJson(value: unknown): string {
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(
          `canonicalJson: non-finite number has no canonical form (${value})`,
        );
      }
      // JSON.stringify(-0) === '0' — accepted normalization.
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'undefined':
      throw new TypeError(
        'canonicalJson: undefined has no canonical form (omit the field instead)',
      );
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new TypeError(`canonicalJson: cannot serialize ${typeof value}`);
    // The object case MUST `return` a value directly, never `break` out to code
    // after the switch. A `case 'object': break;` that fell through to a
    // post-switch body compiled INCORRECTLY under Next's SWC/minifier: the
    // minifier judged the fall-through unreachable (every other case
    // returns/throws) and DROPPED the entire post-switch body, so the compiled
    // function returned `undefined` for every object input. Source + Vitest
    // were correct (they run un-minified), so only the production bundle broke —
    // `rowContentHash`/`fingerprintPack` fed `undefined` into
    // `createHash().update()` and every brand-context ingest + pack fingerprint
    // 500'd in prod (2026-08-13). Keep object handling INSIDE the switch. Only
    // `npm run build` + inspecting `.next` catches this class; unit tests cannot.
    case 'object':
      return canonicalObject(value);
    default:
      throw new TypeError(`canonicalJson: cannot serialize ${typeof value}`);
  }
}

/** `typeof value === 'object'` branch — kept out of the switch so the object
 * path always ends in a `return` (see the SWC drop-the-fallthrough note above). */
function canonicalObject(value: object | null): string {
  if (value === null) return 'null';

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(
      'canonicalJson: only plain objects are serializable (got a class/Date/Map/Set instance)',
    );
  }

  const record = value as Record<string, unknown>;
  // Array.prototype.sort() with no comparator = UTF-16 code-unit order.
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    parts.push(`${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  }
  return `{${parts.join(',')}}`;
}
