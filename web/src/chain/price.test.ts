import { describe, expect, it } from "vitest";
import { AUCTION_FLOOR, AUCTION_TICK } from "./launch";
import { amountsAt, ceilTo, floorTo, holdingsAtPrice, priceAt, q96ToNumber, rangeToPool, rangeToPrice, snapToAuctionTick, ticksBelowPct, ticksToPct, toPool, toPrice } from "./price";

describe("orientation (Orient.sol)", () => {
  it("negates ticks when the quote is currency0 and keeps them otherwise", () => {
    expect(toPrice(true, 2601)).toBe(-2601);
    expect(toPrice(false, 2601)).toBe(2601);
    expect(toPool(true, toPrice(true, -120))).toBe(-120);
  });
  it("keeps range bounds ordered both ways", () => {
    expect(rangeToPrice(true, -2700, -2520)).toEqual([2520, 2700]);
    expect(rangeToPool(true, 2520, 2700)).toEqual([-2700, -2520]);
    expect(rangeToPrice(false, -2700, -2520)).toEqual([-2700, -2520]);
  });
  it("rounds to the spacing toward minus infinity, like floorTo/ceilTo", () => {
    expect(floorTo(-1, 60)).toBe(-60);
    expect(floorTo(-60, 60)).toBe(-60);
    expect(floorTo(59, 60)).toBe(0);
    expect(ceilTo(-59, 60)).toBe(-0);
    expect(ceilTo(61, 60)).toBe(120);
    expect(ceilTo(120, 60)).toBe(120);
  });
});

describe("amounts (RangeMath.amounts)", () => {
  const L = 1000;
  it("holds only currency0 below the range and only currency1 above it", () => {
    const below = amountsAt(Math.sqrt(1.0001 ** -1000), -600, 600, L);
    const above = amountsAt(Math.sqrt(1.0001 ** 1000), -600, 600, L);
    expect(below.a1).toBe(0);
    expect(below.a0).toBeGreaterThan(0);
    expect(above.a0).toBe(0);
    expect(above.a1).toBeGreaterThan(0);
  });
  it("in price ticks, a range under the price is a bid (quote only) and one over it an ask (tokens only)", () => {
    const bid = holdingsAtPrice(true, 2601, 1200, 2520, L);
    const ask = holdingsAtPrice(true, 2601, 2700, 5700, L);
    expect(bid.token).toBe(0);
    expect(bid.quote).toBeGreaterThan(0);
    expect(ask.quote).toBe(0);
    expect(ask.token).toBeGreaterThan(0);
  });
});

describe("prices", () => {
  it("reads price ticks as quote per token", () => {
    expect(priceAt(0)).toBe(1);
    expect(priceAt(2601)).toBeCloseTo(1.2969, 3);
    expect(ticksToPct(1500)).toBeCloseTo(16.18, 1);
  });
  it("snaps a CCA price to the auction's 1/64 grid", () => {
    expect(snapToAuctionTick(1.016, AUCTION_FLOOR, AUCTION_TICK)).toBe(AUCTION_FLOOR + AUCTION_TICK);
    expect(snapToAuctionTick(1.3, AUCTION_FLOOR, AUCTION_TICK)).toBe(AUCTION_FLOOR + 19n * AUCTION_TICK);
    expect(snapToAuctionTick(0.5, AUCTION_FLOOR, AUCTION_TICK)).toBe(AUCTION_FLOOR);
    expect(q96ToNumber(AUCTION_FLOOR + 19n * AUCTION_TICK)).toBeCloseTo(1.296875, 6);
  });
});

describe("tick distances in percent", () => {
  it("a rise over 1500 ticks is 16.2%, while a band 1500 ticks below the price reaches down 13.9%", () => {
    expect(ticksToPct(1500)).toBeCloseTo(16.18, 2);
    expect(ticksBelowPct(1500)).toBeCloseTo(13.93, 2);
    // the two agree for small distances and diverge as the distance grows
    expect(Math.abs(ticksToPct(10) - ticksBelowPct(10))).toBeLessThan(0.001);
  });
});
