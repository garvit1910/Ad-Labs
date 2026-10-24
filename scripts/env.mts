import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dirname, "..");

// Secrets live only in .env.local at the repo root. Shell variables win.
export function loadEnv(): void {
  const file = join(REPO_ROOT, ".env.local");
  if (existsSync(file)) process.loadEnvFile(file);
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set in .env.local`);
  return value;
}
