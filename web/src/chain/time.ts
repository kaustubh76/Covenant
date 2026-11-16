import type { Hex } from "viem";
import { type ChainCtx, devControls } from "./client";

export async function latest(ctx: ChainCtx): Promise<{ number: bigint; timestamp: bigint }> {
  const b = await ctx.pub.getBlock({ blockTag: "latest" });
  return { number: b.number, timestamp: b.timestamp };
}

/**
 * Move the chain clock forward and mine a block there. The local chain stamps one second per block otherwise, so the
 * clock (and with it the TWAP and the Guard) only moves when something happens.
 */
export async function advance(ctx: ChainCtx, seconds: number): Promise<void> {
  const test = devControls(ctx);
  const { timestamp } = await latest(ctx);
  await test.setNextBlockTimestamp({ timestamp: timestamp + BigInt(Math.max(1, Math.round(seconds))) });
  await test.mine({ blocks: 1 });
}

/**
 * Until the next block is at least `blockNumber`, so a call gated on it can go now (pre-flights run in the pending
 * block). The dev chain mines there at once; a public chain is waited for, since its blocks come on their own.
 */
export async function reach(ctx: ChainCtx, blockNumber: bigint, onWait?: (latest: bigint, target: bigint) => void): Promise<void> {
  if (ctx.test) return mineTo(ctx, blockNumber - 1n);
  for (;;) {
    const now = await ctx.pub.getBlockNumber({ cacheTime: 0 });
    if (now + 1n >= blockNumber) return;
    onWait?.(now, blockNumber);
    await new Promise((r) => setTimeout(r, ctx.net.caps.blockTimeMs));
  }
}

/** Mine empty blocks until `blockNumber` is the latest block. */
export async function mineTo(ctx: ChainCtx, blockNumber: bigint): Promise<void> {
  const test = devControls(ctx);
  const { number } = await latest(ctx);
  if (blockNumber > number) await test.mine({ blocks: Number(blockNumber - number) });
}

export async function snapshot(ctx: ChainCtx): Promise<Hex> {
  return devControls(ctx).snapshot();
}

/** Revert to a snapshot. Anvil restores state, block number and clock, and consumes the snapshot. */
export async function revertTo(ctx: ChainCtx, id: Hex): Promise<void> {
  await devControls(ctx).revert({ id });
}

/** Run `fn` and put the chain back exactly as it was, whatever happens. */
export async function sandbox<T>(ctx: ChainCtx, fn: () => Promise<T>): Promise<T> {
  const id = await snapshot(ctx);
  try {
    return await fn();
  } finally {
    await revertTo(ctx, id);
  }
}
