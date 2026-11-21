import { describe, expect, it } from "vitest";
import { amt } from "./format";

describe("amt", () => {
  it("never shows a real amount as zero: one too small for four decimals is said to be under 0.0001", () => {
    expect(amt(0)).toBe("0");
    expect(amt(3e-7)).toBe("< 0.0001");
    expect(amt(-3e-7)).toBe("−< 0.0001");
    expect(amt(0.00012)).toBe("0.0001");
    expect(amt(1.5)).toBe("1.50");
    expect(amt(12345.6)).toBe("12,346");
  });
});
