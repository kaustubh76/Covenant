// A local Anvil fork of Base Sepolia: Covenant deployed by the real deploy script (script/Deploy.s.sol) beside Uniswap's
// deployed PoolManager, PositionManager, LBPStrategy and CCA factory, then a launch run through them in real blocks
// (publiclaunch.ts). Behind `npm run fork` and the fork test suite. The fork only reads the live chain; nothing is sent
// to it.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Hex, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { NETWORKS } from "../../src/chain/network";
import { type AnvilProcess, ROOT, alive, manifestPath, rpc, run, startAnvil, waitFor } from "./localchain";
import { type PublicLaunchResult, runPublicLaunch } from "./publiclaunch";

export interface ForkOptions {
  port?: number;
  /** Seconds per block: 2 by default, 1 to rehearse faster. (Base Sepolia's blocks come every 200 ms.) */
  blockTime?: number;
  /** Auction length in blocks (128 by default). */
  durationBlocks?: number;
  /** The launch's epoch in seconds (the Standard terms' day by default; an hour is the contract's minimum). */
  epochLength?: number;
  forkBlock?: number;
  /** Deployment records under deployments/: the dev fork's by default; the test suite keeps its own. */
  records?: string;
  /** The live chain to fork: BASE_SEPOLIA_RPC_URL, or the public endpoint. */
  upstream?: string;
  /** Receives lines prefixed "fork: " and "launch: ". */
  log?: (line: string) => void;
}

export interface Fork {
  rpcUrl: string;
  records: string;
  /** The throwaway key that deployed Covenant and ran the launch. It only ever holds the fork's ETH. */
  key: Hex;
  launch: PublicLaunchResult;
  anvil: AnvilProcess;
  stop(): Promise<void>;
}

export async function startFork(o: ForkOptions = {}): Promise<Fork> {
  const log = o.log ?? (() => {});
  const say = (s: string) => log(`fork: ${s}`);
  const fork = NETWORKS["base-sepolia-fork"];
  const port = o.port ?? Number(new URL(fork.defaultRpc).port);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const records = o.records ?? fork.records;
  const blockTime = o.blockTime ?? 2;
  const upstream = o.upstream ?? (process.env.BASE_SEPOLIA_RPC_URL || NETWORKS["base-sepolia"].defaultRpc);
  if (await alive(rpcUrl)) throw new Error(`something is already listening on ${rpcUrl}; stop it first`);

  const logDir = join(process.cwd(), ".chain");
  mkdirSync(logDir, { recursive: true });
  const anvilLog = join(logDir, `anvil-${port}.log`);
  const args = ["--fork-url", upstream, "--port", String(port), "--block-time", String(blockTime)];
  if (o.forkBlock !== undefined) args.push("--fork-block-number", String(o.forkBlock));
  say(`forking Base Sepolia on ${rpcUrl} (${blockTime}s blocks; log: ${anvilLog})`);
  const anvil = startAnvil(args, anvilLog);
  try {
    await waitFor(rpcUrl, 60_000);
    const id = Number(await rpc<string>(rpcUrl, "eth_chainId"));
    if (id !== fork.chainId) throw new Error(`the fork answers as chain ${id}, not ${fork.chainId}`);

    // A throwaway key, made for this fork and funded on it, signs everything, the way your own key will on Base
    // Sepolia. Never Anvil's well-known accounts here: the fork carries the live chain's state, and on Base Sepolia
    // those accounts have EIP-7702 delegations to sweepers that forward any balance away the moment ETH arrives.
    const key = generatePrivateKey();
    const deployer = privateKeyToAccount(key);
    await rpc(rpcUrl, "anvil_setBalance", [deployer.address, toHex(parseEther("100"))]);
    say(`deploying Covenant with the real deploy script (script/Deploy.s.sol), as ${deployer.address}`);
    await run(
      "forge",
      ["script", "script/Deploy.s.sol", "--rpc-url", rpcUrl, "--broadcast", "--slow", "--private-key", key],
      ROOT,
      join(logDir, `forge-fork-${port}.log`),
      // The fork answers as chain 84532, like Base Sepolia, so its broadcast log goes to a folder of its own. In the
      // default one it would replace the real deployment's run-latest.json.
      { COVENANT_MANIFEST: manifestPath(records), FOUNDRY_BROADCAST: join(ROOT, "broadcast", "fork") },
    );
    say(`deployed: ${manifestPath(records)}`);

    // A new fork has none of the last one's state: a fresh launch, and none of the old fork's launches.
    const launch = await runPublicLaunch({
      net: "base-sepolia-fork",
      records,
      rpcUrl,
      signer: { account: deployer },
      durationBlocks: o.durationBlocks,
      epochLength: o.epochLength,
      fresh: true,
      resetRuntime: true,
      log: (s) => log(`launch: ${s}`),
    });
    return { rpcUrl, records, key, launch, anvil, stop: anvil.stop };
  } catch (e) {
    await anvil.stop();
    throw e;
  }
}
