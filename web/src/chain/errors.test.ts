import { RawContractError, encodeErrorResult } from "viem";
import { describe, expect, it } from "vitest";
import { errorAbi } from "./abi.generated";
import { decodeRevert, describeError } from "./errors";

// Revert data exactly as the vault returns it (cast calldata "SupportBroken(uint256,uint256)" 3156 4000).
const SUPPORT_BROKEN = "0xd41610710000000000000000000000000000000000000000000000000000000000000c540000000000000000000000000000000000000000000000000000000000000fa0";
const PRICE_GUARD =
  "0x4a0e125bfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff5d7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff9bf";

describe("decodeRevert", () => {
  it("decodes a vault custom error to its name, arguments, rule and reason", () => {
    const d = decodeRevert(new RawContractError({ data: SUPPORT_BROKEN }));
    expect(d.name).toBe("SupportBroken");
    expect(d.args).toEqual([3156n, 4000n]);
    expect(d.signature).toBe("SupportBroken(3156, 4000)");
    expect(d.rule).toBe("Support");
    expect(d.reason).toContain("31.6%");
    expect(d.reason).toContain("40%");
  });

  it("reads signed tick arguments", () => {
    const d = decodeRevert(new RawContractError({ data: PRICE_GUARD }));
    expect(d.name).toBe("PriceGuard");
    expect(d.args).toEqual([-2601, -1601]);
    expect(d.rule).toBe("Guard");
    expect(d.reason).toContain("1000 ticks");
  });

  it("unwraps an error a callee raised inside the PoolManager", () => {
    const wrapped = encodeErrorResult({
      abi: errorAbi,
      errorName: "WrappedError",
      args: ["0x0000000000000000000000000000000000000001", "0x12345678", SUPPORT_BROKEN, "0x"],
    });
    expect(decodeRevert(new RawContractError({ data: wrapped })).name).toBe("SupportBroken");
  });

  it("decodes errors from libraries the vault links (CovenantLogic) and from Uniswap", () => {
    const band = encodeErrorResult({ abi: errorAbi, errorName: "RestoreBandEmpty", args: [1200, 1100] });
    expect(decodeRevert(new RawContractError({ data: band })).rule).toBe("Anchor");
    const auction = encodeErrorResult({ abi: errorAbi, errorName: "AuctionNotStarted" });
    expect(decodeRevert(new RawContractError({ data: auction })).rule).toBe("Auction");
  });

  it("keeps unknown errors readable", () => {
    expect(describeError("SomethingNew", [1n]).signature).toBe("SomethingNew(1)");
    expect(decodeRevert(new Error("boom")).reason).toBe("boom");
  });
});
