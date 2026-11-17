// The vault, as the app shows it: one plain object built from CovenantLens.snapshot plus a few direct reads. Rule state
// (support, guard, pace, lock) comes from the contract; the floats here are for display and charts only.

import { type Address, type ContractFunctionReturnType, type Hex, encodePacked, formatEther, keccak256, pad, zeroAddress } from "viem";
import { covenantLensAbi, covenantVaultAbi, poolManagerAbi, testTokenAbi } from "./abi.generated";
import { type Actor, actorOf } from "./accounts";
import type { ChainCtx } from "./client";
import { type PoolKey, poolIdOf } from "./launch";
import { holdingsAtPrice, rangeToPool, sqrtX96ToFloat, tickAtSqrt, toPrice } from "./price";
import type { Terms } from "./terms";

export type RangeKind = "Core" | "Support" | "Reserve" | "Asks" | "Full range";

export interface RangeView {
  index: number;
  tickLower: number;
  tickUpper: number;
  /** Price ticks: rise with the token's price. */
  priceLower: number;
  priceUpper: number;
  liquidity: bigint;
  /** Liquidity / 1e18, for display maths. */
  L: number;
  /** Held at the spot price. */
  quote: number;
  token: number;
  kind: RangeKind;
}

export interface Holding {
  quote: number;
  token: number;
}

export interface VaultView {
  address: Address;
  chainId: number;
  block: bigint;
  /** Chain time (seconds). */
  time: number;
  key: PoolKey;
  poolId: Hex;
  quoteIs0: boolean;
  quoteSymbol: string;
  token: Address;
  tokenSymbol: string;
  tickSpacing: number;
  feePips: number;
  terms: Terms;
  adopted: boolean;
  // ---- prices, in price ticks
  /** Exact (fractional) spot from the pool's sqrt price. */
  spot: number;
  /** Spot as the contract sees it: the pool's integer tick, as a price tick. */
  spotTick: number;
  twap: number;
  anchor: number;
  /** The highest price the curator may bid at: Anchor + guard. */
  ceiling: number;
  /** Support band [min(Anchor, TWAP) − B, TWAP]. */
  band: [number, number];
  // ---- rules
  guard: { ok: boolean; diff: number; limit: number };
  support: { have: number; need: number; inBand: number; total: number };
  pace: { setup: boolean; setupEndsAt: number; available: number; cap: number };
  lock: { adoptedAt: number; unlockStartsAt: number; fullyVestedAt: number; vested: number; withdrawable: number };
  // ---- holdings
  value: number;
  principal: Holding;
  idle: Holding;
  ranges: RangeView[];
  // ---- ledger
  shares: { total: number; principal: number; outside: number; byActor: Partial<Record<Actor, number>> };
  fees: { pot: Holding; bountyPool: number; curator: Holding; principalOwed: Holding; owed: Partial<Record<Actor, Holding>> };
  people: { issuer: Address; pendingIssuer: Address | null; curator: Address; pendingCurator: Address | null; curatorReadyAt: number; treasury: Address };
  /** Exact integers, for transaction arguments. */
  raw: { totalShares: bigint; principalShares: bigint; principalWithdrawable: bigint; sharesOf: Partial<Record<Actor, bigint>> };
  /** Reads beyond the lens snapshot, kept so a simulated snapshot can be turned into a view (see viewFromSnapshot). */
  extras: Extras;
}

export type LensState = ContractFunctionReturnType<typeof covenantLensAbi, "view", "snapshot">;

interface Extras {
  address: Address;
  chainId: number;
  block: bigint;
  time: number;
  sqrtP: bigint;
  symbol: string;
  curatorFees: readonly [bigint, bigint];
  principalOwed: readonly [bigint, bigint];
  holders: { actor: Actor; shares: bigint; owed: readonly [bigint, bigint] }[];
  treasury: Address;
  pendingIssuer: Address;
}

const POOLS_SLOT = pad("0x06", { size: 32 });
const WAD = 1e18;
const f = (x: bigint) => Number(formatEther(x));

/** Quote held in a price-tick range that sits wholly below the price (RangeMath.quoteBetween). */
function quoteIn(quoteIs0: boolean, L: number, priceLower: number, priceUpper: number): number {
  if (priceUpper <= priceLower) return 0;
  return holdingsAtPrice(quoteIs0, priceUpper + 1e-9, priceLower, priceUpper, L).quote;
}

function kindOf(r: { priceLower: number; priceUpper: number; quote: number; token: number }, band: [number, number], spot: number): RangeKind {
  if (r.priceUpper - r.priceLower > 100_000) return "Full range";
  if (r.priceLower < spot && r.priceUpper > spot) return "Core";
  if (r.priceLower >= spot) return "Asks";
  return r.priceUpper > band[0] && r.priceLower < band[1] ? "Support" : "Reserve";
}

/** Exact sqrt price of a pool, read from PoolManager storage (StateLibrary.getSlot0). */
export async function readSqrtPrice(ctx: ChainCtx, poolId: Hex): Promise<bigint> {
  const slot = keccak256(encodePacked(["bytes32", "bytes32"], [poolId, POOLS_SLOT]));
  const word = await ctx.pub.readContract({ address: ctx.net.manifest.poolManager, abi: poolManagerAbi, functionName: "extsload", args: [slot] });
  return BigInt(word) & ((1n << 160n) - 1n);
}

