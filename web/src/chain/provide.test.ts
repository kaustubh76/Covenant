import { parseEther } from "viem";
import { describe, expect, it } from "vitest";
import { quoteBudget, withSlack } from "./provide";

describe("quoteBudget", () => {
  // The lens's principal is the vault's whole quote, idle included: 50 ETH in ranges plus 2 idle reads as 52.
  const v = { principal: { quote: 52, token: 400 }, idle: { quote: 2, token: 0 } };

  it("budgets a tenth over the slice of the principal, idle counted once", () => {
    expect(quoteBudget(v, 0.1)).toBe(parseEther((52 * 0.1 * 1.1 + 0.01).toFixed(18)));
  });

  it("stays within what the payer can spend", () => {
    expect(quoteBudget(v, 0.1, parseEther("1"))).toBe(parseEther("1"));
    expect(quoteBudget(v, 0.1, -1n)).toBe(0n);
  });
});

describe("withSlack", () => {
  it("adds half a percent and a wei", () => {
    expect(withSlack(1000n)).toBe(1006n);
  });
});
