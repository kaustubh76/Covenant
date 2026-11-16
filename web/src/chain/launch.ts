// A Covenant launch on Uniswap's real stack, step by step, exactly as the Solidity suite runs it
// (test/base/UniswapStack.sol, test/base/CovenantTestBase.sol):
//   1. the issuer deploys the token and creates the vault, before the auction;
//   2. the launch is registered with LBPStrategy, naming the vault as LP recipient (this creates the CCA);
//   3. bidders bid; 4. the auction closes; 5. anyone migrates; 6. anyone adopts; 7. the curator seeds.

import {
  type Address,
  type Hex,
  encodeAbiParameters,
  encodePacked,
  keccak256,
  parseEther,
  zeroAddress,
  zeroHash,
} from "viem";
import {
  ccaAbi,
  covenantFactoryAbi,
  covenantVaultAbi,
  lbpStrategyAbi,
  positionManagerAbi,
  seedPlannerAbi,
  testTokenAbi,
  testTokenBytecode,
} from "./abi.generated";
import type { Actor } from "./accounts";
import type { ChainCtx } from "./client";
import type { Terms } from "./terms";
import { latest, mineTo } from "./time";
import { must, send } from "./tx";

export const Q96 = 2n ** 96n;
/** CCA prices are quote per token, Q96. The suite's auctions floor at 1.0 and step in 1/64ths. */
export const AUCTION_FLOOR = Q96;
export const AUCTION_TICK = 2n ** 90n;
export const NEVER = 2n ** 256n - 1n;
export const MAX_LIQUIDITY = 2n ** 128n - 1n;

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export interface LaunchSpec {
  name: string;
  symbol: string;
  terms: Terms;
  issuer: Actor;
  curator: Actor;
  treasury: Actor;
  /** Tokens sold in the auction. */
  auctionSupply: bigint;
  /** Tokens reserved for the pool. */
  lpReserve: bigint;
  /** Share of the raise that goes to the pool, in mps (1e7 = 100%). */
  lpRateMps: number;
  fee: number;
  tickSpacing: number;
  /** Auction length in blocks; must divide 1e7 mps evenly over two halves. */
  durationBlocks: number;
  salt: Hex;
}

export interface Launch {
  vault: Address;
  token: Address;
  symbol: string;
  auction: Address;
  key: PoolKey;
  poolId: Hex;
  startBlock: bigint;
  endBlock: bigint;
  /** LP NFTs the launcher minted to the vault, inclusive. Set by `migrate`. */
  lpIds?: bigint[];
}

/** The suite's default launch: 1,000 tokens sold, 100 reserved for the pool, 10% of the raise to the pool. */
export function defaultLaunchSpec(terms: Terms, overrides: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    name: "Covenant Launch",
    symbol: "TOKEN",
    terms,
    issuer: "issuer",
    curator: "curator",
    treasury: "treasury",
    auctionSupply: parseEther("1000"),
    lpReserve: parseEther("100"),
    lpRateMps: 1_000_000,
    fee: 3000,
    tickSpacing: 60,
    durationBlocks: 100,
    salt: zeroHash,
    ...overrides,
  };
}

