import { describe, expect, it } from "vitest";
import { PRESETS, termsProblems } from "./terms";

describe("terms", () => {
  it("accepts every preset at the default spacing, as the factory does", () => {
    for (const t of Object.values(PRESETS)) expect(termsProblems(t, 60)).toEqual([]);
  });
  it("mirrors TermsLib's bounds", () => {
    expect(termsProblems({ ...PRESETS.standard, supportBandTicks: 400 }, 60)[0]).toContain("480");
    expect(termsProblems({ ...PRESETS.standard, curatorFeeBps: 3001 }, 60)).toHaveLength(1);
    expect(termsProblems({ ...PRESETS.standard, twapWindow: 60 }, 60)).toHaveLength(1);
    expect(termsProblems({ ...PRESETS.standard, epochLength: 1800 }, 60)).toHaveLength(1);
  });
});
