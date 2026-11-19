// A Covenant launch on Uniswap's real stack, step by step, exactly as the Solidity suite runs it
// (test/base/UniswapStack.sol, test/base/CovenantTestBase.sol):
//   1. the issuer deploys the token and creates the vault, before the auction;
//   2. the launch is registered with LBPStrategy, naming the vault as LP recipient (this creates the CCA);
//   3. bidders bid; 4. the auction closes; 5. anyone migrates; 6. anyone adopts; 7. the curator seeds.
// The same steps run on a public chain, where each one waits for its block instead of mining to it (time.ts `reach`).

import {
  type Address,
  type Hex,
  type TransactionReceipt,
  encodeAbiParameters,
  encodePacked,
  keccak256,
  parseEther,
  parseEventLogs,
  zeroAddress,
  zeroHash,
} from "viem";
import {
  ccaAbi,
  covenantFactoryAbi,
  covenantVaultAbi,
  launchTokenAbi,
  launchTokenBytecode,
  lbpStrategyAbi,
  positionManagerAbi,
  seedPlannerAbi,
  testTokenAbi,
  testTokenBytecode,
} from "./abi.generated";
import type { Actor } from "./accounts";
import type { ChainCtx } from "./client";
import type { Terms } from "./terms";
import { latest, reach } from "./time";
import { type Party, devTxFields, must, receiptFor, send } from "./tx";

export const Q96 = 2n ** 96n;
/** CCA prices are quote per token, Q96. The suite's auctions floor at 1.0 and step in 1/64ths. */
export const AUCTION_FLOOR = Q96;
export const AUCTION_TICK = 2n ** 90n;
export const NEVER = 2n ** 256n - 1n;
export const MAX_LIQUIDITY = 2n ** 128n - 1n;
/**
 * A testnet launch divides every auction price, and every bid, by 2^13: the same auction played with about 0.24 ETH
 * instead of 2,000. The CCA's math scales evenly with price and currency; its floor only has to stay above 2^32 and on
 * the tick grid, which 2^83 and 2^77 are.
 */
export const TESTNET_PRICE_SHIFT = 13;
const NO_CHECKPOINT = 2n ** 64n - 1n;

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/** An auction's price grid: its floor and one step, both Q96 quote per token. */
export interface AuctionGrid {
  floorPrice: bigint;
  auctionTick: bigint;
}

export interface LaunchSpec extends AuctionGrid {
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
  /** Blocks between the registration's block and the auction's first: 1 locally; more where inclusion takes time. */
  startDelay: number;
  /** "test": the open-mint TestToken (local chains). "fixed": LaunchToken, its whole supply minted to the issuer. */
  token: "test" | "fixed";
  salt: Hex;
}

export interface Launch extends AuctionGrid {
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
    floorPrice: AUCTION_FLOOR,
    auctionTick: AUCTION_TICK,
    startDelay: 1,
    token: "test",
    salt: zeroHash,
    ...overrides,
  };
}

/**
 * A wallet's launch on a public chain: the auction must outlast a person approving each bid in their wallet. 1,000
 * blocks is about 3 min 20 s at 200 ms blocks (and splits the auction's 1e7 mps evenly, as registerLaunch requires);
 * 50 blocks, about 10 s, lets the registration settle before the auction opens.
 */
export const WALLET_AUCTION_BLOCKS = 1000;
export const WALLET_START_DELAY = 50;

/**
 * The suite's launch sized for a public testnet: every price divided by 2^shift, a fixed-supply token, 128 blocks of
 * auction (about 26 seconds at Base Sepolia's 200 ms blocks: fine for a script) and ten blocks for the registration to
 * land before the auction opens. A launch a person signs block by block uses WALLET_AUCTION_BLOCKS instead.
 */
