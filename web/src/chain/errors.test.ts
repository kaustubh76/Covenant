import { RawContractError, encodeErrorResult, toFunctionSelector } from "viem";
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

  it("says who may sweep an auction, and that a sweep only happens once", () => {
    const treasury = "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f";
    const bob = "0xBcd4042DE499D14e55001CcbB24a551F3b954096";
    const d = decodeRevert(new RawContractError({ data: encodeErrorResult({ abi: errorAbi, errorName: "NotAuthorized", args: [treasury, bob] }) }));
    expect(d.rule).toBe("Auction");
    expect(d.reason).toBe("Only 0x2361…1E8f, the recipient the auction names, can do this. It was sent from 0xBcd4…4096.");
    expect(decodeRevert(new RawContractError({ data: encodeErrorResult({ abi: errorAbi, errorName: "CannotSweepTokens" }) })).reason).toContain("already been swept");
  });

  it("tells the auction's InvalidAmount from the launcher's, which share a name", () => {
    const shapes = errorAbi.filter((e) => e.type === "error" && e.name === "InvalidAmount");
    expect(shapes.map((e) => e.inputs.length).sort()).toEqual([0, 2]);
    const of = (inputs: number, args: readonly unknown[]) =>
      decodeRevert(new RawContractError({ data: encodeErrorResult({ abi: shapes.filter((e) => e.inputs.length === inputs), errorName: "InvalidAmount", args } as never) }));
    expect(of(0, []).reason).toBe("The ETH sent must equal the bid's amount.");
    expect(of(2, [2n * 10n ** 18n, 10n ** 18n]).reason).toBe("2.00 is more than the 1.00 allowed.");
  });

  it("says why the vault could not take a depositor's tokens, from the bare selector Solady reverts with", () => {
    // Exactly what the vault returns for a depositor holding too few tokens: SafeTransferLib drops the token's own error.
    const d = decodeRevert(new RawContractError({ data: "0x7939f424" }), { tokenSymbol: "CVNT" });
    expect(d.name).toBe("TransferFromFailed");
    expect(d.signature).toBe("TransferFromFailed()");
    expect(d.rule).toBe("Other");
    expect(d.reason).toBe("The vault could not take the CVNT it is owed: the sender holds too few, or has not approved the vault for that many.");
    // and the refund of a deposit's unused ETH, to an address that refuses it
    const refund = decodeRevert(new RawContractError({ data: "0xb12d13eb" }));
    expect(refund.name).toBe("ETHTransferFailed");
    expect(refund.reason).toContain("does not accept ETH");
  });

  it("gives every error a selector of its own, so none decodes as another", () => {
    type Param = { type: string; components?: readonly Param[] };
    const typeOf = (p: Param): string => (p.components ? `(${p.components.map(typeOf).join(",")})${p.type.slice(5)}` : p.type);
    const selectors = errorAbi.map((e) => toFunctionSelector(`${e.name}(${(e.inputs as readonly Param[]).map(typeOf).join(",")})`));
    expect(selectors).toContain("0x7939f424");
    expect(new Set(selectors).size).toBe(selectors.length);
  });

  it("keeps unknown errors readable", () => {
    expect(describeError("SomethingNew", [1n]).signature).toBe("SomethingNew(1)");
    expect(decodeRevert(new Error("boom")).reason).toBe("boom");
  });
});