export function poolIdOf(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

/** Price level `steps` above the floor: 1 + steps/64 quote per token (UniswapStack._price). */
export const auctionPrice = (steps: number) => AUCTION_FLOOR + BigInt(steps) * AUCTION_TICK;

const AUCTION_PARAMETERS = [
  {
    type: "tuple",
    components: [
      { name: "currency", type: "address" },
      { name: "tokensRecipient", type: "address" },
      { name: "fundsRecipient", type: "address" },
      { name: "startBlock", type: "uint64" },
      { name: "endBlock", type: "uint64" },
      { name: "claimBlock", type: "uint64" },
      { name: "tickSpacing", type: "uint256" },
      { name: "validationHook", type: "address" },
      { name: "floorPrice", type: "uint256" },
      { name: "requiredCurrencyRaised", type: "uint128" },
      { name: "auctionStepsData", type: "bytes" },
    ],
  },
] as const;

const MIGRATOR_PARAMETERS = [
  {
    type: "tuple",
    components: [
      { name: "token", type: "address" },
      { name: "currency", type: "address" },
      { name: "migrationBlock", type: "uint64" },
      { name: "reservedTokenAmountForLP", type: "uint128" },
      { name: "recipient", type: "address" },
      { name: "positionRecipient", type: "address" },
      {
        name: "poolParameters",
        type: "tuple",
        components: [
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hook", type: "address" },
        ],
      },
      { name: "positionDefinitions", type: "bytes" },
      { name: "lpAllocationSchedule", type: "bytes" },
    ],
  },
  { type: "bytes" },
] as const;

const POSITION_DEFINITIONS = [
  {
    type: "tuple[]",
    components: [
      { name: "offsetLower", type: "int24" },
      { name: "offsetUpper", type: "int24" },
      { name: "weight", type: "uint24" },
      { name: "overridePositionRecipient", type: "address" },
    ],
  },
] as const;

const ALLOCATION_SCHEDULE = [
  {
    type: "tuple[]",
    components: [
      { name: "lowerThreshold", type: "uint128" },
      { name: "rate", type: "uint24" },
    ],
  },
] as const;

/** Steps 1–2: token, vault, and the launch registered with LBPStrategy (which creates the CCA). */
export async function registerLaunch(ctx: ChainCtx, spec: LaunchSpec): Promise<Launch> {
  const m = ctx.net.manifest;
  if (1e7 % spec.durationBlocks !== 0 || spec.durationBlocks % 2 !== 0) throw new Error("auction length must split 1e7 mps evenly over two halves");
  const issuer = ctx.wallet(spec.issuer);

  const deployHash = await issuer.deployContract({ abi: testTokenAbi, bytecode: testTokenBytecode, args: [spec.name, spec.symbol, 18] });
  const token = (await ctx.pub.waitForTransactionReceipt({ hash: deployHash })).contractAddress;
  if (!token) throw new Error("token deployment failed");

  const total = spec.auctionSupply + spec.lpReserve;
  must(await send(ctx, spec.issuer, { address: token, abi: testTokenAbi, functionName: "mint", args: [ctx.address(spec.issuer), total] }), "mint");

  const key: PoolKey = { currency0: zeroAddress, currency1: token, fee: spec.fee, tickSpacing: spec.tickSpacing, hooks: m.hook };
  const config = {
    quoteIsCurrency0: true,
    terms: spec.terms,
    issuer: ctx.address(spec.issuer),
    treasury: ctx.address(spec.treasury),
    curator: ctx.address(spec.curator),
  };
  // Vault addresses are deterministic per creator and salt, so one issuer's launches each need their own salt. The new
  // token's address makes it unique, and the vault's address is still known before the auction opens.
  const salt = keccak256(encodePacked(["bytes32", "address"], [spec.salt, token]));
  const created = must(
    await send(ctx, spec.issuer, { address: m.factory, abi: covenantFactoryAbi, functionName: "createVault", args: [key, config, salt] }),
    "createVault",
  );
  const vault = created.value as Address;

  must(await send(ctx, spec.issuer, { address: token, abi: testTokenAbi, functionName: "approve", args: [m.lbpStrategy, total] }), "approve");

  // The registration is the next block: the auction starts in the one after it.
  const { number } = await latest(ctx);
  const startBlock = number + 2n;
  const endBlock = startBlock + BigInt(spec.durationBlocks);
  const half = spec.durationBlocks / 2;
  const mps = 1e7 / spec.durationBlocks;
  const auctionParams = encodeAbiParameters(AUCTION_PARAMETERS, [
    {
      currency: zeroAddress,
      tokensRecipient: ctx.address(spec.treasury),
      fundsRecipient: m.lbpStrategy,
      startBlock,
      endBlock,
      claimBlock: endBlock + 10n,
      tickSpacing: AUCTION_TICK,
      validationHook: zeroAddress,
      floorPrice: AUCTION_FLOOR,
      requiredCurrencyRaised: 0n,
      auctionStepsData: encodePacked(["uint24", "uint40", "uint24", "uint40"], [mps, half, mps, half]),
    },
  ]);
  const migratorParams = {
    token,
    currency: zeroAddress,
    migrationBlock: endBlock + 1n,
    reservedTokenAmountForLP: spec.lpReserve,
    recipient: ctx.address(spec.treasury),
    positionRecipient: vault,
    poolParameters: { fee: spec.fee, tickSpacing: spec.tickSpacing, hook: m.hook },
    positionDefinitions: encodeAbiParameters(POSITION_DEFINITIONS, [[]]),
    lpAllocationSchedule: encodeAbiParameters(ALLOCATION_SCHEDULE, [[{ lowerThreshold: 0n, rate: spec.lpRateMps }]]),
  };
  must(
    await send(ctx, spec.issuer, {
      address: m.lbpStrategy,
      abi: lbpStrategyAbi,
      functionName: "initializeDistribution",
      args: [token, total, encodeAbiParameters(MIGRATOR_PARAMETERS, [migratorParams, auctionParams]), zeroHash],
    }),
    "initializeDistribution",
  );

  const poolId = poolIdOf(key);
  const auction = await ctx.pub.readContract({ address: m.lbpStrategy, abi: lbpStrategyAbi, functionName: "registeredPoolIds", args: [poolId] });
  if (auction === zeroAddress) throw new Error("the strategy did not register the auction");
  return { vault, token, symbol: spec.symbol, auction, key, poolId, startBlock, endBlock };
}

/** A bid of `amount` ETH up to `maxPrice` (Q96, on the auction's tick grid). */
export function bid(ctx: ChainCtx, launch: Launch, bidder: Actor, maxPrice: bigint, amount: bigint) {
  return send(ctx, bidder, {
    address: launch.auction,
    abi: ccaAbi,
    functionName: "submitBid",
    args: [maxPrice, amount, ctx.address(bidder), "0x"],
    value: amount,
  });
}

/** The suite's default auction: two losing bids at 1.016 and 1.047, and a winner that clears at about 1.297. */
export async function runDefaultAuction(ctx: ChainCtx, launch: Launch): Promise<void> {
  await mineTo(ctx, launch.startBlock - 1n);
  must(await bid(ctx, launch, "bob", auctionPrice(1), parseEther("300")), "bid 1");
  must(await bid(ctx, launch, "bob", auctionPrice(3), parseEther("300")), "bid 2");
  must(await bid(ctx, launch, "alice", auctionPrice(19), parseEther("1400")), "bid 3");
}

/** Step 4: run to the last block and checkpoint there, so the final clearing price is on-chain. */
export async function closeAuction(ctx: ChainCtx, launch: Launch, by: Actor = "deployer"): Promise<void> {
  await mineTo(ctx, launch.endBlock - 1n);
  must(await send(ctx, by, { address: launch.auction, abi: ccaAbi, functionName: "checkpoint", args: [] }), "checkpoint");
}

/** Step 5: anyone migrates. LBPStrategy initializes the pool through the Covenant hook and mints the LP to the vault. */
export async function migrate(ctx: ChainCtx, launch: Launch, by: Actor = "deployer"): Promise<bigint[]> {
  const m = ctx.net.manifest;
  await mineTo(ctx, launch.endBlock);
  const first = await ctx.pub.readContract({ address: m.positionManager, abi: positionManagerAbi, functionName: "nextTokenId" });
  must(await send(ctx, by, { address: m.lbpStrategy, abi: lbpStrategyAbi, functionName: "migrate", args: [launch.auction] }), "migrate");
  const next = await ctx.pub.readContract({ address: m.positionManager, abi: positionManagerAbi, functionName: "nextTokenId" });
  const ids: bigint[] = [];
  for (let id = first; id < next; id++) ids.push(id);
  if (!ids.length) throw new Error("migration minted no LP positions");
  launch.lpIds = ids;
  return ids;
}

/** Step 6: anyone adopts every launcher NFT into vault-owned positions. */
export function adopt(ctx: ChainCtx, launch: Launch, by: Actor = "deployer") {
  if (!launch.lpIds) throw new Error("migrate first");
  return send(ctx, by, { address: launch.vault, abi: covenantVaultAbi, functionName: "adopt", args: [launch.lpIds] });
}

export interface SeedParams {
  supportShareBps: number;
  coreShareBps: number;
  maxLevels: number;
  levelHalfWidth: number;
}
/** The integration test's seed: half the quote as support, a small core, up to six demand levels. */
export const DEFAULT_SEED: SeedParams = { supportShareBps: 5000, coreShareBps: 300, maxLevels: 6, levelHalfWidth: 2 };

/**
 * Seed parameters for a vault's terms. Standard terms get the integration test's exact parameters; stricter terms put
 * a larger share of the quote in the support leg, so the seed clears the vault's own minimum with room to spare.
 */
export function seedParamsFor(terms: Pick<Terms, "supportBps">): SeedParams {
  if (terms.supportBps <= 4000) return DEFAULT_SEED;
  return { ...DEFAULT_SEED, supportShareBps: Math.min(9000, terms.supportBps + 1500) };
}

/** The demand-shaped Seed: SeedPlanner reads the auction's outbid demand and returns the reshape. */
export async function planSeed(ctx: ChainCtx, launch: Launch, params: SeedParams = DEFAULT_SEED) {
  const [cuts, legs] = await ctx.pub.readContract({
    address: ctx.net.manifest.seedPlanner,
    abi: seedPlannerAbi,
    functionName: "plan",
    args: [launch.vault, launch.auction, params],
  });
  return { cuts, legs };
}

/** Step 7: the curator's first reshape, shaped by the auction's own demand. */
export async function seed(ctx: ChainCtx, launch: Launch, curator: Actor = "curator", params: SeedParams = DEFAULT_SEED) {
  const { cuts, legs } = await planSeed(ctx, launch, params);
  return send(ctx, curator, { address: launch.vault, abi: covenantVaultAbi, functionName: "reshape", args: [cuts, legs, NEVER] });
}

/** Registration through adoption, with the suite's default auction. */
export async function launchAndAdopt(ctx: ChainCtx, spec: LaunchSpec): Promise<Launch> {
  const launch = await registerLaunch(ctx, spec);
  await runDefaultAuction(ctx, launch);
  await closeAuction(ctx, launch);
  await migrate(ctx, launch);
  must(await adopt(ctx, launch), "adopt");
  return launch;
}
