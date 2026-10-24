import { createHash } from "node:crypto";

// Every draw has its own key, hash(seed, stream, shopper, tick, ...), so no draw depends on
// processing order, and changing the population size never changes an existing shopper.
// `tick` in keys is the run-wide sim day (see config.run), never a per-round day number.
export type Stream =
  | "population"
  | "need"
  | "reach"
  | "arm"
  | "variant"
  | "neighbours"
  | "order"
  | "tap"
  | "stay"
  | "buy";

export type KeyPart = string | number;

const TWO_POW_53 = 2 ** 53;
const TWO_POW_26 = 2 ** 26;

// Uniform in [0, 1) from the first 53 bits of sha256 over the key.
export function uniform(seed: number, stream: Stream, ...key: KeyPart[]): number {
  const h = createHash("sha256").update(JSON.stringify([seed, stream, ...key])).digest();
  const hi = h.readUInt32BE(0) >>> 5; // 27 bits
  const lo = h.readUInt32BE(4) >>> 6; // 26 bits
  return (hi * TWO_POW_26 + lo) / TWO_POW_53;
}

export function bernoulli(p: number, seed: number, stream: Stream, ...key: KeyPart[]): boolean {
  return uniform(seed, stream, ...key) < p;
}

// Box-Muller over two keyed uniforms.
export function normal(mean: number, sd: number, seed: number, stream: Stream, ...key: KeyPart[]): number {
  const u1 = Math.max(uniform(seed, stream, ...key, "u1"), Number.MIN_VALUE);
  const u2 = uniform(seed, stream, ...key, "u2");
  return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function weightedIndex(weights: readonly number[], seed: number, stream: Stream, ...key: KeyPart[]): number {
  const total = weights.reduce((s, w) => s + w, 0);
  if (!(total > 0)) throw new Error("weightedIndex needs a positive total weight");
  let r = uniform(seed, stream, ...key) * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]!;
    if (r < 0) return i;
  }
  return weights.length - 1;
}

// k items without replacement, each pick proportional to its weight.
export function weightedSample<T>(
  items: readonly T[],
  weight: (item: T) => number,
  k: number,
  seed: number,
  stream: Stream,
  ...key: KeyPart[]
): T[] {
  const pool = [...items];
  const out: T[] = [];
  for (let i = 0; i < k && pool.length > 0; i++) {
    const idx = weightedIndex(pool.map(weight), seed, stream, ...key, i);
    out.push(pool.splice(idx, 1)[0]!);
  }
  return out;
}

// Fisher-Yates with one keyed draw per step.
export function shuffle<T>(items: readonly T[], seed: number, stream: Stream, ...key: KeyPart[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(uniform(seed, stream, ...key, i) * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
