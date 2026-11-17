// A Covenant launch on a public chain (Base Sepolia) or a local fork of one, in real blocks, made with the same launch
// code the app runs (src/chain/launch.ts): token → vault → the CCA, created through Uniswap's live LBPStrategy →
// three bids → the auction runs out → checkpoint → migrate → adopt → the SeedPlanner seed → bounty → refunds.
// One account plays every role: issuer, curator, treasury and the bidders.
//
// Each step is recorded in deployments/<records>.launch.json as it lands, and checked against the chain before it
// runs, so a run that stops (a dropped RPC, a closed laptop) carries on where it left off. The finished launch goes
// into deployments/<records>.runtime.json, which the app reads.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Address, type Hex, formatEther, parseEther, zeroAddress } from "viem";
import { ccaAbi, covenantFactoryAbi, covenantLensAbi, covenantVaultAbi, lbpStrategyAbi, positionManagerAbi } from "../../src/chain/abi.generated";
import { type ChainCtx, type ExternalSigner, createChainCtx } from "../../src/chain/client";
import {
  type Launch,
  type OnWait,
  TESTNET_PRICE_SHIFT,
  adopt,
  closeAuction,
  createLaunchVault,
  deployLaunchToken,
  launchPoolKey,
  migrate,
  poolIdOf,
  registerAuction,
  runAuction,
  seed,
  seedParamsFor,
  settleBids,
  testnetBids,
  testnetLaunchSpec,
  vaultSalt,
} from "../../src/chain/launch";
import { type LaunchRecord, NETWORKS, type NetworkKey, type Runtime, explorerAddress, explorerTx, networkOf, parseManifest } from "../../src/chain/network";
import { PRESETS } from "../../src/chain/terms";
import { must, send } from "../../src/chain/tx";
import { ROOT, manifestPath, runtimePath } from "./localchain";

export type PublicNetworkKey = Exclude<NetworkKey, "local">;

export interface PublicLaunchOptions {
  net: PublicNetworkKey;
  /** Deployment records under deployments/: the network's own unless given (the fork test suite keeps its own). */
  records?: string;
  /** The RPC to use; defaults to the network's. Never written to the records (it may carry an API key). */
  rpcUrl?: string;
  signer: ExternalSigner;
  /** Divide the suite's prices and bids by 2^shift: 13 sends about 0.24 ETH of bids, 14 about half that. */
  shift?: number;
  symbol?: string;
  /** Auction length in blocks: 128 by default (26 seconds of Base Sepolia's 200 ms blocks; four minutes on a 2-second fork). */
  durationBlocks?: number;
  /** The keepers' bounty pool the issuer funds after the seed. */
  bounty?: bigint;
  /**
   * The epoch, in seconds: the setup epoch (no deposits until it ends) and Pace's period. The Standard terms' day unless
   * given; the contract's minimum is an hour.
   */
  epochLength?: number;
  /** The progress file's name under deployments/ (<progress>.launch.json): the records' unless given. */
  progress?: string;
  /** Make this launch the runtime's default vault: yes unless false, so a second launch can stand beside the first. */
  makeDefault?: boolean;
  /** Forget a previous run's progress and start a new launch. */
  fresh?: boolean;
  /** Drop the network's earlier launches from the runtime records (a new fork starts from nothing). */
  resetRuntime?: boolean;
  log?: (line: string) => void;
}

interface Progress {
  net: PublicNetworkKey;
  signer: Address;
  spec: { symbol: string; shift: number; durationBlocks: number; epochLength?: number };
  /** The block this launch began from: its events are all at or after it. */
  fromBlock: number;
  token?: Address;
  vault?: Address;
  launch?: { auction: Address; poolId: Hex; startBlock: string; endBlock: string; floorPrice: string; auctionTick: string };
  closed?: boolean;
  lpIds?: string[];
  adopted?: boolean;
  seeded?: boolean;
  bountyFunded?: boolean;
  settled?: { exited: number; claimed: number };
}

export const progressPath = (records: string) => join(ROOT, "deployments", `${records}.launch.json`);

export interface PublicLaunchResult {
  ctx: ChainCtx;
  launch: Launch;
  record: LaunchRecord;
}

