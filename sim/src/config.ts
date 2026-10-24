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
    concurrency: 24,
    timeoutMs: 30_000,
    maxAttempts: 5,
  },
  run: {
    seed: 13,
    population: 300,
    roundsPlanned: 5,
    ticksPerRound: 3,
    reach: 0.8,
  },
  shopper: {
    preferenceSd: 0.08,
    preferenceMin: 0.05,
    preferenceMax: 0.95,
    preferenceEvidence: 2,
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
  },
} as const;
