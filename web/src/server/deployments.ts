// Server-side access to the deployment records the local bring-up writes (deployments/<chainId>.json and
// deployments/<chainId>.runtime.json at the repository root). Used only by API routes.

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LOCAL_CHAIN_ID } from "@/chain/accounts";
import { type Network, type Runtime, networkOf, parseManifest } from "@/chain/network";

const DIR = resolve(process.env.COVENANT_DEPLOYMENTS_DIR ?? join(process.cwd(), "..", "deployments"));
const DEFAULT_LOCAL_RPC = process.env.COVENANT_LOCAL_RPC ?? "http://127.0.0.1:8545";

export const runtimeFile = (chainId: number) => join(DIR, `${chainId}.runtime.json`);
const manifestFile = (chainId: number) => join(DIR, `${chainId}.json`);

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

export type LocalStatus =
  | { state: "ready"; network: Network }
  | { state: "offline"; reason: string };

/** The local chain, if the bring-up has run and Anvil is answering with that deployment on it. */
export async function localChain(): Promise<LocalStatus> {
  const raw = await readJson<unknown>(manifestFile(LOCAL_CHAIN_ID));
  if (!raw) return { state: "offline", reason: "No local deployment yet. Start the chain with make demo (or npm run chain in web/)." };
  let manifest;
  try {
    manifest = parseManifest(raw);
  } catch (e) {
    return { state: "offline", reason: `deployments/${LOCAL_CHAIN_ID}.json is unreadable: ${(e as Error).message}` };
  }
  const runtime = await readJson<Runtime>(runtimeFile(LOCAL_CHAIN_ID));
  const rpcUrl = runtime?.rpcUrl ?? DEFAULT_LOCAL_RPC;
  try {
    const id = await rpc<string>(rpcUrl, "eth_chainId");
    if (Number(id) !== LOCAL_CHAIN_ID) return { state: "offline", reason: `${rpcUrl} is chain ${Number(id)}, not the local chain.` };
    const code = await rpc<string>(rpcUrl, "eth_getCode", [manifest.factory, "latest"]);
    if (!code || code === "0x") return { state: "offline", reason: "Anvil is running but has no Covenant deployment. Restart it with make demo." };
  } catch {
    return { state: "offline", reason: `The local chain is not answering on ${rpcUrl}. Start it with \`make demo\`.` };
  }
  if (!runtime) return { state: "offline", reason: "The local chain is up but was not seeded. Restart it with make demo." };
  return {
    state: "ready",
    network: networkOf("local", rpcUrl, manifest, runtime),
  };
}

export async function saveRuntime(chainId: number, runtime: Runtime): Promise<void> {
  await writeFile(runtimeFile(chainId), JSON.stringify(runtime, null, 2) + "\n");
}
