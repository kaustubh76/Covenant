// Local bring-up: Anvil, Uniswap's stack and Covenant (script/LocalStack.s.sol), then a seeded launch made with the
// same TypeScript launch code the app runs. Used by `npm run chain`, `npm run demo`, the recorder and the chain tests.

import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Address, formatEther, maxUint256, parseEther } from "viem";
import { covenantVaultAbi, testTokenAbi } from "../../src/chain/abi.generated";
import { type Actor, LOCAL_CHAIN_ID, devKey } from "../../src/chain/accounts";
import { type ChainCtx, createChainCtx } from "../../src/chain/client";
import { type Launch, defaultLaunchSpec, launchAndAdopt, seed } from "../../src/chain/launch";
import { type Manifest, type Network, type Runtime, networkOf, parseManifest } from "../../src/chain/network";
import { PRESETS } from "../../src/chain/terms";
import { advance, snapshot } from "../../src/chain/time";
import { must, send } from "../../src/chain/tx";

export const ROOT = resolve(process.env.COVENANT_ROOT ?? resolve(process.cwd(), ".."));
/** Deployment records live in deployments/<name>.json; the dev chain is "31337", the chain tests use their own name. */
export const DEV = String(LOCAL_CHAIN_ID);
export const manifestPath = (name = DEV) => join(ROOT, "deployments", `${name}.json`);
export const runtimePath = (name = DEV) => join(ROOT, "deployments", `${name}.runtime.json`);

/** Anvil, configured so the demo is deterministic: fixed genesis time, one second per block, no fees. */
export const ANVIL_ARGS = (port: number) => [
  "--port", String(port),
  "--chain-id", String(LOCAL_CHAIN_ID),
  "--accounts", "12",
  "--balance", "1000000",
  "--timestamp", "1800000000",
  "--block-base-fee-per-gas", "0",
  "--gas-price", "0",
  "--disable-min-priority-fee",
];

export interface LocalChainOptions {
  port?: number;
  /** Name of the deployment records, so a test chain never overwrites the dev chain's. */
  name?: string;
  /** Attach to an Anvil already running on the port with a seeded deployment instead of failing. */
  reuse?: boolean;
  log?: (line: string) => void;
}

export interface LocalChain {
  rpcUrl: string;
  net: Network;
  ctx: ChainCtx;
  runtime: Runtime;
  launch: Launch | null;
  /** Kill Anvil if this process started it. */
  stop(): Promise<void>;
  /** Called if Anvil exits on its own. Only set when this process started it. */
  onExit?: (fn: (code: number | null, signal: NodeJS.Signals | null) => void) => void;
}

export async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

