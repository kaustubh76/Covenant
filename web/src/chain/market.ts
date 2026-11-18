// The market around the vault: real swaps through v4's PoolSwapTest router. On the local chain they come from demo
// accounts and the demo token mints freely, so a trader never runs out of tokens to sell. On a public chain they come
// from the connected wallet, with what it really holds (Base Sepolia has Uniswap's own PoolSwapTest deployed).

import { type Address, formatEther, maxUint256, parseEther } from "viem";
import { poolSwapTestAbi, testTokenAbi } from "./abi.generated";
import type { Actor } from "./accounts";
import type { ChainCtx } from "./client";
import { sqrtAtTick, sqrtX96ToFloat, tickAtSqrt, toPool, toPrice } from "./price";
import { type Outcome, type SendOptions, must, send, simulate } from "./tx";
import { readSqrtPrice } from "./view";
import type { VaultView } from "./view";

export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

/** sqrt(1.0001^tick) in Q96, approximately: good enough for a swap's price limit, clamped to v4's bounds. */
export function sqrtPriceLimitAt(poolTick: number): bigint {
  const raw = BigInt(Math.floor(sqrtAtTick(poolTick) * 2 ** 96));
  return raw <= MIN_SQRT_PRICE ? MIN_SQRT_PRICE + 1n : raw >= MAX_SQRT_PRICE ? MAX_SQRT_PRICE - 1n : raw;
}

export type Pool = Pick<VaultView, "key" | "poolId" | "quoteIs0" | "token">;

/** ETH a public-chain buy leaves in the wallet for gas. */
const GAS_RESERVE = parseEther("0.002");

/** Mint (dev chain) and approve so `who` can pay `amount` of the token into the router. */
async function fundTokens(ctx: ChainCtx, who: Actor, token: Address, amount: bigint) {
  const me = ctx.address(who);
  const router = ctx.net.manifest.swapRouter as Address;
  const [bal, allowance] = await Promise.all([
    ctx.pub.readContract({ address: token, abi: testTokenAbi, functionName: "balanceOf", args: [me] }),
    ctx.pub.readContract({ address: token, abi: testTokenAbi, functionName: "allowance", args: [me, router] }),
  ]);
  if (bal < amount) {
    if (!ctx.net.caps.devChain) {
      throw new Error(`The wallet holds ${Number(formatEther(bal)).toFixed(2)} tokens, fewer than the ${Number(formatEther(amount)).toFixed(2)} to sell. Buy some first.`);
    }
    must(await send(ctx, who, { address: token, abi: testTokenAbi, functionName: "mint", args: [me, amount - bal] }), "mint");
  }
  // A real wallet approves the router for this sale only; dev chains keep the open allowance their demos rely on.
  const approval = ctx.net.caps.devChain ? maxUint256 : amount;
  if (allowance < amount) must(await send(ctx, who, { address: token, abi: testTokenAbi, functionName: "approve", args: [router, approval] }), "approve");
}

/** What a swap's caller pays in currency0, from the router's BalanceDelta (amount0 in the high 128 bits; negative is owed). */
export const paidIn0 = (delta: bigint): bigint => -BigInt.asIntN(128, delta >> 128n);

/**
 * The router call for an exact-input swap, built but not sent: `swap` sends it, and a simulation can run it in a block
 * of its own (crashsim.ts). `buy`: pay quote, receive tokens. The price limit stops the swap at `limitPriceTick`.
 */
export function swapCall(ctx: ChainCtx, pool: Pool, buy: boolean, amountIn: bigint, limitPriceTick?: number) {
  const zeroForOne = buy === pool.quoteIs0; // the input currency is currency0
  const defaultLimit = zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n;
  const limit = limitPriceTick === undefined ? defaultLimit : sqrtPriceLimitAt(toPool(pool.quoteIs0, limitPriceTick));
  const nativeIn = buy && pool.quoteIs0; // native ETH is always currency0
  return {
    address: ctx.net.manifest.swapRouter as Address,
    abi: poolSwapTestAbi,
    functionName: "swap" as const,
    args: [
      pool.key,
      { zeroForOne, amountSpecified: -amountIn, sqrtPriceLimitX96: limit },
      { takeClaims: false, settleUsingBurn: false },
      "0x",
    ] as const,
    value: nativeIn ? amountIn : 0n,
  };
}

/** Exact-input swap. `buy`: pay quote, receive tokens (the token's price rises). */
export async function swap(ctx: ChainCtx, pool: Pool, who: Actor, buy: boolean, amountIn: bigint, limitPriceTick?: number, opts?: SendOptions): Promise<Outcome> {
  if (!buy) await fundTokens(ctx, who, pool.token, amountIn);
  const nativeIn = buy && pool.quoteIs0; // native ETH is always currency0
  // A public chain's wallet holds real (testnet) ETH: a budget beyond its balance is cut to what it can spend, keeping
  // some for gas. The router hands back whatever the price limit leaves unspent.
  if (nativeIn && !ctx.net.caps.devChain) {
    const balance = await ctx.pub.getBalance({ address: ctx.address(who) });
    const spendable = balance > GAS_RESERVE ? balance - GAS_RESERVE : 0n;
    if (spendable === 0n) throw new Error("The wallet has no ETH to buy with.");
    if (amountIn > spendable) amountIn = spendable;
    // Ask the pool what the swap really spends before its price limit stops it, and send that and a hair more: the
    // wallet's confirmation then shows what the trade costs, not everything the wallet holds.
    if (limitPriceTick !== undefined) {
      const pre = await simulate(ctx, who, swapCall(ctx, pool, buy, amountIn, limitPriceTick));
      const spent = pre.ok && typeof pre.value === "bigint" ? paidIn0(pre.value) : 0n;
      if (spent > 0n && spent < amountIn) amountIn = spent + spent / 200n + 1n;
    }
  }
  return send(ctx, who, swapCall(ctx, pool, buy, amountIn, limitPriceTick), opts);
}

/** The pool's exact price tick now. */
export async function spotOf(ctx: ChainCtx, pool: Pool): Promise<number> {
  return toPrice(pool.quoteIs0, tickAtSqrt(sqrtX96ToFloat(await readSqrtPrice(ctx, pool.poolId))));
}

/** Push the price to `targetPriceTick` with an oversized exact-input swap capped by the price limit. */
export async function pushTo(ctx: ChainCtx, pool: Pool, who: Actor, targetPriceTick: number, budget: bigint, opts?: SendOptions): Promise<Outcome> {
  const spot = await spotOf(ctx, pool);
  return swap(ctx, pool, who, targetPriceTick > spot, budget, targetPriceTick, opts);
}
