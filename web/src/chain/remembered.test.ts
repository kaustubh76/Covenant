import { describe, expect, it } from "vitest";
import { MAX_REMEMBERED_SPAN, sanitizeLaunches } from "./remembered";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const good = { vault: A(1), token: A(2), auction: A(3), symbol: "CVLP", createdAtBlock: 100, adopted: true };

describe("sanitizeLaunches", () => {
  it("keeps well-formed records, rebuilt from their checked fields only", () => {
    const [r] = sanitizeLaunches([{ ...good, spans: [[200, 300]], extra: "dropped" }]);
    expect(r).toEqual({ ...good, spans: [[200, 300]] });
  });

  it("drops records with a bad address or a block that is not a whole number", () => {
    expect(sanitizeLaunches([{ ...good, vault: "0x123" }, { ...good, token: 7 }, { ...good, createdAtBlock: 1.5 }, { ...good, createdAtBlock: -1 }, null, "x"])).toEqual([]);
  });

  it("drops spans that are malformed, reversed or long enough to start a history scan", () => {
    const [r] = sanitizeLaunches([{ ...good, spans: [[5, 1], [0, MAX_REMEMBERED_SPAN], [1, "2"], [10, 20]] }]);
    expect(r.spans).toEqual([[10, 20]]);
    const [s] = sanitizeLaunches([{ ...good, spans: [[0, 1e12]] }]);
    expect(s.spans).toBeUndefined();
  });

  it("trims a long symbol, defaults a missing one, and ignores anything that is not a list", () => {
    expect(sanitizeLaunches([{ ...good, symbol: "X".repeat(40) }])[0].symbol).toHaveLength(16);
    expect(sanitizeLaunches([{ ...good, symbol: undefined }])[0].symbol).toBe("TOKEN");
    expect(sanitizeLaunches({ launches: [good] })).toEqual([]);
  });
});
