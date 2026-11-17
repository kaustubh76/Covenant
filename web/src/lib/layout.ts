import type { VaultView } from "@/chain/view";

/**
 * A vault's liquidity layout as one string: which vault, and each range's bounds and liquidity. It changes when a
 * reshape, deposit or withdrawal settles, or another vault is picked; not when a block passes or the price moves.
 * The curate editor keeps a hand-edited draft until it does.
 */
export function layoutKey(v: Pick<VaultView, "address" | "ranges">): string {
  return `${v.address.toLowerCase()}|${v.ranges.map((r) => `${r.tickLower}:${r.tickUpper}:${r.liquidity}`).join(",")}`;
}
