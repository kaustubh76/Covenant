import { describe, expect, it } from "vitest";
import { AUCTION_FLOOR, auctionPrice, defaultLaunchSpec, poolIdOf } from "./launch";
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
});
