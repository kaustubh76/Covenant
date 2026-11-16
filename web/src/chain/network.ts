import type { Address, Hex } from "viem";
import { LOCAL_CHAIN_ID } from "./accounts";

export const BASE_SEPOLIA_CHAIN_ID = 84532;

/** Contract addresses for one chain: `deployments/<records>.json`, written by the deploy script. */
export interface Manifest {
  chainId: number;
  poolManager: Address;
  positionManager: Address;
  lbpStrategy: Address;
  ccaFactory?: Address;
  swapRouter?: Address;
  liquidityRouter?: Address;
  hook: Address;
  vaultOps: Address;
  factory: Address;
  vaultImplementation: Address;
  seedPlanner: Address;
  lens: Address;
  maxTickRate?: number;
  deployer?: Address;
  /** The block the deployment started from: log scans on a public chain begin here. */
  deployedAtBlock?: number;
}

/** One launch: a vault, the token and auction it was created for, and the pool they share. */
export interface LaunchRecord {
  vault: Address;
  token: Address;
  symbol: string;
  auction: Address;
  createdAtBlock: number;
  /** The launcher's liquidity has been adopted: the pool exists and the vault is live. */
  adopted?: boolean;
}

/** Launches a bring-up or launch script left behind: `deployments/<records>.runtime.json`. */
export interface Runtime {
  rpcUrl: string;
  /** Snapshot of the freshly seeded local chain, which Reset reverts to. Local chain only. */
  baselineSnapshot?: Hex;
  defaultVault: Address;
  launches: LaunchRecord[];
  seededAt: number;
}

export interface Capabilities {
  /** Anvil: time travel, snapshots, sandboxes, open-mint demo tokens and dev-key signing. */
  devChain: boolean;
  /** The most blocks one eth_getLogs call may span; public RPCs cap it (Base Sepolia's: 200). Unset: no limit. */
  logRange?: number;
  /** How often to poll for new blocks, in ms. */
  pollMs: number;
  /** Typical time between blocks, in ms, for waits and countdowns. */
  blockTimeMs: number;
  /** Block explorer for transaction and address links, when the chain has a public one. */
  explorer?: string;
}

export type NetworkKey = "local" | "base-sepolia" | "base-sepolia-fork";

/** A chain the app knows how to reach, before anything is read from it. */
export interface NetworkInfo {
  key: NetworkKey;
  chainId: number;
  name: string;
  /** Deployment records under deployments/: `<records>.json` (addresses) and `<records>.runtime.json` (launches). */
  records: string;
  defaultRpc: string;
  caps: Capabilities;
}

const PUBLIC: Omit<Capabilities, "explorer"> = { devChain: false, logRange: 200, pollMs: 2000, blockTimeMs: 2000 };

export const NETWORKS: Record<NetworkKey, NetworkInfo> = {
  local: {
    key: "local",
    chainId: LOCAL_CHAIN_ID,
    name: "Local chain",
    records: String(LOCAL_CHAIN_ID),
    defaultRpc: "http://127.0.0.1:8545",
    caps: { devChain: true, pollMs: 500, blockTimeMs: 1000 },
  },
  "base-sepolia": {
    key: "base-sepolia",
    chainId: BASE_SEPOLIA_CHAIN_ID,
    name: "Base Sepolia",
    records: String(BASE_SEPOLIA_CHAIN_ID),
    defaultRpc: "https://sepolia.base.org",
    caps: { ...PUBLIC, explorer: "https://sepolia.basescan.org" },
  },
  // A local Anvil fork of Base Sepolia, for rehearsing the public-chain path against Uniswap's live contracts. It is
  // treated exactly like the public chain (no dev keys, no time travel); it just has no explorer.
  "base-sepolia-fork": {
    key: "base-sepolia-fork",
    chainId: BASE_SEPOLIA_CHAIN_ID,
    name: "Base Sepolia fork",
    records: `${BASE_SEPOLIA_CHAIN_ID}-fork`,
    defaultRpc: "http://127.0.0.1:8548",
    caps: { ...PUBLIC },
  },
};

export const NETWORK_KEYS = Object.keys(NETWORKS) as NetworkKey[];

export function isNetworkKey(v: unknown): v is NetworkKey {
  return typeof v === "string" && (NETWORK_KEYS as string[]).includes(v);
}

export interface Network {
  key: NetworkKey;
  chainId: number;
  name: string;
  rpcUrl: string;
  manifest: Manifest;
  runtime: Runtime | null;
  caps: Capabilities;
}

/** A network as reached at `rpcUrl`, from its records. */
export function networkOf(key: NetworkKey, rpcUrl: string, manifest: Manifest, runtime: Runtime | null): Network {
  const info = NETWORKS[key];
  if (manifest.chainId !== info.chainId) throw new Error(`${info.name}: the deployment records are for chain ${manifest.chainId}`);
  return { key, chainId: info.chainId, name: info.name, rpcUrl, manifest, runtime, caps: info.caps };
}

const REQUIRED: (keyof Manifest)[] = ["poolManager", "positionManager", "lbpStrategy", "hook", "vaultOps", "factory", "seedPlanner", "lens"];

export function parseManifest(raw: unknown): Manifest {
  const m = raw as Partial<Manifest>;
  if (!m || typeof m !== "object" || typeof m.chainId !== "number") throw new Error("manifest: missing chainId");
  for (const k of REQUIRED) if (typeof m[k] !== "string") throw new Error(`manifest: missing ${k}`);
  return m as Manifest;
}

/** Explorer links, when the network has an explorer. */
export const explorerTx = (net: Pick<Network, "caps">, hash: Hex) => (net.caps.explorer ? `${net.caps.explorer}/tx/${hash}` : undefined);
export const explorerAddress = (net: Pick<Network, "caps">, address: Address) =>
  net.caps.explorer ? `${net.caps.explorer}/address/${address}` : undefined;
