import { SPACETIMEDB_DB_NAME, SPACETIMEDB_URI } from '@/lib/spacetime/config';

/*
 * A's plain-HTTP SpacetimeDB client, shared by the phase scripts (scripts/a4-*),
 * the creative worker (worker/creatives) and A6's agent routes. Plain fetch like
 * scripts/check-connections.mts, with nothing imported from sim/ (A and B share
 * only the database):
 *   POST /v1/identity                       -> { identity, token }
 *   POST /v1/database/<db>/call/<reducer>   body: the reducer's arguments as a JSON array
 *   POST /v1/database/<db>/sql              body: SQL text -> [{ schema, rows }] in SATS-JSON
 * A's upsert reducers take one typed row array, so their body is [[row, …]].
 */

export type SqlRow = Record<string, unknown>;

/** Which database a client talks to. */
export interface SpacetimeTarget {
  uri: string;
  dbName: string;
  isLocal: boolean;
  /** "<uri> / <database> (LOCAL|MAINCLOUD)". */
  label: string;
}

export interface SpacetimeTargetInput {
  uri?: string;
  dbName?: string;
}

/** What A's code needs from the database; tests pass a fake. */
export interface Spacetime {
  /** "<uri> / <database> (LOCAL|MAINCLOUD)", for log lines. */
  readonly label: string;
  /** Set by connectSpacetime; a fake may leave it out. */
  readonly target?: SpacetimeTarget;
  /** Calls a reducer with positional args; a reducer error throws with SpacetimeDB's message. */
  call(reducer: string, args: unknown[]): Promise<void>;
  sql<T = SqlRow>(query: string): Promise<T[]>;
}

export class SpacetimeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SpacetimeError';
  }
}

const TIMEOUT_MS = 60_000;

export const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** B's local test bench runs on localhost; anything else is the shared Maincloud database. */
export function isLocalUri(uri: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(uri).hostname);
  } catch {
    return false;
  }
}

// SATS-JSON (spacetimedb.com/docs/sats-json): a product is an array in element order or an object
// by field name. A sum is [tag, value] over HTTP SQL (the live 2.13 server; B's D79) or a one-key
// object keyed by variant index or name; options are some/none sums. A timestamp is a product of
// one field, microseconds since the epoch.
type AlgebraicType = Record<string, any>;
type Element = { name?: { some?: string } | null; algebraic_type: AlgebraicType };
const TIMESTAMP_FIELD = '__timestamp_micros_since_unix_epoch__';
const elementName = (element: Element | undefined) => element?.name?.some ?? '';

function decode(type: AlgebraicType, value: unknown): unknown {
  if ('Product' in type) {
    const elements: Element[] = type.Product.elements ?? [];
    const field = (i: number) => (Array.isArray(value) ? value[i] : (value as SqlRow)[elementName(elements[i])]);
    if (elements.length === 1 && elementName(elements[0]) === TIMESTAMP_FIELD) {
      return new Date(Number(field(0)) / 1000).toISOString();
    }
    return Object.fromEntries(elements.map((element, i) => [elementName(element), decode(element.algebraic_type, field(i))]));
  }
  if ('Sum' in type) {
    const variants: Element[] = type.Sum.variants ?? [];
    const [key, inner] = Array.isArray(value) ? [String(value[0]), value[1]] : (Object.entries(value as SqlRow)[0] ?? []);
    const index = /^\d+$/.test(key ?? '') ? Number(key) : variants.findIndex((variant) => elementName(variant) === key);
    const variant = variants[index];
    if (variants.length === 2 && elementName(variants[0]) === 'some' && elementName(variants[1]) === 'none') {
      return index === 0 ? decode(variants[0].algebraic_type, inner) : null;
    }
    return { [elementName(variant) || String(index)]: variant ? decode(variant.algebraic_type, inner) : inner };
  }
  if ('Array' in type) return (value as unknown[]).map((item) => decode(type.Array, item));
  return value;
}

/** The /sql response body → plain rows (column → value; options → value or null; timestamps → ISO). */
export function decodeSqlResults(results: Array<{ schema: AlgebraicType; rows: unknown[] }>): SqlRow[] {
  return results.flatMap(({ schema, rows }) => {
    const product = 'Product' in schema ? schema : { Product: schema };
    return rows.map((row) => decode(product, row) as SqlRow);
  });
}

/**
 * The database a client will talk to. An explicit pair wins; give both or neither, so a local uri
 * is never paired with .env.local's shared database name. Otherwise SPACETIMEDB_URI /
 * SPACETIMEDB_DB_NAME (shell over .env.local), then lib/spacetime/config's defaults (Maincloud).
 */
export function resolveSpacetimeTarget(input: SpacetimeTargetInput = {}): SpacetimeTarget {
  const givenUri = input.uri?.trim();
  const givenDb = input.dbName?.trim();
  if (Boolean(givenUri) !== Boolean(givenDb)) throw new Error('give both uri and dbName, or neither');
  const uri = (givenUri || process.env.SPACETIMEDB_URI?.trim() || SPACETIMEDB_URI).replace(/\/$/, '');
  const dbName = givenDb || process.env.SPACETIMEDB_DB_NAME?.trim() || SPACETIMEDB_DB_NAME;
  const isLocal = isLocalUri(uri);
  return { uri, dbName, isLocal, label: `${uri} / ${dbName} (${isLocal ? 'LOCAL' : 'MAINCLOUD'})` };
}

/**
 * Connects with a fresh anonymous identity: every table is public and no reducer
 * checks the sender. With no argument the target comes from the env (resolveSpacetimeTarget).
 */
export async function connectSpacetime(input: SpacetimeTargetInput = {}): Promise<Spacetime> {
  const target = resolveSpacetimeTarget(input);
  const { uri, dbName: database, label } = target;
  const identity = await fetch(`${uri}/v1/identity`, { method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!identity.ok) throw new SpacetimeError(`POST /v1/identity on ${uri}: HTTP ${identity.status}`, identity.status);
  const { token } = (await identity.json()) as { token: string };

  async function post(path: string, body: string, contentType: string, what: string): Promise<string> {
    const res = await fetch(`${uri}/v1/database/${database}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new SpacetimeError(`${what}: HTTP ${res.status}: ${text.slice(0, 600)}`, res.status);
    return text;
  }

  return {
    label,
    target,
    async call(reducer, args) {
      await post(`call/${reducer}`, JSON.stringify(args), 'application/json', reducer);
    },
    async sql<T>(query: string) {
      return decodeSqlResults(JSON.parse(await post('sql', query, 'text/plain', 'sql'))) as T[];
    },
  };
}
