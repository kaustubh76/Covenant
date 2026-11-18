// npm run playground:seed: the state every Playground chain on the backend starts from.
//
// Seeds a fresh chain exactly as `make demo` does (script/LocalStack.s.sol, then the default launch), prints a fingerprint
// of the vault, and saves Anvil's state to backend/state/playground.json. The chain's records land in
// deployments/playground.json and playground.runtime.json. The backend loads that state into a new Anvil per visitor,
// so every Playground chain starts from the same block, the same clock and the same launch.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Address } from "viem";
import { readVaultView } from "../src/chain/view";
import { ROOT, rpc, startLocalChain } from "./lib/localchain";

const NAME = "playground";
const port = Number(process.env.SEED_PORT ?? 8552);
const out = join(ROOT, "backend", "state", `${NAME}.json`);

async function main() {
  const chain = await startLocalChain({ port, name: NAME, log: (s) => console.log(`seed: ${s}`) });
  try {
    const v = await readVaultView(chain.ctx, chain.runtime.defaultVault as Address);
    console.log(`seed: fingerprint ${JSON.stringify(fingerprint(v))}`);
    const dumped = await rpc<string>(chain.rpcUrl, "anvil_dumpState");
    const raw = Buffer.from(dumped.slice(2), "hex");
    // Anvil gzips the dump it returns over RPC; --load-state reads the plain JSON.
    const json = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, json);
    console.log(`seed: saved ${(json.length / 1e6).toFixed(2)} MB of state at block ${v.extras.block} to ${out}`);
  } finally {
    await chain.stop();
  }
}

/** What must survive a dump and a load: the block and clock, and the vault's rule state and layout. */
export function fingerprint(v: Awaited<ReturnType<typeof readVaultView>>) {
  return { block: Number(v.extras.block), time: v.extras.time, spotTick: v.spotTick, support: v.support.have, ranges: v.ranges.length, shares: String(v.raw.totalShares) };
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
