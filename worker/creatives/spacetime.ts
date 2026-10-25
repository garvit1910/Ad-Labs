import { SPACETIMEDB_DB_NAME, SPACETIMEDB_URI } from '@/lib/spacetime/config';

/*
 * SpacetimeDB over its HTTP API, plain fetch like scripts/check-connections.mts
 * and nothing imported from sim/ (A and B share only the database):
 *   POST /v1/identity                       -> { identity, token }
 *   POST /v1/database/<db>/call/<reducer>   body: the reducer's arguments as a JSON array
 *   POST /v1/database/<db>/sql              body: SQL text -> [{ schema, rows }] in SATS-JSON
 * A's upsert reducers take one typed row array, so their body is [[row, …]].
 */

export type SqlRow = Record<string, unknown>;

/** What the creative worker needs from the database; tests pass a fake. */
export interface Stdb {
  sql(query: string): Promise<SqlRow[]>;
  call(reducer: string, args: unknown[]): Promise<void>;
}

export class StdbError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'StdbError';
  }
}

const TIMEOUT_MS = 30_000;

export const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

// SATS-JSON (spacetimedb.com/docs/sats-json): a product is an array in element order or an object
// by field name; a sum is a one-key object keyed by variant index or name. Options are some/none
// sums, and a timestamp is a product of one field, microseconds since the epoch.
type AlgebraicType = Record<string, any>;
type Element = { name?: { some?: string } | null; algebraic_type: AlgebraicType };
const TIMESTAMP_FIELD = '__timestamp_micros_since_unix_epoch__';

function decode(type: AlgebraicType, value: unknown): unknown {
  if ('Product' in type) {
    const elements: Element[] = type.Product.elements ?? [];
    const names = elements.map((element) => element.name?.some ?? '');
    const field = (i: number) => (Array.isArray(value) ? value[i] : (value as SqlRow)[names[i]]);
    if (names.length === 1 && names[0] === TIMESTAMP_FIELD) return new Date(Number(field(0)) / 1000).toISOString();
    return Object.fromEntries(elements.map((element, i) => [names[i], decode(element.algebraic_type, field(i))]));
  }
  if ('Sum' in type) {
    const variants: Element[] = type.Sum.variants ?? [];
    const [key, inner] = Object.entries(value as SqlRow)[0] ?? [];
    const index = /^\d+$/.test(key ?? '') ? Number(key) : variants.findIndex((v) => v.name?.some === key);
    const isOption = variants.length === 2 && variants[0].name?.some === 'some' && variants[1].name?.some === 'none';
    if (isOption) return index === 0 ? decode(variants[0].algebraic_type, inner) : null;
    return { [variants[index]?.name?.some ?? String(index)]: inner };
  }
  if ('Array' in type) return (value as unknown[]).map((item) => decode(type.Array, item));
  return value;
}

/** The /sql response body → plain rows (column name → value; options → value or null; timestamps → ISO). */
export function decodeSqlResults(results: Array<{ schema: AlgebraicType; rows: unknown[] }>): SqlRow[] {
  return results.flatMap(({ schema, rows }) => {
    const product = 'Product' in schema ? schema : { Product: schema };
    return rows.map((row) => decode(product, row) as SqlRow);
  });
}

/** An anonymous identity is enough: every table is public and no reducer checks the sender. */
export async function connectStdb(): Promise<Stdb> {
  const uri = SPACETIMEDB_URI.replace(/\/$/, '');
  const base = `${uri}/v1/database/${SPACETIMEDB_DB_NAME}`;
  const res = await fetch(`${uri}/v1/identity`, { method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new StdbError(`POST /v1/identity: HTTP ${res.status}`, res.status);
  const { token } = (await res.json()) as { token: string };
  const headers = (contentType: string) => ({ 'Content-Type': contentType, Authorization: `Bearer ${token}` });

  return {
    async sql(query) {
      const response = await fetch(`${base}/sql`, {
        method: 'POST',
        headers: headers('text/plain'),
        body: query,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await response.text();
      if (!response.ok) throw new StdbError(`sql: HTTP ${response.status}: ${text.slice(0, 300)}`, response.status);
      return decodeSqlResults(JSON.parse(text));
    },
    async call(reducer, args) {
      const response = await fetch(`${base}/call/${reducer}`, {
        method: 'POST',
        headers: headers('application/json'),
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new StdbError(`${reducer}: HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`, response.status);
      }
    },
  };
}
