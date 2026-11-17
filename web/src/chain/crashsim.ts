// A sell-off that holds, simulated: the vault a TWAP window after the market sold the price down, and whether a keeper's
// restore would then settle. Nothing is sent.
//
// Restore exists for a crash that lasts. The support band follows the time-weighted price down, and quote the vault
// keeps deep below the price can end up under it. The dev chain finds such a crash with snapshots (scenarios/restore.ts).
// Any chain with eth_simulateV1 can find it without them, in one call of two blocks: the sale in the next block, and the
// vault read back a window later, as if nobody traded in between. The live proof picks its crash this way.

import { type Abi, type Address, maxUint256 } from "viem";
import { covenantLensAbi, testTokenAbi } from "./abi.generated";
import type { ChainCtx } from "./client";
import { type DecodedError, decodeRevert } from "./errors";
import { swapCall } from "./market";
import { restoreCall, restoreCandidates } from "./scenarios/restore";
import { type LensState, type VaultView, viewFromSnapshot } from "./view";

/** The sell-off depths the guided demo tries, in price ticks below spot (scenarios/restore.ts). */
export const CRASH_DEPTHS = [1500, 2000, 2500, 3000, 3500, 4000, 5000, 6000];

export interface CrashSim {
  /** How far below spot the sale's price limit sits, in price ticks. */
  depth: number;
  /** Tokens the seller would sell, in wei. */
  sold: bigint;
  /** The vault once the sale has held for the window. */
  after: VaultView;
  /** Support has fallen below the covenant while the guard passes: restore is open to anyone. */
  lapsed: boolean;
  /** The keeper's restore at that point: the ranges it names, and what the contract would say. */
  restore: { indices: number[]; ok: boolean; error?: DecodedError; supportAfter?: number } | null;
}

export interface SimCall {
  account?: Address;
  to: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
}
interface SimResult {
  status: string;
  result?: unknown;
  error?: unknown;
}

/** One eth_simulateV1 on top of `base`: `sale` in the next block, `later` in a block `hold` seconds after it. */
async function twoBlocks(ctx: ChainCtx, base: { number: bigint; timestamp: bigint }, hold: bigint, sale: SimCall[], later: SimCall[]): Promise<[SimResult[], SimResult[]]> {
  const blocks = await ctx.pub.simulateBlocks({
    blockNumber: base.number,
    blocks: [
      { blockOverrides: { number: base.number + 1n, time: base.timestamp + 1n }, calls: sale },
      { blockOverrides: { number: base.number + 2n, time: base.timestamp + 1n + hold }, calls: later },
    ],
  } as never);
  const [a, b] = blocks as unknown as { calls: SimResult[] }[];
  return [a.calls, b.calls];
}

/**
 * `seller` sells the price down `depth` ticks (spending at most its whole token balance) and the price then holds for
 * the TWAP window plus `margin` seconds. If that leaves support lapsed, a restore by `keeper` is tried: every candidate
 * range together, then each alone, as planRestore does. Null when the sale itself fails; an error when the seller holds
 * no tokens, since then nothing at all can be learned about this layout.
 *
 * `prelude` runs first in the sale's block: a reshape that is not sent yet, say, so a whole plan can be checked before
 * any of it goes on chain. The sale's price limit is taken from `v`, which a reshape does not move.
 */
export async function simulateCrash(
  ctx: ChainCtx,
  v: VaultView,
  depth: number,
  seller: Address,
  keeper: Address,
  prelude: SimCall[] = [],
  margin = 300,
): Promise<CrashSim | null> {
  const base = await ctx.pub.getBlock({ blockTag: "latest" });
  const hold = BigInt(v.terms.twapWindow + margin);
  const budget = await ctx.pub.readContract({ address: v.token, abi: testTokenAbi, functionName: "balanceOf", args: [seller] });
  if (budget === 0n) throw new Error(`${seller} holds no ${v.tokenSymbol} to simulate a sell-off with.`);
  const swap = swapCall(ctx, v, false, budget, v.spotTick - depth);
  const sale: SimCall[] = [
    ...prelude,
    { account: seller, to: v.token, abi: testTokenAbi as Abi, functionName: "approve", args: [swap.address, maxUint256] },
    { account: seller, to: swap.address, abi: swap.abi as Abi, functionName: swap.functionName, args: swap.args, value: swap.value },
    { to: v.token, abi: testTokenAbi as Abi, functionName: "balanceOf", args: [seller] },
  ];
  const snapshot: SimCall = { to: ctx.net.manifest.lens, abi: covenantLensAbi as Abi, functionName: "snapshot", args: [v.address] };
  const [results, [snap]] = await twoBlocks(ctx, base, hold, sale, [snapshot]);
  const sold = results.slice(prelude.length);
  if (results.slice(0, prelude.length).some((r) => r.status !== "success")) return null;
  if (sold[1]?.status !== "success" || snap?.status !== "success") return null;

  // The view a window later. Prices and support come from the simulated snapshot; the clock is the simulated block's.
  const time = Number(base.timestamp + 1n + hold);
  const later: VaultView = { ...v, extras: { ...v.extras, time, block: base.number + 2n } };
  const after = viewFromSnapshot(later, snap.result as LensState);
  const out: CrashSim = { depth, sold: budget - (sold[2].result as bigint), after, lapsed: after.support.have < after.support.need && after.guard.ok, restore: null };
  if (!out.lapsed) return out;

  const all = restoreCandidates(after);
  for (const indices of all.length ? [all, ...all.map((i) => [i])] : []) {
    const call = restoreCall(after, [...indices].sort((a, b) => a - b));
    const [, [r, s]] = await twoBlocks(ctx, base, hold, sale, [
      { account: keeper, to: call.address, abi: call.abi as Abi, functionName: call.functionName, args: call.args },
      snapshot,
    ]);
    if (r.status === "success") {
      out.restore = { indices, ok: true, supportAfter: viewFromSnapshot(later, s.result as LensState).support.have };
      return out;
    }
    out.restore ??= { indices, ok: false, error: decodeRevert(r.error, { now: time, quoteSymbol: v.quoteSymbol, tokenSymbol: v.tokenSymbol }) };
  }
  return out;
}

/** The shallowest of `depths` whose sell-off, once it has held, leaves support lapsed and a restore that settles. */
export async function findCrash(ctx: ChainCtx, v: VaultView, seller: Address, keeper: Address, prelude: SimCall[] = [], depths = CRASH_DEPTHS): Promise<CrashSim | null> {
  for (const depth of depths) {
    const sim = await simulateCrash(ctx, v, depth, seller, keeper, prelude);
    if (sim?.lapsed && sim.restore?.ok) return sim;
  }
  return null;
}