export async function alive(url: string): Promise<boolean> {
  try {
    await rpc(url, "eth_chainId");
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(url: string, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await alive(url)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Anvil did not answer on ${url} within ${ms / 1000}s`);
}

export function run(cmd: string, args: string[], cwd: string, logFile: string, env: Record<string, string> = {}): Promise<void> {
  return new Promise((ok, fail) => {
    const out = createWriteStream(logFile, { flags: "a" });
    const p = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    let tail = "";
    const keep = (b: Buffer) => {
      out.write(b);
      tail = (tail + b.toString()).slice(-4000);
    };
    p.stdout.on("data", keep);
    p.stderr.on("data", keep);
    p.on("error", (e) => fail(new Error(`${cmd} could not start: ${e.message}`)));
    p.on("close", (code) => (code === 0 ? ok() : fail(new Error(`${cmd} ${args[0]} exited with ${code}\n${tail}`))));
  });
}

export interface AnvilProcess {
  proc: ChildProcess;
  /** SIGINT (Anvil's own clean shutdown), then SIGKILL if it is still running 5 s later. */
  stop(): Promise<void>;
}

/** Start Anvil with `args`, its output going to `logFile`. Every Anvil this project starts goes through here. */
export function startAnvil(args: string[], logFile: string): AnvilProcess {
  const out = createWriteStream(logFile, { flags: "w" });
  // --silent: Anvil logs every RPC request otherwise, and the app polls the chain every second.
  // --max-persisted-states 0: old block states stay in memory. By default Anvil also writes up to 3,600 of them to
  // ~/.foundry/anvil/tmp and leaves the folder behind even after a clean exit; long sessions filled the disk that way.
  const proc: ChildProcess = spawn("anvil", [...args, "--max-persisted-states", "0", "--silent"], { stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout?.pipe(out);
  proc.stderr?.pipe(out);
  const stop = async () => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = new Promise((r) => proc.once("exit", r));
    proc.kill("SIGINT");
    const force = setTimeout(() => proc.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(force);
  };
  return { proc, stop };
}

export function readNetwork(rpcUrl: string, name = DEV): Network {
  const manifest: Manifest = parseManifest(JSON.parse(readFileSync(manifestPath(name), "utf8")));
  const runtime: Runtime | null = existsSync(runtimePath(name)) ? JSON.parse(readFileSync(runtimePath(name), "utf8")) : null;
  // The chain tests' and the recorder's chains keep their own records, but they are the local network all the same.
  return networkOf("local", rpcUrl, manifest, runtime);
}

/** Tokens and approvals so the market, attacker, LP and holder can trade and deposit from the start. */
async function fundActors(ctx: ChainCtx, launch: Launch): Promise<void> {
  const router = ctx.net.manifest.swapRouter as Address;
  const traders: Actor[] = ["market", "attacker", "lp", "holder", "keeper"];
  for (const who of traders) {
    must(await send(ctx, who, { address: launch.token, abi: testTokenAbi, functionName: "mint", args: [ctx.address(who), parseEther("100000")] }), "mint");
    must(await send(ctx, who, { address: launch.token, abi: testTokenAbi, functionName: "approve", args: [router, maxUint256] }), "approve router");
    must(await send(ctx, who, { address: launch.token, abi: testTokenAbi, functionName: "approve", args: [launch.vault, maxUint256] }), "approve vault");
  }
}

/** The default launch: Standard terms, the suite's auction, the demand-shaped seed, a funded bounty, one hour later. */
async function seedDefaultLaunch(ctx: ChainCtx, log: (s: string) => void): Promise<Launch> {
  const launch = await launchAndAdopt(ctx, defaultLaunchSpec(PRESETS.standard));
  const [before] = await ctx.pub.readContract({ address: launch.vault, abi: covenantVaultAbi, functionName: "support" });
  must(await seed(ctx, launch), "seed");
  const [after, need] = await ctx.pub.readContract({ address: launch.vault, abi: covenantVaultAbi, functionName: "support" });
  const bounty = parseEther("0.1");
  must(await send(ctx, "issuer", { address: launch.vault, abi: covenantVaultAbi, functionName: "fundBounty", args: [bounty], value: bounty }), "fundBounty");
  await fundActors(ctx, launch);
  await advance(ctx, 3600);
  log(`seed: support ${before} → ${after} bps (needs ${need}), bounty pool ${formatEther(bounty)} ETH`);
  return launch;
}

export async function startLocalChain(opts: LocalChainOptions = {}): Promise<LocalChain> {
  const log = opts.log ?? (() => {});
  const port = opts.port ?? Number(process.env.ANVIL_PORT ?? 8545);
  const name = opts.name ?? DEV;
  const rpcUrl = `http://127.0.0.1:${port}`;
  const logDir = join(process.cwd(), ".chain");
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `anvil-${port}.log`);

  if (await alive(rpcUrl)) {
    if (!opts.reuse) throw new Error(`Something is already listening on ${rpcUrl}. Stop it, or pass --reuse to attach to a seeded chain.`);
    const net = readNetwork(rpcUrl, name);
    if (!net.runtime) throw new Error(`${runtimePath(name)} is missing: the running chain was not seeded by this script.`);
    const ctx = createChainCtx(net);
    const code = await ctx.pub.getCode({ address: net.manifest.factory });
    if (!code || code === "0x") throw new Error("The running chain has no Covenant deployment at the recorded addresses.");
    log(`attached to the chain on ${rpcUrl}`);
    return { rpcUrl, net, ctx, runtime: net.runtime, launch: null, stop: async () => {} };
  }

  log(`starting anvil on ${rpcUrl} (log: ${logFile})`);
  const { proc: anvil, stop } = startAnvil(ANVIL_ARGS(port), logFile);
  try {
    await waitFor(rpcUrl, 20_000);
    await rpc(rpcUrl, "anvil_setBlockTimestampInterval", [1]);

    log("deploying Uniswap v4, the launcher, the CCA and Covenant (script/LocalStack.s.sol)");
    mkdirSync(dirname(manifestPath(name)), { recursive: true });
    await run(
      "forge",
      // --slow: one transaction per block. Batched, the 12 deployments landed in 4 to 6 blocks depending on timing, which
      // shifted every later timestamp and made recordings differ from run to run.
      ["script", "script/LocalStack.s.sol", "--rpc-url", rpcUrl, "--broadcast", "--slow", "--private-key", devKey("deployer", LOCAL_CHAIN_ID)],
      ROOT,
      join(logDir, "forge.log"),
      { COVENANT_LOCAL_MANIFEST: manifestPath(name) },
    );

    const net: Network = { ...readNetwork(rpcUrl, name), runtime: null };
    const ctx = createChainCtx(net);
    log("running the default launch: vault → auction → migrate → adopt → seed");
    const launch = await seedDefaultLaunch(ctx, log);

    const runtime: Runtime = {
      rpcUrl,
      baselineSnapshot: await snapshot(ctx),
      defaultVault: launch.vault,
      launches: [{ vault: launch.vault, token: launch.token, symbol: launch.symbol, auction: launch.auction, createdAtBlock: Number(launch.startBlock) - 2 }],
      seededAt: Date.now(),
    };
    writeFileSync(runtimePath(name), JSON.stringify(runtime, null, 2) + "\n");
    net.runtime = runtime;
    let stopping = false;
    const onExit = (fn: (code: number | null, signal: NodeJS.Signals | null) => void) => anvil.once("exit", (code, signal) => !stopping && fn(code, signal));
    const stopOnce = async () => {
      stopping = true;
      await stop();
    };
    return { rpcUrl, net, ctx, runtime, launch, stop: stopOnce, onExit };
  } catch (e) {
    await stop();
    throw e;
  }
}
