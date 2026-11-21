// Server-side access to the deployment records under deployments/ at the repository root: `<records>.json` (addresses,
// written by the deploy scripts) and `<records>.runtime.json` (launches, written by the bring-up and launch scripts).
// Used by the API routes, and at build time by the landing page (server/live.ts).

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { NETWORKS, NETWORK_KEYS, type Network, type NetworkKey, type Runtime, isNetworkKey, networkOf, parseManifest } from "@/chain/network";

const DIR = resolve(process.env.COVENANT_DEPLOYMENTS_DIR ?? join(process.cwd(), "..", "deployments"));
const DEFAULT_LOCAL_RPC = process.env.COVENANT_LOCAL_RPC ?? NETWORKS.local.defaultRpc;

export const runtimeFile = (records: string) => join(DIR, `${records}.runtime.json`);
const manifestFile = (records: string) => join(DIR, `${records}.json`);
/** Any file under deployments/, such as a live proof's `<records>.proof.json`. */
export const recordFile = (name: string) => join(DIR, name);

export async function readJson<T>(path: string): Promise<T | null> {
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
 * A hosted copy lists base-sepolia and playground, since nothing it runs on can reach a local chain or fork; the
 * Playground's chains run on Covenant's backend (COVENANT_BACKEND_URL).
 */
export function servedNetworks(): NetworkKey[] {
  const raw = (process.env.COVENANT_NETWORKS ?? "").trim();
  const listed = raw
    .split(",")
    .map((s) => s.trim())
    .filter(isNetworkKey);
  if (raw && !listed.length && !warnedNetworks) {
    // A typo should not quietly change what a hosted copy offers without anyone noticing.
    warnedNetworks = true;
    console.warn(`COVENANT_NETWORKS="${raw}" names no network the app knows (${NETWORK_KEYS.join(", ")}); offering all of them.`);
  }
  if (listed.length) return NETWORK_KEYS.filter((k) => listed.includes(k));
  // Unlisted, every network the app knows; the Playground only once a backend is set for it.
  return NETWORK_KEYS.filter((k) => k !== "playground" || backendUrl() !== null);
}
let warnedNetworks = false;

/** How each network is brought up, for the offline message. */
const HOW: Record<NetworkKey, string> = {
  local: "Start the local chain with make demo (or npm run chain in web/).",
  "base-sepolia": "Deploy with make deploy-sepolia, then launch with make launch-sepolia.",
  "base-sepolia-fork": "Start the rehearsal fork with make fork.",
  playground: "Run Covenant's backend (backend/: npm run dev, or the Render service) and set COVENANT_BACKEND_URL to it.",
};

/** Covenant's backend (backend/), which runs the Playground's chains. Unset, the Playground is not offered. */
export function backendUrl(): string | null {
  const raw = (process.env.COVENANT_BACKEND_URL ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s]+$/.test(raw) ? raw : null;
}

/**
 * The Playground, if this server knows a backend for it. Its chain is the visitor's own, opened by the browser on the
 * backend (chain/playground.ts), so there is nothing to check here beyond the records: the backend may well be asleep
 * (Render's free plan), and the browser waits for it with a message instead of this request waiting a minute.
 */
async function playgroundStatus(): Promise<ChainStatus> {
  const info = NETWORKS.playground;
  const backend = backendUrl();
  if (!backend) return { state: "offline", reason: `The Playground needs Covenant's backend. ${HOW.playground}` };
  const raw = await readJson<unknown>(manifestFile(info.records));
  const runtime = await readJson<Runtime>(runtimeFile(info.records));
  if (!raw || !runtime) return { state: "offline", reason: "The Playground's records are missing (deployments/playground.json). Run npm run playground:seed in web/." };
  let manifest;
  try {
    manifest = parseManifest(raw);
  } catch (e) {
    return { state: "offline", reason: `deployments/playground.json is unreadable: ${(e as Error).message}` };
  }
  // A nudge, not a check: any request wakes a sleeping backend, so it is warmer by the time the browser opens a chain.
  void fetch(`${backend}/healthz`, { cache: "no-store", signal: AbortSignal.timeout(60_000) }).catch(() => undefined);
  return { state: "ready", network: { ...networkOf("playground", `${backend}/rpc/play/`, manifest, runtime), backend } };
}

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
  if (key === "playground") return playgroundStatus();
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
  const network = networkOf(key, rpcUrl, manifest, runtime);
  // Base Sepolia's reads go through the backend's shared cache when there is one (the browser falls back to the public
  // endpoint whenever it does not answer). COVENANT_READ_CACHE=off keeps every read direct.
  const relay = key === "base-sepolia" ? backendUrl() : null;
  const backend = relay && process.env.COVENANT_READ_CACHE !== "off" ? relay : null;
  return { state: "ready", network: { ...network, ...(backend ? { backend } : {}), ...(relay ? { relay } : {}) } };
}

/** The local chain, as the reset route needs it. */
export const localChain = () => chainStatus("local");

/** Every network this server offers, with whether each is reachable right now. */
/** Whether Covenant's backend answers its health check within `ms`: a sleeping one (Render's free plan) takes a minute to wake. */
async function backendAwake(backend: string, ms = 3000): Promise<boolean> {
  try {
    const res = await fetch(`${backend}/healthz`, { cache: "no-store", signal: AbortSignal.timeout(ms) });
    return res.ok && ((await res.json()) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

/**
 * Every served network, with whether it can be used now. A Playground whose backend did not answer its health check is
 * still offered (opening a chain wakes it), with a reason that says it is waking, rather than shown as live.
 */
export async function allStatuses(): Promise<{ key: NetworkKey; name: string; state: ChainStatus["state"]; reason?: string }[]> {
  return Promise.all(
    servedNetworks().map(async (key) => {
      const s = await chainStatus(key);
      if (s.state === "ready" && key === "playground" && s.network.backend && !(await backendAwake(s.network.backend))) {
        return { key, name: NETWORKS[key].name, state: s.state, reason: "Covenant's backend did not answer just now: it sleeps when idle, and opening a chain wakes it in about a minute." };
      }
      return { key, name: NETWORKS[key].name, state: s.state, ...(s.state === "offline" ? { reason: s.reason } : {}) };
    }),
  );
}

export async function saveRuntime(records: string, runtime: Runtime): Promise<void> {
  await writeFile(runtimeFile(records), JSON.stringify(runtime, null, 2) + "\n");
}
