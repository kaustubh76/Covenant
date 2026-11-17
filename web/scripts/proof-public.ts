// npm run proof -- --net base-sepolia [--check] [--fresh]
// npm run proof -- --rehearse [--fork-block N] [--check]
//
// The live proof (scripts/lib/proof.ts): Covenant's rules exercised as real transactions against the CVNT vault on
// Base Sepolia, each on record in deployments/84532.proof.json with its receipt. It takes about half an hour, most of it
// waiting while the 30-minute TWAP follows the sell-off (26 minutes on 2026-11-17), and resumes if it stops.
//
// --net base-sepolia  signs with PRIVATE_KEY from the repository's .env, which it never prints. The vault's issuer and
//                     curator are that account. The keeper that restores is a second account whose key is derived from
//                     it (keccak256 of the key and "covenant:keeper"), so its ETH is never stranded.
// --rehearse          the same proof against a fork of Base Sepolia as it is now, with the real vault on it: the
//                     deployer is impersonated, the keeper is a throwaway key, and the TWAP window is jumped over.
//                     Nothing reaches the live chain.
// --check             simulate the whole proof and stop. Nothing is sent and nothing is written.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Hex, concat, keccak256, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { NETWORKS, parseManifest } from "../src/chain/network";
import { ROOT, alive, manifestPath, rpc, startAnvil, waitFor } from "./lib/localchain";
import { runProof } from "./lib/proof";

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const RECORDS = NETWORKS["base-sepolia"].records;
const log = (s: string) => console.log(`proof: ${s}`);

async function rehearse() {
  const fork = NETWORKS["base-sepolia-fork"];
  const port = Number(new URL(fork.defaultRpc).port);
  const rpcUrl = `http://127.0.0.1:${port}`;
  if (await alive(rpcUrl)) throw new Error(`something is already listening on ${rpcUrl}; stop it first`);
  const upstream = process.env.BASE_SEPOLIA_RPC_URL || NETWORKS["base-sepolia"].defaultRpc;
  const logDir = join(process.cwd(), ".chain");
  mkdirSync(logDir, { recursive: true });
  const args = ["--fork-url", upstream, "--port", String(port)];
  if (arg("fork-block")) args.push("--fork-block-number", arg("fork-block") as string);
  log(`forking Base Sepolia on ${rpcUrl}, with the live vault on it`);
  const anvil = startAnvil(args, join(logDir, `anvil-${port}.log`));
  try {
    await waitFor(rpcUrl, 60_000);
    const deployer = parseManifest(JSON.parse(readFileSync(manifestPath(RECORDS), "utf8"))).deployer;
    if (!deployer) throw new Error(`deployments/${RECORDS}.json does not record its deployer`);
    await rpc(rpcUrl, "anvil_impersonateAccount", [deployer]);
    await runProof({
      net: "base-sepolia-fork",
      records: RECORDS,
      progress: `${RECORDS}-fork-rehearsal`,
      rpcUrl,
      signer: { account: deployer },
      keeper: privateKeyToAccount(generatePrivateKey()),
      warp: true,
      fresh: true,
      check: argv.includes("--check"),
      log,
    });
  } finally {
    await anvil.stop();
  }
}

async function live() {
  const net = arg("net") ?? "base-sepolia";
  if (net !== "base-sepolia") throw new Error("--net must be base-sepolia (rehearse on a fork with --rehearse)");
  const env = join(ROOT, ".env");
  if (existsSync(env)) process.loadEnvFile(env);
  // With or without 0x: wallets export keys both ways.
  const key = process.env.PRIVATE_KEY?.trim().replace(/^0x/i, "");
  if (!key || !/^[0-9a-fA-F]{64}$/.test(key)) throw new Error("PRIVATE_KEY in .env must be a 32-byte hex key, with or without 0x (see .env.example)");
  const signer = privateKeyToAccount(`0x${key}`);
  const keeper = privateKeyToAccount(keccak256(concat([`0x${key}` as Hex, toHex("covenant:keeper")])));
  await runProof({
    net,
    records: RECORDS,
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || undefined,
    signer: { account: signer },
    keeper,
    recordSpan: true,
    check: argv.includes("--check"),
    fresh: argv.includes("--fresh"),
    log,
  });
}

(argv.includes("--rehearse") ? rehearse() : live()).catch((e) => {
  console.error(`proof: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
