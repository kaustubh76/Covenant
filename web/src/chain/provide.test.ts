import { parseEther } from "viem";
import { describe, expect, it } from "vitest";
import { GUARD_MARGIN_TICKS, guardEdgeTick, largestDepositThatFits, quoteBudget, withSlack } from "./provide";

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

describe("largestDepositThatFits: a public chain's deposit, sized to what the pool sells within the price guard", () => {
  // CVNT on Base Sepolia, read on 2026-11-20: 152.34 tokens in the vault. A wallet holding none, and a pool that sells
  // 7.8 tokens before spot reaches the guard's edge.
  const cvnt = { vaultTokens: 152.34, held: 0, buyable: 7.8 };

  it("offers the whole percents whose token side the wallet can cover, with the page's margins", () => {
    // each percent takes 1.5234 * 1.01 = 1.5386 tokens; 7.8 / 1.02 = 7.647 coverable: 4 whole percents
    expect(largestDepositThatFits(cvnt)).toBe(4);
  });

  it("counts what the wallet already holds", () => {
    expect(largestDepositThatFits({ ...cvnt, held: 10 })).toBe(11);
  });

  it("never offers more than the slider allows", () => {
    expect(largestDepositThatFits({ ...cvnt, held: 1_000 })).toBe(25);
    expect(largestDepositThatFits({ ...cvnt, held: 1_000, max: 10 })).toBe(10);
  });

  it("offers nothing when not even 1% fits, or the vault holds no tokens", () => {
    expect(largestDepositThatFits({ vaultTokens: 152.34, held: 0, buyable: 1 })).toBe(0);
    expect(largestDepositThatFits({ vaultTokens: 0, held: 5, buyable: 5 })).toBe(0);
    expect(largestDepositThatFits({ vaultTokens: 152.34, held: 0, buyable: -3 })).toBe(0);
  });
});

describe("guardEdgeTick", () => {
  it("stops a buy short of the guard's edge, above the time-weighted price", () => {
    expect(guardEdgeTick({ twap: -89_012, terms: { guardTicks: 300 } } as never)).toBe(-89_012 + 300 - GUARD_MARGIN_TICKS);
  });
});
