// Server-side access to the deployment records under deployments/ at the repository root: `<records>.json` (addresses,
// written by the deploy scripts) and `<records>.runtime.json` (launches, written by the bring-up and launch scripts).
// Used only by API routes.

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { NETWORKS, NETWORK_KEYS, type Network, type NetworkKey, type Runtime, isNetworkKey, networkOf, parseManifest } from "@/chain/network";

const DIR = resolve(process.env.COVENANT_DEPLOYMENTS_DIR ?? join(process.cwd(), "..", "deployments"));
const DEFAULT_LOCAL_RPC = process.env.COVENANT_LOCAL_RPC ?? NETWORKS.local.defaultRpc;

export const runtimeFile = (records: string) => join(DIR, `${records}.runtime.json`);
const manifestFile = (records: string) => join(DIR, `${records}.json`);

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function rpc<T>(url: string, method: string, params: unknown[] = [], timeoutMs = 1500): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

export type ChainStatus = { state: "ready"; network: Network } | { state: "offline"; reason: string };

/**
 * The networks this server offers: every one the app knows, or only those COVENANT_NETWORKS lists (comma-separated).
 * A hosted copy lists base-sepolia alone, since nothing it runs on can reach a local chain or fork.
 */
export function servedNetworks(): NetworkKey[] {
  const listed = (process.env.COVENANT_NETWORKS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(isNetworkKey);
  return listed.length ? NETWORK_KEYS.filter((k) => listed.includes(k)) : [...NETWORK_KEYS];
}

/** How each network is brought up, for the offline message. */
const HOW: Record<NetworkKey, string> = {
  local: "Start the local chain with make demo (or npm run chain in web/).",
  "base-sepolia": "Deploy with make deploy-sepolia, then launch with make launch-sepolia.",
  "base-sepolia-fork": "Start the rehearsal fork with make fork.",
};

/**
 * The RPC the browser should use. For Base Sepolia that is the public endpoint unless NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL
 * names another: the server's own BASE_SEPOLIA_RPC_URL may carry an API key and is never handed to the browser.
 */
function browserRpc(key: NetworkKey, runtime: Runtime | null): string {
  if (key === "local") return runtime?.rpcUrl ?? DEFAULT_LOCAL_RPC;
  if (key === "base-sepolia") return process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL || NETWORKS[key].defaultRpc;
  return NETWORKS[key].defaultRpc;
}

/** A network, if its deployment is recorded and its chain answers with that deployment on it; otherwise why not. */
export async function chainStatus(key: NetworkKey): Promise<ChainStatus> {
  const info = NETWORKS[key];
  const raw = await readJson<unknown>(manifestFile(info.records));
  if (!raw) return { state: "offline", reason: `No ${info.name} deployment yet. ${HOW[key]}` };
  let manifest;
  try {
    manifest = parseManifest(raw);
  } catch (e) {
    return { state: "offline", reason: `deployments/${info.records}.json is unreadable: ${(e as Error).message}` };
  }
  const runtime = await readJson<Runtime>(runtimeFile(info.records));
  const rpcUrl = browserRpc(key, runtime);
  // A public RPC is slower to answer than Anvil.
  const timeout = info.caps.devChain ? 1500 : 5000;
  try {
    const id = Number(await rpc<string>(rpcUrl, "eth_chainId", [], timeout));
    if (id !== info.chainId) return { state: "offline", reason: `${rpcUrl} is chain ${id}, not ${info.name}.` };
    const code = await rpc<string>(rpcUrl, "eth_getCode", [manifest.factory, "latest"], timeout);
    if (!code || code === "0x") return { state: "offline", reason: `${info.name} has no Covenant deployment at the recorded addresses. ${HOW[key]}` };
  } catch {
    return { state: "offline", reason: `${info.name} is not answering on ${rpcUrl}. ${HOW[key]}` };
  }
  if (!runtime) return { state: "offline", reason: `${info.name} has a deployment but no launch yet. ${HOW[key]}` };
  return { state: "ready", network: networkOf(key, rpcUrl, manifest, runtime) };
}

/** The local chain, as the reset route needs it. */
export const localChain = () => chainStatus("local");

/** Every network this server offers, with whether each is reachable right now. */
export async function allStatuses(): Promise<{ key: NetworkKey; name: string; state: ChainStatus["state"]; reason?: string }[]> {
  return Promise.all(
    servedNetworks().map(async (key) => {
      const s = await chainStatus(key);
      return { key, name: NETWORKS[key].name, state: s.state, ...(s.state === "offline" ? { reason: s.reason } : {}) };
    }),
  );
}

export async function saveRuntime(records: string, runtime: Runtime): Promise<void> {
  await writeFile(runtimeFile(records), JSON.stringify(runtime, null, 2) + "\n");
}
