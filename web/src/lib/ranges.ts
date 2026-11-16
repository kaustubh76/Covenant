import { priceAt } from "@/chain/price";
import type { RangeKind, VaultView } from "@/chain/view";

export type { RangeKind };

/** One vault range as the tables show it: its role in the layout, what it holds at spot and its price span. */
export function describeRange(v: VaultView, i: number) {
  const r = v.ranges[i];
  const full = r.kind === "Full range";
  return {
    kind: r.kind,
    quote: r.quote,
    token: r.token,
    label: full ? "All prices" : `${priceAt(r.priceLower).toFixed(3)} – ${priceAt(r.priceUpper).toFixed(3)}`,
  };
}

export const KIND_SWATCH: Record<RangeKind, string> = {
  Core: "bg-accent",
  Support: "bg-support",
  Reserve: "bg-support/40",
  Asks: "bg-ask",
  "Full range": "bg-muted",
};
