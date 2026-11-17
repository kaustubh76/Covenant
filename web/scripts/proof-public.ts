// npm run proof -- --net base-sepolia [--check] [--fresh]
// npm run proof -- --rehearse [--fork-block N] [--check]
// npm run proof -- --lp [--net base-sepolia | --rehearse] [--vault 0x…] [--check] [--fresh]
// npm run proof -- --manage [--net base-sepolia | --rehearse] [--vault 0x…] [--check] [--fresh]
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
// --lp                the LP proof instead (scripts/lib/lpproof.ts): an outside LP joins the latest launch in kind, earns
//                     its share of the fees and leaves in kind, recorded in deployments/84532-lp.proof.json. Its key is
//                     derived from yours ("covenant:lp"), or a throwaway one when rehearsing.
// --manage            the management proof instead (scripts/lib/manageproof.ts): on the latest launch, past its setup
//                     epoch, a pump; the curator's chase above the Anchor, refused; an honest re-centre capped at the
//                     ceiling; and moving everything at once, refused by Pace. Recorded in deployments/84532-manage.proof.json.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Address, type Hex, concat, keccak256, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { NETWORKS, parseManifest } from "../src/chain/network";
import { ROOT, alive, manifestPath, rpc, startAnvil, waitFor } from "./lib/localchain";
import { runLpProof } from "./lib/lpproof";
import { runManageProof } from "./lib/manageproof";
import { runProof } from "./lib/proof";

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const RECORDS = NETWORKS["base-sepolia"].records;
const LP = argv.includes("--lp");
const MANAGE = argv.includes("--manage");
const vaultArg = arg("vault") as Address | undefined;
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
    if (MANAGE) {
      await runManageProof({
        net: "base-sepolia-fork",
        records: RECORDS,
        progress: `${RECORDS}-fork-manage-rehearsal`,
        rpcUrl,
        signer: { account: deployer },
        vault: vaultArg,
        warp: true,
        fresh: true,
        check: argv.includes("--check"),
        log,
      });
      return;
    }
    if (LP) {
      await runLpProof({
        net: "base-sepolia-fork",
        records: RECORDS,
        progress: `${RECORDS}-fork-lp-rehearsal`,
        rpcUrl,
        signer: { account: deployer },
        lp: privateKeyToAccount(generatePrivateKey()),
        vault: vaultArg,
        warp: true,
        fresh: true,
        check: argv.includes("--check"),
        log,
      });
      return;
    }
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
  if (MANAGE) {
    await runManageProof({
      net,
      records: RECORDS,
      rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || undefined,
      signer: { account: signer },
      vault: vaultArg,
      recordSpan: true,
      check: argv.includes("--check"),
      fresh: argv.includes("--fresh"),
      log,
    });
    return;
  }
  if (LP) {
    await runLpProof({
      net,
      records: RECORDS,
      rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || undefined,
      signer: { account: signer },
      lp: privateKeyToAccount(keccak256(concat([`0x${key}` as Hex, toHex("covenant:lp")]))),
      vault: vaultArg,
      recordSpan: true,
      check: argv.includes("--check"),
      fresh: argv.includes("--fresh"),
      log,
    });
    return;
  }
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