export function testnetLaunchSpec(terms: Terms, overrides: Partial<LaunchSpec> = {}, shift = TESTNET_PRICE_SHIFT): LaunchSpec {
  return defaultLaunchSpec(terms, {
    name: "Covenant Testnet Launch",
    symbol: "CVNT",
    floorPrice: AUCTION_FLOOR >> BigInt(shift),
    auctionTick: AUCTION_TICK >> BigInt(shift),
    durationBlocks: 128,
    startDelay: 10,
    token: "fixed",
    ...overrides,
  });
}

export function poolIdOf(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

const SUITE_GRID: AuctionGrid = { floorPrice: AUCTION_FLOOR, auctionTick: AUCTION_TICK };

/** Price level `steps` above the floor of `grid`; the suite's grid is 1 + steps/64 quote per token (UniswapStack._price). */
export const auctionPrice = (steps: number, grid: AuctionGrid = SUITE_GRID) => grid.floorPrice + BigInt(steps) * grid.auctionTick;

/** One bid of a scripted auction. */
export interface BidSpec {
  bidder: Actor;
  steps: number;
  amount: bigint;
}

/** The suite's auction: two bids that get outbid, 1/64 and 3/64 above the floor, and a winner at 19/64. */
export const DEFAULT_BIDS: readonly BidSpec[] = [
  { bidder: "bob", steps: 1, amount: parseEther("300") },
  { bidder: "bob", steps: 3, amount: parseEther("300") },
  { bidder: "alice", steps: 19, amount: parseEther("1400") },
];

/** The suite's auction in a testnet launch's units: each amount divided by 2^shift, like its prices. */
export const testnetBids = (shift = TESTNET_PRICE_SHIFT): BidSpec[] => DEFAULT_BIDS.map((b) => ({ ...b, amount: b.amount >> BigInt(shift) }));

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

/** Step 1a: the token, with the whole launch supply in the issuer's hands. */
export async function deployLaunchToken(ctx: ChainCtx, spec: LaunchSpec): Promise<Address> {
  const issuer = ctx.wallet(spec.issuer);
  const total = spec.auctionSupply + spec.lpReserve;
  const hash =
    spec.token === "fixed"
      ? await issuer.deployContract({ abi: launchTokenAbi, bytecode: launchTokenBytecode, args: [spec.name, spec.symbol, total, ctx.address(spec.issuer)], ...devTxFields(ctx) })
      : await issuer.deployContract({ abi: testTokenAbi, bytecode: testTokenBytecode, args: [spec.name, spec.symbol, 18], ...devTxFields(ctx) });
  const receipt = await receiptFor(ctx, hash);
  const token = receipt.contractAddress;
  if (receipt.status !== "success" || !token) throw new Error("token deployment failed");
  if (spec.token === "test") {
    must(await send(ctx, spec.issuer, { address: token, abi: testTokenAbi, functionName: "mint", args: [ctx.address(spec.issuer), total] }), "mint");
  }
  return token;
}

/** The pool a launch's vault manages: native ETH against the token, through the Covenant hook. */
export const launchPoolKey = (ctx: ChainCtx, spec: Pick<LaunchSpec, "fee" | "tickSpacing">, token: Address): PoolKey => ({
  currency0: zeroAddress,
  currency1: token,
  fee: spec.fee,
  tickSpacing: spec.tickSpacing,
  hooks: ctx.net.manifest.hook,
});

// Vault addresses are deterministic per creator and salt, so one issuer's launches each need their own salt. The new
// token's address makes it unique, and the vault's address is still known before the auction opens.
export const vaultSalt = (spec: Pick<LaunchSpec, "salt">, token: Address) => keccak256(encodePacked(["bytes32", "address"], [spec.salt, token]));

/** Step 1b: the vault, created before the auction so the launch can name it as the LP recipient. */
export async function createLaunchVault(ctx: ChainCtx, spec: LaunchSpec, token: Address): Promise<Address> {
  const config = {
    quoteIsCurrency0: true,
    terms: spec.terms,
    issuer: ctx.address(spec.issuer),
    treasury: ctx.address(spec.treasury),
    curator: ctx.address(spec.curator),
  };
  const created = must(
    await send(ctx, spec.issuer, {
      address: ctx.net.manifest.factory,
      abi: covenantFactoryAbi,
      functionName: "createVault",
      args: [launchPoolKey(ctx, spec, token), config, vaultSalt(spec, token)],
    }),
    "createVault",
  );
  return created.value as Address;
}

/** Step 2: the launch registered with LBPStrategy, naming the vault as LP recipient. This creates the CCA. */
export async function registerAuction(ctx: ChainCtx, spec: LaunchSpec, token: Address, vault: Address): Promise<Launch> {
  const m = ctx.net.manifest;
  if (1e7 % spec.durationBlocks !== 0 || spec.durationBlocks % 2 !== 0) throw new Error("auction length must split 1e7 mps evenly over two halves");
  const total = spec.auctionSupply + spec.lpReserve;
  must(await send(ctx, spec.issuer, { address: token, abi: testTokenAbi, functionName: "approve", args: [m.lbpStrategy, total] }), "approve");

  // The registration lands in the next block; the auction opens `startDelay` blocks after that.
  const { number } = await latest(ctx);
  const startBlock = number + 1n + BigInt(spec.startDelay);
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
      tickSpacing: spec.auctionTick,
      validationHook: zeroAddress,
      floorPrice: spec.floorPrice,
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

  const key = launchPoolKey(ctx, spec, token);
  const poolId = poolIdOf(key);
  const auction = await ctx.pub.readContract({ address: m.lbpStrategy, abi: lbpStrategyAbi, functionName: "registeredPoolIds", args: [poolId] });
  if (auction === zeroAddress) throw new Error("the strategy did not register the auction");
  return { vault, token, symbol: spec.symbol, auction, key, poolId, startBlock, endBlock, floorPrice: spec.floorPrice, auctionTick: spec.auctionTick };
}

/** Steps 1–2: token, vault, and the launch registered with LBPStrategy (which creates the CCA). */
export async function registerLaunch(ctx: ChainCtx, spec: LaunchSpec): Promise<Launch> {
  const token = await deployLaunchToken(ctx, spec);
  const vault = await createLaunchVault(ctx, spec, token);
  return registerAuction(ctx, spec, token, vault);
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

/** Called while a public chain is waited on: the latest block, and the one the next step needs. */
export type OnWait = (latest: bigint, target: bigint) => void;

/** Step 3: the scripted bids, from the auction's first block and in order (a lower bid after the winner reverts). */
export async function runAuction(ctx: ChainCtx, launch: Launch, bids: readonly BidSpec[] = DEFAULT_BIDS, onWait?: OnWait): Promise<void> {
  await reach(ctx, launch.startBlock, onWait);
  for (const [i, b] of bids.entries()) must(await bid(ctx, launch, b.bidder, auctionPrice(b.steps, launch), b.amount), `bid ${i + 1}`);
}

/** The suite's default auction: two losing bids at 1.016 and 1.047, and a winner that clears at about 1.297. */
export const runDefaultAuction = (ctx: ChainCtx, launch: Launch) => runAuction(ctx, launch, DEFAULT_BIDS);

/** Step 4: run to the last block and checkpoint there, so the final clearing price is on-chain. */
export async function closeAuction(ctx: ChainCtx, launch: Launch, by: Actor = "deployer", onWait?: OnWait): Promise<void> {
  await reach(ctx, launch.endBlock, onWait);
  must(await send(ctx, by, { address: launch.auction, abi: ccaAbi, functionName: "checkpoint", args: [] }), "checkpoint");
}

/** What the auction sold. Final once its last block is checkpointed; the treasury may then sweep the rest, once. */
export interface Sale {
  /** The last block is checkpointed: `sold` and `unsold` no longer move. */
  closed: boolean;
  sold: bigint;
  /** What the sweep sends (`remainingSupply`). A sweep does not lower it, so `swept` says whether it has happened. */
  unsold: bigint;
  swept: boolean;
  /** The only address the auction lets sweep: the launch's treasury. */
  recipient: Address;
}

/** Below this an auction counts as sold out: a full sale can leave a few wei to rounding. */
export const SWEEP_DUST = 10n ** 12n;

export async function readSale(ctx: ChainCtx, launch: Pick<Launch, "auction" | "endBlock">): Promise<Sale> {
  const at = { address: launch.auction, abi: ccaAbi } as const;
  const [last, sold, unsold, sweptAt, recipient] = await Promise.all([
    ctx.pub.readContract({ ...at, functionName: "lastCheckpointedBlock" }),
    ctx.pub.readContract({ ...at, functionName: "totalCleared" }),
    ctx.pub.readContract({ ...at, functionName: "remainingSupply" }),
    ctx.pub.readContract({ ...at, functionName: "sweepUnsoldTokensBlock" }),
    ctx.pub.readContract({ ...at, functionName: "tokensRecipient" }),
  ]);
  return { closed: last === launch.endBlock, sold, unsold, swept: sweptAt !== 0n, recipient };
}

/**
 * The treasury takes what the auction did not sell. `by` defaults to the address the auction names, so a dev chain's
 * treasury key signs, and on a public chain the wallet that made the launch. The amount comes from the auction's own
 * TokensSwept: LBPStrategy emits an event with the same signature.
 */
export async function sweepUnsold(ctx: ChainCtx, launch: Pick<Launch, "auction">, by?: Party) {
  const party = by ?? (await ctx.pub.readContract({ address: launch.auction, abi: ccaAbi, functionName: "tokensRecipient" }));
  const o = await send(ctx, party, { address: launch.auction, abi: ccaAbi, functionName: "sweepUnsoldTokens", args: [] });
  const event = o.receipt
    ? parseEventLogs({ abi: ccaAbi, eventName: "TokensSwept", logs: o.receipt.logs }).find((l) => l.address.toLowerCase() === launch.auction.toLowerCase())
    : undefined;
  return { ...o, amount: event?.args.tokensAmount };
}

/** The position NFTs a transaction minted to `to`, read from its receipt (on a shared chain others mint in between). */
export function mintedPositions(ctx: ChainCtx, receipt: TransactionReceipt, to: Address): bigint[] {
  const pm = ctx.net.manifest.positionManager.toLowerCase();
  return parseEventLogs({ abi: positionManagerAbi, eventName: "Transfer", logs: receipt.logs })
    .filter((l) => l.address.toLowerCase() === pm && l.args.from === zeroAddress && l.args.to.toLowerCase() === to.toLowerCase())
    .map((l) => l.args.id);
}

/** Step 5: anyone migrates. LBPStrategy initializes the pool through the Covenant hook and mints the LP to the vault. */
export async function migrate(ctx: ChainCtx, launch: Launch, by: Actor = "deployer", onWait?: OnWait): Promise<bigint[]> {
  const m = ctx.net.manifest;
  await reach(ctx, launch.endBlock + 1n, onWait);
  const o = must(await send(ctx, by, { address: m.lbpStrategy, abi: lbpStrategyAbi, functionName: "migrate", args: [launch.auction] }), "migrate");
  const ids = o.receipt ? mintedPositions(ctx, o.receipt, launch.vault) : [];
  if (!ids.length) {
    // The strategy does not revert when it cannot build the pool: it sends the raise and the reserve to the recipient
    // and says why, so a "successful" migration can still have minted nothing.
    const failed = o.receipt ? parseEventLogs({ abi: lbpStrategyAbi, eventName: "MigrationFailed", logs: o.receipt.logs })[0] : undefined;
    throw new Error(failed ? `migration failed inside LBPStrategy (reason ${failed.args.reason}); the funds went to the recipient` : "migration minted no LP positions");
  }
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

/**
 * After the auction: exit every bid `by` owns, which refunds the ETH each did not spend (all of it for a bid that was
 * outbid), then, with `claim`, wait for the claim block and take the tokens they bought. A public launch recovers its
 * outbid ETH this way. The CCA wants checkpoint hints for an outbid bid; they come from walking its checkpoint list.
 */
export async function settleBids(
  ctx: ChainCtx,
  launch: Launch,
  by: Actor,
  opts: { claim?: boolean; onWait?: OnWait } = {},
): Promise<{ exited: number; claimed: number }> {
  const auction = launch.auction;
  const owner = ctx.address(by).toLowerCase();
  const [next, final, last] = await Promise.all([
    ctx.pub.readContract({ address: auction, abi: ccaAbi, functionName: "nextBidId" }),
    ctx.pub.readContract({ address: auction, abi: ccaAbi, functionName: "clearingPrice" }),
    ctx.pub.readContract({ address: auction, abi: ccaAbi, functionName: "lastCheckpointedBlock" }),
  ]);
  const bidOf = (id: bigint) => ctx.pub.readContract({ address: auction, abi: ccaAbi, functionName: "bids", args: [id] });
  const ids: bigint[] = [];
  for (let id = 0n; id < next; id++) if ((await bidOf(id)).owner.toLowerCase() === owner) ids.push(id);

  let exited = 0;
  for (const id of ids) {
    const b = await bidOf(id);
    if (b.exitedBlock !== 0n) continue;
    if (b.maxPrice > final) {
      must(await send(ctx, by, { address: auction, abi: ccaAbi, functionName: "exitBid", args: [id] }), `exit bid ${id}`);
    } else {
      const { lastFullyFilled, outbid } = await exitHints(ctx, auction, b.startBlock, b.maxPrice, final, last);
      must(
        await send(ctx, by, { address: auction, abi: ccaAbi, functionName: "exitPartiallyFilledBid", args: [id, lastFullyFilled, outbid] }),
        `exit bid ${id}`,
      );
    }
    exited++;
  }

  let claimed = 0;
  if (opts.claim) {
    await reach(ctx, await ctx.pub.readContract({ address: auction, abi: ccaAbi, functionName: "claimBlock" }), opts.onWait);
    for (const id of ids) {
      if ((await bidOf(id)).tokensFilled === 0n) continue;
      must(await send(ctx, by, { address: auction, abi: ccaAbi, functionName: "claimTokens", args: [id] }), `claim bid ${id}`);
      claimed++;
    }
  }
  return { exited, claimed };
}

/**
 * The checkpoints `exitPartiallyFilledBid` needs for a bid priced at or below the final clearing price: the last one
 * still priced below the bid (filled in full up to there), and the first priced above it (0 for a bid exactly at the
 * final price, which exits after the end instead).
 */
async function exitHints(ctx: ChainCtx, auction: Address, startBlock: bigint, maxPrice: bigint, final: bigint, last: bigint) {
  const at = (block: bigint) => ctx.pub.readContract({ address: auction, abi: ccaAbi, functionName: "checkpoints", args: [block] });
  let lastFullyFilled = startBlock;
  let c = await at(startBlock);
  while (c.next !== NO_CHECKPOINT && c.next <= last) {
    const n = await at(c.next);
    if (n.clearingPrice >= maxPrice) break;
    lastFullyFilled = c.next;
    c = n;
  }
  if (maxPrice === final) return { lastFullyFilled, outbid: 0n };
  for (let block = c.next; block !== NO_CHECKPOINT && block <= last; ) {
    const n = await at(block);
    if (n.clearingPrice > maxPrice) return { lastFullyFilled, outbid: block };
    block = n.next;
  }
  throw new Error(`no checkpoint outbids the bid at ${maxPrice}`);
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
