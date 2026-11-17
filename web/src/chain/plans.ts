// Reshape plans: the honest layouts a curator submits and the hostile ones the rules reject. Every builder mirrors a
// helper in the Solidity suite (test/base/CovenantTestBase.sol, test/attacks/AttackCatalogue.t.sol), in price ticks.

import { MAX_LIQUIDITY } from "./launch";
import { ceilTo, floorTo, rangeToPool } from "./price";
import type { VaultView } from "./view";

/** A leg share meaning "whatever is left of this currency". */
export const SINK = 0xffff;

export interface Cut {
  index: bigint;
  liquidity: bigint;
}
export interface Leg {
  tickLower: number;
  tickUpper: number;
  share0: number;
  share1: number;
}
export interface Plan {
  cuts: Cut[];
  legs: Leg[];
}

type V = Pick<VaultView, "quoteIs0" | "tickSpacing" | "terms" | "ranges" | "spotTick">;

/** A pool-tick leg for a price-tick range, aligned outward to the spacing (CovenantTestBase._pool). */
export function leg(v: V, priceLower: number, priceUpper: number, quoteShare: number, tokenShare: number): Leg {
  const s = v.tickSpacing;
  const [tickLower, tickUpper] = rangeToPool(v.quoteIs0, floorTo(priceLower, s), ceilTo(priceUpper, s));
  return v.quoteIs0 ? { tickLower, tickUpper, share0: quoteShare, share1: tokenShare } : { tickLower, tickUpper, share0: tokenShare, share1: quoteShare };
}
/** A bid: quote only (CovenantTestBase._bid). */
export const bidLeg = (v: V, priceLower: number, priceUpper: number, quoteShare: number) => leg(v, priceLower, priceUpper, quoteShare, 0);
/** An ask: tokens only (CovenantTestBase._ask). */
export const askLeg = (v: V, priceLower: number, priceUpper: number, tokenShare: number) => leg(v, priceLower, priceUpper, 0, tokenShare);

export const cut = (index: number, liquidity: bigint = MAX_LIQUIDITY): Cut => ({ index: BigInt(index), liquidity });
export const cutAll = (v: V): Cut[] => v.ranges.map((_, i) => cut(i));

/** The highest aligned price a bid may reach: strictly under the price as v4 compares ticks (CovenantLogic.restoreTargets). */
export const bidTop = (v: V) => floorTo(v.quoteIs0 ? v.spotTick - 1 : v.spotTick, v.tickSpacing);
/** The lowest aligned price an ask may start at. */
export const askFloor = (v: V) => ceilTo(v.quoteIs0 ? v.spotTick : v.spotTick + 1, v.tickSpacing);

/**
 * The honest curator's layout around price tick `p` (CovenantTestBase._honestLegs): a three-spacing core straddling
 * the price, `supportBps` of the quote as a bid band from the core down to B below the price, the rest of the quote
 * further down, and every token as asks from the core up.
 */
export function honestLegs(v: V, p = v.spotTick, supportBps = 6000): Leg[] {
  const s = v.tickSpacing;
  const band = v.terms.supportBandTicks;
  const coreLow = floorTo(p - 1, s) - s;
  const coreHigh = ceilTo(p + 1, s) + s;
  const bidBottom = ceilTo(p - band, s) + s;
  return [leg(v, coreLow, coreHigh, 300, 300), bidLeg(v, bidBottom, coreLow, supportBps), bidLeg(v, bidBottom - 4 * band, bidBottom, SINK), askLeg(v, coreHigh, coreHigh + 2 * band, SINK)];
}

const byQuote = (v: V, kinds: string[]) =>
  v.ranges
    .filter((r) => kinds.includes((r as { kind?: string }).kind ?? ""))
    .sort((a, b) => b.quote - a.quote)
    .map((r) => r.index);

/** The main support bid: the in-band range holding the most quote. */
export function supportIndex(v: V): number {
  return byQuote(v, ["Support"])[0] ?? byQuote(v, ["Core", "Reserve"])[0] ?? 0;
}
/** The reserve: the out-of-band bid holding the most quote. */
export function reserveIndex(v: V): number {
  return byQuote(v, ["Reserve"])[0] ?? supportIndex(v);
}

// ---------------------------------------------------------------------------------------------------- hostile

/** "Soft rug": all of the support's quote moved 9,000–12,000 ticks under the price (13.2.03). */
export const softRug = (v: V): Plan => ({ cuts: [cut(supportIndex(v))], legs: [bidLeg(v, v.spotTick - 12_000, v.spotTick - 9_000, SINK)] });

/** "Skim": re-add only 90% of what the support held (13.2.02). */
export const skim = (v: V): Plan => ({ cuts: [cut(supportIndex(v))], legs: [bidLeg(v, v.spotTick - 1440, v.spotTick - 180, 9000)] });

/** "Fragment": the reserve split into twelve slivers, to grief gas (13.2.08). */
export function fragment(v: V): Plan {
  const legs: Leg[] = [];
  let top = v.spotTick - v.terms.supportBandTicks;
  for (let i = 0; i < 12; i++) {
    legs.push(bidLeg(v, top - 60, top, i === 0 ? SINK : 500));
    top -= 60;
  }
  return { cuts: [cut(reserveIndex(v))], legs };
}

/** The whole vault in one transaction (13.2.06): fine in the setup epoch, over Pace after it. */
export const moveEverything = (v: V): Plan => ({ cuts: cutAll(v), legs: honestLegs(v) });

/**
 * Half of the quote-only reserve into the band and the rest spread four bands deeper: the layout restore exists for. A
 * sell-off that holds drags the band down past the deep half and strands it there (the guided demo's step 7, and the
 * live proof on Base Sepolia).
 */
export function deepenReserve(v: V & Pick<VaultView, "twap">): Plan {
  const s = v.tickSpacing;
  const B = v.terms.supportBandTicks;
  const reserve = v.ranges.filter((r) => r.token < 1e-12 && r.quote > 0).map((r) => r.index);
  const top = Math.min(bidTop(v), floorTo(v.twap, s));
  const bandFloor = ceilTo(v.twap - B, s) + s;
  return { cuts: reserve.map((i) => cut(i)), legs: [bidLeg(v, bandFloor, top, 5000), bidLeg(v, v.twap - 5 * B, bandFloor, SINK)] };
}
