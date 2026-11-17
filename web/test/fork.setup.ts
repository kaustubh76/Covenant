import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { startFork } from "../scripts/lib/forkchain";
import { ROOT } from "../scripts/lib/localchain";

// A fork of its own: another port and its own deployment records, so a running `npm run fork` is untouched.
const PORT = Number(process.env.FORK_TEST_PORT ?? 8550);
const RECORDS = "84532-fork-test";

declare module "vitest" {
  export interface ProvidedContext {
    forkRpcUrl: string;
    forkRecords: string;
    forkKey: string;
    /** Why the fork tests are skipped, or empty when they run. */
    forkSkip: string;
  }
}

export default async function setup(project: TestProject) {
  const env = join(ROOT, ".env");
  if (existsSync(env)) process.loadEnvFile(env);
  const upstream = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
  const reachable = await fetch(upstream, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    signal: AbortSignal.timeout(10_000),
  })
    .then((r) => r.ok)
    .catch(() => false);
  if (!reachable) {
    project.provide("forkSkip", `Base Sepolia is not reachable at ${upstream}`);
    project.provide("forkRpcUrl", "");
    project.provide("forkRecords", "");
    project.provide("forkKey", "");
    return;
  }
  // One-second blocks and a 32-block auction: the same steps as the real launch, in about a minute and a half.
  const fork = await startFork({ port: PORT, blockTime: 1, durationBlocks: 32, records: RECORDS, log: (s) => console.log(`fork-test ${s}`) });
  project.provide("forkSkip", "");
  project.provide("forkRpcUrl", fork.rpcUrl);
  project.provide("forkRecords", RECORDS);
  project.provide("forkKey", fork.key);
  return async () => {
    await fork.stop();
  };
}
