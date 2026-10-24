import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const SIM_ROOT = resolve(import.meta.dirname, "..");
export const REPO_ROOT = resolve(SIM_ROOT, "..");

// Secrets live only in .env.local. The repo-root file is the shared one; sim/.env.local
// is allowed for running sim/ on its own. Shell variables win over both.
export function loadEnv(): void {
  for (const file of [join(REPO_ROOT, ".env.local"), join(SIM_ROOT, ".env.local")]) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

export const config = {
  jev: {
    endpoint: "https://api.typesafe.ai/v1/systemone",
    // Pinned, never jev-latest: a silent model upgrade would shift the calibration.
    model: "jev-1.13.0",
    // B1 (SPIKE.md): latency is flat to 32 (p50 ~75 ms) and no 429s up to 256 in flight.
    concurrency: 32,
    timeoutMs: 30_000,
    maxAttempts: 5,
    // Billed on input only.
    usdPerMillionInputTokens: 0.042,
  },
  run: {
    seed: 13,
    population: 300,
    roundsPlanned: 5,
    // A tick is one sim day, counted across the whole run (round 0 = ticks 0-2, round 1 =
    // ticks 3-5, ...), so a tick never repeats and draw keys never collide across rounds.
    ticksPerRound: 3,
    reach: 0.8,
  },
  reward: {
    // ShopSim's CPM assumption; swap in a real Meta CPM for cereal if A finds one.
    cpmUsd: 13.88,
  },
  shopper: {
    preferenceSd: 0.08,
    preferenceMin: 0.05,
    preferenceMax: 0.95,
    preferenceEvidence: 2,
    unheldW: 0.5,
    unheldE: 1.0,
    budgetFloorUsd: 15,
    quotesShown: 2,
  },
  render: {
    maxWords: 450,
    maxConcepts: 6,
  },
  paths: {
    fixtures: join(SIM_ROOT, "fixtures", "magicspoon"),
    cacheDb: join(SIM_ROOT, ".cache", "jev-cache.sqlite"),
    lastCall: join(SIM_ROOT, ".cache", "last-jev-call.json"),
    // The worker's SpacetimeDB identity token (git-ignored with the rest of .cache).
    spacetimeIdentity: join(SIM_ROOT, ".cache", "spacetime-identity.json"),
  },
} as const;