export async function runPublicLaunch(o: PublicLaunchOptions): Promise<PublicLaunchResult> {
  const log = o.log ?? (() => {});
  const info = NETWORKS[o.net];
  const records = o.records ?? info.records;
  const rpcUrl = o.rpcUrl ?? info.defaultRpc;
  const mpath = manifestPath(records);
  if (!existsSync(mpath)) {
    throw new Error(`${info.name}: no Covenant deployment recorded at ${mpath}. Deploy first (${o.net === "base-sepolia" ? "make deploy-sepolia" : "make fork"}).`);
  }
  const manifest = parseManifest(JSON.parse(readFileSync(mpath, "utf8")));
  const ctx = createChainCtx(networkOf(o.net, rpcUrl, manifest, null), o.signer);
  const net = ctx.net;
  const me = ctx.signer as Address;
  const chainId = await ctx.pub.getChainId();
  if (chainId !== info.chainId) throw new Error(`the RPC answers as chain ${chainId}, not ${info.name} (${info.chainId})`);
  const factoryCode = await ctx.pub.getCode({ address: manifest.factory });
  if (!factoryCode || factoryCode === "0x") throw new Error(`${info.name}: no Covenant factory at ${manifest.factory}`);
  // The signer is the treasury, so the raise is paid to it. An account with code runs that code on every payment: on
  // public testnets the well-known dev keys carry EIP-7702 delegations to sweepers that forward the whole balance.
  const signerCode = await ctx.pub.getCode({ address: me });
  if (signerCode && signerCode !== "0x") {
    const delegate = signerCode.toLowerCase().startsWith("0xef0100") ? `0x${signerCode.slice(8, 48)}` : null;
    throw new Error(
      delegate
        ? `${me} delegates its code to ${delegate} (EIP-7702): the raise paid to it would run that code. Use a fresh key.`
        : `${me} is a contract; the launch needs a plain account.`,
    );
  }

  const ppath = progressPath(o.progress ?? records);
  const previous: Progress | null = !o.fresh && existsSync(ppath) ? JSON.parse(readFileSync(ppath, "utf8")) : null;
  if (previous && previous.signer.toLowerCase() !== me.toLowerCase()) {
    throw new Error(`${ppath} is a launch by ${previous.signer}, not ${me}. Pass --fresh to start a new one.`);
  }
  const p: Progress = previous ?? {
    net: o.net,
    signer: me,
    spec: { symbol: o.symbol ?? "CVNT", shift: o.shift ?? TESTNET_PRICE_SHIFT, durationBlocks: o.durationBlocks ?? 128, epochLength: o.epochLength },
    fromBlock: Number(await ctx.pub.getBlockNumber()),
  };
  const save = () => writeFileSync(ppath, JSON.stringify(p, null, 2) + "\n");
  if (previous) log(`resuming the launch in ${ppath}`);
  save();

  const terms = { ...PRESETS.standard, epochLength: p.spec.epochLength ?? PRESETS.standard.epochLength };
  const spec = testnetLaunchSpec(terms, { name: `${p.spec.symbol} Launch`, symbol: p.spec.symbol, durationBlocks: p.spec.durationBlocks }, p.spec.shift);
  const bids = testnetBids(p.spec.shift);
  const bounty = o.bounty ?? parseEther("0.005");
  const link = (h?: Hex) => (h ? (explorerTx(net, h) ?? h) : "");
  let lastWaitLog = 0;
  const onWait: OnWait = (now, target) => {
    if (Date.now() - lastWaitLog < 15_000) return;
    lastWaitLog = Date.now();
    log(`  waiting for block ${target} (now ${now}, about ${Math.ceil((Number(target - now) * net.caps.blockTimeMs) / 1000)}s)`);
  };

  // What this run still has to pay for, so a short balance fails now rather than halfway through the auction.
  const mine = (await countBids(ctx, p, me)) ?? 0;
  const owed = bids.slice(mine).reduce((t, b) => t + b.amount, 0n) + (p.bountyFunded ? 0n : bounty);
  const balance = await ctx.pub.getBalance({ address: me });
  const gas = parseEther("0.003");
  log(`signer ${me}: ${formatEther(balance)} ETH (this run sends ${formatEther(owed)} ETH, plus gas)`);
  if (balance < owed + gas) {
    throw new Error(`${me} has ${formatEther(balance)} ETH but the launch needs about ${formatEther(owed + gas)}. Fund it, or pass --shift ${p.spec.shift + 1} to halve the bids.`);
  }

  // 1. The token: LaunchToken, its whole supply minted to the issuer.
  if (!p.token) {
    p.token = await deployLaunchToken(ctx, spec);
    save();
  }
  log(`token ${p.spec.symbol} ${p.token}`);

  // 2. The vault. Its address follows from the issuer and the salt, so one a stopped run created is found, not re-made.
  if (!p.vault) {
    const predicted = await ctx.pub.readContract({ address: manifest.factory, abi: covenantFactoryAbi, functionName: "predictVault", args: [me, vaultSalt(spec, p.token)] });
    const exists = await ctx.pub.readContract({ address: manifest.factory, abi: covenantFactoryAbi, functionName: "isVault", args: [predicted] });
    p.vault = exists ? predicted : await createLaunchVault(ctx, spec, p.token);
    save();
  }
  log(`vault ${p.vault}`);

  // 3. The registration: the live LBPStrategy creates the CCA, with the vault as the LP recipient.
  let launch: Launch;
  if (!p.launch) {
    const poolId = poolIdOf(launchPoolKey(ctx, spec, p.token));
    const registered = await ctx.pub.readContract({ address: manifest.lbpStrategy, abi: lbpStrategyAbi, functionName: "registeredPoolIds", args: [poolId] });
    launch = registered === zeroAddress ? await registerAuction(ctx, spec, p.token, p.vault) : await launchOf(ctx, spec, p.token, p.vault, registered);
    p.launch = {
      auction: launch.auction,
      poolId: launch.poolId,
      startBlock: String(launch.startBlock),
      endBlock: String(launch.endBlock),
      floorPrice: String(launch.floorPrice),
      auctionTick: String(launch.auctionTick),
    };
    save();
  } else {
    launch = {
      vault: p.vault,
      token: p.token,
      symbol: p.spec.symbol,
      auction: p.launch.auction,
      key: launchPoolKey(ctx, spec, p.token),
      poolId: p.launch.poolId,
      startBlock: BigInt(p.launch.startBlock),
      endBlock: BigInt(p.launch.endBlock),
      floorPrice: BigInt(p.launch.floorPrice),
      auctionTick: BigInt(p.launch.auctionTick),
    };
  }
  log(`auction ${launch.auction}: blocks ${launch.startBlock} to ${launch.endBlock}`);

  // 4. The bids, in order, from the auction's first block.
  const placed = (await countBids(ctx, p, me)) ?? 0;
  if (placed < bids.length) {
    await runAuction(ctx, launch, bids.slice(placed), onWait);
    log(`bids placed: ${bids.map((b) => `${formatEther(b.amount)} ETH at +${b.steps}/64`).join(", ")}`);
  }

  // 5. The auction runs out, and the last block is checkpointed so the clearing price is final.
  if (!p.closed) {
    log(`the auction runs until block ${launch.endBlock}`);
    await closeAuction(ctx, launch, "deployer", onWait);
    p.closed = true;
    save();
  }

  // 6. Migration (the strategy initializes the pool through the hook and mints the LP to the vault), then adoption.
  const adoptedAt = await ctx.pub.readContract({ address: p.vault, abi: covenantVaultAbi, functionName: "adoptedAt" });
  if (adoptedAt === 0n) {
    if (!p.lpIds) {
      const stillRegistered = await ctx.pub.readContract({ address: manifest.lbpStrategy, abi: lbpStrategyAbi, functionName: "registeredPoolIds", args: [launch.poolId] });
      // A migration whose ids were never saved has cleared the registration; find what it minted from its logs.
      launch.lpIds = stillRegistered === zeroAddress ? await positionsMintedSince(ctx, p.vault, launch.endBlock) : await migrate(ctx, launch, "deployer", onWait);
      p.lpIds = launch.lpIds.map(String);
      save();
    } else {
      launch.lpIds = p.lpIds.map(BigInt);
    }
    must(await adopt(ctx, launch), "adopt");
  }
  p.adopted = true;
  save();
  log(`migrated and adopted: positions ${p.lpIds?.join(", ") ?? "(adopted earlier)"}`);

  // 7. The seed: the curator's first reshape, shaped by the auction's own demand.
  const lens = () => ctx.pub.readContract({ address: manifest.lens, abi: covenantLensAbi, functionName: "snapshot", args: [p.vault as Address] });
  if (!p.seeded) {
    const before = await lens();
    // One full-range position is what adoption leaves; any more means a stopped run's seed already landed.
    if (before.ranges.length <= 1) {
      must(await seed(ctx, launch, "curator", seedParamsFor(spec.terms)), "seed");
    }
    const after = await lens();
    log(`seed: support ${before.supportBps} → ${after.supportBps} bps (needs ${after.terms.supportBps}), ${after.ranges.length} ranges`);
    p.seeded = true;
    save();
  }

  // 8. The keepers' bounty.
  if (!p.bountyFunded) {
    const o2 = must(await send(ctx, "issuer", { address: p.vault, abi: covenantVaultAbi, functionName: "fundBounty", args: [bounty], value: bounty }), "fundBounty");
    log(`bounty pool funded with ${formatEther(bounty)} ETH ${link(o2.hash)}`);
    p.bountyFunded = true;
    save();
  }

  // 9. Refunds: the outbid bids' ETH comes back, and the bought tokens are claimed once the claim block passes.
  if (!p.settled) {
    p.settled = await settleBids(ctx, launch, "alice", { claim: true, onWait });
    save();
    log(`bids settled: ${p.settled.exited} exited, ${p.settled.claimed} claimed`);
  }

  // 10. The records the app reads.
  const record: LaunchRecord = { vault: p.vault, token: p.token, symbol: p.spec.symbol, auction: launch.auction, createdAtBlock: p.fromBlock, adopted: true };
  const rpath = runtimePath(records);
  if (o.resetRuntime) rmSync(rpath, { force: true });
  const prior: Runtime | null = existsSync(rpath) ? JSON.parse(readFileSync(rpath, "utf8")) : null;
  const runtime: Runtime = {
    rpcUrl: info.defaultRpc,
    defaultVault: o.makeDefault === false && prior?.defaultVault ? prior.defaultVault : p.vault,
    launches: [...(prior?.launches ?? []).filter((l) => l.vault.toLowerCase() !== p.vault?.toLowerCase()), record],
    seededAt: Date.now(),
  };
  writeFileSync(rpath, JSON.stringify(runtime, null, 2) + "\n");

  const s = await lens();
  log("");
  log(`  Network          ${net.name} (${rpcUrl === info.defaultRpc ? rpcUrl : "custom RPC"})`);
  log(`  Vault            ${p.vault}${explorerAddress(net, p.vault) ? `  ${explorerAddress(net, p.vault)}` : ""}`);
  log(`  Token            ${p.token} (${p.spec.symbol})`);
  log(`  Auction          ${launch.auction}`);
  log(`  Support          ${s.supportBps} bps (needs ${s.terms.supportBps})`);
  log(`  Principal        ${Number(formatEther(s.principalQuote)).toFixed(5)} ETH + ${Number(formatEther(s.principalToken)).toFixed(2)} tokens in ${s.ranges.length} ranges`);
  log(`  Signer balance   ${formatEther(await ctx.pub.getBalance({ address: me }))} ETH`);
  log(`  Records          ${rpath}`);
  return { ctx, launch, record };
}

