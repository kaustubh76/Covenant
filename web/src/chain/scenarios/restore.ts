// Restore needs quote stranded below the support band. A sell-off strands it when the vault keeps a reserve deeper than
// one band under the price; when every bid sits within a band of the price, a crash either leaves it in the band or
// fills it, and there is nothing to restore. These helpers find a crash that strands quote, and the ranges to restore.

import { parseEther } from "viem";
import { covenantVaultAbi } from "../abi.generated";
import type { Actor } from "../accounts";
import type { ChainCtx } from "../client";
import { NEVER } from "../launch";
import { pushTo } from "../market";
import { type Preflight, preflight } from "../preflight";
import { advance, sandbox } from "../time";
import type { Party } from "../tx";
import { type VaultView, readVaultView } from "../view";

/** Ranges worth restoring: every range holding quote with any part below the band, most quote first. */
export function restoreCandidates(v: VaultView): number[] {
  return v.ranges
    .filter((r) => r.quote > 1e-9 && r.priceLower < v.band[0])
    .sort((a, b) => b.quote - a.quote)
    .map((r) => r.index);
}

export function restoreCall(v: VaultView, indices: number[]) {
  return { address: v.address, abi: covenantVaultAbi, functionName: "restore" as const, args: [indices.map(BigInt), NEVER] as const };
}

/** The restore a keeper would submit now: all candidates, or failing that the single best one. */
export async function planRestore(ctx: ChainCtx, v: VaultView, keeper: Party): Promise<{ indices: number[]; pre: Preflight } | null> {
  const all = restoreCandidates(v);
  const options = all.length ? [all, ...all.map((i) => [i])] : [v.ranges.map((r) => r.index)];
  let first: { indices: number[]; pre: Preflight } | null = null;
  for (const indices of options) {
    const pre = await preflight(ctx, keeper, restoreCall(v, [...indices].sort((a, b) => a - b)), v);
    first ??= { indices, pre };
    if (pre.ok) return { indices, pre };
    // Holding support has nothing to restore, whichever ranges are tried: the first refusal already says so, and a
    // public RPC is not asked for the rest every block.
    if (v.support.have >= v.support.need) break;
  }
  return first;
}

/** Sell the price down `depth` ticks and hold it there until the TWAP has caught up (the suite's _settleTwap). */
export async function crash(ctx: ChainCtx, v: VaultView, depth: number, seller: Actor = "market") {
  const sold = await pushTo(ctx, v, seller, v.spotTick - depth, parseEther("1000000"));
  await advance(ctx, v.terms.twapWindow + 3600);
  return sold;
}

/**
 * The smallest sell-off that leaves support lapsed and restorable, found by trying depths in a sandbox. Null when no
 * depth works on this layout.
 */
export async function findLapsingCrash(ctx: ChainCtx, v: VaultView, depths = [1500, 2000, 2500, 3000, 3500, 4000, 5000, 6000]): Promise<number | null> {
  for (const depth of depths) {
    const works = await sandbox(ctx, async () => {
      await crash(ctx, v, depth);
      const after = await readVaultView(ctx, v.address);
      if (after.support.have >= after.support.need || !after.guard.ok) return false;
      const plan = await planRestore(ctx, after, "keeper");
      return !!plan?.pre.ok;
    });
    if (works) return depth;
  }
  return null;
}
