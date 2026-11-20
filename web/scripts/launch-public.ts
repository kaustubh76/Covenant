// npm run launch -- --net base-sepolia [--shift 13] [--symbol CVNT] [--blocks 128] [--epoch 86400] [--progress name]
//                   [--timelock s] [--lock s] [--vest s] [--no-default] [--fresh]
// npm run launch -- --net base-sepolia-fork [--rpc http://127.0.0.1:8548]
//
// A real-time testnet launch through Uniswap's deployed LBPStrategy and CCA (see scripts/lib/publiclaunch.ts).
// On Base Sepolia it signs with PRIVATE_KEY from the repository's .env, which it never prints; that account becomes the
// vault's issuer, curator and treasury. About 0.24 ETH of bids go out. The outbid bids' ETH comes back at the end,
// and most of the raise goes to the treasury, so the launch ends up costing about 0.02 ETH plus gas.
// --timelock, --lock and --vest shorten the curator timelock, the principal's lock and its vesting (in seconds) for a
// vault meant to show its governance settling in one sitting (CVQ: 900, 1800, 1800); every other term stays Standard.
// On a fork (from `npm run fork`) it acts as the fork's own deployer through Anvil's impersonation: no key is needed,
// and the real one is never used.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import type { ExternalSigner } from "../src/chain/client";
import { NETWORKS, isNetworkKey, parseManifest } from "../src/chain/network";
import { ROOT, manifestPath, rpc } from "./lib/localchain";
import { runPublicLaunch } from "./lib/publiclaunch";

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));

async function main() {
  const net = arg("net") ?? "base-sepolia";
  if (!isNetworkKey(net) || net === "local") throw new Error("--net must be base-sepolia or base-sepolia-fork (the local chain launches with `npm run chain`)");
  const env = join(ROOT, ".env");
  if (existsSync(env)) process.loadEnvFile(env);

  let signer: ExternalSigner;
  let rpcUrl = arg("rpc");
  if (net === "base-sepolia") {
    // With or without 0x: wallets export keys both ways (MetaMask leaves it off).
    const key = process.env.PRIVATE_KEY?.trim().replace(/^0x/i, "");
    if (!key || !/^[0-9a-fA-F]{64}$/.test(key)) throw new Error("PRIVATE_KEY in .env must be a 32-byte hex key, with or without 0x (see .env.example)");
    signer = { account: privateKeyToAccount(`0x${key}`) };
    rpcUrl ??= process.env.BASE_SEPOLIA_RPC_URL || undefined;
  } else {
    // The fork's deployer is a throwaway key that `npm run fork` made; Anvil signs for it once it is impersonated.
    const records = manifestPath(NETWORKS[net].records);
    if (!existsSync(records)) throw new Error(`no fork deployment at ${records}: run \`npm run fork\` first`);
    const deployer = parseManifest(JSON.parse(readFileSync(records, "utf8"))).deployer;
    if (!deployer) throw new Error(`${records} does not record its deployer`);
    rpcUrl ??= NETWORKS[net].defaultRpc;
    await rpc(rpcUrl, "anvil_impersonateAccount", [deployer]);
    signer = { account: deployer };
  }
  await runPublicLaunch({
    net,
    rpcUrl,
    signer,
    shift: num(arg("shift")),
    symbol: arg("symbol"),
    durationBlocks: num(arg("blocks")),
    epochLength: num(arg("epoch")),
    curatorTimelock: num(arg("timelock")),
    lockDuration: num(arg("lock")),
    vestDuration: num(arg("vest")),
    progress: arg("progress"),
    makeDefault: !argv.includes("--no-default"),
    fresh: argv.includes("--fresh"),
    log: (s) => console.log(`launch: ${s}`),
  });
}

main().catch((e) => {
  console.error(`launch: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
