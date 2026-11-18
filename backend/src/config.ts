// The backend's settings, from the environment. Every value has a default that works on a laptop.

import { resolve } from "node:path";

const int = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
};
const list = (name: string, fallback: string[]): string[] => process.env[name]?.split(",").map((s) => s.trim()).filter(Boolean) ?? fallback;

/** The repository root: src/ and dist/ both sit one level under backend/. */
export const ROOT = resolve(process.env.COVENANT_ROOT ?? resolve(import.meta.dirname, "..", ".."));

export interface Config {
  port: number;
  host: string;
  /** Browser origins allowed to call the backend. Requests without an Origin (curl, servers) are always served. */
  origins: string[];
  anvil: string;
  /** The seeded state every Playground chain starts from (web/scripts/playground-seed.ts). */
  stateFile: string;
  /** Where deployments/playground.json and playground.runtime.json live. */
  records: string;
  /** Playground chains running at once, across all visitors. */
  maxChains: number;
  /** Playground chains one address may hold. Opening one more replaces its least recently used. */
  chainsPerIp: number;
  /** A chain nobody has called for this long is stopped. */
  idleMs: number;
  /** When every chain is taken, one idle for this long is handed to a new visitor. */
  evictAfterMs: number;
  startTimeoutMs: number;
  maxBodyBytes: number;
}

export function loadConfig(): Config {
  return {
    port: int("PORT", 8080),
    host: process.env.HOST ?? "0.0.0.0",
    origins: list("ALLOWED_ORIGINS", ["https://covenant-uhi11.vercel.app", "http://localhost:3000", "http://127.0.0.1:3000"]),
    anvil: process.env.ANVIL_BIN ?? "anvil",
    stateFile: resolve(ROOT, process.env.PLAYGROUND_STATE ?? "backend/state/playground.json"),
    records: resolve(ROOT, process.env.RECORDS_DIR ?? "deployments"),
    maxChains: int("MAX_CHAINS", 4),
    chainsPerIp: int("CHAINS_PER_IP", 2),
    idleMs: int("CHAIN_IDLE_MS", 10 * 60_000),
    evictAfterMs: int("CHAIN_EVICT_AFTER_MS", 2 * 60_000),
    startTimeoutMs: int("CHAIN_START_TIMEOUT_MS", 90_000),
    maxBodyBytes: int("MAX_BODY_BYTES", 2_000_000),
  };
}
