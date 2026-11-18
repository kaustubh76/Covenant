// One Playground chain: an Anvil loaded from the seeded state, its clock set where the seed left it.
//
// A dumped state keeps every block, but not Anvil's clock: a fresh Anvil would date its next block from the wall clock,
// which is behind the seed's (the local chain starts at timestamp 1,800,000,000), and the TWAP oracle underflows on a
// block older than its last observation. So each chain sets its clock to its head, one second per block, exactly like
// the local chain (web/scripts/lib/localchain.ts), and takes a baseline snapshot to reset to.

import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";

export const CHAIN_ID = 31337;

export interface AnvilChain {
  port: number;
  url: string;
  /** The snapshot a reset reverts to. Anvil consumes a snapshot when it reverts, so a reset takes a new one. */
  baseline: string;
  /** True once the process has exited, for whatever reason. */
  readonly exited: boolean;
  stop(): Promise<void>;
}

export interface StartOptions {
  bin: string;
  stateFile: string;
  timeoutMs: number;
}

let rpcId = 0;
/** One JSON-RPC call to a chain this backend runs. */
export async function rpc<T>(url: string, method: string, params: unknown[] = [], timeoutMs = 15_000): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message ?? "failed"}`);
  return body.result as T;
}

/** A port nothing is listening on right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => (a && typeof a === "object" ? resolve(a.port) : reject(new Error("no port"))));
    });
  });
}

/** Set the chain's clock to its head block, then one second per block, as the local chain runs. */
export async function prepareClock(url: string): Promise<void> {
  const head = await rpc<{ timestamp: string }>(url, "eth_getBlockByNumber", ["latest", false]);
  await rpc(url, "anvil_setTime", [Number(head.timestamp)]);
  await rpc(url, "anvil_setBlockTimestampInterval", [1]);
}

export async function startChain(o: StartOptions): Promise<AnvilChain> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const proc: ChildProcess = spawn(
    o.bin,
    [
      "--host", "127.0.0.1",
      "--port", String(port),
      "--chain-id", String(CHAIN_ID),
      "--accounts", "12",
      "--balance", "1000000",
      "--block-base-fee-per-gas", "0",
      "--gas-price", "0",
      "--disable-min-priority-fee",
      "--load-state", o.stateFile,
      // Old block states stay in memory; by default Anvil would also write thousands of them to disk.
      "--max-persisted-states", "0",
      "--silent",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let exited = false;
  let stderr = "";
  proc.stderr?.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2_000)));
  const gone = new Promise<void>((resolve) => proc.once("exit", () => ((exited = true), resolve())));

  const stop = async () => {
    if (exited) return;
    proc.kill("SIGTERM");
    const t = setTimeout(() => proc.kill("SIGKILL"), 3_000);
    await gone;
    clearTimeout(t);
  };

  try {
    const deadline = Date.now() + o.timeoutMs;
    for (;;) {
      if (exited) throw new Error(`anvil exited while starting: ${stderr.trim().split("\n").pop() ?? "no output"}`);
      if (Date.now() > deadline) throw new Error(`anvil did not answer within ${o.timeoutMs / 1000}s`);
      const up = await rpc<string>(url, "eth_chainId", [], 2_000).then(
        (id) => Number(id) === CHAIN_ID,
        () => false,
      );
      if (up) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await prepareClock(url);
    const baseline = await rpc<string>(url, "evm_snapshot");
    return {
      port,
      url,
      baseline,
      get exited() {
        return exited;
      },
      stop,
    };
  } catch (e) {
    await stop();
    throw e;
  }
}

/** Put a chain back to its seeded state: revert to the baseline, reset the clock, take a new baseline. */
export async function resetChain(c: AnvilChain): Promise<void> {
  const ok = await rpc<boolean>(c.url, "evm_revert", [c.baseline]);
  if (!ok) throw new Error("the baseline snapshot is gone");
  await prepareClock(c.url);
  c.baseline = await rpc<string>(c.url, "evm_snapshot");
}
