import { requireEnv } from './env.mjs';

/*
 * Plain-HTTP SpacetimeDB client for A's phase scripts: an anonymous identity,
 * reducer calls and SQL reads. Plain fetch like scripts/check-connections.mts,
 * with nothing imported from sim/ (A and B share only the database).
 * A5 writes its own client in parallel; merge the two after both land.
 */

const TIMEOUT_MS = 60_000;

type AlgebraicType = Record<string, unknown>;
interface Element {
  name?: { some?: string } | null;
  algebraic_type: AlgebraicType;
}

const elementName = (element: Element | undefined) => element?.name?.some ?? '';

/**
 * SATS-JSON to plain values: a product is an array in element order, a sum a
 * one-key object keyed by variant index or name. Options become the value or
 * null, timestamps ISO strings. A's tables are all strings, numbers and bools.
 */
function decode(type: AlgebraicType, value: unknown): unknown {
  if ('Product' in type) {
    const elements = (type.Product as { elements?: Element[] }).elements ?? [];
    const field = (i: number) => (Array.isArray(value) ? value[i] : (value as Record<string, unknown>)[elementName(elements[i])]);
    if (elements.length === 1 && elementName(elements[0]) === '__timestamp_micros_since_unix_epoch__') {
      return new Date(Number(field(0)) / 1000).toISOString();
    }
    return Object.fromEntries(elements.map((element, i) => [elementName(element), decode(element.algebraic_type, field(i))]));
  }
  if ('Sum' in type) {
    const variants = (type.Sum as { variants?: Element[] }).variants ?? [];
    const [key, inner] = Object.entries(value as Record<string, unknown>)[0] ?? [];
    const index = /^\d+$/.test(key ?? '') ? Number(key) : variants.findIndex((variant) => elementName(variant) === key);
    const variant = variants[index];
    if (variants.length === 2 && elementName(variants[0]) === 'some' && elementName(variants[1]) === 'none') {
      return index === 0 ? decode(variant!.algebraic_type, inner) : null;
    }
    return { [elementName(variant) || String(index)]: variant ? decode(variant.algebraic_type, inner) : inner };
  }
  if ('Array' in type) return (value as unknown[]).map((item) => decode(type.Array as AlgebraicType, item));
  return value;
}

export interface Spacetime {
  database: string;
  /** Calls a reducer with positional args; a reducer error throws with SpacetimeDB's message. */
  call(reducer: string, args: unknown[]): Promise<void>;
  sql<T = Record<string, unknown>>(query: string): Promise<T[]>;
}

export async function connectSpacetime(): Promise<Spacetime> {
  const uri = requireEnv('SPACETIMEDB_URI').replace(/\/$/, '');
  const database = requireEnv('SPACETIMEDB_DB_NAME');
  const identity = await fetch(`${uri}/v1/identity`, { method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!identity.ok) throw new Error(`SpacetimeDB identity: HTTP ${identity.status}`);
  const { token } = (await identity.json()) as { token: string };

  async function post(path: string, body: string, contentType: string): Promise<string> {
    const res = await fetch(`${uri}/v1/database/${database}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`SpacetimeDB ${path}: HTTP ${res.status}: ${text.slice(0, 600)}`);
    return text;
  }

  return {
    database,
    async call(reducer, args) {
      await post(`call/${reducer}`, JSON.stringify(args), 'application/json');
    },
    async sql<T>(query: string) {
      const results = JSON.parse(await post('sql', query, 'text/plain')) as Array<{ schema: AlgebraicType; rows: unknown[] }>;
      return results.flatMap((result) => {
        const type = 'Product' in result.schema ? result.schema : { Product: result.schema };
        return result.rows.map((row) => decode(type, row) as T);
      });
    },
  };
}
