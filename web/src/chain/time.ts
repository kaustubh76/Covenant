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

/** Blocks a public chain is waited past the one asked for (reach). */
export const REACH_MARGIN = 2n;

/**
 * Until the next block is at least `blockNumber`, so a call gated on it can go now (pre-flights run in the pending
 * block). The dev chain mines there at once; a public chain is waited for, since its blocks come on their own.
 */
export async function reach(ctx: ChainCtx, blockNumber: bigint, onWait?: (latest: bigint, target: bigint) => void): Promise<void> {
  if (ctx.test) return mineTo(ctx, blockNumber - 1n);
  // A public RPC answers from whichever node a call reaches, and one can be a block or two behind the one that said the
  // height was reached: the call waiting on it would be simulated there, and refused as too early. Two blocks more, 400
  // ms on Base Sepolia, puts every node past it.
  const target = blockNumber + REACH_MARGIN;
  for (;;) {
    const now = await ctx.pub.getBlockNumber({ cacheTime: 0 });
    if (now + 1n >= target) return;
    onWait?.(now, target);
    // Once a block, but no more than once a second: Base Sepolia makes a block every 200 ms.
    await new Promise((r) => setTimeout(r, Math.max(ctx.net.caps.blockTimeMs, 1000)));
  }
}

/**
 * The most blocks one mine may ask for: the Playground backend's own per-call cap. The app's longest wait is a dev
 * launch's auction, about 200 blocks. A target far beyond it is a block height from another chain (a public launch's,
 * say): mining to it would stall the chain and fill its memory, at about 75 KB a block.
 */
export const MAX_MINE = 1_000;

/** A mine refused before it was asked for: `target` is too far ahead of `from`. Nothing was mined. */
export class TooManyBlocks extends Error {
  override name = "TooManyBlocks";
  constructor(
    readonly target: bigint,
    readonly from: bigint,
    readonly cap: number = MAX_MINE,
  ) {
    super(`Block ${target} is ${target - from} blocks ahead of this chain, more than the ${cap.toLocaleString("en-US")} it mines at once. Nothing was mined.`);
  }
}

/** Mine empty blocks until `blockNumber` is the latest block. Refuses, with TooManyBlocks, a target past MAX_MINE. */
export async function mineTo(ctx: ChainCtx, blockNumber: bigint): Promise<void> {
  const test = devControls(ctx);
  const { number } = await latest(ctx);
  if (blockNumber <= number) return;
  if (blockNumber - number > BigInt(MAX_MINE)) throw new TooManyBlocks(blockNumber, number);
  await test.mine({ blocks: Number(blockNumber - number) });
}

export async function snapshot(ctx: ChainCtx): Promise<Hex> {
  return devControls(ctx).snapshot();
}

/** A save point the chain no longer has: it was reset or replaced (a fresh Playground chain, say) since it was taken. */
export class SnapshotGone extends Error {
  override name = "SnapshotGone";
  constructor(readonly id: Hex) {
    super("That save point is gone: the chain was reset or replaced since it was taken.");
  }
}

/**
 * Revert to a snapshot. Anvil restores state, block number and clock, and consumes the snapshot. Anvil answers false for
 * an id it does not have, and then nothing moved: that is thrown as SnapshotGone rather than taken for a revert (viem's
 * own `revert` drops the answer).
 */
export async function revertTo(ctx: ChainCtx, id: Hex): Promise<void> {
  const reverted: unknown = await devControls(ctx).request({ method: "evm_revert", params: [id] });
  if (reverted === false) throw new SnapshotGone(id);
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
