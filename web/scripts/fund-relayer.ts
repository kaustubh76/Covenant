// npm run relayer:fund -- [--new] [--check]
//
// Tops the backend relayer's account up on Base Sepolia, from the deployer (PRIVATE_KEY in the repository's .env), to
// 0.05 ETH and 50 of each recorded launch's token. Only the shortfall is sent, so running it again is safe. Neither key
// is ever printed; only addresses, amounts and transaction hashes are.
//
// --new    creates the relayer's key if .env has none, and appends it to .env as RELAYER_PRIVATE_KEY. The backend reads
//          the same variable (set it as a secret where the backend runs).
// --check  reads the balances and simulates every transfer, then stops. Nothing is sent and .env is not written.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Address,
  type Hex,
  concat,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatEther,
  formatUnits,
  http,
  keccak256,
  parseEther,
  parseUnits,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { NETWORKS } from "../src/chain/network";
import { ROOT, runtimePath } from "./lib/localchain";

const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const NEW = argv.includes("--new");
const ETH_TARGET = parseEther("0.05");
const TOKEN_TARGET = "50";
const log = (s: string) => console.log(`relayer:fund: ${s}`);
const HEX_KEY = /^(?:0x)?([0-9a-fA-F]{64})$/;

function keyFrom(name: string): Hex | undefined {
  const m = process.env[name]?.trim().match(HEX_KEY);
  return m ? (`0x${m[1].toLowerCase()}` as Hex) : undefined;
}

async function main() {
  const envFile = join(ROOT, ".env");
  if (!existsSync(envFile)) throw new Error(`no .env at ${envFile} (see .env.example)`);
  process.loadEnvFile(envFile);
  const deployerKey = keyFrom("PRIVATE_KEY");
  if (!deployerKey) throw new Error("PRIVATE_KEY in .env must be a 32-byte hex key, with or without 0x");

  let relayerKey = keyFrom("RELAYER_PRIVATE_KEY");
  let created = false;
  if (!relayerKey) {
    if (process.env.RELAYER_PRIVATE_KEY?.trim()) throw new Error("RELAYER_PRIVATE_KEY in .env is not a 32-byte hex key");
    if (!NEW) throw new Error("no RELAYER_PRIVATE_KEY in .env; pass --new to create one");
    relayerKey = generatePrivateKey();
    created = true;
  }
  // The relayer must hold none of the vaults' roles: the backend refuses such a key, and so does this.
  const derived = ["covenant:keeper", "covenant:lp", "covenant:curator", "covenant:issuer", "covenant:attacker"].map((tag) => keccak256(concat([deployerKey, toHex(tag)])));
  if (relayerKey === deployerKey || derived.includes(relayerKey)) {
    throw new Error("RELAYER_PRIVATE_KEY must be its own key, not the deployer's or one derived from it");
  }

  const deployer = privateKeyToAccount(deployerKey);
  const relayer = privateKeyToAccount(relayerKey);
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || NETWORKS["base-sepolia"].defaultRpc;
  const transport = http(rpcUrl, { retryCount: 4, retryDelay: 400 });
  const pub = createPublicClient({ chain: baseSepolia, transport });
  const wallet = createWalletClient({ account: deployer, chain: baseSepolia, transport });

  if ((await pub.getChainId()) !== baseSepolia.id) throw new Error(`${rpcUrl} is not Base Sepolia`);
  const code = await pub.getCode({ address: relayer.address });
  if (code && code !== "0x") throw new Error(`the relayer ${relayer.address} has code (an EIP-7702 delegation?); use a fresh key`);

  const runtime = JSON.parse(readFileSync(runtimePath(NETWORKS["base-sepolia"].records), "utf8")) as {
    launches: { token: Address; symbol: string }[];
  };

  log(`deployer ${deployer.address}`);
  log(`relayer  ${relayer.address}${created ? " (new key)" : ""}`);

  type Step = { what: string; send: () => Promise<Hex>; simulate: () => Promise<unknown> };
  const steps: Step[] = [];

  const [relayerEth, deployerEth] = await Promise.all([
    pub.getBalance({ address: relayer.address }),
    pub.getBalance({ address: deployer.address }),
  ]);
  log(`ETH: relayer ${formatEther(relayerEth)}, deployer ${formatEther(deployerEth)}`);
  if (relayerEth < ETH_TARGET) {
    const value = ETH_TARGET - relayerEth;
    if (deployerEth < value + parseEther("0.005")) throw new Error(`the deployer cannot spare ${formatEther(value)} ETH`);
    steps.push({
      what: `${formatEther(value)} ETH`,
      simulate: () => pub.estimateGas({ account: deployer, to: relayer.address, value }),
      send: () => wallet.sendTransaction({ to: relayer.address, value }),
    });
  }

  for (const { token, symbol } of runtime.launches) {
    const [decimals, has, deployerHas] = await Promise.all([
      pub.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
      pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [relayer.address] }),
      pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [deployer.address] }),
    ]);
    const target = parseUnits(TOKEN_TARGET, decimals);
    log(`${symbol}: relayer ${formatUnits(has, decimals)}, deployer ${formatUnits(deployerHas, decimals)}`);
    if (has >= target) continue;
    const amount = target - has;
    if (deployerHas < amount) throw new Error(`the deployer holds too little ${symbol}`);
    const call = { address: token, abi: erc20Abi, functionName: "transfer", args: [relayer.address, amount] } as const;
    steps.push({
      what: `${formatUnits(amount, decimals)} ${symbol}`,
      simulate: () => pub.simulateContract({ ...call, account: deployer }),
      send: () => wallet.writeContract(call),
    });
  }

  if (!steps.length) {
    log("already funded; nothing to send");
    return;
  }
  for (const s of steps) await s.simulate();
  log(`simulated: ${steps.map((s) => s.what).join(", ")}`);
  if (CHECK) {
    log("--check: nothing sent" + (created ? "; no key was written" : ""));
    return;
  }

  // Write the key before anything is sent to it, so funds never reach an account whose key was not kept.
  if (created) {
    const text = readFileSync(envFile, "utf8");
    const line = `RELAYER_PRIVATE_KEY=${relayerKey}`;
    const blank = /^[ \t]*RELAYER_PRIVATE_KEY[ \t]*=[ \t]*$/m; // the empty slot .env.example carries
    if (blank.test(text)) writeFileSync(envFile, text.replace(blank, line));
    else appendFileSync(envFile, `${text.endsWith("\n") ? "" : "\n"}${line}\n`);
    const back = [...readFileSync(envFile, "utf8").matchAll(/^\s*RELAYER_PRIVATE_KEY\s*=\s*(\S+)\s*$/gm)].map((m) => m[1].toLowerCase());
    if (back.length !== 1 || back[0] !== relayerKey) throw new Error("could not read the new key back from .env; nothing sent");
    log("wrote RELAYER_PRIVATE_KEY to .env");
  }

  for (const s of steps) {
    await s.simulate(); // again, right before sending: an earlier step may have changed the state
    const hash = await s.send();
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`${s.what} reverted: ${hash}`);
    log(`sent ${s.what}: https://sepolia.basescan.org/tx/${hash}`);
  }
  log("done");
}

main().catch((e) => {
  console.error(`relayer:fund: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
