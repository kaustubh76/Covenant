// The market around the vault: real swaps through v4's PoolSwapTest router, from demo accounts. On the local chain the
// demo token mints freely, so a trader never runs out of tokens to sell.

import { type Address, maxUint256 } from "viem";
import { poolSwapTestAbi, testTokenAbi } from "./abi.generated";
import type { Actor } from "./accounts";
import type { ChainCtx } from "./client";
import { sqrtAtTick, sqrtX96ToFloat, tickAtSqrt, toPool, toPrice } from "./price";
import { type Outcome, must, send } from "./tx";
import { readSqrtPrice } from "./view";
import type { VaultView } from "./view";

export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

/** sqrt(1.0001^tick) in Q96, approximately: good enough for a swap's price limit, clamped to v4's bounds. */
export function sqrtPriceLimitAt(poolTick: number): bigint {
  const raw = BigInt(Math.floor(sqrtAtTick(poolTick) * 2 ** 96));
  return raw <= MIN_SQRT_PRICE ? MIN_SQRT_PRICE + 1n : raw >= MAX_SQRT_PRICE ? MAX_SQRT_PRICE - 1n : raw;
}

type Pool = Pick<VaultView, "key" | "poolId" | "quoteIs0" | "token">;

/** Mint (dev chain) and approve so `who` can pay `amount` of the token into the router. */
async function fundTokens(ctx: ChainCtx, who: Actor, token: Address, amount: bigint) {
  const me = ctx.address(who);
  const router = ctx.net.manifest.swapRouter as Address;
  const [bal, allowance] = await Promise.all([
    ctx.pub.readContract({ address: token, abi: testTokenAbi, functionName: "balanceOf", args: [me] }),
    ctx.pub.readContract({ address: token, abi: testTokenAbi, functionName: "allowance", args: [me, router] }),
  ]);
  if (bal < amount) {
    if (!ctx.net.caps.devChain) throw new Error("not enough tokens to sell");
    must(await send(ctx, who, { address: token, abi: testTokenAbi, functionName: "mint", args: [me, amount - bal] }), "mint");
  }
  if (allowance < amount) must(await send(ctx, who, { address: token, abi: testTokenAbi, functionName: "approve", args: [router, maxUint256] }), "approve");
}

/** Exact-input swap. `buy`: pay quote, receive tokens (the token's price rises). */
export async function swap(ctx: ChainCtx, pool: Pool, who: Actor, buy: boolean, amountIn: bigint, limitPriceTick?: number): Promise<Outcome> {
  const router = ctx.net.manifest.swapRouter as Address;
  const zeroForOne = buy === pool.quoteIs0; // the input currency is currency0
  const defaultLimit = zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n;
  const limit = limitPriceTick === undefined ? defaultLimit : sqrtPriceLimitAt(toPool(pool.quoteIs0, limitPriceTick));
  if (!buy) await fundTokens(ctx, who, pool.token, amountIn);
  const nativeIn = buy && pool.quoteIs0; // native ETH is always currency0
  return send(ctx, who, {
    address: router,
    abi: poolSwapTestAbi,
    functionName: "swap",
    args: [
      pool.key,
      { zeroForOne, amountSpecified: -amountIn, sqrtPriceLimitX96: limit },
      { takeClaims: false, settleUsingBurn: false },
      "0x",
    ],
    value: nativeIn ? amountIn : 0n,
  });
}

/** The pool's exact price tick now. */
export async function spotOf(ctx: ChainCtx, pool: Pool): Promise<number> {
  return toPrice(pool.quoteIs0, tickAtSqrt(sqrtX96ToFloat(await readSqrtPrice(ctx, pool.poolId))));
}

/** Push the price to `targetPriceTick` with an oversized exact-input swap capped by the price limit. */
export async function pushTo(ctx: ChainCtx, pool: Pool, who: Actor, targetPriceTick: number, budget: bigint): Promise<Outcome> {
  const spot = await spotOf(ctx, pool);
  return swap(ctx, pool, who, targetPriceTick > spot, budget, targetPriceTick);
}