/** How many bids `owner` has in this launch's auction, or null before the auction exists. */
async function countBids(ctx: ChainCtx, p: Progress, owner: Address): Promise<number | null> {
  if (!p.launch) return null;
  const auction = p.launch.auction;
  const next = await ctx.pub.readContract({ address: auction, abi: ccaAbi, functionName: "nextBidId" });
  let n = 0;
  for (let id = 0n; id < next; id++) {
    const b = await ctx.pub.readContract({ address: auction, abi: ccaAbi, functionName: "bids", args: [id] });
    if (b.owner.toLowerCase() === owner.toLowerCase()) n++;
  }
  return n;
}

/** A launch whose registration landed but was never saved: its blocks come from the auction itself. */
async function launchOf(ctx: ChainCtx, spec: Parameters<typeof launchPoolKey>[1] & { symbol: string; floorPrice: bigint; auctionTick: bigint }, token: Address, vault: Address, auction: Address): Promise<Launch> {
  const key = launchPoolKey(ctx, spec, token);
  const [startBlock, endBlock] = await Promise.all([
    ctx.pub.readContract({ address: auction, abi: ccaAbi, functionName: "startBlock" }),
    ctx.pub.readContract({ address: auction, abi: ccaAbi, functionName: "endBlock" }),
  ]);
  return { vault, token, symbol: spec.symbol, auction, key, poolId: poolIdOf(key), startBlock, endBlock, floorPrice: spec.floorPrice, auctionTick: spec.auctionTick };
}

/** Position NFTs minted to `vault` since `fromBlock`, scanned in spans the RPC accepts. */
async function positionsMintedSince(ctx: ChainCtx, vault: Address, fromBlock: bigint): Promise<bigint[]> {
  const span = BigInt(ctx.net.caps.logRange ?? 10_000);
  const latestBlock = await ctx.pub.getBlockNumber();
  const ids: bigint[] = [];
  for (let from = fromBlock; from <= latestBlock; from += span) {
    const to = from + span - 1n < latestBlock ? from + span - 1n : latestBlock;
    const logs = await ctx.pub.getContractEvents({
      address: ctx.net.manifest.positionManager,
      abi: positionManagerAbi,
      eventName: "Transfer",
      args: { from: zeroAddress, to: vault },
      fromBlock: from,
      toBlock: to,
    });
    for (const l of logs) if (l.args.id !== undefined) ids.push(l.args.id);
  }
  if (!ids.length) throw new Error("the migration cleared the registration but no positions reached the vault");
  return ids;
}
