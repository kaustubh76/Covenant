import { describe, expect, it } from "vitest";
import { feedAmount } from "./history";

describe("feedAmount", () => {
  it("writes a testnet fee out in full, with three significant figures", () => {
    expect(feedAmount(2.45454545454e-7)).toBe("0.000000245");
    expect(feedAmount(2.454545454545e-6)).toBe("0.00000245");
    expect(feedAmount(0.000969)).toBe("0.000969");
    expect(feedAmount(0.0149281)).toBe("0.0149");
  });

  it("writes zero as 0, and larger amounts as before", () => {
    expect(feedAmount(0)).toBe("0");
    expect(feedAmount(9.6574)).toBe("9.66");
    expect(feedAmount(41.9123)).toBe("41.91");
    expect(feedAmount(129.42)).toBe("129");
  });
});