/**
 * Liquidity of a position as the PoolManager stores it (StateLibrary.getPositionLiquidity). Positions are keyed by
 * owner, bounds and salt, which is why only the vault can touch the vault's.
 */
export async function positionLiquidity(ctx: ChainCtx, poolId: Hex, owner: Address, tickLower: number, tickUpper: number, salt: Hex = pad("0x00", { size: 32 })): Promise<bigint> {
  const positionId = keccak256(encodePacked(["address", "int24", "int24", "bytes32"], [owner, tickLower, tickUpper, salt]));
  const stateSlot = keccak256(encodePacked(["bytes32", "bytes32"], [poolId, POOLS_SLOT]));
  const mapping = pad(`0x${(BigInt(stateSlot) + 6n).toString(16)}`, { size: 32 });
  const slot = keccak256(encodePacked(["bytes32", "bytes32"], [positionId, mapping]));
  const word = await ctx.pub.readContract({ address: ctx.net.manifest.poolManager, abi: poolManagerAbi, functionName: "extsload", args: [slot] });
  return BigInt(word) & ((1n << 128n) - 1n);
}

const symbols = new Map<Address, string>();
async function symbolOf(ctx: ChainCtx, token: Address): Promise<string> {
  let s = symbols.get(token);
  if (!s) {
    s = await ctx.pub.readContract({ address: token, abi: testTokenAbi, functionName: "symbol" }).catch(() => "TOKEN");
    symbols.set(token, s);
  }
  return s;
}

/** Accounts whose shares and fees the app shows. */
const HOLDERS: Actor[] = ["lp", "holder", "keeper", "curator", "issuer", "attacker", "market"];

/**
 * Whose shares to read. On the dev chain, every demo actor's. On a public chain every role is the connected wallet,
 * so its shares are read once and stand for each role; with no wallet connected there is no one to read.
 */
function holderAccounts(ctx: ChainCtx): Address[] {
  if (ctx.net.caps.devChain) return HOLDERS.map((a) => ctx.address(a));
  return ctx.signer ? [ctx.signer] : [];
}

export async function readVaultView(ctx: ChainCtx, vault: Address): Promise<VaultView> {
  const { lens } = ctx.net.manifest;
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    ctx.pub.readContract({ address: vault, abi: covenantVaultAbi, functionName, args } as never) as Promise<T>;

  const [s, block] = await Promise.all([
    ctx.pub.readContract({ address: lens, abi: covenantLensAbi, functionName: "snapshot", args: [vault] }),
    ctx.pub.getBlock({ blockTag: "latest" }),
  ]);
  const key = keyOf(s);
  const token = s.quoteIsCurrency0 ? key.currency1 : key.currency0;
  const [sqrtP, symbol, c0, c1, principalOwed, treasury, pendingIssuer, ...perHolder] = await Promise.all([
    readSqrtPrice(ctx, poolIdOf(key)),
    symbolOf(ctx, token),
    read<bigint>("curatorFees0", [s.curator]),
    read<bigint>("curatorFees1", [s.curator]),
    read<readonly [bigint, bigint]>("feesOwed", [zeroAddress]),
    read<Address>("treasury"),
    read<Address>("pendingIssuer"),
    ...holderAccounts(ctx).flatMap((who) => [read<bigint>("sharesOf", [who]), read<readonly [bigint, bigint]>("feesOwed", [who])]),
  ]);
  const holderAt = (i: number) => ({ shares: perHolder[2 * i] as bigint, owed: perHolder[2 * i + 1] as readonly [bigint, bigint] });
  const holders = ctx.net.caps.devChain
    ? HOLDERS.map((actor, i) => ({ actor, ...holderAt(i) }))
    : ctx.signer
      ? HOLDERS.map((actor) => ({ actor, ...holderAt(0) }))
      : [];
  return buildView(s, {
    address: vault,
    chainId: ctx.net.chainId,
    block: block.number,
    time: Number(block.timestamp),
    sqrtP: sqrtP as bigint,
    symbol: symbol as string,
    curatorFees: [c0 as bigint, c1 as bigint],
    principalOwed: principalOwed as readonly [bigint, bigint],
    holders,
    treasury: treasury as Address,
    pendingIssuer: pendingIssuer as Address,
  });
}

/**
 * The view after a simulated action: the simulated lens snapshot with everything else (prices, balances) taken from
 * the view the action started from. Actions previewed this way (reshape, restore, deposit) do not move the price.
 */
export function viewFromSnapshot(base: VaultView, s: LensState): VaultView {
  return buildView(s, base.extras);
}

const keyOf = (s: LensState): PoolKey => ({
  currency0: s.key.currency0,
  currency1: s.key.currency1,
  fee: s.key.fee,
  tickSpacing: s.key.tickSpacing,
  hooks: s.key.hooks,
});

