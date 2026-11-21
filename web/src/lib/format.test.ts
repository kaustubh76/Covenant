import { describe, expect, it } from "vitest";
import { amt, duration } from "./format";

describe("amt", () => {
  it("never shows a real amount as zero: one too small for four decimals is said to be under 0.0001", () => {
    expect(amt(0)).toBe("0");
    expect(amt(3e-7)).toBe("< 0.0001");
    expect(amt(-3e-7)).toBe("> −0.0001");
    expect(amt(0.00012)).toBe("0.0001");
    expect(amt(1.5)).toBe("1.50");
    expect(amt(12345.6)).toBe("12,346");
  });
});

describe("duration", () => {
  it("names whole days without a zero hour", () => {
    expect(duration(86_400)).toBe("1d");
    expect(duration(90_000)).toBe("1d 1h");
    expect(duration(2 * 86_400)).toBe("2d");
    expect(duration(1_800)).toBe("30m");
  });
});
