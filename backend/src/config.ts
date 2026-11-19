// The backend's settings, from the environment. Every value has a default that works on a laptop.

import { resolve } from "node:path";

const int = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
};
const num = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
/** A private key from the environment, with or without 0x; anything else is no key. */
const keyOf = (raw: string | undefined): `0x${string}` | null => {
  const k = raw?.trim().replace(/^0x/i, "");
  return k && /^[0-9a-fA-F]{64}$/.test(k) ? (`0x${k}` as `0x${string}`) : null;
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
  /** Base Sepolia's RPC for the shared reader. May carry an API key: never logged, never sent to a browser. */
  baseSepoliaRpc: string;
  /** Upstream calls a second the reader makes, for every visitor together. */
  readRate: number;
  /** How long a read may queue for its turn before the caller is told to go direct. */
  readMaxWaitMs: number;
  /** The relayer's own key (never the deployer's), or null: then the relayer is off. A Render secret; never logged. */
  relayerKey: `0x${string}` | null;
  /** ETH the relayer may spend a day, gas and drips together. */
  relayDailyEth: number;
  dripEth: number;
  dripTokens: number;
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
    baseSepoliaRpc: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
    readRate: int("READ_RATE", 15),
    readMaxWaitMs: int("READ_MAX_WAIT_MS", 4_000),
    relayerKey: keyOf(process.env.RELAYER_PRIVATE_KEY),
    relayDailyEth: num("RELAY_DAILY_ETH", 0.02),
    dripEth: num("RELAY_DRIP_ETH", 0.002),
    dripTokens: num("RELAY_DRIP_TOKENS", 2),
  };
}