function buildView(s: LensState, x: Extras): VaultView {
  const key = keyOf(s);
  const q0 = s.quoteIsCurrency0;
  const token = q0 ? key.currency1 : key.currency0;
  const terms: Terms = { ...s.terms };
  const time = x.time;
  const adopted = s.adoptedAt > 0n;
  const spot = x.sqrtP > 0n ? toPrice(q0, tickAtSqrt(sqrtX96ToFloat(x.sqrtP))) : s.spotPrice;
  const twap = s.twapPrice;
  const anchor = s.anchor;
  const band: [number, number] = [Math.min(anchor, twap) - terms.supportBandTicks, twap];
  const split = (a0: bigint, a1: bigint): Holding => (q0 ? { quote: f(a0), token: f(a1) } : { quote: f(a1), token: f(a0) });

  const ranges: RangeView[] = s.ranges.map((r, index) => {
    const base = {
      index,
      tickLower: r.tickLower,
      tickUpper: r.tickUpper,
      priceLower: r.priceLower,
      priceUpper: r.priceUpper,
      liquidity: r.liquidity,
      L: Number(r.liquidity) / WAD,
      quote: f(r.quote),
      token: f(r.token),
    };
    return { ...base, kind: kindOf(base, band, spot) };
  });

  // Support as the contract defines it, for display: quote inside the band over all quote, both valued at the TWAP.
  const idle = split(s.idle0, s.idle1);
  let total = idle.quote;
  let inBand = 0;
  for (const r of ranges) {
    total += holdingsAtPrice(q0, twap, r.priceLower, r.priceUpper, r.L).quote;
    inBand += quoteIn(q0, r.L, Math.max(r.priceLower, band[0]), Math.min(r.priceUpper, band[1]));
  }

  const byActor: Partial<Record<Actor, number>> = {};
  const owed: Partial<Record<Actor, Holding>> = {};
  for (const h of x.holders) {
    byActor[h.actor] = Number(h.shares) / WAD;
    owed[h.actor] = split(h.owed[0], h.owed[1]);
  }

  const setupEndsAt = Number(s.setupEndsAt);
  const unlockStartsAt = Number(s.unlockStartsAt);
  const fullyVestedAt = Number(s.fullyVestedAt);
  const vested = !adopted || time < unlockStartsAt ? 0 : fullyVestedAt <= unlockStartsAt ? 1 : Math.min(1, (time - unlockStartsAt) / (fullyVestedAt - unlockStartsAt));
  const MAX = 2n ** 255n;

  return {
    address: x.address,
    chainId: x.chainId,
    block: x.block,
    time,
    key,
    poolId: poolIdOf(key),
    quoteIs0: q0,
    quoteSymbol: "ETH",
    token,
    tokenSymbol: x.symbol,
    tickSpacing: key.tickSpacing,
    feePips: key.fee,
    terms,
    adopted,
    spot,
    spotTick: s.spotPrice,
    twap,
    anchor,
    ceiling: anchor + terms.guardTicks,
    band,
    guard: { ok: s.guardPasses, diff: Math.abs(spot - twap), limit: terms.guardTicks },
    support: { have: Number(s.supportBps), need: terms.supportBps, inBand, total },
    pace: { setup: adopted && time < setupEndsAt, setupEndsAt, available: s.paceAvailable >= MAX ? 1 : Number(s.paceAvailable) / 1e9, cap: terms.paceBps / 1e4 },
    lock: { adoptedAt: Number(s.adoptedAt), unlockStartsAt, fullyVestedAt, vested, withdrawable: Number(s.principalWithdrawable) / WAD },
    value: f(s.totalValue),
    principal: { quote: f(s.principalQuote), token: f(s.principalToken) },
    idle,
    ranges,
    shares: {
      total: Number(s.totalShares) / WAD,
      principal: Number(s.principalShares) / WAD,
      outside: Number(s.totalShares - s.principalShares) / WAD,
      byActor,
    },
    fees: {
      pot: split(s.feePot0, s.feePot1),
      bountyPool: f(s.bountyPool),
      curator: split(x.curatorFees[0], x.curatorFees[1]),
      principalOwed: split(x.principalOwed[0], x.principalOwed[1]),
      owed,
    },
    people: {
      issuer: s.issuer,
      pendingIssuer: x.pendingIssuer === zeroAddress ? null : x.pendingIssuer,
      curator: s.curator,
      pendingCurator: s.pendingCurator === zeroAddress ? null : s.pendingCurator,
      curatorReadyAt: Number(s.curatorReadyAt),
      treasury: x.treasury,
    },
    raw: {
      totalShares: s.totalShares,
      principalShares: s.principalShares,
      principalWithdrawable: s.principalWithdrawable,
      sharesOf: Object.fromEntries(x.holders.map((h) => [h.actor, h.shares])),
    },
    extras: x,
  };
}

/** Who an address is in the demo, for display. */
export const whoIs = (a: Address | null | undefined) => actorOf(a ?? undefined);

/** A pool-tick range for a price-tick range (Orient.rangeToPool), for building legs. */
export const poolRange = (v: Pick<VaultView, "quoteIs0">, priceLower: number, priceUpper: number) => rangeToPool(v.quoteIs0, priceLower, priceUpper);
