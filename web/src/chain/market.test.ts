import { describe, expect, it } from "vitest";
import { paidIn0 } from "./market";

/** A BalanceDelta as the router returns it: amount0 in the high 128 bits, amount1 in the low, both signed. */
const delta = (amount0: bigint, amount1: bigint) => (BigInt.asUintN(128, amount0) << 128n) | BigInt.asUintN(128, amount1);

describe("paidIn0", () => {
  it("reads what the caller paid in currency0 (native ETH) from a swap's BalanceDelta", () => {
    // Paid 0.0123 ETH (owed: negative), received 41 tokens.
    expect(paidIn0(delta(-12_300_000_000_000_000n, 41n * 10n ** 18n))).toBe(12_300_000_000_000_000n);
    // A sell: received ETH, so nothing paid in it.
    expect(paidIn0(delta(5n * 10n ** 15n, -(10n ** 18n)))).toBe(-(5n * 10n ** 15n));
  });
});
