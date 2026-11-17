import { describe, expect, it } from "vitest";
import { AUCTION_FLOOR, AUCTION_TICK, DEFAULT_BIDS, auctionPrice, defaultLaunchSpec, poolIdOf, testnetBids, testnetLaunchSpec } from "./launch";
import { PRESETS } from "./terms";

describe("launch helpers", () => {
  it("computes the same PoolId as v4 (keccak of the abi-encoded key)", () => {
    // The local chain's default launch, read back with `cast call <vault> "poolId()"`.
    const key = {
      currency0: "0x0000000000000000000000000000000000000000",
      currency1: "0x8464135c8F25Da09e49BC8782676a84730C318bC",
      fee: 3000,
      tickSpacing: 60,
      hooks: "0xfdBDcFDd18B434EBDa90e46E367A20428690F040",
    } as const;
    expect(poolIdOf(key)).toBe("0x85e98dc6a7e1f4c84d24583ba53f524caca34de39c0b9789a6d60094526d9456");
  });

  it("prices auction levels like the Solidity suite", () => {
    expect(auctionPrice(0)).toBe(AUCTION_FLOOR);
    expect(Number(auctionPrice(19)) / 2 ** 96).toBeCloseTo(1.296875, 9);
  });

  it("defaults to the suite's launch", () => {
    const s = defaultLaunchSpec(PRESETS.standard);
    expect(s.auctionSupply).toBe(1000n * 10n ** 18n);
    expect(s.lpReserve).toBe(100n * 10n ** 18n);
    expect(s.lpRateMps).toBe(1_000_000);
    expect(1e7 % s.durationBlocks).toBe(0);
  });

  it("sizes a testnet launch as the suite's auction with every price and bid divided by 2^13", () => {
    const s = testnetLaunchSpec(PRESETS.standard);
    // The CCA's own rules (TickStorage, StepStorage): floor above 2^32 and on the tick grid, spacing at least 2,
    // and the steps split 1e7 mps evenly over two halves.
    expect(s.floorPrice).toBe(2n ** 83n);
    expect(s.auctionTick).toBe(2n ** 77n);
    expect(s.floorPrice > 2n ** 32n).toBe(true);
    expect(s.floorPrice % s.auctionTick).toBe(0n);
    expect(1e7 % s.durationBlocks).toBe(0);
    expect(s.durationBlocks % 2).toBe(0);
    expect(s.token).toBe("fixed");
    // Same supply and pool reserve as the suite, so the auction plays out the same way at 1/8192 of the price.
    expect(s.auctionSupply).toBe(defaultLaunchSpec(PRESETS.standard).auctionSupply);
    expect(Number(auctionPrice(19, s)) / Number(auctionPrice(19))).toBeCloseTo(1 / 8192, 12);
    expect(AUCTION_TICK / s.auctionTick).toBe(8192n);
  });

  it("scales the bids with the prices: 0.0366, 0.0366 and 0.1709 ETH", () => {
    const bids = testnetBids();
    expect(bids.map((b) => b.steps)).toEqual(DEFAULT_BIDS.map((b) => b.steps));
    expect(bids.map((b) => b.amount)).toEqual([36621093750000000n, 36621093750000000n, 170898437500000000n]);
    expect(testnetBids(14)[2].amount * 2n).toBe(bids[2].amount);
  });
});

